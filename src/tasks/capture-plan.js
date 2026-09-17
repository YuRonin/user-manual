'use strict';

const path = require('path');
const { writeText } = require('../util/fsx');
const { effectiveRisk } = require('./model');

function implicitDefaultState(page) {
  return {
    description: `${page.title || page.id}初始状态`,
    assertions: [{ type: 'url', value: page.route }],
  };
}

function executionFor(risk) {
  if (risk === 'destructive') return 'never';
  if (risk === 'write') return 'stop-before-action';
  return 'auto';
}

function buildCapturePlan(task, pages) {
  const errors = [];
  if (!task || task.status !== 'approved') {
    return { ok: false, errors: ['只有 approved 任务可以生成截图计划。'] };
  }
  const byId = new Map(pages.map((page) => [page.id, page]));
  const entryPage = byId.get(task.entryPage);
  if (!entryPage) errors.push(`入口页面不存在: ${task.entryPage}`);

  const steps = (task.steps || []).map((step, index) => {
    const page = byId.get(step.page);
    if (!page) {
      errors.push(`steps[${index}] 引用不存在的页面: ${step.page}`);
      return null;
    }
    const states = { default: implicitDefaultState(page), ...(page.states || {}) };
    const before = step.stateBefore || 'default';
    const after = step.stateAfter || before;
    if (!states[before]) errors.push(`steps[${index}].stateBefore 不存在: ${before}`);
    if (!states[after]) errors.push(`steps[${index}].stateAfter 不存在: ${after}`);
    const risk = effectiveRisk(task, step);
    const execution = executionFor(risk);
    return {
      id: step.id,
      instruction: step.instruction,
      page: step.page,
      route: page.route,
      stateBefore: before,
      action: step.action,
      risk,
      execution,
      willExecute: execution === 'auto',
      expectedState: execution === 'auto' ? { id: after, ...states[after] } : null,
      capture: step.capture || null,
    };
  }).filter(Boolean);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    plan: {
      version: 1,
      taskId: task.id,
      taskTitle: task.title,
      createdAt: new Date().toISOString(),
      entry: { page: entryPage.id, route: entryPage.route, state: 'default' },
      steps,
    },
  };
}

function writeCapturePlan(stateDirAbs, plan) {
  const file = path.join(stateDirAbs, 'artifacts', 'manifests', `${plan.taskId}--capture-plan.json`);
  writeText(file, JSON.stringify(plan, null, 2) + '\n');
  return file;
}

module.exports = { buildCapturePlan, writeCapturePlan, implicitDefaultState };
