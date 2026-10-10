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
const { approvalState, approvalMessage, scopeHash, compatiblePageRevisionsFor, pageObservationRevision, APPROVAL_STATES } = require('../model/approval');
const { deriveTaskScenario, derivePageScenario } = require('../scenarios/model');
const { resolveScenario, readScenario, scenariosDirFor } = require('../scenarios/store');
const { readFixture, fixtureRevision, dataRevisionFor } = require('../scenarios/fixtures');
const { checkFixtureAllowed } = require('../scenarios/policy');
const { buildCapturePlan } = require('../tasks/capture-plan');
const { isActivePage, ANALYSIS } = require('../inspect/model');
const { authDisabled, identityRevision } = require('../auth/identity');
const { policyRevision } = require('../publication/validate');
const { RENDERER_VERSION } = require('../evidence/image-pipeline');
const { TEMPLATE_VERSION } = require('../generate/render');
const { DEFAULT_READY_OPTIONS } = require('../browser/provider');
const { capabilitiesFor, missingCapabilities } = require('../browser/capabilities');
const { captureKey } = require('../cache/keys');
const { lookup, offlineMissDescription } = require('../cache/lookup');
const { resolveTarget } = require('./resolve-target');
const { RuntimeError } = require('./errors');
const { taskQuality } = require('../generate/quality');

const PLAN_VERSION = 1;
// 采集语义版本：标注覆盖规则变化（guide/隐式标注优先级、步骤级功能归属）后旧缓存不能复用
const CAPTURE_PIPELINE_VERSION = 'quality-3';
// update 复用 generate 的节点（采集 → 草稿 → 文案 → 门槛 → 发布），目标集合由影响分析给出。
const COMMANDS = ['generate', 'capture', 'update'];
const CAPTURE_CAPABILITIES = ['capture', 'assertions', 'privacyGeometry'];
const TASK_CAPABILITIES = [...CAPTURE_CAPABILITIES, 'semanticActions'];

function browserVersion() {
  try { return `playwright-${require('playwright/package.json').version}`; } catch (_) { return 'unknown'; }
}

