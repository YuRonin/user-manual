'use strict';

const fs = require('fs');
const path = require('path');
const { writeText } = require('../util/fsx');
const { sha256Hex } = require('../util/hash');
const { captureStable, derivePublished } = require('../evidence/capture-safe');
const { createCaptureStore, sanitizeUrl } = require('../evidence/store');
const { revisionOf } = require('../util/hash');
const { validateNavigation, runAssertions, isUrlOnly, DEFAULT_ASSERTION_TIMEOUT_MS } = require('../evidence/validate-page');
const { errorCode } = require('../runtime/errors');
const { derivationSidecar } = require('../evidence/capture-page');

class TaskExecutionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskExecutionError';
    this.code = code;
    Object.assign(this, details);
  }
}

function joinUrl(baseUrl, route) {
  return `${String(baseUrl).replace(/\/$/, '')}/${String(route || '/').replace(/^\//, '')}`;
}

async function diagnosticScreenshot(provider, stateDir, plan, step) {
  const file = path.join(stateDir, 'artifacts', 'diagnostics', `${plan.taskId}--${step.id}--failure.png`);
  await provider.screenshot({ path: file, format: 'png' });
  return file;
}

/**
 * 截图时刻解析标注目标：after 截图必须重新定位，不能沿用动作前的旧矩形。
 * 目标找不到时返回 annotation-target-missing（需要在 capture.annotations 里另指定目标）。
 */
function annotationResolver(provider, step) {
  return async () => {
    const out = [];
    for (const annotation of step.capture?.annotations || []) {
      if (annotation.rect) { out.push({ label: annotation.label, rect: annotation.rect }); continue; }
      const target = annotation.target === 'action.target' ? step.action?.target : annotation.target;
      if (!target) continue;
      try {
        const located = await provider.performAction({ type: 'inspect', target });
        if (!located?.rect) throw new Error('目标没有可用几何。');
        out.push({ label: annotation.label, rect: located.rect });
      } catch (error) {
        throw Object.assign(new Error(`步骤 ${step.id} 的标注目标在截图时不可见：${error.message}`), { code: 'annotation-target-missing' });
      }
    }
    return out;
  };
}

/**
 * 一次截图 = 一条不可变 Capture 记录。文件先写本次 staging，派生完成后按内容寻址安装，
 * 记录最后可见；返回值是记录的兼容投影（旧 evidence manifest 的 screenshot 条目）。
 */
