'use strict';

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const pageStore = require('../inspect/store');
const { validateTask } = require('../tasks/model');
const taskStore = require('../tasks/store');
const { buildDiscoveryWorklist } = require('../tasks/discovery');

const KNOWN_FLAGS = new Set(['projectRoot', 'input', 'all', 'json', 'help']);
const HELP = `
manual discover-tasks —— 从页面证据提出候选用户任务

用法:
  manual discover-tasks <page-id> --json
  manual discover-tasks --all --json
  manual discover-tasks <page-id> --input <候选.json> --json

无 --input 时返回 AI 应读取的页面证据工作清单；有 --input 时校验并写入
.manual/tasks/*.yaml。新任务始终保存为 candidate，之后必须运行 approve-tasks。
`.trim();

function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else for (const error of list) process.stderr.write(`[manual discover-tasks] ${error}\n`);
  return 1;
}

function readJson(file, errors) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    errors.push(`--input 文件不存在: ${full}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    errors.push(`--input 不是合法 JSON: ${error.message}`);
    return null;
  }
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, {
    known: KNOWN_FLAGS,
    booleans: ['all'],
  });
  const json = values.json === true;
  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if ((values.all && positional.length > 0) || (!values.all && positional.length !== 1)) {
    return fail('需要指定一个 page-id，或单独使用 --all。', json);
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const stateDir = path.join(projectRoot, loaded.config.artifacts.stateDir);
  const existingPages = pageStore.readExistingPages(stateDir);
  if (existingPages.errors.length > 0) return fail(existingPages.errors, json);
  if (existingPages.pages.length === 0) return fail('还没有页面模型，请先运行 manual inspect。', json);

  const selected = values.all
    ? existingPages.pages.filter((page) => page.includeInManual !== false)
    : existingPages.pages.filter((page) => page.id === positional[0]);
  if (selected.length === 0) return fail(`找不到页面: ${positional[0]}`, json);

  const worklist = buildDiscoveryWorklist(selected);
  if (!values.input) {
    const output = { ok: true, phase: 'worklist', worklist };
    if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    else process.stdout.write(`[manual discover-tasks] 已准备 ${worklist.length} 个页面的候选发现工作清单。\n`);
    return 0;
  }

  const inputErrors = [];
  const payload = readJson(values.input, inputErrors);
  if (inputErrors.length > 0) return fail(inputErrors, json);
  if (!payload || !Array.isArray(payload.tasks) || payload.tasks.length === 0) {
    return fail('输入需要形如 { "tasks": [ ... ] }，且不能为空。', json);
  }

  const current = taskStore.readTasks(stateDir);
  if (current.errors.length > 0) return fail(current.errors, json);
  const existingById = new Map(current.tasks.map((task) => [task.id, task]));
  const selectedIds = new Set(selected.map((page) => page.id));
  const knownPageIds = new Set(existingPages.pages.map((page) => page.id));
  const seen = new Set();
  const candidates = [];
  const errors = [];

  payload.tasks.forEach((input, index) => {
    const where = `tasks[${index}]`;
    if (!input || typeof input !== 'object') {
      errors.push(`${where} 不是对象。`);
      return;
    }
    if (!selectedIds.has(input.entryPage)) {
      errors.push(`${where}.entryPage "${input.entryPage}" 不在本次发现范围。`);
    }
    const existing = existingById.get(input.id);
    if (existing && existing.status !== 'candidate') {
      errors.push(`${where}: 不能覆盖 ${existing.status} 任务 ${input.id}。`);
    }
    if (seen.has(input.id)) errors.push(`${where}.id 重复: ${input.id}`);
    seen.add(input.id);
    const task = { ...input, status: 'candidate' };
    if (Array.isArray(task.steps)) {
      task.steps.forEach((step, stepIndex) => {
        if (step?.page && !knownPageIds.has(step.page)) {
          errors.push(`${where}.steps[${stepIndex}].page 不存在: ${step.page}`);
        }
      });
    }
    const checked = validateTask(task);
    if (!checked.ok) errors.push(...checked.errors.map((error) => `${where}: ${error}`));
    else candidates.push(checked.task);
  });

  if (errors.length > 0) return fail(errors, json);
  for (const task of candidates) taskStore.writeTask(stateDir, task);

  const merged = new Map(current.tasks.map((task) => [task.id, task]));
  for (const task of candidates) merged.set(task.id, task);
  pageStore.writeIndexes(stateDir, existingPages.pages, {
    docsOutputDir: loaded.config.docs.outputDir,
    tasks: [...merged.values()],
  });

  const output = { ok: true, phase: 'candidates', created: candidates.map((task) => task.id), status: 'candidate' };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual discover-tasks] 已写入 ${candidates.length} 个候选任务，等待人工确认。\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
