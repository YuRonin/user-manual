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

const fs = require('fs');
const path = require('path');

const { createProjectStore } = require('../store/project');
const { normalizePage, isActivePage } = require('../inspect/model');
const { derivePageScenario, deriveTaskScenario, resolveEntryLocation } = require('../scenarios/model');
const { resolveScenario } = require('../scenarios/store');
const { buildCapturePlan, implicitDefaultState } = require('../tasks/capture-plan');
const { joinUrl } = require('../evidence/capture-page');
const { validateNavigation, assertWithin, DEFAULT_ASSERTION_TIMEOUT_MS } = require('../evidence/validate-page');
const { computeClaims } = require('../evidence/claims');
const { prepareAuth, classifyAuthFailure } = require('../auth/runtime');
const { definitionRevision } = require('../model/revision');
const releases = require('../publication/release-store');
const { sectionsOf } = require('../generate/manual-model');
const { RuntimeError } = require('../runtime/errors');
const { classify, overall } = require('./report');
const { createCaptureStore } = require('../evidence/store');
const { captureStable, derivePublished } = require('../evidence/capture-safe');
const { RENDERER_VERSION } = require('../evidence/image-pipeline');
const { policyRevision } = require('../publication/validate');
const { compareSemantic } = require('./semantic-diff');
const { environmentCompatible, applicableMasks, compareImages } = require('./visual-diff');
const { newUuid } = require('../model/ids');

const DRIFT_ORDER = ['behavior-breaking', 'content-changed', 'visual-only', 'environment-incompatible', 'inconclusive', 'none'];

function scaleRect(rect, dpr) {
  return { x: Math.floor(rect.x * dpr), y: Math.floor(rect.y * dpr), width: Math.ceil(rect.width * dpr), height: Math.ceil(rect.height * dpr) };
}

/**
 * 页面手册的语义 / 视觉漂移：与发布时的 Capture 比较（基线只来自已发布的已验证采集，不自动接受新图）。
 * 当前图走与发布相同的派生管线（同隐私策略 / 渲染器）生成到临时目录，比较后删除原图与中间产物。
 */
