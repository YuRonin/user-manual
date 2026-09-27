'use strict';

const fs = require('fs');
const path = require('path');
const { sha256Hex } = require('../util/hash');
const { parseArgs } = require('../cli/args');
const { exitCodeFor, exitCodeForCode, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { captureTask } = require('../tasks/capture-usecase');
const { recordCapture } = require('../runtime/app');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'help']);
const HELP = 'manual capture-task <task-id> [--project-root <路径>] [--json]';
function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else list.forEach((error) => process.stderr.write(`[manual capture-task] ${error}\n`));
  return exitCodeFor(list);
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return usageExit(fail(`未知参数: ${unknownFlags.join(', ')}`, json));
  if (positional.length !== 1) return usageExit(fail('需要一个 task-id。', json));
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  return captureTaskTarget({ projectRoot, config: loaded.config, taskId: positional[0], json });
}

/** capture-task 与 `capture task:<id>` 共用：执行用例 → 登记缓存 → 输出。 */
async function captureTaskTarget({ projectRoot, config, taskId, json }) {
  let result;
  try {
    result = await captureTask({ projectRoot, config, taskId });
  } catch (error) {
    if (error.errors) { fail(error.errors, json); return exitCodeForCode(error.code); }
    if (error.name === 'TaskExecutionError') {
      return fail([{ code: error.code || 'capture-task-failed', message: error.message, task: error.task, step: error.step, pageState: error.pageState, target: error.target, diagnostic: error.diagnostic, suggestion: error.suggestion }], json);
    }
    return fail([{ code: error.reason || error.code || 'capture-task-failed', message: error.message, hint: error.hint }], json);
  }
  const manifest = path.join(projectRoot, result.updatedTask.evidenceManifest);
  recordCapture({
    projectRoot, subject: { type: 'task', id: result.task.id }, captureIds: result.updatedTask.lastCapture.captureIds,
    extraRefs: [{ kind: 'file', ref: result.updatedTask.evidenceManifest, sha256: sha256Hex(fs.readFileSync(manifest)) }], observedAt: result.evidence.capturedAt,
  });
  const output = { ok: true, taskId: result.task.id, status: 'captured', planFile: result.planFile, evidence: result.evidence };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual capture-task] ${result.task.title} 已完成安全采集。\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, captureTaskTarget };
