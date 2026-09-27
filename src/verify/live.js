'use strict';

/*
 * 在线验证 verify --live（P3-03）。
 *
 * 对一份已发布手册，按它的 ManualSection → Scenario / 检查点关系真实回放：
 *   打开页面（每次都真实导航，不从旧 Capture 或缓存返回结果）→ 导航 / 页面身份检查 →
 *   任务步骤：动作前状态 → 安全动作 → 动作后断言 → 用本次断言重新计算完成声明（claim）。
 * 写 / 破坏性步骤默认不执行：对应 claim 为 not_run，报告验证覆盖比例和停止边界。
 *
 * 与采集不同：断言逐条收集结果（不在第一条失败就放弃其余检查），失败按原因分类
 * （404 / UI 名称变化 / 目标消失 / 身份不符 / 状态变化 / 网络不可达），网络类只能是 inconclusive。
 * 不写截图、不改 Capture / 发布记录 / 任务状态；只追加一份不可变验证报告。
 */

const path = require('path');

const { createProjectStore } = require('../store/project');
const { normalizePage, isActivePage } = require('../inspect/model');
const { derivePageScenario, deriveTaskScenario } = require('../scenarios/model');
const { resolveScenario } = require('../scenarios/store');
const { buildCapturePlan, implicitDefaultState } = require('../tasks/capture-plan');
const { resolveRoute, joinUrl } = require('../evidence/capture-page');
const { validateNavigation, assertWithin, DEFAULT_ASSERTION_TIMEOUT_MS } = require('../evidence/validate-page');
const { computeClaims } = require('../evidence/claims');
const { prepareAuth, classifyAuthFailure } = require('../auth/runtime');
const { definitionRevision } = require('../model/revision');
const releases = require('../publication/release-store');
const { sectionsOf } = require('../generate/manual-model');
const { RuntimeError } = require('../runtime/errors');
const { classify, overall } = require('./report');

function codeOf(error) {
  return error?.reason || error?.code || 'navigation-failed';
}

function check(id, scope, outcome, extra = {}) {
  return { id, scope, outcome, checkedAt: new Date().toISOString(), ...extra };
}

function failedCheck(id, scope, error, extra = {}) {
  const code = codeOf(error);
  const c = classify(code);
  return check(id, scope, c.outcome, { code, category: c.category, message: String(error?.message || error).slice(0, 300), ...(c.needsInput ? { needsInput: true } : {}), ...extra });
}

/** 逐条执行断言并收集结果（不在第一条失败时中止）。 */
async function collectAssertions(provider, assertions, { scope, idPrefix, phase = null, stepId = null, timeoutMs }) {
  const out = [];
  for (const [index, assertion] of (assertions || []).entries()) {
    const assertionId = assertion.id || `${idPrefix}#${index}`;
    try {
      await assertWithin(provider, assertion, { timeoutMs });
      out.push(check(`assert:${assertionId}${stepId ? `@${stepId}` : ''}`, scope, 'passed', { assertionId, type: assertion.type, phase, stepId }));
    } catch (error) {
      out.push(failedCheck(`assert:${assertionId}${stepId ? `@${stepId}` : ''}`, scope, error, { assertionId, type: assertion.type, phase, stepId }));
    }
  }
  return out;
}

/** 打开入口并验证导航；失败时返回 null（原因已写入 checks）。 */
async function openEntry(provider, url, expected, checks, auth) {
  let openResult;
  try {
    openResult = await provider.open(url);
    await provider.waitUntilReady();
  } catch (error) {
    checks.push(failedCheck('navigation', 'page-identity', classifyAuthFailure(error, auth)));
    return null;
  }
  const observation = provider.currentObservation ? await provider.currentObservation() : null;
  try {
    const navigation = validateNavigation({ requestedUrl: url, openResult, observation, expected });
    for (const v of navigation.validations) checks.push(check(`navigation:${v.check}`, v.scope, 'passed', { detail: v.actualRoute || v.status || v.actual || null }));
    return navigation;
  } catch (error) {
    checks.push(failedCheck('navigation', 'page-identity', classifyAuthFailure(error, auth)));
    return null;
  }
}

function loadSubject(projectRoot, config, target) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const store = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
  const committed = store.readCommitted() || store.load();
  const model = committed.model;
  const manualId = releases.manualIdFor(target.type, target.id);
  const release = releases.readCurrentRelease(stateDirAbs, manualId);
  if (!release) throw new RuntimeError('not-published', `${target.type}:${target.id} 还没有发布记录，没有可验证的手册（先 manual generate）。`);
  const entity = target.type === 'task' ? model.tasks.find((t) => t.id === target.id) : model.pages.find((p) => p.id === target.id);
  if (!entity) throw new RuntimeError('unknown-target', `找不到 ${target.type}:${target.id}。`);
  return { stateDirAbs, model, manualId, release, entity };
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config
 * @param {{ type:'page'|'task', id }} p.target
 * @param {object} p.session       BrowserSession（同一次 verify 复用 Browser，每个 Scenario 独立 Context）
 * @param {number} [p.timeoutMs]
 * @returns {Promise<object>} 报告主体（未落盘）
 */
