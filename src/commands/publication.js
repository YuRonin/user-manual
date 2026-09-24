'use strict';

const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { status, repair } = require('../publication/reconcile');

const KNOWN_FLAGS = new Set(['projectRoot', 'dryRun', 'json', 'help']);
const HELP = `
manual publication —— 查看与恢复中断的发布事务

用法:
  manual publication status [--json]
  manual publication repair [--dry-run] [--json]

status   只读：列出未完成的发布事务、正式文档当前是旧版 / 新版 / 被修改，以及下一步。
repair   继续中断的事务（文档是旧版或新版时）；文档在中途被修改过则标为 conflict 并保留修改。
         --dry-run 只报告将要做什么。重复运行是安全的。
`.trim();

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['dryRun'] });
  const json = values.json === true;
  const print = (payload) => { if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n'); return payload.ok ? 0 : 1; };
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return print({ ok: false, errors: [`未知参数: ${unknownFlags.join(', ')}`] });
  const action = positional[0];
  if (!['status', 'repair'].includes(action)) return print({ ok: false, errors: ['需要子命令 status 或 repair。'] });
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return print({ ok: false, errors: loaded.errors });
  const stateDirAbs = path.join(projectRoot, loaded.config.artifacts.stateDir);

  if (action === 'status') {
    const items = status(projectRoot, stateDirAbs);
    if (!json) {
      if (!items.length) process.stdout.write('[manual publication] 没有未完成的发布事务。\n');
      for (const item of items) process.stdout.write(`  ${item.transactionId}  ${item.documentPath}  状态 ${item.state}  文档 ${item.document}  下一步 ${item.next}\n`);
    }
    return print({ ok: true, transactions: items });
  }
  const results = repair(projectRoot, stateDirAbs, { dryRun: values.dryRun === true });
  if (!json) {
    if (!results.length) process.stdout.write('[manual publication] 没有需要恢复的事务。\n');
    for (const r of results) process.stdout.write(`  ${r.transactionId}  ${r.dryRun ? `将 ${r.next}` : r.result}${r.message ? `  ${r.message}` : ''}\n`);
  }
  const failed = results.filter((r) => r.result === 'failed');
  return print({ ok: failed.length === 0, dryRun: values.dryRun === true, results });
}

module.exports = { run, HELP, KNOWN_FLAGS };
