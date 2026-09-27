'use strict';

const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { captureTask } = require('../tasks/capture-usecase');

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
  let result;
  try {
    result = await captureTask({ projectRoot, config: loaded.config, taskId: positional[0] });
  } catch (error) {
    if (error.errors) return fail(error.errors, json);
    if (error.name === 'TaskExecutionError') {
      return fail([{ code: error.code || 'capture-task-failed', message: error.message, task: error.task, step: error.step, pageState: error.pageState, target: error.target, diagnostic: error.diagnostic, suggestion: error.suggestion }], json);
    }
    return fail([{ code: error.reason || error.code || 'capture-task-failed', message: error.message, hint: error.hint }], json);
  }
  const output = { ok: true, taskId: result.task.id, status: 'captured', planFile: result.planFile, evidence: result.evidence };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual capture-task] ${result.task.title} 已完成安全采集。\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
