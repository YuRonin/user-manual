'use strict';

const path = require('path');
const { writeText } = require('../util/fsx');
const { planRedactions } = require('../artifacts/redaction');
const { layoutAnnotations } = require('../artifacts/annotation');

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
  let activeStep = null;
  try {
    await provider.open(result.url);
    await provider.waitUntilReady();
    for (const step of plan.steps) {
      activeStep = step;
      const record = { id: step.id, page: step.page, status: null, action: step.action, screenshots: [] };
      result.steps.push(record);

      if (!step.willExecute) {
        record.status = 'not-executed';
        record.reason = step.execution;
        break;
      }
      let inspected = null;
      if (step.capture?.timing === 'before') {
        if (step.action?.target) inspected = await provider.performAction({ type: 'inspect', target: step.action.target });
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'before', 'raw', options, inspected));
      }
      record.target = await provider.performAction(step.action);
      await provider.waitUntilReady();
      for (const assertion of step.expectedState?.assertions || []) {
        await provider.assertCondition(assertion);
      }
      record.status = 'verified';
      record.pageState = step.expectedState?.id || step.stateBefore;
      if (step.capture?.timing === 'after') {
        record.screenshots.push(await takeScreenshot(provider, stateDir, plan, step, 'after', 'raw', options, record.target));
      }
    }
    const manifestFile = path.join(stateDir, 'artifacts', 'manifests', `${plan.taskId}--evidence.json`);
    writeText(manifestFile, JSON.stringify(result, null, 2) + '\n');
    result.manifestFile = manifestFile;
    return result;
  } catch (cause) {
    let diagnostic = null;
    if (activeStep) {
      try { diagnostic = (await takeScreenshot(provider, stateDir, plan, activeStep, 'failure', 'diagnostic')).raw; } catch (_) { /* best effort */ }
    }
    throw new TaskExecutionError(
      cause.code || 'state-assertion-failed',
      `任务 ${plan.taskId} 的步骤 ${activeStep?.id || '(entry)'} 失败: ${cause.message}`,
      {
        task: plan.taskId,
        step: activeStep?.id || null,
        pageState: activeStep?.expectedState?.id || activeStep?.stateBefore || null,
        target: activeStep?.action?.target || null,
        diagnostic,
        suggestion: '检查目标的可访问名称、页面状态断言以及当前账号权限后重试。',
      }
    );
  } finally {
    await provider.close();
  }
}

module.exports = { executeCapturePlan, TaskExecutionError, joinUrl };
