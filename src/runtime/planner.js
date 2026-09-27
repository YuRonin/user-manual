'use strict';

/*
 * 确定性 Planner（契约 C07）。
 *
 * 分两步：
 *   collectPlanningInputs()  读取（只读）当前模型、Scenario、配置与缓存，产出可 JSON 序列化的 snapshot；
 *   plan()                   纯函数：snapshot + command + 策略 → 任务 DAG。不访问浏览器、不改模型、不读文件。
 * 相同 snapshot 得到相同 DAG 与 planHash（不含时间戳）。
 *
 * 节点 kind 固定为 C07 的八种；本阶段用到 analyze / capture / derive-image / draft / rewrite / validate / publish。
 * 审批作为 plan gate：未获批的任务生成 approve 节点（kind=validate），执行时若仍未批准则 waiting_input；
 * 已确认的范围不再询问。缓存命中只把 capture 标为 reuse candidate，执行前仍重新校验完整性。
 */

const { revisionOf } = require('../util/hash');
const { definitionRevision } = require('../model/revision');
const { approvalState, approvalMessage, scopeHash, pageRevisionsFor, pageObservationRevision, APPROVAL_STATES } = require('../model/approval');
const { deriveTaskScenario, derivePageScenario } = require('../scenarios/model');
const { resolveScenario } = require('../scenarios/store');
const { buildCapturePlan } = require('../tasks/capture-plan');
const { isActivePage, ANALYSIS } = require('../inspect/model');
const { authDisabled, identityRevision } = require('../auth/identity');
const { policyRevision } = require('../publication/validate');
const { RENDERER_VERSION } = require('../evidence/image-pipeline');
const { TEMPLATE_VERSION } = require('../generate/render');
const { DEFAULT_READY_OPTIONS } = require('../browser/provider');
const { capabilitiesFor, missingCapabilities } = require('../browser/capabilities');
const { captureKey } = require('../cache/keys');
const { lookup } = require('../cache/lookup');
const { resolveTarget } = require('./resolve-target');
const { RuntimeError } = require('./errors');

const PLAN_VERSION = 1;
const COMMANDS = ['generate', 'capture'];
const CAPTURE_CAPABILITIES = ['capture', 'assertions', 'privacyGeometry'];
const TASK_CAPABILITIES = [...CAPTURE_CAPABILITIES, 'semanticActions'];

function browserVersion() {
  try { return `playwright-${require('playwright/package.json').version}`; } catch (_) { return 'unknown'; }
}

function subjectKey(subject) {
  return `${subject.type}:${subject.id}`;
}

/** 当前图像派生输入：隐私规则、标注主题、渲染器。任一变化 → 已有 raw 需要重新派生。 */
function imageInputsOf(config) {
  const theme = config.annotation?.themes?.[config.annotation?.activeTheme] || null;
  return { privacyRevision: policyRevision(config), themeRevision: revisionOf({ theme }), rendererVersion: RENDERER_VERSION };
}

/**
 * Capture 缓存 key 的字段（C09）。handler 写缓存时用同一个函数，保证读写一致。
 * @param {{ subject, scenario, sourceHash, captureMode }} p
 */
function captureKeyFields({ config, subject, scenario, sourceHash, captureMode, browser, platform }) {
  const profile = config.capture.profiles[config.capture.activeProfile];
  const provider = config.browser.providers[config.browser.activeProvider] || {};
  const authProfile = scenario.authProfile || config.auth?.activeProfile;
  return {
    projectId: config.project.id || config.auth?.cacheKey || config.project.name,
    environment: `${scenario.environment || 'local'}@${new URL(config.project.baseUrl).origin}`,
    deployedBuild: config.runtime?.deployedBuild,
    dataRevision: scenario.data?.revision,
    scenarioId: scenario.id,
    scenarioRevision: scenario.revision,
    checkpoint: subject.type === 'task' ? 'task-steps' : 'default',
    sourceHash,
    identityRevision: authDisabled(config, authProfile) ? 'anonymous' : (identityRevision(config, authProfile) || `profile:${authProfile}`),
    viewport: profile.viewport,
    dpr: profile.deviceScaleFactor,
    locale: profile.locale || null,
    timezone: profile.timezoneId || null,
    browser: `${provider.type || 'playwright'}:${provider.channel || 'chromium'}:${provider.headless === false ? 'headed' : 'headless'}:${browser}`,
    platform,
    captureMode,
    readinessPolicy: revisionOf({ ready: DEFAULT_READY_OPTIONS }),
  };
}

