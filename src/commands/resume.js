'use strict';

/*
 * `manual resume <runId> [--request <id> --input <响应.json>] [--replan]` —— 读取原计划继续执行。
 * 规划之后输入变了（任务定义、源码、Scenario、文案文件……）→ run-input-changed，原 Run 不变；
 * --replan 按原目标与策略重新规划，创建后继 Run 并记录 predecessor。
 * 带 --request/--input 时先提交宿主模型的响应（与 run-submit 同一校验），通过后立即继续，
 * 把“提交 → 继续”合成一步；校验失败时不继续，Run 状态不变。
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { usageExit } = require('../cli/output');
const { resumeRun, openProject } = require('../runtime/app');
const { submitModelResponse } = require('../runtime/model-response');
const { printRun, printRuntimeError } = require('../cli/run-report');

const KNOWN_FLAGS = new Set(['projectRoot', 'replan', 'request', 'input', 'json', 'help']);
const HELP = `
manual resume <runId> [--request <requestId> --input <响应.json>] [--replan] [--json]
    从任务快照继续：已成功的任务不重做；等待输入的任务重新检查；中断且可安全重放的任务重新执行，
    不能安全重放的转为等待核查（outcome-unknown）。
    --request / --input  先提交模型文案或页面分析响应（见 references/manual-writing-style.md 第七节），
                         校验通过后继续；requestId / inputHash 不符或改写受保护事实时拒绝且不继续。
    --replan  输入已变化时，按原目标与策略重新规划，创建新的 Run（记录 predecessor）。
`.trim();

function readResponse(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['replan'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  const submitting = values.request !== undefined || values.input !== undefined;
  const badSubmit = submitting && (typeof values.request !== 'string' || typeof values.input !== 'string');
  if (unknownFlags.length || positional.length !== 1 || badSubmit) {
    const message = unknownFlags.length ? `未知参数: ${unknownFlags.join(', ')}`
      : badSubmit ? '--request 与 --input 需要同时提供。' : '需要一个 runId。';
    printRuntimeError({ json, error: { code: 'invalid-arguments', message }, label: 'resume' });
    return usageExit();
  }
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const runId = positional[0];
  try {
    if (submitting) {
      let response;
      try { response = readResponse(values.input); } catch (error) {
        printRuntimeError({ json, error: { code: 'invalid-arguments', message: `--input 读取失败: ${error.message}` }, label: 'resume' });
        return usageExit();
      }
      const { config } = openProject(projectRoot);
      submitModelResponse({ projectRoot, config, runId, requestId: values.request, response });
    }
    return printRun({ json, result: await resumeRun({ projectRoot, runId, replan: values.replan === true }), label: 'resume', projectRoot });
  } catch (error) {
    return printRuntimeError({ json, error, label: 'resume' });
  }
}

module.exports = { run, HELP, KNOWN_FLAGS };