async function pageDrift({ provider, projectRoot, config, stateDirAbs, release, identityAssertions, reportId }) {
  const out = { semantic: { status: 'baseline-missing' }, visual: { status: 'not-compared', reasons: [] }, warnings: [] };
  const captureId = (release.captureIds || [])[0];
  let baseline = null;
  try { baseline = captureId ? createCaptureStore({ projectRoot, stateDirAbs }).read(captureId) : null; } catch (_) { baseline = null; }
  const current = provider.semanticSnapshot ? await provider.semanticSnapshot() : null;
  out.semantic = compareSemantic(baseline?.semantic || null, current);
  if (!baseline) { out.visual.reasons.push('baseline-capture-missing'); return out; }
  const published = (baseline.artifacts || []).find((a) => a.kind === 'published');
  if (!published || !fs.existsSync(path.join(projectRoot, published.path))) { out.visual.reasons.push('baseline-image-missing'); return out; }
  const env = provider.environmentInfo ? provider.environmentInfo({ fullPage: !!baseline.spec?.fullPage }) : null;
  const compat = environmentCompatible(baseline.environment || null, env);
  if (!compat.ok) { out.visual = { status: 'environment-incompatible', reasons: compat.mismatches }; return out; }
  const versions = [];
  if (baseline.provenance?.rendererVersion && baseline.provenance.rendererVersion !== RENDERER_VERSION) versions.push(`rendererVersion: ${baseline.provenance.rendererVersion} → ${RENDERER_VERSION}`);
  if (baseline.privacy?.policyRevision && baseline.privacy.policyRevision !== policyRevision(config)) versions.push('privacy-policy-changed');
  if (versions.length) { out.visual = { status: 'baseline-incompatible', reasons: versions }; return out; }

  const work = path.join(stateDirAbs, 'verifications', `.work-${reportId}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const format = config.artifacts.format || 'png';
    const rawPath = path.join(work, `raw.${format}`);
    const captured = await captureStable(provider, { rawPath, fullPage: !!baseline.spec?.fullPage, format });
    const safe = await derivePublished({
      captured, rawPath,
      sanitizedPath: path.join(work, 'sanitized.png'),
      publishedPath: path.join(work, 'published.png'),
      theme: config.annotation.themes[config.annotation.activeTheme],
      redactionRules: config.privacy || {},
    });
    if (!safe.published) { out.visual = { status: 'not-compared', reasons: ['privacy-not-passed'] }; return out; }
    const dpr = env.dpr || 1;
    const regions = config.verify?.visual?.dynamicRegions || [];
    const masks = [];
    for (const region of regions) {
      const rect = provider.rectOf ? await provider.rectOf(region.selector) : null;
      if (rect) masks.push({ id: region.id || region.selector, rect });
    }
    const critical = [];
    for (const assertion of identityAssertions) {
      const rect = assertion.target && provider.rectOf ? await provider.rectOf(assertion.target, { content: true }) : null;
      if (rect) critical.push({ id: assertion.id || assertion.target.name || 'assertion', rect });
    }
    const { used, refused } = applicableMasks(masks, critical);
    for (const r of refused) out.warnings.push(`critical-region-not-masked: 动态区域 ${r.id} 与断言目标 ${r.overlaps} 重叠，关键区域不能被忽略。`);
    const diffPath = path.join(stateDirAbs, 'verifications', `${reportId}-visual-diff.png`);
    const compared = await compareImages({
      baseline: path.join(projectRoot, published.path),
      current: path.join(work, 'published.png'),
      masks: used.map((m) => scaleRect(m.rect, dpr)),
      tolerance: config.verify?.visual?.tolerance,
      threshold: config.verify?.visual?.threshold,
      diffPath,
    });
    out.visual = {
      ...compared,
      diffPath: compared.diffPath ? path.relative(projectRoot, compared.diffPath).replace(/\\/g, '/') : null,
      masks: used.map((m) => m.id),
      refusedMasks: refused,
      baselineCaptureId: baseline.id,
    };
    return out;
  } finally {
    // 原图未脱敏：比较结束立即删除，只保留基于发布图的差异 PNG
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 漂移分类：行为失败优先，其次语义内容，再次视觉。 */
function classifyDrift({ behaviorFailed, semantic, visual }) {
  if (behaviorFailed) return 'behavior-breaking';
  if (semantic?.status === 'changed') return 'content-changed';
  if (visual && ['changed', 'size-changed'].includes(visual.status)) return 'visual-only';
  if (visual && ['environment-incompatible', 'baseline-incompatible'].includes(visual.status)) return 'environment-incompatible';
  if (!semantic || ['baseline-missing', 'unavailable'].includes(semantic.status)) return 'inconclusive';
  return 'none';
}

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
async function verifyLive({ projectRoot, config, target, session, timeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS, drift: driftEnabled = true }) {
  const startedAt = new Date().toISOString();
  const reportId = newUuid();
  let drift = null;
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
    // 与采集相同的入口解析：显式 Scenario 的 path / query 打开同一条具体内容
    const entry = scenario.entry?.path !== undefined || scenario.entry?.params ? scenario.entry : { ...scenario.entry, params: page.params || {} };
    const route = resolveEntryLocation(page.route, entry);
    if (!route.ok) throw new RuntimeError('invalid-arguments', `页面 ${page.id} 的入口无法解析：${[...route.missing, ...route.invalid].join(', ')}`);
    url = joinUrl(config.project.baseUrl, route.route) + route.search;
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
    url = joinUrl(config.project.baseUrl, plan.entry.route) + (plan.entry.search || '');
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
    if (!plan) {
      if (driftEnabled && identityOk) {
        try {
          drift = await pageDrift({ provider, projectRoot, config, stateDirAbs, release, identityAssertions, reportId });
        } catch (error) {
          drift = { semantic: { status: 'unavailable' }, visual: { status: 'not-compared', reasons: [`${error.code || 'error'}: ${error.message}`] }, warnings: [] };
        }
      }
      return { stepRecords };
    }
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
      const required = await collectAssertions(provider, step.requires || [], { scope: 'scenario-state', phase: 'before', stepId: step.id, idPrefix: `${step.id}:requires`, timeoutMs });
      checks.push(...required);
      if (required.some(c => c.outcome !== 'passed')) { record.status = 'failed'; stopped = 'precondition-failed'; continue; }
      try {
        const actionResult = await provider.performAction(step.action);
        if (actionResult?.resolution?.fallback) checks.push(check(`locator:${step.id}`, 'interaction', 'inconclusive', { stepId: step.id, reason: 'locator-fallback-used' }));
        await provider.waitUntilReady({ networkIdleTimeout: 1500 });
        checks.push(check(`action:${step.id}`, 'interaction', 'passed', { stepId: step.id, action: step.action?.type || null }));
      } catch (error) {
        checks.push(failedCheck(`action:${step.id}`, 'interaction', error, { stepId: step.id, action: step.action?.type || null, target: step.action?.target?.name || null }));
        record.status = 'failed';
        stopped = 'blocked-by-failure';
        continue;
      }
      const after = await collectAssertions(provider, step.expectedState?.assertions || [], { scope: 'scenario-state', phase: 'after', stepId: step.id, idPrefix: `${step.pageAfter || step.page}:${step.expectedState?.id || step.stateBefore}`, timeoutMs });
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
  let result = overall(checks, claims.filter((c) => c.outcome !== 'not_run'));
  const behaviorFailed = result === 'failed';
  const driftReport = {
    classification: classifyDrift({ behaviorFailed, semantic: drift?.semantic || (target.type === 'task' ? { status: 'same' } : null), visual: drift?.visual || null }),
    semantic: drift?.semantic || null,
    visual: drift?.visual || null,
    warnings: drift?.warnings || [],
    // 基线只来自已发布的采集；验证发现差异不会自动接受新图（需要重新 generate / update 并通过发布门槛）
    baselineAccepted: false,
  };
  // 语义内容变化：行为断言仍通过也说明手册可能过期 → drift；视觉差异不能否定已验证行为，语义失败也不能被"图很像"覆盖
  if (result === 'passed' && driftReport.classification === 'content-changed') result = 'drift';
  return {
    id: reportId,
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
    drift: driftReport,
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

module.exports = { verifyLive, collectAssertions, sectionResults, classifyDrift, DRIFT_ORDER };