function scenarioIndex(stateDirAbs, model, config) {
  const out = [];
  for (const task of model.tasks) {
    const derived = deriveTaskScenario(task, model.pages, config);
    out.push({ id: derived.id, subject: { type: 'task', id: task.id }, derived, stepIds: (task.steps || []).map((s) => s.id) });
  }
  for (const page of model.pages) {
    const derived = derivePageScenario(page, config);
    out.push({ id: derived.id, subject: { type: 'page', id: page.id }, derived, stepIds: [] });
  }
  return out;
}

function taskInputs({ task, model, config, scenario }) {
  const approval = approvalState(task, model.pages);
  const built = buildCapturePlan(task, model.pages, { scenario });
  const boundaries = built.ok ? built.plan.steps.filter((step) => !step.willExecute).map((step) => ({ stepId: step.id, execution: step.execution, risk: step.risk, reason: step.riskReason })) : [];
  return {
    approval,
    approvalMessage: approval === APPROVAL_STATES.APPROVED ? null : approvalMessage(approval, task.id),
    scopeHash: scopeHash(task, model.pages),
    definitionRevision: definitionRevision('userTask', task),
    pageRevisions: pageRevisionsFor(task, model.pages),
    // 审批之外的计划错误（缺页面、断言为空、缺路由参数……）在规划期就报告。
    planErrors: built.ok || approval !== APPROVAL_STATES.APPROVED ? [] : built.errors,
    boundaries,
    stepCount: (task.steps || []).length,
  };
}

function pageInputs({ page }) {
  const errors = [];
  if (!isActivePage(page)) errors.push(`page-not-active: 页面 ${page.id} 当前是 ${page.lifecycle}，不能采集或生成。`);
  if (page.includeInManual === false) errors.push(`页面 ${page.id} 标记为 includeInManual: false，不在手册范围内。`);
  return {
    analysis: page.status?.sourceAnalysis || null,
    observationRevision: pageObservationRevision(page),
    definitionRevision: definitionRevision('page', page),
    planErrors: errors,
  };
}

/**
 * 只读收集规划输入。
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config          loadConfig().config
 * @param {object} p.base            projectStore.load() 的结果
 * @param {string[]} p.targets       原始目标字符串
 * @param {object} p.mode            cache/policy.resolveMode()
 * @param {object} [p.cacheStore]    cache/store；缺省时不查缓存
 */
