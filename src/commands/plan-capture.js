'use strict';

const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const pageStore = require('../inspect/store');
const taskStore = require('../tasks/store');
const { buildCapturePlan, writeCapturePlan } = require('../tasks/capture-plan');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'help']);
const HELP = 'manual plan-capture <task-id> [--project-root <路径>] [--json]';

function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else list.forEach((error) => process.stderr.write(`[manual plan-capture] ${error}\n`));
  return 1;
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (positional.length !== 1) return fail('需要一个 task-id。', json);
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const stateDir = path.join(projectRoot, loaded.config.artifacts.stateDir);
  const task = taskStore.readTask(stateDir, positional[0]);
  if (!task) return fail(`找不到任务: ${positional[0]}`, json);
  const pages = pageStore.readExistingPages(stateDir);
  if (pages.errors.length) return fail(pages.errors, json);
  const result = buildCapturePlan(task, pages.pages);
  if (!result.ok) return fail(result.errors, json);
  const planFile = writeCapturePlan(stateDir, result.plan);
  const output = { ok: true, planFile, plan: result.plan };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual plan-capture] 截图计划已写入 ${planFile}\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
