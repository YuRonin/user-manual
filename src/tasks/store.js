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
    status: task.status,
    steps: task.steps,
    completion: task.completion,
    branches: task.branches,
    relatedTasks: task.relatedTasks,
    evidence: Array.isArray(task.evidence) ? task.evidence : [],
    capturePlan: task.capturePlan ?? null,
    evidenceManifest: task.evidenceManifest ?? null,
  };
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