function collectPlanningInputs({ projectRoot, config, base, targets, mode, cacheStore = null, now = () => Date.now(), platform = process.platform }) {
  const stateDirAbs = require('path').join(projectRoot, config.artifacts.stateDir);
  const model = base.model;
  const scenarios = scenarioIndex(stateDirAbs, model, config);
  const resolved = [];
  for (const raw of targets) {
    const result = resolveTarget(raw, { tasks: model.tasks, pages: model.pages, scenarios });
    if (!result.ok) throw new RuntimeError(result.code, result.message, { candidates: result.candidates || null });
    resolved.push(result.target);
  }
  const browser = browserVersion();
  const provider = config.browser.providers[config.browser.activeProvider];
  const subjects = {};
  for (const target of resolved) {
    const key = subjectKey(target);
    if (subjects[key]) continue;
    const entry = scenarios.find((item) => item.subject.type === target.type && item.subject.id === target.id);
    const scenarioResult = resolveScenario(stateDirAbs, entry.derived, { stepIds: entry.stepIds });
    if (!scenarioResult.ok) throw new RuntimeError('invalid-scenario', scenarioResult.errors.join('；'));
    const scenario = scenarioResult.scenario;
    const entity = target.type === 'task' ? model.tasks.find((t) => t.id === target.id) : model.pages.find((p) => p.id === target.id);
    const details = target.type === 'task' ? taskInputs({ task: entity, model, config, scenario }) : pageInputs({ page: entity });
    const sourceHash = target.type === 'task'
      ? revisionOf({ scopeHash: details.scopeHash, pageRevisions: details.pageRevisions })
      : details.observationRevision;
    const keyFields = captureKeyFields({ config, subject: target, scenario, sourceHash, captureMode: target.type === 'task' ? 'task-steps' : 'viewport', browser, platform });
    const keyInfo = captureKey(keyFields);
    let cache = null;
    if (cacheStore) {
      const found = lookup({
        store: cacheStore, keyInfo, subject: `capture:${key}`, mode, projectRoot, stateDirAbs,
        requiredScopes: ['page-identity'], privacy: { audience: config.privacy?.audience || 'public' },
        cachePolicy: config.cache, now,
      });
      cache = found.hit
        ? { hit: true, reusedFrom: found.reusedFrom, observedAt: found.observedAt, stale: found.stale, uncertainty: found.uncertainty, imageInputs: found.entry.meta?.imageInputs || null, outputRefs: found.outputRefs }
        : { hit: false, reason: found.reason || null, bypassed: found.bypassed || null, changedFields: found.changedFields || null };
    }
    subjects[key] = {
      subject: { type: target.type, id: target.id },
      scenario: { id: scenario.id, revision: scenario.revision, authProfile: scenario.authProfile, explicit: scenarioResult.explicit },
      captureKey: keyInfo.key,
      captureKeyInput: keyInfo.input,
      captureUncertainty: keyInfo.uncertainty,
      cache,
      ...details,
    };
  }
  return {
    version: PLAN_VERSION,
    modelRevision: base.modelRevision,
    projectId: config.project.id || null,
    language: config.docs.language,
    templateVersion: TEMPLATE_VERSION,
    imageInputs: imageInputsOf(config),
    capabilities: capabilitiesFor(provider, config.browser.activeProvider),
    mode: { name: mode.name, browserAllowed: mode.browserAllowed },
    targets: resolved.map((target) => ({ type: target.type, id: target.id, ref: target.ref, ...(target.scenarioId ? { scenarioId: target.scenarioId } : {}), ...(target.manualId ? { manualId: target.manualId } : {}) })),
    subjects,
  };
}

function sameImageInputs(a, b) {
  return !!a && !!b && revisionOf(a) === revisionOf(b);
}

/**
 * 纯规划。
 * @param {object} snapshot  collectPlanningInputs() 的结果
 * @param {{ command: 'generate'|'capture', copy?: { mode: 'model'|'default'|'file', path?, sha256? }, acceptReview?, force? }} policy
 * @returns {{ plan, errors: string[] }}  plan.tasks 可直接交给 Run Store
 */
