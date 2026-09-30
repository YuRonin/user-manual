'use strict';

/*
 * 任务采集用例：`manual capture-task` 与 Runtime 的 capture handler 共用。
 *
 * 读取已提交模型 → 解析 Scenario → 构建采集计划（审批不符直接拒绝）→ 在隔离 Context 中执行 →
 * 提交任务的采集投影（lastCapture / captureIds / evidenceManifest）。
 * 不做输出；失败抛带 code 的错误（TaskExecutionError / CaptureError / RuntimeError）。
 */

const path = require('path');

const { createProvider } = require('../browser');
const { createProjectStore } = require('../store/project');
const { scopeHash, pageRevisionsFor } = require('../model/approval');
const { deriveTaskScenario } = require('../scenarios/model');
const { resolveScenario } = require('../scenarios/store');
const { buildCapturePlan, writeCapturePlan } = require('./capture-plan');
const { executeCapturePlan, reconcileCapturePlan } = require('./executor');
const { prepareAuth, authRuntimeFor } = require('../auth/runtime');
const { RuntimeError } = require('../runtime/errors');
const { prepareScenarioData } = require('../scenarios/fixtures');

function inputError(code, errors) {
  return new RuntimeError(code, errors.join(' '), { errors });
}

/** 任务采集投影：lastCapture 记录这次观察依据的输入，新鲜度由它与当前定义比较得出。 */
function taskProjection(task, pages, { capturedAt, captureIds, manifestRelative, scenario, modelRevision }) {
  // status 只是兼容投影，不再参与"能否执行"的判断；旧的 stale 标记被新观察清除。
  const { stale: _cleared, ...rest } = task;
  return {
    ...rest,
    status: 'captured',
    lastCapture: {
      capturedAt,
      captureIds,
      scopeHash: scopeHash(task, pages),
      modelRevision,
      pageRevisions: pageRevisionsFor(task, pages),
      scenarioId: scenario.id,
      scenarioRevision: scenario.revision,
    },
    captureIds,
    evidenceManifest: manifestRelative,
  };
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config
 * @param {string} p.taskId
 * @param {object} [p.session]  BrowserSession；缺省时自行创建并关闭 provider
 * @returns {Promise<{ task, updatedTask, plan, planFile, evidence, scenario }>}
 */
async function captureTask({ projectRoot, config, taskId, session = null, runId = null, preflight = false, reconcile = null }) {
  const stateDir = path.join(projectRoot, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs: stateDir, docsOutputDir: config.docs.outputDir });
  let base;
  try { base = projectStore.load(); } catch (error) { throw inputError('invalid-model', error.errors || [error.message]); }
  const task = base.model.tasks.find((t) => t.id === taskId);
  if (!task) throw inputError('unknown-target', [`找不到任务: ${taskId}`]);
  const pages = base.model.pages;
  const derived = deriveTaskScenario(task, pages, config);
  const scenario = resolveScenario(stateDir, derived, { stepIds: (task.steps || []).map((step) => step.id) });
  if (!scenario.ok) throw inputError('invalid-scenario', scenario.errors);
  const built = buildCapturePlan(task, pages, { scenario: scenario.scenario, config, preflight });
  if (!built.ok) {
    const APPROVAL_CODES = { pending: 'approval-required', 'legacy-unverified': 'approval-required', 'scope-changed': 'scope-changed', rejected: 'approval-rejected' };
    throw inputError(APPROVAL_CODES[built.code] || 'invalid-plan', built.errors);
  }
  const planFile = preflight ? null : writeCapturePlan(stateDir, built.plan);

  const profileId = config.capture.activeProfile;
  const providerId = config.browser.activeProvider;
  const profile = config.capture.profiles[profileId];
  const providerConfig = config.browser.providers[providerId];
  // Fixture 先过环境策略；Scenario 的身份决定认证档案（匿名 / 成员 / 管理员各自隔离）
  const data = prepareScenarioData({ stateDirAbs: stateDir, config, scenario: scenario.scenario, runId });
  const auth = prepareAuth(config, { profile: scenario.scenario.authProfile });
  const execute = (provider, ownsProvider) => (reconcile ? reconcileCapturePlan : executeCapturePlan)(built.plan, provider, {
    preflight,
    onProgress: (step) => process.stderr.write(`[manual capture] ${taskId}: ${step}\n`),
    routes: data.routes,
    provenanceMode: data.mode,
    fixture: data.fixture,
    baseUrl: config.project.baseUrl,
    stateDir,
    projectRoot,
    annotatedDir: config.artifacts.annotatedDir,
    theme: config.annotation.themes[config.annotation.activeTheme],
    redactionRules: config.privacy || {},
    // BrowserSession 负责写回认证（成功总是写，失败只在凭据变化时写）并关闭 Context
    authRuntime: authRuntimeFor(auth, { refresh: ownsProvider }),
    ownsProvider,
    ...(reconcile ? { sessionUrl: reconcile.sessionUrl, priorCaptureIds: reconcile.priorCaptureIds } : {}),
  });
  let evidence;
  const warnings = [];
  if (session) {
    const result = await session.withScenario({ id: providerId, providerConfig, profile, auth }, (provider) => execute(provider, false));
    evidence = result.value;
    warnings.push(...result.warnings);
  } else {
    const provider = createProvider({ id: providerId, profile, providerConfig, storageState: auth.storageState });
    evidence = await execute(provider, true);
  }

  if (preflight) return { task, plan: built.plan, evidence, preflight: true };
  const updatedTask = taskProjection(task, pages, {
    capturedAt: evidence.capturedAt,
    captureIds: evidence.canonicalCaptureRefs,
    manifestRelative: path.relative(projectRoot, evidence.manifestFile).replace(/\\/g, '/'),
    scenario: scenario.scenario,
    modelRevision: built.plan.modelRevision,
  });
  // 观察提交：浏览器执行期间不持有项目锁；只写本任务的采集投影，不覆盖同时发生的定义修改
  projectStore.commit({ base, kind: 'observation', changes: { tasks: [updatedTask] } });
  return { task, updatedTask, plan: built.plan, planFile, evidence: { ...evidence, warnings: [...(evidence.warnings || []), ...warnings] }, scenario: scenario.scenario };
}

module.exports = { captureTask, taskProjection };