async function takeScreenshot(provider, stateDir, plan, step, timing, options = {}, validations = []) {
  const projectRoot = options.projectRoot || path.dirname(stateDir);
  const store = createCaptureStore({ projectRoot, stateDirAbs: stateDir });
  const staging = store.begin();
  const prefix = `${plan.taskId}--${step.id}--${timing}`;
  const rawPath = staging.file('raw.png');
  const publish = provider.collectSensitiveElements && options.projectRoot && options.annotatedDir;
  try {
    const captured = await captureStable(provider, { rawPath, resolveTargets: publish ? annotationResolver(provider, step) : async () => [] });
    const stateRelative = path.relative(projectRoot, stateDir).replace(/\\/g, '/') || '.';
    const artifacts = [{ kind: 'raw', file: rawPath, dir: `${stateRelative}/artifacts/raw`, prefix }];
    let safe = null;
    if (publish) {
      // 派生输入私有保存：隐私规则 / 主题变化时可从同一份 raw 重新派生，不必重新执行任务。
      fs.writeFileSync(staging.file('derivation.json'), derivationSidecar(captured));
      artifacts.push({ kind: 'derivation', file: staging.file('derivation.json'), dir: `${stateRelative}/artifacts/derivation`, prefix });
      safe = await derivePublished({
        captured, rawPath, sanitizedPath: staging.file('sanitized.png'), publishedPath: staging.file('published.png'),
        theme: options.theme, redactionRules: options.redactionRules || {},
      });
      artifacts.push({ kind: 'sanitized', file: staging.file('sanitized.png'), dir: `${stateRelative}/artifacts/sanitized`, prefix });
      if (safe.published) artifacts.push({ kind: 'published', file: staging.file('published.png'), dir: options.annotatedDir, prefix });
    }
    const meta = captured.shot.meta || {};
    const spec = { viewport: meta.viewport || null, dpr: meta.deviceScaleFactor || null, fullPage: !!meta.fullPage };
    const record = store.commit(staging, {
      artifacts,
      record: {
        kind: 'task-step',
        subject: { taskId: plan.taskId, stepId: step.id, timing },
        runId: null,
        scenarioId: plan.scenario?.id || null,
        checkpointId: `${step.id}:${timing}`,
        inputHash: revisionOf({
          taskId: plan.taskId, modelRevision: plan.modelRevision || null, scenarioRevision: plan.scenario?.revision || null,
          approvalScopeHash: plan.approvalScopeHash || null, stepId: step.id, timing, action: step.action ?? null, spec,
        }),
        modelRevision: plan.modelRevision || null,
        sourceFingerprint: null,
        observedAt: new Date().toISOString(),
        finalUrl: sanitizeUrl(meta.url),
        spec,
        validations: validations.filter((v) => v && v.scope && v.outcome),
        // 未做隐私检测的截图明确记为 not-run，发布时按 unknown 处理
        ...(safe ? { quality: safe.quality } : {}),
        privacy: safe ? safe.privacy : { status: 'not-run' },
        redactions: safe ? safe.redactions.map(({ kind, rect, result }) => ({ kind, rect, result })) : [],
        ...(options.fixture ? { fixture: options.fixture } : {}),
        provenance: safe ? {
          mode: options.provenanceMode || 'live',
          derivedFromRawHash: safe.derived.rawHash,
          geometryHash: safe.derived.geometryHash,
          rendererVersion: safe.derived.rendererVersion,
        } : { mode: options.provenanceMode || 'live' },
      },
    });
    store.setLatest({ [`task:${plan.taskId}:${step.id}:${timing}`]: record.id });
    const artifactOf = (kind) => record.artifacts.find((a) => a.kind === kind) || null;
    const output = { captureId: record.id, raw: path.join(projectRoot, artifactOf('raw').path), timing, bytes: captured.shot.bytes,
      meta: { ...captured.shot.meta, url: sanitizeUrl(captured.shot.meta?.url) } };
    if (safe) {
      output.sanitized = path.join(projectRoot, artifactOf('sanitized').path);
      output.annotated = artifactOf('published')?.path || null;
      output.redactions = safe.redactions;
      // 实际执行过检测的记录；缺这条记录的截图在发布时按 privacy unknown 处理。
      output.privacy = safe.privacy;
      output.annotations = safe.annotations;
      output.quality = safe.quality;
      output.derivedFromRawHash = safe.derived.rawHash;
      output.geometryHash = safe.derived.geometryHash;
      output.rendererVersion = safe.derived.rendererVersion;
      output.sha256 = artifactOf('published')?.sha256 || null;
    }
    return output;
  } catch (error) {
    store.abort(staging);
    throw error;
  }
}

function screenshotFromRecord(record, projectRoot) {
  const artifact = (kind) => record.artifacts.find((item) => item.kind === kind);
  return {
    captureId: record.id,
    raw: path.join(projectRoot, artifact('raw').path),
    sanitized: artifact('sanitized') ? path.join(projectRoot, artifact('sanitized').path) : null,
    annotated: artifact('published')?.path || null,
    timing: record.subject.timing,
    privacy: record.privacy,
    quality: record.quality,
    sha256: artifact('published')?.sha256 || null,
  };
}

function commitEvidenceManifest(stateDir, result) {
  result.canonicalCaptureRefs = result.steps.flatMap((step) => step.screenshots.map((shot) => shot.captureId)).filter(Boolean);
  const manifestText = JSON.stringify(result, null, 2) + '\n';
  writeText(path.join(stateDir, 'artifacts', 'manifests', `${result.taskId}--evidence.json`), manifestText);
  const manifestFile = path.join(stateDir, 'artifacts', 'manifests', `${result.taskId}--evidence--${sha256Hex(manifestText).slice(0, 16)}.json`);
  if (!fs.existsSync(manifestFile)) writeText(manifestFile, manifestText);
  result.manifestFile = manifestFile;
  return result;
}

