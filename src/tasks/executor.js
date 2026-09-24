'use strict';

const path = require('path');
const { writeText } = require('../util/fsx');
const { planRedactions } = require('../artifacts/redaction');
const { layoutAnnotations } = require('../artifacts/annotation');
const { buildPrivacyRecord } = require('../publication/validate');
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

async function takeScreenshot(provider, stateDir, plan, step, timing, kind = 'raw', options = {}, resolvedTarget = null) {
  const dir = kind === 'diagnostic'
    ? path.join(stateDir, 'artifacts', 'diagnostics')
    : path.join(stateDir, 'artifacts', 'raw');
  const suffix = kind === 'diagnostic' ? 'failure' : timing;
  const file = path.join(dir, `${plan.taskId}--${step.id}--${suffix}.png`);
  const shot = await provider.screenshot({ path: file, format: 'png' });
  const output = { raw: file, timing, bytes: shot.bytes, meta: shot.meta };
  if (kind === 'raw' && provider.collectSensitiveElements && provider.renderEvidence && options.projectRoot && options.annotatedDir) {
    const privacy = planRedactions(await provider.collectSensitiveElements(), options.redactionRules || {});
    if (!privacy.ok) throw Object.assign(new Error(privacy.errors.join('；')), { code: 'privacy-uncertain' });
    const requested = (step.capture?.annotations || []).map((annotation) => ({
      label: annotation.label,
      rect: annotation.target === 'action.target' ? resolvedTarget?.rect : annotation.rect,
    })).filter((item) => item.rect);
    const layout = layoutAnnotations(requested, shot.meta.viewport, options.theme);
    if (!layout.ok) throw Object.assign(new Error(layout.errors.join('；')), { code: 'annotation-layout-failed' });
    const sanitizedPath = path.join(stateDir, 'artifacts', 'sanitized', `${plan.taskId}--${step.id}--${timing}.png`);
    const annotatedRelative = path.posix.join(String(options.annotatedDir).replace(/\\/g, '/'), `${plan.taskId}--${step.id}--${timing}.png`);
    const annotatedPath = path.join(options.projectRoot, annotatedRelative);
    await provider.renderEvidence({ sanitizedPath, annotatedPath, redactions: privacy.redactions, annotations: layout.annotations, theme: options.theme });
    output.sanitized = sanitizedPath;
    output.annotated = annotatedRelative;
    output.redactions = privacy.redactions;
    // 实际执行过检测的记录；缺这条记录的截图在发布时按 privacy unknown 处理。
    output.privacy = buildPrivacyRecord({ redactions: privacy.redactions, config: { privacy: options.redactionRules || {} } });
    output.annotations = layout.annotations;
  }
  return output;
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
        break;
      }
      // 动作之前先确认处于 stateBefore；不满足时绝不执行动作。
      record.validations.push(...await runAssertions(provider, step.beforeState?.assertions || [], {
        scope: 'scenario-state', phase: 'before', idPrefix: `${step.page}:${step.stateBefore}`, timeoutMs,
      }));
      let inspected = null;
      if (step.capture?.timing === 'before') {
        if (step.action?.target) inspected = await provider.performAction({ type: 'inspect', target: step.action.target });
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'before', 'raw', options, inspected));
      }
      record.target = await provider.performAction(step.action);
      await provider.waitUntilReady();
      const afterAssertions = step.expectedState?.assertions || [];
      record.validations.push(...await runAssertions(provider, afterAssertions, {
        scope: 'scenario-state', phase: 'after', idPrefix: `${step.page}:${step.expectedState?.id || step.stateBefore}`, timeoutMs,
      }));
      // 只有非 URL 断言通过才算验证了状态；只有 URL 的旧状态记为 observed。
      record.status = afterAssertions.length > 0 && !isUrlOnly(afterAssertions) ? 'verified' : 'observed';
      record.pageState = step.expectedState?.id || step.stateBefore;
      if (step.capture?.timing === 'after') {
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'after', 'raw', options, record.target));
      }
    }
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
      try { diagnostic = (await takeScreenshot(provider, stateDir, plan, activeStep, 'failure', 'diagnostic')).raw; } catch (_) { /* best effort */ }
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
