'use strict';

const path = require('path');
const { writeText } = require('../util/fsx');
const { captureStable, derivePublished } = require('../evidence/capture-safe');
const { createCaptureStore, sanitizeUrl } = require('../evidence/store');
const { revisionOf } = require('../util/hash');
const { validateNavigation, runAssertions, isUrlOnly, DEFAULT_ASSERTION_TIMEOUT_MS } = require('../evidence/validate-page');

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
        privacy: safe ? safe.privacy : { status: 'not-run' },
        redactions: safe ? safe.redactions.map(({ kind, rect, result }) => ({ kind, rect, result })) : [],
        provenance: safe ? {
          mode: 'live',
          derivedFromRawHash: safe.derived.rawHash,
          geometryHash: safe.derived.geometryHash,
          rendererVersion: safe.derived.rendererVersion,
        } : { mode: 'live' },
      },
    });
    store.setLatest({ [`task:${plan.taskId}:${step.id}:${timing}`]: record.id });
    const artifactOf = (kind) => record.artifacts.find((a) => a.kind === kind) || null;
    const output = { captureId: record.id, raw: path.join(projectRoot, artifactOf('raw').path), timing, bytes: captured.shot.bytes, meta: captured.shot.meta };
    if (safe) {
      output.sanitized = path.join(projectRoot, artifactOf('sanitized').path);
      output.annotated = artifactOf('published')?.path || null;
      output.redactions = safe.redactions;
      // 实际执行过检测的记录；缺这条记录的截图在发布时按 privacy unknown 处理。
      output.privacy = safe.privacy;
      output.annotations = safe.annotations;
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

async function executeCapturePlan(plan, provider, options) {
  const { baseUrl, stateDir } = options;
  const result = {
    version: 1,
    taskId: plan.taskId,
    capturedAt: new Date().toISOString(),
    url: joinUrl(baseUrl, plan.entry.route),
    steps: [],
  };
  const timeoutMs = options.assertionTimeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS;
  let activeStep = null;
  try {
    // 入口：HTTP / 最终 URL / 页面状态 → 页面身份断言。全部基于等待之后重新读取的页面事实。
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
    result.finalUrl = navigation.finalUrl;
    result.validations = [...navigation.validations];
    const entryAssertions = (plan.entry.assertions || []).filter((assertion) => assertion.type !== 'url');
    result.validations.push(...await runAssertions(provider, entryAssertions, {
      scope: 'page-identity', idPrefix: `${plan.entry.page}:${plan.entry.state || 'default'}`, timeoutMs,
    }));
    result.entryIdentity = entryAssertions.length > 0 ? 'verified' : 'url-only';

    for (const step of plan.steps) {
      activeStep = step;
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
      // 动作之前先确认处于 stateBefore；不满足时绝不执行动作。
      record.validations.push(...await runAssertions(provider, step.beforeState?.assertions || [], {
        scope: 'scenario-state', phase: 'before', stepId: step.id, idPrefix: `${step.page}:${step.stateBefore}`, timeoutMs,
      }));
      if (step.capture?.timing === 'before') {
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'before', options, [...result.validations, ...record.validations]));
      }
      record.target = await provider.performAction(step.action);
      await provider.waitUntilReady();
      const afterAssertions = step.expectedState?.assertions || [];
      record.validations.push(...await runAssertions(provider, afterAssertions, {
        scope: 'scenario-state', phase: 'after', stepId: step.id, idPrefix: `${step.page}:${step.expectedState?.id || step.stateBefore}`, timeoutMs,
      }));
      // 只有非 URL 断言通过才算验证了状态；只有 URL 的旧状态记为 observed。
      record.status = afterAssertions.length > 0 && !isUrlOnly(afterAssertions) ? 'verified' : 'observed';
      record.pageState = step.expectedState?.id || step.stateBefore;
      if (step.capture?.timing === 'after') {
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'after', options, [...result.validations, ...record.validations]));
      }
    }
    // 旧 evidence manifest 仅作兼容视图：每张截图条目都由对应 Capture 记录生成，
    // canonicalCaptureRefs 是权威引用，不能与记录各自维护。
    result.canonicalCaptureRefs = result.steps.flatMap((s) => s.screenshots.map((shot) => shot.captureId)).filter(Boolean);
    const manifestFile = path.join(stateDir, 'artifacts', 'manifests', `${plan.taskId}--evidence.json`);
    writeText(manifestFile, JSON.stringify(result, null, 2) + '\n');
    if (options.authRuntime?.refresh) {
      const refreshed = await options.authRuntime.refresh(provider);
      if (refreshed?.warning) result.warnings = [...(result.warnings || []), refreshed.warning];
    }
    result.manifestFile = manifestFile;
    return result;
  } catch (cause) {
    let diagnostic = null;
    if (activeStep) {
      try { diagnostic = await diagnosticScreenshot(provider, stateDir, plan, activeStep); } catch (_) { /* best effort */ }
    }
    throw new TaskExecutionError(
      cause.code || cause.reason || 'state-assertion-failed',
      `任务 ${plan.taskId} 的步骤 ${activeStep?.id || '(entry)'} 失败: ${cause.message}`,
      {
        task: plan.taskId,
        step: activeStep?.id || null,
        pageState: activeStep?.expectedState?.id || activeStep?.stateBefore || null,
        target: activeStep?.action?.target || null,
        diagnostic,
        validation: cause.validation || null,
        suggestion: '检查目标的可访问名称、页面状态断言以及当前账号权限后重试。',
      }
    );
  } finally {
    await provider.close();
  }
}

module.exports = { executeCapturePlan, TaskExecutionError, joinUrl };