/** Read-only recovery after a write with unknown outcome. Never repeats task actions. */
async function reconcileCapturePlan(plan, provider, options) {
  const { baseUrl, stateDir, projectRoot, sessionUrl, priorCaptureIds } = options;
  const expected = new URL(joinUrl(baseUrl, plan.entry.route));
  const session = new URL(sessionUrl);
  if (session.origin !== expected.origin || session.pathname !== expected.pathname || !session.searchParams.has('session')) {
    throw new TaskExecutionError('invalid-reconcile-url', '会话 URL 必须属于当前站点与任务入口，且包含 session 参数。');
  }
  const shots = new Map();
  const store = createCaptureStore({ projectRoot, stateDirAbs: stateDir });
  let previousObservedAt = 0;
  for (const id of priorCaptureIds) {
    const record = store.read(id);
    if (!record || record.kind !== 'task-step' || record.subject.taskId !== plan.taskId || record.modelRevision !== plan.modelRevision ||
        record.scenarioId !== plan.scenario?.id || record.finalUrl?.origin !== session.origin ||
        record.privacy?.status !== 'passed' || record.provenance?.mode !== 'live' ||
        record.validations?.some((v) => v.outcome !== 'passed')) {
      throw new TaskExecutionError('invalid-prior-capture', `此前截图 ${id} 与本次任务或隐私规则不匹配。`);
    }
    const step = plan.steps.find((item) => item.id === record.subject.stepId);
    if (!step || step.risk === 'write' || record.subject.timing !== step.capture?.timing) {
      throw new TaskExecutionError('invalid-prior-capture', `此前截图 ${id} 的步骤不匹配。`);
    }
    const observedAt = Date.parse(record.observedAt);
    if (!Number.isFinite(observedAt) || observedAt < previousObservedAt ||
        (previousObservedAt && observedAt - previousObservedAt > 30 * 60 * 1000) || shots.has(step.id)) {
      throw new TaskExecutionError('invalid-prior-capture', '此前截图不属于同一条有序采集链。');
    }
    previousObservedAt = observedAt;
    shots.set(step.id, record);
  }
  const expectedShots = plan.steps.slice(0, -1).filter((step) => step.capture).map((step) => step.id);
  if (expectedShots.some((id) => !shots.has(id)) || shots.size !== expectedShots.length) {
    throw new TaskExecutionError('incomplete-prior-captures', '缺少提交前的完整截图，无法核对这次任务。');
  }
  const last = plan.steps.at(-1);
  if (!last || last.risk !== 'write' || !last.capture || !last.expectedState?.assertions?.length) {
    throw new TaskExecutionError('invalid-reconcile-plan', '只支持核对最后一步为写操作且有结果断言的任务。');
  }
  try {
    const opened = await provider.open(sessionUrl);
    await provider.waitUntilReady({ networkIdleTimeout: 1500 });
    const observation = await provider.currentObservation();
    const navigation = validateNavigation({ requestedUrl: sessionUrl, openResult: opened, observation, expected: {} });
    const filled = plan.steps.slice(0, -1).reverse().find((step) => step.action?.type === 'fill' && typeof step.action.value === 'string');
    const promptValidations = filled ? await runAssertions(provider, [{ type: 'visible', target: { text: filled.action.value } }], {
        scope: 'scenario-state', phase: 'after', stepId: filled.id, idPrefix: `${filled.id}:session-match`,
        timeoutMs: DEFAULT_ASSERTION_TIMEOUT_MS,
      }) : [];
    const validations = [...navigation.validations, ...promptValidations, ...await runAssertions(provider, last.expectedState.assertions, {
      scope: 'scenario-state', phase: 'after', stepId: last.id,
      idPrefix: `${last.pageAfter}:${last.expectedState.id}`, timeoutMs: last.assertionTimeoutMs || DEFAULT_ASSERTION_TIMEOUT_MS,
    })];
    const result = {
      version: 1, taskId: plan.taskId, capturedAt: new Date().toISOString(),
      url: joinUrl(baseUrl, plan.entry.route), finalUrl: sanitizeUrl(navigation.finalUrl),
      provenance: 'live', reconciliation: { mode: 'existing-session', priorCaptureIds, actionReplayed: false },
      entryIdentity: 'url-only', validations, steps: plan.steps.slice(0, -1).map((step) => {
        const record = shots.get(step.id);
        return { id: step.id, page: step.page, status: record && !isUrlOnly(step.expectedState?.assertions) ? 'verified' : 'observed', action: step.action,
          screenshots: record ? [screenshotFromRecord(record, projectRoot)] : [], validations: record?.validations || [] };
      }),
    };
    const shot = await takeScreenshot(provider, stateDir, plan, last, last.capture.timing, options, validations);
    result.steps.push({ id: last.id, page: last.page, status: 'verified', action: last.action, pageState: last.expectedState.id,
      screenshots: [shot], validations });
    const committed = commitEvidenceManifest(stateDir, result);
    if (options.authRuntime?.refresh) await options.authRuntime.refresh(provider);
    return committed;
  } finally {
    if (options.ownsProvider !== false) await provider.close();
  }
}