async function verifyLive({ projectRoot, config, target, session, timeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS }) {
  const startedAt = new Date().toISOString();
  const { stateDirAbs, model, manualId, release, entity } = loadSubject(projectRoot, config, target);
  const profileId = config.capture.activeProfile;
  const providerId = config.browser.activeProvider;
  const profile = config.capture.profiles[profileId];
  const providerConfig = config.browser.providers[providerId];
  const checks = [];
  let scenario;
  let steps = [];
  let claims = [];
  let url;
  let expected = {};
  let identityAssertions = [];
  let plan = null;

  if (target.type === 'page') {
    const page = normalizePage(entity);
    if (!isActivePage(page)) throw new RuntimeError('page-not-active', `页面 ${page.id} 当前是 ${page.lifecycle}：手册需要下线或更新，不能在线验证。`);
    const resolved = resolveScenario(stateDirAbs, derivePageScenario(page, config), { stepIds: [] });
    if (!resolved.ok) throw new RuntimeError('invalid-scenario', resolved.errors.join('；'));
    scenario = resolved.scenario;
    const route = resolveRoute(page.route, scenario.entry?.params || page.params || {});
    if (!route.ok) throw new RuntimeError('invalid-arguments', `页面 ${page.id} 缺少路由参数：${route.missing.join(', ')}`);
    url = joinUrl(config.project.baseUrl, route.route);
    expected = { statuses: scenario.expected?.httpStatuses, state: scenario.expected?.state };
    identityAssertions = (page.states?.default?.assertions || implicitDefaultState(page).assertions || []).filter((a) => a.type !== 'url');
  } else {
    const task = entity;
    const resolved = resolveScenario(stateDirAbs, deriveTaskScenario(task, model.pages, config), { stepIds: (task.steps || []).map((s) => s.id) });
    if (!resolved.ok) throw new RuntimeError('invalid-scenario', resolved.errors.join('；'));
    scenario = resolved.scenario;
    const built = buildCapturePlan(task, model.pages, { scenario });
    if (!built.ok) throw new RuntimeError(built.code === 'scope-changed' ? 'scope-changed' : 'invalid-plan', built.errors.join('；'));
    plan = built.plan;
    url = joinUrl(config.project.baseUrl, plan.entry.route);
    expected = plan.entry.expected || {};
    identityAssertions = (plan.entry.assertions || []).filter((a) => a.type !== 'url');
  }

  const auth = prepareAuth(config, { profile: scenario.authProfile });
  const work = async (provider) => {
    const navigation = await openEntry(provider, url, expected, checks, auth);
    if (!navigation) return { stepRecords: [] };
    checks.push(...await collectAssertions(provider, identityAssertions, { scope: 'page-identity', idPrefix: `${target.id}:default`, timeoutMs }));
    const identityOk = !checks.some((c) => c.outcome !== 'passed');
    const stepRecords = [];
    if (!plan) return { stepRecords };
    let stopped = identityOk ? null : 'identity-failed';
    for (const step of plan.steps) {
      const record = { id: step.id, status: null, validations: [] };
      stepRecords.push(record);
      if (stopped) { record.status = 'not-executed'; record.reason = stopped; continue; }
      if (!step.willExecute) {
        // 写 / 破坏性步骤：在线验证不执行，之后的步骤也不执行
        record.status = 'not-executed';
        record.reason = step.execution;
        stopped = 'skipped-by-boundary';
        continue;
      }
      const before = await collectAssertions(provider, step.beforeState?.assertions || [], { scope: 'scenario-state', phase: 'before', stepId: step.id, idPrefix: `${step.page}:${step.stateBefore}`, timeoutMs });
      checks.push(...before);
      if (before.some((c) => c.outcome !== 'passed')) { record.status = 'failed'; stopped = 'blocked-by-failure'; continue; }
      try {
        await provider.performAction(step.action);
        await provider.waitUntilReady();
        checks.push(check(`action:${step.id}`, 'interaction', 'passed', { stepId: step.id, action: step.action?.type || null }));
      } catch (error) {
        checks.push(failedCheck(`action:${step.id}`, 'interaction', error, { stepId: step.id, action: step.action?.type || null, target: step.action?.target?.name || null }));
        record.status = 'failed';
        stopped = 'blocked-by-failure';
        continue;
      }
      const after = await collectAssertions(provider, step.expectedState?.assertions || [], { scope: 'scenario-state', phase: 'after', stepId: step.id, idPrefix: `${step.page}:${step.expectedState?.id || step.stateBefore}`, timeoutMs });
      checks.push(...after);
      record.validations = after.map((c) => ({ assertionId: c.assertionId, phase: 'after', outcome: c.outcome === 'passed' ? 'passed' : 'failed', scope: c.scope, checkedAt: c.checkedAt }));
      record.status = after.some((c) => c.outcome !== 'passed') ? 'failed' : 'executed';
      if (record.status === 'failed') stopped = 'blocked-by-failure';
    }
    return { stepRecords };
  };

  let value;
  try {
    value = (await session.withScenario({ id: providerId, providerConfig, profile, auth }, work)).value;
  } catch (error) {
    checks.push(failedCheck('session', 'page-identity', error));
    value = { stepRecords: [] };
  }
  steps = value.stepRecords;

  if (target.type === 'task') {
    const evidence = {
      validations: checks.filter((c) => c.scope === 'page-identity' && c.assertionId).map((c) => ({ assertionId: c.assertionId, outcome: c.outcome === 'passed' ? 'passed' : 'failed', scope: c.scope, checkedAt: c.checkedAt })),
      steps: steps.map((s) => ({ id: s.id, validations: s.validations })),
    };
    const live = computeClaims(entity, evidence);
    const published = new Map((release.facts?.claims || []).map((c) => [c.id, c.status]));
    claims = live.map((c) => {
      const releaseStatus = published.get(c.id) || null;
      let outcome;
      if (c.status === 'verified') outcome = 'passed';
      else if (c.status === 'failed') outcome = 'failed';
      // 发布时已验证的声明现在无法回放：不是通过，也不能冒充产品回归
      else if (releaseStatus === 'verified') outcome = checks.some((x) => x.outcome === 'failed') ? 'failed' : 'inconclusive';
      else outcome = 'not_run';
      return { id: c.id, text: c.text, releaseStatus, liveStatus: c.status, outcome };
    });
  }

  const executed = steps.filter((s) => s.status === 'executed').length;
  const boundary = steps.find((s) => s.status === 'not-executed');
  const coverage = {
    claims: {
      total: claims.length,
      verified: claims.filter((c) => c.outcome === 'passed').length,
      failed: claims.filter((c) => c.outcome === 'failed').length,
      notRun: claims.filter((c) => c.outcome === 'not_run' || c.outcome === 'inconclusive').length,
    },
    steps: { total: steps.length, executed, notExecuted: steps.filter((s) => s.status === 'not-executed').length },
    stoppedAt: boundary ? { stepId: boundary.id, reason: boundary.reason } : null,
    identityChecks: checks.filter((c) => c.scope === 'page-identity').length,
  };
  const sections = sectionResults(release, target, checks, steps, claims);
  const result = overall(checks, claims.filter((c) => c.outcome !== 'not_run'));
  return {
    kind: 'live',
    manualId,
    releaseId: release.id,
    target: `${target.type}:${target.id}`,
    startedAt,
    finishedAt: new Date().toISOString(),
    onlineChecked: true,
    inputRevisions: {
      definitionRevision: definitionRevision(target.type === 'task' ? 'userTask' : 'page', entity),
      releaseDefinitionRevision: release.definitionRevisions?.[target.id] || null,
      scenarioId: scenario.id,
      scenarioRevision: scenario.revision,
      documentHash: release.documentHash,
    },
    environment: {
      origin: new URL(config.project.baseUrl).origin,
      profile: profileId,
      provider: providerId,
      authProfile: scenario.authProfile || null,
      deployedBuild: config.runtime?.deployedBuild || 'unknown',
    },
    checks,
    steps: steps.map(({ id, status, reason }) => ({ id, status, ...(reason ? { reason } : {}) })),
    claims,
    sections,
    coverage,
    result,
  };
}

/** 把检查结果归到手册章节：页面身份 → overview / location；步骤 → step.<id>；claim → completion。 */
function sectionResults(release, target, checks, steps, claims) {
  const summarize = (list) => (list.length === 0 ? 'not_run' : overall(list, []));
  const identity = checks.filter((c) => c.scope === 'page-identity' || c.id === 'session');
  return sectionsOf(release).map((section) => {
    let outcome;
    if (section.kind === 'step') {
      const stepId = section.id.slice('step.'.length);
      const related = checks.filter((c) => c.stepId === stepId);
      const step = steps.find((s) => s.id === stepId);
      outcome = step?.status === 'not-executed' ? 'not_run' : summarize(related);
    } else if (section.kind === 'completion') {
      outcome = claims.length ? overall([], claims.filter((c) => c.outcome !== 'not_run')) : 'not_run';
      if (claims.length && claims.every((c) => c.outcome === 'not_run')) outcome = 'not_run';
    } else if (['overview', 'location'].includes(section.kind)) {
      outcome = summarize(identity);
    } else {
      outcome = 'not_run';
    }
    return { id: section.id, kind: section.kind, outcome };
  });
}

module.exports = { verifyLive, collectAssertions, sectionResults };
