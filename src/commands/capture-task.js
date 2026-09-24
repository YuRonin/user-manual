'use strict';

const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProvider } = require('../browser');
const pageStore = require('../inspect/store');
const taskStore = require('../tasks/store');
const { definitionRevision } = require('../model/revision');
const { scopeHash, pageRevisionsFor } = require('../model/approval');
const { deriveTaskScenario } = require('../scenarios/model');
const { resolveScenario } = require('../scenarios/store');
const { buildCapturePlan, writeCapturePlan } = require('../tasks/capture-plan');
const { executeCapturePlan } = require('../tasks/executor');
const { prepareAuth, assertAuthenticated, classifyAuthFailure, refreshAuth } = require('../auth/runtime');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'help']);
const HELP = 'manual capture-task <task-id> [--project-root <路径>] [--json]';
function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else list.forEach((error) => process.stderr.write(`[manual capture-task] ${error}\n`));
  return 1;
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (positional.length !== 1) return fail('需要一个 task-id。', json);
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const { config } = loaded;
  const stateDir = path.join(projectRoot, config.artifacts.stateDir);
  const task = taskStore.readTask(stateDir, positional[0]);
  if (!task) return fail(`找不到任务: ${positional[0]}`, json);
  const pages = pageStore.readExistingPages(stateDir);
  if (pages.errors.length) return fail(pages.errors, json);
  const derived = deriveTaskScenario(task, pages.pages, config);
  const scenario = resolveScenario(stateDir, derived, { stepIds: (task.steps || []).map((step) => step.id) });
  if (!scenario.ok) return fail(scenario.errors, json);
  const built = buildCapturePlan(task, pages.pages, { scenario: scenario.scenario });
  if (!built.ok) return fail(built.errors, json);
  // 截图记录绑定本次执行所依据的任务定义 revision
  built.plan.modelRevision = definitionRevision('userTask', task);
  const planFile = writeCapturePlan(stateDir, built.plan);

  const profileId = config.capture.activeProfile;
  const providerId = config.browser.activeProvider;
  let auth;
  try { auth = prepareAuth(config); }
  catch (error) { return fail([{ code: error.reason || error.code, message: error.message, hint: error.hint }], json); }
  const provider = createProvider({
    id: providerId,
    profile: config.capture.profiles[profileId],
    providerConfig: config.browser.providers[providerId],
    storageState: auth.storageState,
  });
  try {
    const theme = config.annotation.themes[config.annotation.activeTheme];
    const evidence = await executeCapturePlan(built.plan, provider, {
      baseUrl: config.project.baseUrl,
      stateDir,
      projectRoot,
      annotatedDir: config.artifacts.annotatedDir,
      theme,
      redactionRules: config.privacy || {},
      authRuntime: {
        assertAuthenticated: (openResult) => assertAuthenticated(openResult, auth),
        classify: (error) => classifyAuthFailure(error, auth),
        refresh: (actualProvider) => refreshAuth(actualProvider, auth),
      },
    });
    // 采集可以重复执行：记录这次观察所依据的输入，新鲜度之后由它与当前定义比较得出。
    // status 只是兼容投影，不再参与"能否执行"的判断；旧的 stale 标记被新观察清除。
    const { stale: _cleared, ...rest } = task;
    const lastCapture = {
      capturedAt: evidence.capturedAt,
      captureIds: evidence.canonicalCaptureRefs,
      scopeHash: scopeHash(task, pages.pages),
      modelRevision: built.plan.modelRevision,
      pageRevisions: pageRevisionsFor(task, pages.pages),
      scenarioId: scenario.scenario.id,
      scenarioRevision: scenario.scenario.revision,
    };
    taskStore.writeTask(stateDir, { ...rest, status: 'captured', lastCapture, captureIds: evidence.canonicalCaptureRefs, evidenceManifest: path.relative(projectRoot, evidence.manifestFile).replace(/\\/g, '/') });
    const tasks = taskStore.readTasks(stateDir).tasks;
    pageStore.writeIndexes(stateDir, pages.pages, { docsOutputDir: config.docs.outputDir, tasks });
    const output = { ok: true, taskId: task.id, status: 'captured', planFile, evidence };
    if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    else process.stdout.write(`[manual capture-task] ${task.title} 已完成安全采集。\n`);
    return 0;
  } catch (error) {
    return fail([{ code: error.code || 'capture-task-failed', message: error.message, task: error.task, step: error.step, pageState: error.pageState, target: error.target, diagnostic: error.diagnostic, suggestion: error.suggestion }], json);
  }
}

module.exports = { run, HELP, KNOWN_FLAGS };
