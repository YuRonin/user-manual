'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { emit } = require('../util/yaml-emit');
const { writeText } = require('../util/fsx');
const { validateTask } = require('./model');

function tasksDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'tasks');
}

function taskFileFor(stateDirAbs, id) {
  return path.join(tasksDirFor(stateDirAbs), `${id}.yaml`);
}

function renderTaskYaml(input) {
  const result = validateTask(input);
  if (!result.ok) throw new Error(`任务无效：${result.errors.join('；')}`);
  const task = result.task;
  const ordered = {
    id: task.id,
    title: task.title,
    goal: task.goal,
    entryPage: task.entryPage,
    priority: task.priority,
    preconditions: task.preconditions,
    risk: task.risk,
    // 兼容投影：最近完成的操作。能否执行看 approval，证据是否过期由 lastCapture 与当前定义比较得出。
    status: task.status,
    approval: task.approval ?? null,
    steps: task.steps,
    completion: task.completion,
    branches: task.branches,
    relatedTasks: task.relatedTasks,
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    capturePlan: task.capturePlan ?? null,
    // 权威证据引用：本任务最近一次采集提交的 Capture 记录 id（.manual/evidence/captures/<id>.json）
    captureIds: Array.isArray(task.captureIds) ? task.captureIds : [],
    lastCapture: task.lastCapture ?? null,
    stale: task.stale ?? null,
    lastVerification: task.lastVerification ?? null,
    // 兼容视图：旧 evidence manifest 路径，内容由上面的 Capture 记录派生
    evidenceManifest: task.evidenceManifest ?? null,
  };
  // 本版本不认识的字段原样保留在末尾，不因重写任务文件而丢失用户内容。
  for (const [key, value] of Object.entries(input || {})) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  const header = [
    `# .manual/tasks/${task.id}.yaml`,
    '# 候选任务必须经 manual approve-tasks 人工确认后才能进入采集与发布阶段。',
    '',
  ].join('\n');
  return header + emit(ordered);
}

function writeTask(stateDirAbs, task) {
  const file = taskFileFor(stateDirAbs, task.id);
  writeText(file, renderTaskYaml(task));
  return file;
}

function readTask(stateDirAbs, id) {
  const file = taskFileFor(stateDirAbs, id);
  if (!fs.existsSync(file)) return null;
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function readTasks(stateDirAbs) {
  const dir = tasksDirFor(stateDirAbs);
  const tasks = [];
  const errors = [];
  if (!fs.existsSync(dir)) return { tasks, errors };

  for (const name of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(name)) continue;
    try {
      const parsed = yaml.load(fs.readFileSync(path.join(dir, name), 'utf8'));
      const result = validateTask(parsed);
      if (!result.ok) errors.push(`${name}: ${result.errors.join('；')}`);
      else tasks.push(result.task);
    } catch (error) {
      errors.push(`${name}: ${error.message}`);
    }
  }
  return { tasks, errors };
}

function removeTask(stateDirAbs, id) {
  const file = taskFileFor(stateDirAbs, id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

module.exports = {
  tasksDirFor,
  taskFileFor,
  renderTaskYaml,
  writeTask,
  readTask,
  readTasks,
  removeTask,
};
