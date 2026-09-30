'use strict';

const path = require('path');
const { parseArgs } = require('../cli/args');
const { exitCodeFor, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { createProjectStore } = require('../store/project');
const { deriveTaskScenario } = require('../scenarios/model');
const { resolveScenario } = require('../scenarios/store');
const { buildCapturePlan, writeCapturePlan } = require('../tasks/capture-plan');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'help', 'live']);
const HELP = 'manual plan-capture <task-id> [--project-root <路径>] [--live] [--json]\n--live 在真实浏览器预演只读/本地步骤，写操作前停止；不发布证据。';

function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else list.forEach((error) => process.stderr.write(`[manual plan-capture] ${error}\n`));
  return exitCodeFor(list);
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['live'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return usageExit(fail(`未知参数: ${unknownFlags.join(', ')}`, json));
  if (positional.length !== 1) return usageExit(fail('需要一个 task-id。', json));
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const { config } = loaded;
  const stateDir = path.join(projectRoot, config.artifacts.stateDir);
  // 与 capture-task 读取同一份已提交模型与 Scenario，打印的计划就是将要执行的计划。
  let base;
  try { base = createProjectStore({ stateDirAbs: stateDir, docsOutputDir: config.docs.outputDir }).load(); } catch (error) { return fail(error.errors || [error.message], json); }
  const task = base.model.tasks.find((t) => t.id === positional[0]);
  if (!task) return fail(`找不到任务: ${positional[0]}`, json);
  const pages = base.model.pages;
  const scenario = resolveScenario(stateDir, deriveTaskScenario(task, pages, config), { stepIds: (task.steps || []).map((step) => step.id) });
  if (!scenario.ok) return fail(scenario.errors, json);
  const result = buildCapturePlan(task, pages, { scenario: scenario.scenario, config, preflight: !!values.live });
  if (!result.ok) return fail(result.errors, json);
  if (values.live) {
    try {
      const result = await require('../tasks/capture-usecase').captureTask({ projectRoot, config, taskId: task.id, preflight: true });
      process.stdout.write(JSON.stringify({ ok: true, onlineChecked: true, steps: result.evidence.steps.map(s => ({ id: s.id, status: s.status, reason: s.reason, locator: s.target?.resolution })), publicationReady: false }, null, 2) + '\n');
      return 0;
    } catch (error) { return fail(`${error.code || 'preflight-failed'}: ${error.message}`, json); }
  }
  const planFile = writeCapturePlan(stateDir, result.plan);
  const output = { ok: true, planFile, plan: result.plan };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual plan-capture] 截图计划已写入 ${planFile}\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
