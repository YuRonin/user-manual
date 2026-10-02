'use strict';

/*
 * `manual resume <runId> [--replan]` —— 读取原计划继续执行。
 * 规划之后输入变了（任务定义、源码、Scenario、文案文件……）→ run-input-changed，原 Run 不变；
 * --replan 按原目标与策略重新规划，创建后继 Run 并记录 predecessor。
 */

const path = require('path');
const { parseArgs } = require('../cli/args');
const { usageExit } = require('../cli/output');
const { resumeRun } = require('../runtime/app');
const { printRun, printRuntimeError } = require('../cli/run-report');

const KNOWN_FLAGS = new Set(['projectRoot', 'replan', 'json', 'help']);
const HELP = `
manual resume <runId> [--replan] [--json]
    从任务快照继续：已成功的任务不重做；等待输入的任务重新检查；中断且可安全重放的任务重新执行，
    不能安全重放的转为等待核查（outcome-unknown）。
    --replan  输入已变化时，按原目标与策略重新规划，创建新的 Run（记录 predecessor）。
`.trim();

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['replan'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length || positional.length !== 1) {
    printRuntimeError({ json, error: { code: 'invalid-arguments', message: unknownFlags.length ? `未知参数: ${unknownFlags.join(', ')}` : '需要一个 runId。' }, label: 'resume' });
    return usageExit();
  }
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  try {
    return printRun({ json, result: await resumeRun({ projectRoot, runId: positional[0], replan: values.replan === true }), label: 'resume', projectRoot });
  } catch (error) {
    return printRuntimeError({ json, error, label: 'resume' });
  }
}

module.exports = { run, HELP, KNOWN_FLAGS };
