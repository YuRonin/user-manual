'use strict';

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const pageStore = require('../inspect/store');
const { transitionTask, validateTask } = require('../tasks/model');
const store = require('../tasks/store');

const KNOWN_FLAGS = new Set(['projectRoot', 'input', 'json', 'help']);
const HELP = `
manual approve-tasks —— 人工确认、调整或拒绝候选任务

用法:
  manual approve-tasks --input <决策.json> [--project-root <路径>] [--json]

输入格式:
  { "decisions": [
    { "id": "edit-profile", "decision": "approve", "title": "修改个人资料", "goal": "...", "priority": "high" },
    { "id": "unused-task", "decision": "reject" }
  ] }

只有 candidate 可以被批准或拒绝；全部决策校验通过后才会一次性落盘。
`.trim();

function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else for (const error of list) process.stderr.write(`[manual approve-tasks] ${error}\n`);
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
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (!values.input) return fail('需要 --input <决策.json>。', json);

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const stateDir = path.join(projectRoot, loaded.config.artifacts.stateDir);
  const existing = store.readTasks(stateDir);
  if (existing.errors.length > 0) return fail(existing.errors, json);
  const pages = pageStore.readExistingPages(stateDir);
  if (pages.errors.length > 0) return fail(pages.errors, json);

  const inputErrors = [];
  const payload = readJson(values.input, inputErrors);
  if (inputErrors.length > 0) return fail(inputErrors, json);
  if (!payload || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
    return fail('输入需要形如 { "decisions": [ ... ] }，且不能为空。', json);
  }

  const byId = new Map(existing.tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const operations = [];
  const errors = [];

  payload.decisions.forEach((decision, index) => {
    const where = `decisions[${index}]`;
    if (!decision || typeof decision !== 'object' || typeof decision.id !== 'string') {
      errors.push(`${where} 缺少 id。`);
      return;
    }
    if (seen.has(decision.id)) {
      errors.push(`${where} 的 id 重复: ${decision.id}`);
      return;
    }
    seen.add(decision.id);
    const task = byId.get(decision.id);
    if (!task) {
      errors.push(`${where} 的任务不存在: ${decision.id}`);
      return;
    }
    if (task.status !== 'candidate') {
      errors.push(`${where}: 只有 candidate 可以批准或拒绝，${decision.id} 当前是 ${task.status}。`);
      return;
    }
    if (!['approve', 'reject'].includes(decision.decision)) {
      errors.push(`${where}.decision 需要是 approve 或 reject。`);
      return;
    }
    if (decision.decision === 'reject') {
      operations.push({ type: 'reject', task });
      return;
    }

    const editable = {};
    for (const field of ['title', 'goal', 'priority']) {
      if (decision[field] !== undefined) editable[field] = decision[field];
    }
    const next = transitionTask({ ...task, ...editable }, 'approved', { humanConfirmed: true });
    const checked = validateTask(next);
    if (!checked.ok) errors.push(...checked.errors.map((error) => `${where}: ${error}`));
    else operations.push({ type: 'approve', task: checked.task });
  });

  if (errors.length > 0) return fail(errors, json);

  const approved = [];
  const rejected = [];
  for (const operation of operations) {
    if (operation.type === 'approve') {
      store.writeTask(stateDir, operation.task);
      approved.push(operation.task.id);
    } else {
      store.removeTask(stateDir, operation.task.id);
      rejected.push(operation.task.id);
    }
  }
  const updatedTasks = store.readTasks(stateDir);
  pageStore.writeIndexes(stateDir, pages.pages, {
    docsOutputDir: loaded.config.docs.outputDir,
    tasks: updatedTasks.tasks,
  });

  const output = { ok: true, approved, rejected };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual approve-tasks] 已批准 ${approved.length} 个，拒绝 ${rejected.length} 个候选任务。\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
