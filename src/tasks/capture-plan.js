'use strict';

const path = require('path');
const { writeText } = require('../util/fsx');
const { effectiveRisk, stepPageId } = require('./model');
const { stepFeatures } = require('../annotations/coverage');
const { approvalState, approvalMessage, scopeHash, pageRevisionsFor, APPROVAL_STATES } = require('../model/approval');
const { definitionRevision } = require('../model/revision');
const { resolveEntryLocation } = require('../scenarios/model');

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
  for (const pageId of new Set([task.entryPage, ...(task.steps || []).map(stepPageId)])) {
    const lifecycle = byId.get(pageId)?.lifecycle || 'active';
    if (byId.has(pageId) && lifecycle !== 'active') errors.push(`page-not-active: 页面 ${pageId} 当前是 ${lifecycle}，不能采集。`);
  }
  const params = options.params || options.scenario?.entry?.params || task.params || {};
  let entryRoute = null;
  let entrySearch = '';
  if (entryPage) {
    // 显式 Scenario 可用 entry.path / entry.query 打开具体内容；query 只用于打开，不进入 route 与证据
    // 显式传入的 params 优先于 Scenario 的 path（与页面采集的 --params 覆盖一致）
    const entry = { ...(options.scenario?.entry || {}), params, ...(options.params ? { path: undefined } : {}) };
    const resolved = resolveEntryLocation(entryPage.route, entry);
    if (resolved.ok) { entryRoute = resolved.route; entrySearch = resolved.search; }
    else {
      if (resolved.missing.length) errors.push(`入口页面 ${entryPage.id} 是动态路由 ${entryPage.route}，缺少参数: ${resolved.missing.join(', ')}`);
      if (resolved.invalid.length) errors.push(`入口无法解析（catch-all 需要字符串数组；entry.path 需在入口页面路由之内）: ${resolved.invalid.join(', ')}`);
    }
  }

  const steps = (task.steps || []).map((step, index) => {
    const pageId = stepPageId(step);
    const page = byId.get(pageId);
    if (!page) {
      errors.push(`steps[${index}] 引用不存在的页面: ${pageId}`);
      return null;
    }
    const states = { default: implicitDefaultState(page), ...(page.states || {}) };
    const before = step.stateBefore || 'default';
    const nextPage = stepPageId(task.steps[index + 1]);
    const pageAfter = step.pageAfter || (!step.stateAfter && step.action?.type === 'click' && nextPage && nextPage !== pageId ? nextPage : pageId);
    const destination = byId.get(pageAfter);
    if (!destination || (destination.lifecycle && destination.lifecycle !== 'active')) errors.push(`steps[${index}].pageAfter 不存在或不可用: ${pageAfter}`);
    const afterStates = destination ? { default: implicitDefaultState(destination), ...(destination.states || {}) } : {};
    const after = step.stateAfter || (pageAfter !== pageId ? 'default' : before);
    if (!states[before]) errors.push(`steps[${index}].stateBefore 不存在: ${before}`);
    if (!afterStates[after]) errors.push(`steps[${index}].stateAfter 不存在: ${after}`);
    // 状态必须能被断言验证：空断言的状态无法区分"到达"与"没到达"。
    for (const state of [states[before], afterStates[after]]) {
      if (state && !(state.assertions || []).length) errors.push(`页面 ${page.id} 的状态没有任何断言。`);
    }
    const risk = effectiveRisk(task, step);
    let execution = executionFor(risk);
    if (risk === 'write' && !options.preflight && require('./write-policy').permitsWrite(task, step, options.config)) execution = 'auto';
    let riskReason = null;
    if (execution === 'auto' && step.risk === undefined && step.action?.type !== 'inspect' && RISKY_TARGET_RE.test(targetLabel(step.action))) {
      execution = 'stop-before-action';
      riskReason = 'unclassified-high-risk';
    }
    const previousPage = index === 0 ? task.entryPage : stepPageId(task.steps[index - 1]);
    return {
      id: step.id,
      // 任务内原始序号（1 起）：隐式动作标注用它编号，与正文步骤号一致
      number: index + 1,
      ...(step.feature_id ? { feature_id: step.feature_id } : {}),
      instruction: step.instruction,
      page: pageId,
      route: page.route,
      stateBefore: before,
      beforeState: states[before] ? { id: before, ...states[before] } : null,
      pageAfter,
      requires: step.requires || [],
      assertionTimeoutMs: step.assertionTimeoutMs || null,
      ...(risk === 'write' && execution === 'auto' ? { writeOrigin: task.writeAuthorization.origin, writeExpiresAt: task.writeAuthorization.expiresAt } : {}),
      action: step.action,
      risk,
      riskReason,
      replay: risk === 'write' ? 'requires-input' : (step.replay || REPLAY_BY_EXECUTION[execution]),
      execution,
      willExecute: execution === 'auto',
      // 跨页面步骤：执行前的 stateBefore 断言会确认已经到达新页面
      crossPage: pageId !== previousPage,
      expectedState: execution === 'auto' ? { id: after, page: pageAfter, ...afterStates[after] } : null,
      capture: step.capture ? { ...step.capture,
        // 只带归属本步骤的功能（feature_id 或目标与动作一致），不按 task_ids 注入到每一步
        features: stepFeatures({ page, task, step }),
        annotations: (step.capture.annotations || []).map((a, markerIndex) => ({ ...a, label: String(markerIndex + 1) })),
      } : null,
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
      // 执行所依据的定义：截图记录与 Run 计划都引用它；执行时不再无声地重建另一份内容。
      modelRevision: definitionRevision('userTask', task),
      pageRevisions: pageRevisionsFor(task, pages),
      scenario: options.scenario ? { id: options.scenario.id, revision: options.scenario.revision, authProfile: options.scenario.authProfile } : null,
      entry: {
        page: entryPage.id,
        route: entryRoute,
        ...(entrySearch ? { search: entrySearch } : {}),
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