function plan(snapshot, policy) {
  const command = policy.command;
  if (!COMMANDS.includes(command)) throw new RuntimeError('invalid-arguments', `不支持的命令: ${command}`);
  const copy = policy.copy || { mode: 'model' };
  const errors = [];
  const nodes = [];
  const summary = { actions: [], browserScenarios: 0, riskBoundaries: [], cache: [], waitingFor: [] };
  const captureByKey = new Map();
  const multi = snapshot.targets.length > 1;
  const idOf = (kind, index) => (multi ? `${kind}-t${index + 1}` : kind);
  const add = (node) => { nodes.push({ retry: { maxAttempts: 3, replay: 'safe' }, reuse: null, ...node }); return node.id; };

  snapshot.targets.forEach((target, index) => {
    const s = snapshot.subjects[subjectKey(target)];
    const subject = s.subject;
    if (command === 'generate' && target.scenarioId) errors.push(`scenario 目标只用于 capture：${target.ref}`);
    errors.push(...s.planErrors);
    const needed = subject.type === 'task' ? TASK_CAPABILITIES : CAPTURE_CAPABILITIES;
    const missing = missingCapabilities(snapshot.capabilities, needed);
    if (missing.length) errors.push(`capability-missing: 当前 Browser Provider 不支持 ${missing.join(', ')}。`);

    // ---- gate：审批 / 源码分析
    const gateDeps = [];
    if (subject.type === 'task' && s.approval !== APPROVAL_STATES.APPROVED) {
      if (s.approval === APPROVAL_STATES.REJECTED) errors.push(s.approvalMessage);
      else {
        gateDeps.push(add({
          id: idOf('approve', index), kind: 'validate', dependsOn: [],
          inputHash: revisionOf({ gate: 'approval', subject, scopeHash: s.scopeHash }),
          input: { gate: 'approval', subject, scopeHash: s.scopeHash, state: s.approval },
          retry: { maxAttempts: 3, replay: 'requires-input' },
          reason: `approval-${s.approval}`,
        }));
        summary.waitingFor.push({ node: idOf('approve', index), input: 'approval', message: s.approvalMessage });
      }
    }
    // ---- capture（按 captureKey 去重：同一 Scenario / checkpoint / 输入的采集只做一次）
    let captureId = captureByKey.get(s.captureKey);
    let derived = null;
    if (!captureId) {
      const cache = s.cache;
      const reuse = cache?.hit ? { from: cache.reusedFrom, observedAt: cache.observedAt, stale: !!cache.stale, onlineChecked: false } : null;
      const reason = cache?.hit
        ? `cache-hit${cache.stale ? '-stale' : ''}`
        : (cache?.bypassed ? `cache-${cache.bypassed}` : `capture-required:${cache?.reason || 'no-cache'}${cache?.changedFields?.length ? `(${cache.changedFields.join(',')})` : ''}`);
      captureId = add({
        id: idOf('capture', index), kind: 'capture', dependsOn: gateDeps.slice(),
        inputHash: revisionOf({ captureKey: s.captureKey, subject }),
        input: {
          subject, captureKey: s.captureKey, scenario: s.scenario,
          ...(subject.type === 'task' ? { scopeHash: s.scopeHash, definitionRevision: s.definitionRevision, pageRevisions: s.pageRevisions } : { observationRevision: s.observationRevision }),
        },
        reuse,
        retry: { maxAttempts: 3, replay: 'safe' },
        reason,
      });
      captureByKey.set(s.captureKey, captureId);
      summary.cache.push({ node: captureId, subject: subjectKey(subject), hit: !!cache?.hit, reason, observedAt: reuse?.observedAt || null, uncertainty: s.captureUncertainty });
      if (!reuse) {
        if (!snapshot.mode.browserAllowed) errors.push(`cache-miss-offline: ${subjectKey(subject)} 没有可复用的历史证据（${cache?.reason || 'not-found'}），离线模式不能重新采集。`);
        summary.browserScenarios += 1;
        summary.actions.push(`采集 ${subjectKey(subject)}（Scenario ${s.scenario.id}）`);
      } else {
        summary.actions.push(`复用 ${subjectKey(subject)} 的已有证据（观察于 ${reuse.observedAt}）`);
        // 隐私规则 / 主题 / 渲染器变化：raw 仍可用，只重新派生发布图。
        if (!sameImageInputs(cache.imageInputs, snapshot.imageInputs)) {
          derived = add({
            id: idOf('derive-image', index), kind: 'derive-image', dependsOn: [captureId],
            inputHash: revisionOf({ capture: s.captureKey, imageInputs: snapshot.imageInputs }),
            input: { subject, imageInputs: snapshot.imageInputs },
            reason: 'image-inputs-changed→derive-required',
          });
          summary.actions.push(`从已有原图重新派生 ${subjectKey(subject)} 的发布图`);
        }
      }
      if (subject.type === 'task') for (const boundary of s.boundaries) summary.riskBoundaries.push({ subject: subjectKey(subject), ...boundary });
    }
    if (command === 'capture') return;

    // ---- 文档：(analyze) → draft → (rewrite) → validate → publish
    // 源码语义分析（标题、用途）只影响文档，不阻塞采集。
    const draftDeps = [derived || captureId];
    if (subject.type === 'page' && s.analysis !== ANALYSIS.COMPLETED) {
      draftDeps.push(add({
        id: idOf('analyze', index), kind: 'analyze', dependsOn: [],
        inputHash: revisionOf({ subject, observationRevision: s.observationRevision }),
        input: { subject, analysis: s.analysis },
        retry: { maxAttempts: 3, replay: 'requires-input' },
        reason: s.analysis === 'stale' ? 'source-changed→analyze-required' : 'analysis-missing',
      }));
      summary.waitingFor.push({ node: idOf('analyze', index), input: 'model', message: `页面 ${subject.id} 需要源码语义分析（标题、用途）。` });
    }
    const evidenceNode = derived || captureId;
    const draftId = add({
      id: idOf('draft', index), kind: 'draft', dependsOn: draftDeps,
      inputHash: revisionOf({ subject, evidence: nodes.find((n) => n.id === evidenceNode).inputHash, language: snapshot.language, templateVersion: snapshot.templateVersion }),
      input: { subject, language: snapshot.language, templateVersion: snapshot.templateVersion },
      reason: 'document-required',
    });
    const validateDeps = [draftId];
    if (copy.mode === 'model' || copy.mode === 'file') {
      const rewriteId = add({
        id: idOf('rewrite', index), kind: 'rewrite', dependsOn: [draftId],
        inputHash: revisionOf({ draft: nodes.find((n) => n.id === draftId).inputHash, copy: copy.mode === 'file' ? { mode: 'file', sha256: copy.sha256 } : { mode: 'model' } }),
        input: { subject, copy: copy.mode === 'file' ? { mode: 'file', path: copy.path, sha256: copy.sha256 } : { mode: 'model' } },
        retry: { maxAttempts: 3, replay: copy.mode === 'model' ? 'requires-input' : 'safe' },
        reason: copy.mode === 'model' ? 'copy-from-model' : 'copy-from-file',
      });
      validateDeps.push(rewriteId);
      if (copy.mode === 'model') summary.waitingFor.push({ node: rewriteId, input: 'model', message: `${subjectKey(subject)} 的文案块需要宿主模型填写。` });
    }
    const validateId = add({
      id: idOf('validate', index), kind: 'validate', dependsOn: validateDeps,
      inputHash: revisionOf({ deps: validateDeps.map((id) => nodes.find((n) => n.id === id).inputHash), acceptReview: !!policy.acceptReview }),
      input: { subject, acceptReview: !!policy.acceptReview },
      reason: 'publication-gate',
    });
    add({
      id: idOf('publish', index), kind: 'publish', dependsOn: [validateId],
      inputHash: revisionOf({ validate: nodes.find((n) => n.id === validateId).inputHash, force: !!policy.force }),
      input: { subject, force: !!policy.force },
      retry: { maxAttempts: 3, replay: 'safe' },
      reason: 'publish',
    });
    summary.actions.push(`生成并发布 ${subjectKey(subject)} 的手册`);
  });

  const checked = checkDag(nodes);
  errors.push(...checked.errors);
  const body = {
    version: PLAN_VERSION,
    command,
    targets: snapshot.targets.map((t) => t.ref),
    modelRevision: snapshot.modelRevision,
    copy: copy.mode === 'file' ? { mode: 'file', sha256: copy.sha256 } : { mode: copy.mode },
    tasks: checked.order.map((id) => nodes.find((n) => n.id === id)),
    summary,
  };
  return { plan: body, planHash: revisionOf(body), errors };
}

/** 拓扑排序并检查重复 id、未知依赖与循环。按插入顺序稳定输出。 */
function checkDag(nodes) {
  const errors = [];
  const ids = new Set();
  for (const node of nodes) {
    if (ids.has(node.id)) errors.push(`duplicate-node: ${node.id}`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const dep of node.dependsOn) if (!ids.has(dep)) errors.push(`unknown-dependency: ${node.id} → ${dep}`);
  }
  const order = [];
  const state = new Map();
  const visit = (node, trail) => {
    if (state.get(node.id) === 'done') return;
    if (state.get(node.id) === 'visiting') { errors.push(`dependency-cycle: ${[...trail, node.id].join(' → ')}`); return; }
    state.set(node.id, 'visiting');
    for (const dep of node.dependsOn) {
      const target = nodes.find((n) => n.id === dep);
      if (target) visit(target, [...trail, node.id]);
    }
    state.set(node.id, 'done');
    order.push(node.id);
  };
  for (const node of nodes) visit(node, []);
  return { order: [...new Set(order)], errors };
}

module.exports = { PLAN_VERSION, collectPlanningInputs, plan, checkDag, captureKeyFields, imageInputsOf, subjectKey };
