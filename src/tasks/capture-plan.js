'use strict';

const path = require('path');
const { writeText } = require('../util/fsx');
const { effectiveRisk } = require('./model');
const { approvalState, approvalMessage, scopeHash, APPROVAL_STATES } = require('../model/approval');
const { resolveRouteTemplate } = require('../scenarios/model');

// 执行前的保守分类：步骤没有显式声明风险、却对着"保存/删除/提交/支付"这类目标动作时，
// 不把它当作 read/local 自动执行，而是停在动作之前等人确认。
const RISKY_TARGET_RE = /删除|移除|注销|清空|提交|保存|支付|付款|购买|确认|发送|发布|撤销|delete|remove|submit|save|pay|purchase|confirm|send|publish|destroy|revoke/i;
const REPLAY_BY_EXECUTION = { auto: 'safe', 'stop-before-action': 'requires-input', never: 'unsafe' };

function targetLabel(action) {
  const target = action?.target || {};
  return [target.name, target.text, target.label].filter(Boolean).join(' ');
}

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

/**
 * @param {object} task
 * @param {object[]} pages
 * @param {{ params?: object, scenario?: object }} [options]  scenario 为本次执行固定的 Scenario
 */
function buildCapturePlan(task, pages, options = {}) {
  const errors = [];
  if (!task) return { ok: false, errors: ['任务不存在。'] };
  // 能否执行由审批范围决定，而不是 status：同一获批任务可以反复采集，范围一变就要重新确认。
  const approval = approvalState(task, pages);
  if (approval !== APPROVAL_STATES.APPROVED) return { ok: false, code: approval, errors: [approvalMessage(approval, task.id)] };
  const byId = new Map(pages.map((page) => [page.id, page]));
  const entryPage = byId.get(task.entryPage);
  if (!entryPage) errors.push(`入口页面不存在: ${task.entryPage}`);
  for (const pageId of new Set([task.entryPage, ...(task.steps || []).map((step) => step.page)])) {
    const lifecycle = byId.get(pageId)?.lifecycle || 'active';
    if (byId.has(pageId) && lifecycle !== 'active') errors.push(`page-not-active: 页面 ${pageId} 当前是 ${lifecycle}，不能采集。`);
  }
  const params = options.params || options.scenario?.entry?.params || task.params || {};
  let entryRoute = null;
  if (entryPage) {
    const resolved = resolveRouteTemplate(entryPage.route, params);
    if (resolved.ok) entryRoute = resolved.route;
    else {
      if (resolved.missing.length) errors.push(`入口页面 ${entryPage.id} 是动态路由 ${entryPage.route}，缺少参数: ${resolved.missing.join(', ')}`);
      if (resolved.invalid.length) errors.push(`路由参数格式不对（catch-all 需要字符串数组）: ${resolved.invalid.join(', ')}`);
    }
  }

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
    // 状态必须能被断言验证：空断言的状态无法区分"到达"与"没到达"。
    for (const id of new Set([before, after])) {
      if (states[id] && !(states[id].assertions || []).length) errors.push(`页面 ${page.id} 的状态 ${id} 没有任何断言。`);
    }
    const risk = effectiveRisk(task, step);
    let execution = executionFor(risk);
    let riskReason = null;
    if (execution === 'auto' && step.risk === undefined && step.action?.type !== 'inspect' && RISKY_TARGET_RE.test(targetLabel(step.action))) {
      execution = 'stop-before-action';
      riskReason = 'unclassified-high-risk';
    }
    const previousPage = index === 0 ? task.entryPage : task.steps[index - 1].page;
    return {
      id: step.id,
      instruction: step.instruction,
      page: step.page,
      route: page.route,
      stateBefore: before,
      beforeState: states[before] ? { id: before, ...states[before] } : null,
      action: step.action,
      risk,
      riskReason,
      replay: step.replay || REPLAY_BY_EXECUTION[execution],
      execution,
      willExecute: execution === 'auto',
      // 跨页面步骤：执行前的 stateBefore 断言会确认已经到达新页面
      crossPage: step.page !== previousPage,
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
      approvalScopeHash: scopeHash(task, pages),
      scenario: options.scenario ? { id: options.scenario.id, revision: options.scenario.revision, authProfile: options.scenario.authProfile } : null,
      entry: {
        page: entryPage.id,
        route: entryRoute,
        routeTemplate: entryPage.route,
        params,
        state: 'default',
        assertions: ({ default: implicitDefaultState(entryPage), ...(entryPage.states || {}) }).default.assertions || [],
      },
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
