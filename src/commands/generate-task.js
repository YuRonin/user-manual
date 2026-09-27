'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { exitCodeFor, exitCodeForCode, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { draftTask, prepareTaskFinal, publishTaskFinal } = require('../generate/task-usecase');

const KNOWN_FLAGS = new Set(['projectRoot', 'finalize', 'copy', 'acceptReview', 'force', 'json', 'help']);
const HELP = `
manual generate-task <task-id> [--json]
    生成事实草稿（.manual/drafts/tasks/<id>.md）与事实包（<id>.facts.json）。
manual generate-task <task-id> --copy <文案.json> [--accept-review] [--json]
    推荐的定稿方式：文案 JSON 形如 { "intro": "...", "step.<stepId>": "..." }，只能填写事实包
    声明的文案块；动作、顺序、截图、完成声明由程序按事实包渲染，模型无法改写。
manual generate-task <task-id> --finalize <markdown> [--accept-review] [--json]
    兼容旧流程：校验润色后的整篇 Markdown（结构一致性检查，不证明自由文本的语义等价）。
新出现的数字 / 单位或业务承诺需要人工确认（review-required），确认无误后加 --accept-review。
`.trim();

function fail(e, j, extra = {}) {
  const a = Array.isArray(e) ? e : [e];
  if (j) process.stdout.write(JSON.stringify({ ok: false, ...extra, errors: a }, null, 2) + '\n');
  else a.forEach((x) => process.stderr.write(`[manual generate-task] ${x}\n`));
  return exitCodeFor(a);
}

/** 用例错误 → 旧输出形状：审查类与部分提交带 code（及 committed），其余只有 errors。 */
function failWith(error, json) {
  const errors = error.errors || [error.message];
  if (error.code === 'partial-commit') fail(errors, json, { code: error.code, committed: error.committed || [] });
  else if (['review-required', 'copy-blocked'].includes(error.code)) fail(errors, json, { code: error.code });
  else fail(errors, json);
  return exitCodeForCode(error.code);
}

function readInput(file, label) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return { ok: false, error: `${label} 文件不存在: ${abs}` };
  return { ok: true, text: fs.readFileSync(abs, 'utf8') };
}

function runFinalize({ root, config, taskId, finalizeInput, copyInput, acceptReview, force = false, json }) {
  let copy = null;
  let markdown = null;
  if (copyInput) {
    const read = readInput(copyInput, '--copy');
    if (!read.ok) return fail(read.error, json);
    try { copy = JSON.parse(read.text); } catch (error) { return fail(`--copy 不是合法 JSON: ${error.message}`, json); }
  } else {
    const read = readInput(finalizeInput, '--finalize');
    if (!read.ok) return fail(read.error, json);
    markdown = read.text;
  }
  let manualFile;
  try {
    const prepared = prepareTaskFinal({ projectRoot: root, config, taskId, copy, markdown, acceptReview });
    ({ manualFile } = publishTaskFinal({ projectRoot: root, config, taskId, prepared, force }));
  } catch (error) {
    return failWith(error, json);
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'generated', manual: manualFile }, null, 2) + '\n');
  return 0;
}

function runDraft({ root, config, taskId, json }) {
  let built;
  try { built = draftTask({ projectRoot: root, config, taskId }); } catch (error) { return failWith(error, json); }
  if (json) {
    process.stdout.write(JSON.stringify({
      ok: true, status: 'draft', draftFile: built.draftFile, factsFile: built.factsFile, factsHash: built.factsHash,
      // 模型可以填写的文案块及其默认文字；其余内容由程序渲染
      copyBlocks: built.copyBlocks,
      protected: built.facts,
    }, null, 2) + '\n');
  }
  return 0;
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['acceptReview', 'force'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (values.finalize && values.copy) return usageExit(fail('--finalize 与 --copy 只能选一个。', json));
  if (unknownFlags.length) return usageExit(fail(`未知参数: ${unknownFlags.join(', ')}`, json));
  if (positional.length !== 1) return usageExit(fail('需要一个 task-id。', json));
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors, json);
  const config = loaded.config;
  if (values.finalize || values.copy) {
    return runFinalize({
      root, config, taskId: positional[0],
      finalizeInput: values.finalize, copyInput: values.copy, acceptReview: values.acceptReview === true, force: values.force === true, json,
    });
  }
  return runDraft({ root, config, taskId: positional[0], json });
}

module.exports = { run, KNOWN_FLAGS };