/** 任务 / 页面的规划主体；Scenario 变体（空状态、错误态、其他角色）带 @scenarioId，彼此独立。 */
function subjectKey(subject) {
  return `${subject.type}:${subject.id}${subject.scenarioId ? `@${subject.scenarioId}` : ''}`;
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
function captureKeyFields({ config, subject, scenario, sourceHash, captureMode, browser, platform, stateDirAbs = null }) {
  const profile = config.capture.profiles[config.capture.activeProfile];
  const provider = config.browser.providers[config.browser.activeProvider] || {};
  const authProfile = scenario.authProfile || config.auth?.activeProfile;
  return {
    capturePipelineVersion: CAPTURE_PIPELINE_VERSION,
    projectId: config.project.id || config.auth?.cacheKey || config.project.name,
    environment: `${scenario.environment || 'local'}@${new URL(config.project.baseUrl).origin}`,
    deployedBuild: config.runtime?.deployedBuild,
    // live 与 fixture 的采集永不互相命中：fixture 的数据 revision 带 fixture 定义与数据文件的 hash
    dataRevision: scenarioDataRevision(stateDirAbs, scenario),
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

function scenarioDataRevision(stateDirAbs, scenario) {
  if (scenario?.data?.mode !== 'fixture') return scenario?.data?.revision;
  if (!stateDirAbs) return `fixture:${scenario.data.fixture}`;
  try { return dataRevisionFor(stateDirAbs, scenario); } catch (_) { return `fixture:${scenario.data.fixture}:missing`; }
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
  // 显式 Scenario 变体：.manual/scenarios/<id>.yaml 中 id 不同于默认 Scenario 的定义（P3-05）
  const known = new Set(out.map((entry) => entry.id));
  const fs = require('fs');
  const dir = scenariosDirFor(stateDirAbs);
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
      const id = file.slice(0, -'.yaml'.length);
      if (known.has(id)) continue;
      let parsed;
      try { parsed = require('js-yaml').load(fs.readFileSync(require('path').join(dir, file), 'utf8')); } catch (_) { continue; }
      const task = parsed?.userTaskId ? model.tasks.find((t) => t.id === parsed.userTaskId) : null;
      const page = !task && parsed?.entry?.pageId ? model.pages.find((p) => p.id === parsed.entry.pageId) : null;
      if (!task && !page) continue;
      out.push({
        id, variant: true,
        subject: task ? { type: 'task', id: task.id } : { type: 'page', id: page.id },
        stepIds: task ? (task.steps || []).map((s) => s.id) : [],
      });
    }
  }
  return out;
}

/** Scenario 使用的 Fixture：先过环境策略；返回 { id, kind, revision } 或规划错误。 */
function fixtureInputs(stateDirAbs, config, scenario) {
  if (scenario?.data?.mode !== 'fixture') return { fixture: null, errors: [] };
  try {
    const fixture = readFixture(stateDirAbs, scenario.data.fixture);
    checkFixtureAllowed({ fixture, scenario, config });
    return { fixture: { id: fixture.id, kind: fixture.kind, revision: fixtureRevision(fixture) }, errors: [] };
  } catch (error) {
    return { fixture: null, errors: error.errors || [`${error.code || 'fixture-invalid'}: ${error.message}`] };
  }
}

function taskInputs({ task, model, config, scenario }) {
  const approval = approvalState(task, model.pages);
  const built = buildCapturePlan(task, model.pages, { scenario, config });
  const boundaries = built.ok ? built.plan.steps.filter((step) => !step.willExecute).map((step) => ({ stepId: step.id, execution: step.execution, risk: step.risk, reason: step.riskReason })) : [];
  return {
    approval,
    approvalMessage: approval === APPROVAL_STATES.APPROVED ? null : approvalMessage(approval, task.id),
    scopeHash: scopeHash(task, model.pages),
    definitionRevision: definitionRevision('userTask', task),
    pageRevisions: compatiblePageRevisionsFor(task, model.pages, task.lastCapture?.pageRevisions),
    // 审批之外的计划错误（缺页面、断言为空、缺路由参数……）在规划期就报告。
    planErrors: built.ok || approval !== APPROVAL_STATES.APPROVED ? [] : built.errors,
    boundaries,
    executesWrites: built.ok && built.plan.steps.some(s => s.risk === 'write' && s.willExecute),
    stepCount: (task.steps || []).length,
    qualityWarnings: taskQuality(task).warnings.filter((warning) => warning.startsWith('completion-')),
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
    // Scenario 变体是独立的采集主体；默认 Scenario 仍按页面 / 任务本身
    const variantEntry = target.scenarioId ? scenarios.find((item) => item.id === target.scenarioId && item.variant) : null;
    if (variantEntry) target.variantScenarioId = variantEntry.id;
    const key = subjectKey(variantEntry ? { ...target, scenarioId: variantEntry.id } : target);
    if (subjects[key]) continue;
    const entry = scenarios.find((item) => item.subject.type === target.type && item.subject.id === target.id && !item.variant);
    const scenarioResult = variantEntry
      ? (() => { const read = readScenario(stateDirAbs, variantEntry.id, { stepIds: variantEntry.stepIds }); return read.ok ? { ok: true, scenario: read.scenario, explicit: true } : read; })()
      : resolveScenario(stateDirAbs, entry.derived, { stepIds: entry.stepIds });
    if (!scenarioResult.ok) throw new RuntimeError('invalid-scenario', scenarioResult.errors.join('；'));
    const scenario = scenarioResult.scenario;
    const fixtureInfo = fixtureInputs(stateDirAbs, config, scenario);
    const entity = target.type === 'task' ? model.tasks.find((t) => t.id === target.id) : model.pages.find((p) => p.id === target.id);
    const details = target.type === 'task' ? taskInputs({ task: entity, model, config, scenario }) : pageInputs({ page: entity });
    const sourceHash = target.type === 'task'
      ? revisionOf({ scopeHash: details.scopeHash, pageRevisions: details.pageRevisions })
      : details.observationRevision;
    const keyFields = captureKeyFields({ config, subject: target, scenario, sourceHash, captureMode: target.type === 'task' ? 'task-steps' : 'viewport', browser, platform, stateDirAbs });
    const keyInfo = captureKey(keyFields);
    let cache = null;
    if (cacheStore) {
      const found = lookup({
        store: cacheStore, keyInfo, subject: `capture:${key}`, mode, projectRoot, stateDirAbs,
        requiredScopes: ['page-identity'], privacy: { audience: config.privacy?.audience || 'public' },
        cachePolicy: config.cache, requireAnnotation: true, now,
      });
      cache = found.hit
        ? { hit: true, reusedFrom: found.reusedFrom, observedAt: found.observedAt, stale: found.stale, uncertainty: found.uncertainty, imageInputs: found.entry.meta?.imageInputs || null, outputRefs: found.outputRefs }
        : { hit: false, reason: found.reason || null, bypassed: found.bypassed || null, changedFields: found.changedFields || null };
    }
    subjects[key] = {
      subject: { type: target.type, id: target.id, ...(variantEntry ? { scenarioId: variantEntry.id } : {}) },
      scenario: { id: scenario.id, revision: scenario.revision, authProfile: scenario.authProfile, explicit: scenarioResult.explicit },
      scenarioDefinition: scenario,
      fixture: fixtureInfo.fixture,
      captureKey: keyInfo.key,
      captureKeyInput: keyInfo.input,
      captureUncertainty: keyInfo.uncertainty,
      cache,
      ...details,
      planErrors: [...(details.planErrors || []), ...fixtureInfo.errors],
    };
  }
  return {
    version: PLAN_VERSION,
    modelRevision: base.modelRevision,
    capturePipelineVersion: CAPTURE_PIPELINE_VERSION,
    projectId: config.project.id || null,
    language: config.docs.language,
    templateVersion: TEMPLATE_VERSION,
    imageInputs: imageInputsOf(config),
    capabilities: capabilitiesFor(provider, config.browser.activeProvider),
    auth: { enabled: config.auth?.enabled !== false, verifyPath: config.auth?.verifyPath || null,
      hasAssertions: !!config.auth?.identityAssertions?.length },
    mode: { name: mode.name, browserAllowed: mode.browserAllowed },
    targets: resolved.map((target) => ({ type: target.type, id: target.id, ref: target.ref, key: subjectKey(target.variantScenarioId ? { ...target, scenarioId: target.variantScenarioId } : target), ...(target.scenarioId ? { scenarioId: target.scenarioId } : {}), ...(target.manualId ? { manualId: target.manualId } : {}) })),
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
  const summary = { actions: [], browserScenarios: 0, riskBoundaries: [], cache: [], waitingFor: [], warnings: [] };
  const captureByKey = new Map();
  const multi = snapshot.targets.length > 1;
  const idOf = (kind, index) => (multi ? `${kind}-t${index + 1}` : kind);
  const add = (node) => { nodes.push({ retry: { maxAttempts: 3, replay: 'safe' }, reuse: null, ...node }); return node.id; };

  snapshot.targets.forEach((target, index) => {
    const s = snapshot.subjects[target.key || subjectKey(target)];
    const subject = s.subject;
    if (command !== 'capture' && target.scenarioId) errors.push(`scenario 目标只用于 capture：${target.ref}`);
    errors.push(...s.planErrors);
    for (const warning of s.qualityWarnings || []) summary.warnings.push(`${subjectKey(subject)}：${warning}`);
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
    // ---- 认证预检：缓存命中时 handler 直接跳过；缓存执行前失效时也会在线检查。
    // 节点始终存在，避免缓存状态变化导致 resume 的 DAG 输入漂移。
    let authId = null;
    const authProfile = s.scenario.authProfile;
    if (snapshot.auth?.enabled && authProfile !== 'anonymous' && snapshot.auth.verifyPath && snapshot.auth.hasAssertions) {
      authId = add({
        id: idOf('auth-check', index), kind: 'auth-check', dependsOn: gateDeps.slice(),
        inputHash: revisionOf({ subject, captureKey: s.captureKey, authProfile, verifyPath: snapshot.auth.verifyPath }),
        input: { subject, authProfile, captureKey: s.captureKey },
        retry: { maxAttempts: 1, replay: 'safe' }, reason: 'auth-before-browser-if-cache-misses',
      });
    } else if (snapshot.auth?.enabled && authProfile !== 'anonymous' && !s.cache?.hit && snapshot.mode.browserAllowed) {
      summary.warnings.push(`${subjectKey(subject)}：缺少 auth.verifyPath 或 auth.identityAssertions；运行时只能检测登录跳转，不能提前确认身份。`);
    }
    // ---- fixture-setup（hook 类 Fixture：独立任务，写入按 Run 划分的测试数据；cleanup 在采集结束后无论成败都执行）
    let setupId = null;
    // 计划不随缓存命中与否改变形状（resume 时按原计划比较输入）：hook Fixture 总是先准备、后清理
    if (s.fixture?.kind === 'hook' && !captureByKey.get(s.captureKey)) {
      setupId = add({
        id: idOf('fixture-setup', index), kind: 'fixture-setup', dependsOn: [...gateDeps, ...(authId ? [authId] : [])],
        inputHash: revisionOf({ fixture: s.fixture, scenario: s.scenario.id, subject }),
        input: { subject, fixture: s.fixture, scenarioId: s.scenario.id },
        // setup 写测试数据：中断后结果不明，不盲目重放（cleanup 按命名空间清理）
        retry: { maxAttempts: 1, replay: 'unsafe' },
        reason: `fixture-setup:${s.fixture.id}`,
      });
      summary.actions.push(`准备测试数据 ${s.fixture.id}（Scenario ${s.scenario.id}）`);
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
        id: idOf('capture', index), kind: 'capture', dependsOn: [...gateDeps, ...(authId ? [authId] : []), ...(setupId ? [setupId] : [])],
        inputHash: revisionOf({ captureKey: s.captureKey, subject }),
        input: {
          subject, captureKey: s.captureKey, scenario: s.scenario,
          ...(subject.type === 'task' ? { scopeHash: s.scopeHash, definitionRevision: s.definitionRevision, pageRevisions: s.pageRevisions } : { observationRevision: s.observationRevision }),
        },
        reuse,
        retry: s.executesWrites ? { maxAttempts: 1, replay: 'requires-input' } : { maxAttempts: 3, replay: 'safe' },
        reason,
      });
      captureByKey.set(s.captureKey, captureId);
      summary.cache.push({ node: captureId, subject: subjectKey(subject), hit: !!cache?.hit, reason, observedAt: reuse?.observedAt || null, uncertainty: s.captureUncertainty });
      if (!reuse) {
        if (!snapshot.mode.browserAllowed) errors.push(`cache-miss-offline: ${subjectKey(subject)} ${offlineMissDescription(cache, subjectKey(subject))}`);
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
      if (setupId) {
        add({
          id: idOf('fixture-cleanup', index), kind: 'fixture-cleanup', dependsOn: [], after: [setupId, captureId],
          inputHash: revisionOf({ fixture: s.fixture, scenario: s.scenario.id, subject, cleanup: true }),
          input: { subject, fixture: s.fixture, scenarioId: s.scenario.id },
          // 清理按命名空间幂等：中断后可以安全重放
          retry: { maxAttempts: 3, replay: 'safe' },
          reason: `fixture-cleanup:${s.fixture.id}`,
        });
        summary.actions.push(`清理测试数据 ${s.fixture.id}`);
      }
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
    // resume --replan 用同一策略重新规划；缓存模式也记在这里，恢复时沿用。
    policy: { copy, acceptReview: !!policy.acceptReview, force: !!policy.force, mode: snapshot.mode.name },
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
    for (const dep of [...node.dependsOn, ...(node.after || [])]) if (!ids.has(dep)) errors.push(`unknown-dependency: ${node.id} → ${dep}`);
  }
  const order = [];
  const state = new Map();
  const visit = (node, trail) => {
    if (state.get(node.id) === 'done') return;
    if (state.get(node.id) === 'visiting') { errors.push(`dependency-cycle: ${[...trail, node.id].join(' → ')}`); return; }
    state.set(node.id, 'visiting');
    for (const dep of [...node.dependsOn, ...(node.after || [])]) {
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
