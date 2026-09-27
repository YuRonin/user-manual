'use strict';

/*
 * `manual run-submit <runId> --request <requestId> --input <响应.json>` —— 提交宿主模型对交接请求的响应。
 * 校验通过才解除 waiting_input；之后运行 manual resume <runId> 继续。审批仍通过 approve-tasks 明确确认范围。
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { usageExit, exitCodeForCode } = require('../cli/output');
const { openProject } = require('../runtime/app');
const { submitModelResponse } = require('../runtime/model-response');

const KNOWN_FLAGS = new Set(['projectRoot', 'request', 'input', 'json', 'help']);
const HELP = `
manual run-submit <runId> --request <requestId> --input <响应.json> [--json]
    响应形状：{ "requestId": "...", "inputHash": "...", "output": { ... } }（见 references/manual-writing-style.md 第七节）。
    requestId / inputHash 不符、字段未授权、改写受保护事实时拒绝（invalid-model-response），不改任何状态；
    请求依据的事实已变化时返回 run-input-changed。同一响应重复提交是幂等的。
`.trim();

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  const fail = (errors, code) => {
    if (json) process.stdout.write(JSON.stringify({ ok: false, code, errors }, null, 2) + '\n');
    else errors.forEach((e) => process.stderr.write(`[manual run-submit] ${e}\n`));
    return code === 'invalid-arguments' ? usageExit() : exitCodeForCode(code);
  };
  if (unknownFlags.length) return fail([`未知参数: ${unknownFlags.join(', ')}`], 'invalid-arguments');
  if (positional.length !== 1 || typeof values.request !== 'string' || typeof values.input !== 'string') {
    return fail(['用法: manual run-submit <runId> --request <requestId> --input <响应.json>'], 'invalid-arguments');
  }
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  let response;
  try { response = JSON.parse(fs.readFileSync(path.resolve(values.input), 'utf8')); } catch (error) { return fail([`--input 读取失败: ${error.message}`], 'invalid-arguments'); }
  try {
    const { config } = openProject(projectRoot);
    const result = submitModelResponse({ projectRoot, config, runId: positional[0], requestId: values.request, response });
    if (json) process.stdout.write(JSON.stringify({ ...result, next: `manual resume ${positional[0]}` }, null, 2) + '\n');
    else process.stdout.write(`[manual run-submit] 已接受${result.idempotent ? '（重复提交，未改变）' : ''}；运行 manual resume ${positional[0]} 继续。\n`);
    return 0;
  } catch (error) {
    return fail([error.message], error.code || 'invalid-model-response');
  }
}

module.exports = { run, HELP, KNOWN_FLAGS };