async function executeCapturePlan(plan, provider, options) {
  const { baseUrl, stateDir } = options;
  const result = {
    version: 1,
    taskId: plan.taskId,
    capturedAt: new Date().toISOString(),
    url: joinUrl(baseUrl, plan.entry.route),
    // simulated：请求被 Fixture 静态响应拦截，结论只覆盖界面呈现（P3-05）
    provenance: options.provenanceMode || 'live',
    ...(options.fixture ? { fixture: options.fixture } : {}),
    steps: [],
  };
  const timeoutMs = options.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;
  let activeStep = null;
  let writeStarted = false;
  try {
    // 入口：HTTP / 最终 URL / 页面状态 → 页面身份断言。全部基于等待之后重新读取的页面事实。
    if (options.routes?.length) {
      if (!provider.installRoutes) throw Object.assign(new Error('当前 Browser Provider 不支持请求拦截（routeMocking），不能使用 mock Fixture。'), { code: 'capability-missing' });
      await provider.installRoutes(options.routes, { baseUrl });
    }
    const openResult = await provider.open(result.url);
    await provider.waitUntilReady();
    const observation = provider.currentObservation ? await provider.currentObservation() : null;
    const current = { ...openResult, finalUrl: observation?.url || openResult.finalUrl };
    if (options.authRuntime?.assertAuthenticated) options.authRuntime.assertAuthenticated(current);
    let navigation;
    try {
      navigation = validateNavigation({ requestedUrl: result.url, openResult, observation, expected: plan.entry.expected || {} });
    } catch (error) {
      throw options.authRuntime?.classify ? options.authRuntime.classify(error) : error;
    }
    result.finalUrl = sanitizeUrl(navigation.finalUrl);
    result.validations = [...navigation.validations];
    const entryAssertions = (plan.entry.assertions || []).filter((assertion) => assertion.type !== 'url');
    result.validations.push(...await runAssertions(provider, entryAssertions, {
      scope: 'page-identity', idPrefix: `${plan.entry.page}:${plan.entry.state || 'default'}`, timeoutMs,
    }));
    result.entryIdentity = entryAssertions.length > 0 ? 'verified' : 'url-only';

    for (const step of plan.steps) {
      activeStep = step;
      options.onProgress?.(step.id);
      const record = { id: step.id, page: step.page, status: null, action: step.action, screenshots: [], validations: [] };
      result.steps.push(record);

      if (!step.willExecute) {
        record.status = 'not-executed';
        record.reason = step.execution;
        // 风险边界之后的步骤一律显式记录为未执行，不能被默认补成完成。
        for (const rest of plan.steps.slice(plan.steps.indexOf(step) + 1)) {
          result.steps.push({ id: rest.id, page: rest.page, status: 'not-executed', reason: 'skipped-by-boundary', action: rest.action, screenshots: [], validations: [] });
        }
        break;
      }
      try {
        record.validations.push(...await runAssertions(provider, step.requires || [], { scope: 'scenario-state', phase: 'before', stepId: step.id, idPrefix: `${step.id}:requires`, timeoutMs }));
      } catch (cause) {
        throw Object.assign(new Error(`步骤 ${step.id} 的数据或界面前提不满足：${cause.message}`), { code: 'precondition-failed', validation: cause.validation });
      }
      if (step.writeOrigin) {
        const current = await provider.currentObservation();
        if (new URL(current.url).origin !== step.writeOrigin || Date.parse(step.writeExpiresAt) <= Date.now()) throw Object.assign(new Error('写操作授权已过期或不匹配当前站点。'), { code: 'write-authorization-expired' });
      }
      // 动作之前先确认处于 stateBefore；不满足时绝不执行动作。
      record.validations.push(...await runAssertions(provider, step.beforeState?.assertions || [], {
        scope: 'scenario-state', phase: 'before', stepId: step.id, idPrefix: `${step.page}:${step.stateBefore}`, timeoutMs,
      }));
      if (!options.preflight && step.capture?.timing === 'before') {
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'before', options, [...result.validations, ...record.validations]));
      }
      if (step.risk === 'write') writeStarted = true;
      record.target = await provider.performAction(step.action);
      await provider.waitUntilReady({ networkIdleTimeout: 1500 });
      const afterAssertions = step.expectedState?.assertions || [];
      record.validations.push(...await runAssertions(provider, afterAssertions, {
        scope: 'scenario-state', phase: 'after', stepId: step.id, idPrefix: `${step.pageAfter || step.page}:${step.expectedState?.id || step.stateBefore}`, timeoutMs: step.assertionTimeoutMs || timeoutMs,
      }));
      // 只有非 URL 断言通过才算验证了状态；只有 URL 的旧状态记为 observed。
      record.status = afterAssertions.length > 0 && !isUrlOnly(afterAssertions) ? 'verified' : 'observed';
      record.pageState = step.expectedState?.id || step.stateBefore;
      if (!options.preflight && step.capture?.timing === 'after') {
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'after', options, [...result.validations, ...record.validations]));
      }
    }
    if (options.preflight) {
      if (options.authRuntime?.refresh) await options.authRuntime.refresh(provider);
      return { ...result, onlineChecked: true, publicationReady: false };
    }
    // 旧 evidence manifest 仅作兼容视图：每张截图条目都由对应 Capture 记录生成，
    // canonicalCaptureRefs 是权威引用，不能与记录各自维护。
    result.canonicalCaptureRefs = result.steps.flatMap((s) => s.screenshots.map((shot) => shot.captureId)).filter(Boolean);
    const manifestText = JSON.stringify(result, null, 2) + '\n';
    writeText(path.join(stateDir, 'artifacts', 'manifests', `${plan.taskId}--evidence.json`), manifestText);
    // 不可变副本（内容寻址）：任务投影与缓存引用它，之后的采集不会覆盖这次的证据清单。
    const manifestFile = path.join(stateDir, 'artifacts', 'manifests', `${plan.taskId}--evidence--${sha256Hex(manifestText).slice(0, 16)}.json`);
    if (!fs.existsSync(manifestFile)) writeText(manifestFile, manifestText);
    if (options.authRuntime?.refresh) {
      const refreshed = await options.authRuntime.refresh(provider);
      if (refreshed?.warning) result.warnings = [...(result.warnings || []), refreshed.warning];
    }
    result.manifestFile = manifestFile;
    return result;
  } catch (cause) {
    let diagnostic = null;
    if (activeStep && !options.preflight) {
      try { diagnostic = await diagnosticScreenshot(provider, stateDir, plan, activeStep); } catch (_) { /* best effort */ }
    }
    throw new TaskExecutionError(
      // 保留原始分类（CaptureError.reason / 定位与断言 code / Playwright 超时）；没有分类的才记 step-failed。
      writeStarted ? 'outcome-unknown' : (errorCode(cause) || 'step-failed'),
      `任务 ${plan.taskId} 的步骤 ${activeStep?.id || '(entry)'} 失败: ${cause.message}`,
      {
        task: plan.taskId,
        step: activeStep?.id || null,
        pageState: activeStep?.expectedState?.id || activeStep?.stateBefore || null,
        target: activeStep?.action?.target || null,
        diagnostic,
        validation: cause.validation || null,
        hint: cause.hint || null,
        suggestion: '检查目标的可访问名称、页面状态断言以及当前账号权限后重试。',
      }
    );
  } finally {
    // BrowserSession 管理的 provider 由 session 在刷新认证后关闭。
    if (options.ownsProvider !== false) await provider.close();
  }
}

module.exports = { executeCapturePlan, reconcileCapturePlan, TaskExecutionError, joinUrl };
