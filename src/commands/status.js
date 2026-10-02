'use strict';

/*
 * `manual status [runId]` —— 只读查看 Run：不打开租约、不改文件。
 * 无 runId 时列出最近的 Run；有 runId 时显示任务 DAG 摘要、当前等待、失败 code、缓存原因与产物引用。
 */

const path = require('path');
const { parseArgs } = require('../cli/args');
const { usageExit, exitCodeForCode } = require('../cli/output');
const { runStatus } = require('../runtime/app');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'help']);
const HELP = `
manual status [runId] [--json]
    无 runId：列出最近的 Run 及其状态。
    有 runId：显示每个任务的状态、依赖、规划原因、缓存复用来源（observedAt，未在线确认）、
    失败 / 等待的 code 与说明、正式文档路径、产物引用。只读，不影响正在执行的 Run。
`.trim();

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  const fail = (errors, code) => {
    if (json) process.stdout.write(JSON.stringify({ ok: false, code, errors }, null, 2) + '\n');
    else errors.forEach((e) => process.stderr.write(`[manual status] ${e}\n`));
    return code === 'invalid-arguments' ? usageExit() : exitCodeForCode(code);
  };
  if (unknownFlags.length) return fail([`未知参数: ${unknownFlags.join(', ')}`], 'invalid-arguments');
  if (positional.length > 1) return fail(['最多接受一个 runId。'], 'invalid-arguments');
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  let result;
  try { result = runStatus({ projectRoot, runId: positional[0] || null }); } catch (error) { return fail(error.errors || [error.message], error.code); }
  if (json) { process.stdout.write(JSON.stringify({ ok: true, ...result }, null, 2) + '\n'); return 0; }
  const L = [''];
  if (result.runs) {
    if (!result.runs.length) L.push('[manual status] 还没有 Run。');
    for (const r of result.runs) L.push(`  ${r.id}  ${String(r.status).padEnd(13)} ${r.command} ${r.target || ''}  ${r.updatedAt || ''}`);
  } else {
    const { run: r, tasks } = result;
    L.push(`[manual status] Run ${r.id}：${r.status}${r.executing ? '（执行中）' : ''}`);
    L.push(`  ${r.command} ${r.target || ''}${r.predecessor ? `（接续 ${r.predecessor}）` : ''}`);
    L.push(`  已用预算：活跃 ${r.consumed.activeMs}ms / ${r.budget.runActiveMs}ms，动作 ${r.consumed.actions} / ${r.budget.maxActions}`);
    for (const t of tasks) {
      L.push(`  ${t.id.padEnd(14)} ${t.status.padEnd(13)} ${t.reason || ''}${t.reuse ? `  复用 ${t.reuse.observedAt}` : ''}`);
      if (t.error) L.push(`      ${t.error.code}: ${t.error.message}`);
      if (t.next) L.push(`      → ${t.next}`);
    }
    for (const document of result.documents || []) L.push(`  文档 ${document.subject}: ${document.path}`);
    for (const warning of result.warnings || []) L.push(`  提示: ${warning}`);
    for (const r of result.recovery) L.push(`  恢复 ${r.taskId}: ${r.result}`);
    if (result.events.truncated) L.push('  事件日志末行不完整（已忽略；恢复以任务快照为准）');
  }
  L.push('');
  process.stdout.write(L.join('\n') + '\n');
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
