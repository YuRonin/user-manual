'use strict';

const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProjectStore } = require('../store/project');
const { rankPages, taskWorksheet } = require('../tasks/worksheet');

const KNOWN_FLAGS = new Set(['projectRoot', 'page', 'json', 'help']);
const HELP = `manual task-guide <任务目标> [--page <page-id>] [--project-root <路径>] [--json]

只读生成建任务工作表。未指定页面时列出按文字重合排序的入口候选；排序只是线索，不代表页面已验证。
指定 --page 后汇总该页面的指南步骤、断言、前提及待人工判断项。不会创建、批准或执行任务。`;

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  const fail = (message) => {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
    else process.stderr.write(`[manual task-guide] ${message}\n`);
    return 2;
  };
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`);
  if (positional.length !== 1 || !positional[0].trim()) return fail('请提供一句非空的任务目标。');
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors.join('；'));
  const store = createProjectStore({ stateDirAbs: path.join(root, loaded.config.artifacts.stateDir), docsOutputDir: loaded.config.docs.outputDir });
  let model;
  try { model = store.load().model; } catch (error) { return fail((error.errors || [error.message]).join('；')); }
  if (!model.pages.length) return fail('还没有页面模型，请先运行 manual inspect。');
  const goal = positional[0].trim();
  const ranked = rankPages(goal, model.pages);
  let result;
  if (values.page) {
    const page = model.pages.find(item => item.id === values.page && item.includeInManual !== false);
    if (!page) return fail(`找不到可用页面: ${values.page}`);
    result = { ok: true, phase: 'worksheet', worksheet: taskWorksheet(goal, page, model.tasks) };
  } else {
    result = { ok: true, phase: 'select-page', goal, pages: ranked.slice(0, 10),
      note: '按文字重合排序，仅供选择；用 --page <page-id> 查看工作表。' };
  }
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else if (result.worksheet) {
    const w = result.worksheet;
    process.stdout.write(`目标：${w.goal}\n入口：${w.entryPage} (${w.entryRoute})\n步骤线索：${w.suggestions.steps.length}；断言线索：${w.suggestions.assertions.length}\n待确认：\n${w.decisions.map(item => `- ${item}`).join('\n')}\n${w.next}\n`);
  } else process.stdout.write(`目标：${goal}\n页面候选：\n${ranked.slice(0, 10).map(page => `- ${page.id} ${page.title} (${page.route})`).join('\n')}\n${result.note}\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
