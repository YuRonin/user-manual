'use strict';

/*
 * 标注证明（B2-12 / B2-13 / B2-15）。
 *
 * annotations.json 仍写在 .manual/artifacts/（可重建的大文件，含坐标与目标）；
 * 验收必需的精简证明另外内嵌进 Capture 记录（.manual/evidence/captures，随仓库提交）：
 * 清单、计划、逐项绘制结果、候选与修订号。重新 clone、删除 artifacts 后仍能核对覆盖率与正文说明。
 *
 * 修订号把"截图当时的定义"冻结下来：发布前与当前定义比较，变化只说明证据过期（annotation-plan-changed），
 * 不反过来改写历史截图的含义。
 */

const { revisionOf } = require('../util/hash');
const { pageInventory, stepInventory, buildPlan, verifyCoverage } = require('./coverage');
const { stepPageId } = require('../tasks/model');

const PROOF_VERSION = 1;

/**
 * 清单的可比较形态：只取决定"截图上要标什么"的字段（id、优先级、对应的 guide、目标）。
 * 标题与说明文字只影响正文，改它们不需要重新截图。
 */
function inventoryRevision(inventory = []) {
  return revisionOf(inventory.map((item) => ({
    feature_id: item.feature_id, priority: item.priority, guide_id: item.guide_id || null, target: item.target || null,
  })));
}

function planRevision(plan = []) {
  return revisionOf(plan.map((item) => ({ feature_id: item.feature_id, label: item.label || null, target: item.target || null, rect: item.rect || null })));
}

/** 写入 artifacts 的完整文档（含坐标），以及内嵌进 Capture 记录的精简证明。 */
function annotationArtifacts({ inventory, plan, rendered, candidates = [], coverage }) {
  const revisions = { inventoryRevision: inventoryRevision(inventory), planRevision: planRevision(plan) };
  const document = { version: 1, ...revisions, inventory, plan, rendered, candidates, coverage };
  const proof = {
    version: PROOF_VERSION,
    ...revisions,
    inventory: inventory.map((item) => ({ feature_id: item.feature_id, label: item.label || null, priority: item.priority, description: item.description || '', explanation_ref: item.explanation_ref || null, ...(item.guide_id ? { guide_id: item.guide_id } : {}), source: item.source || [] })),
    plan: plan.map((item) => ({ feature_id: item.feature_id, label: item.label || null, priority: item.priority, ...(item.guide_id ? { guide_id: item.guide_id } : {}) })),
    rendered: rendered.map((item) => ({ feature_id: item.feature_id, label: item.label || null, located: !!item.located, outlined: !!item.outlined, intersects: !!item.intersects, drawn: !!item.drawn, reason: item.reason || null,
      ...(item.visible !== undefined ? { visible: item.visible } : {}),
      ...(item.visibleRatio !== undefined ? { visibleRatio: item.visibleRatio, redactedRatio: item.redactedRatio } : {}) })),
    candidates: candidates.map((item) => ({ candidate_id: item.candidate_id, label: item.label, role: item.role })),
  };
  return { document, proof };
}

/** 由精简证明重算覆盖率（与采集时的 annotationCoverage 必须一致）。 */
function coverageFromProof(proof) {
  return verifyCoverage({ inventory: proof.inventory, plan: proof.plan, rendered: proof.rendered, candidates: proof.candidates || [] });
}

/**
 * 按当前模型重算这条 Capture 作用域内的清单（用于判断证据是否过期）。
 * @returns {{ inventory, page } | { missing: string }}
 */
function currentScope(model, record) {
  if (record.kind === 'page') {
    const page = model.pages.find((item) => item.id === record.subject?.pageId);
    if (!page) return { missing: `页面 ${record.subject?.pageId} 已不存在` };
    return { page, inventory: pageInventory({ page, scenarioId: record.scenarioId }) };
  }
  if (record.kind === 'task-step') {
    const task = model.tasks.find((item) => item.id === record.subject?.taskId);
    const step = task?.steps?.find((item) => item.id === record.subject?.stepId);
    const page = model.pages.find((item) => item.id === stepPageId(step));
    if (!task || !step || !page) return { missing: `任务步骤 ${record.subject?.taskId}/${record.subject?.stepId} 已不存在` };
    return { page, inventory: stepInventory({ page, task, step }) };
  }
  return { missing: `未知的 Capture 类型 ${record.kind}` };
}

/**
 * 冻结证据与当前定义的差异：清单变化、guide 编号与图上编号不一致（B2-09 / B2-13）。
 * 只对默认页面截图核对 guide 编号；变体与任务步骤的编号来自各自的声明。
 */
function staleness(proof, scope, record) {
  const problems = [];
  if (scope.missing) return [{ code: 'annotation-plan-changed', message: scope.missing }];
  if (proof.inventoryRevision && proof.inventoryRevision !== inventoryRevision(scope.inventory)) {
    problems.push({ code: 'annotation-plan-changed', message: '截图之后功能清单或其优先级 / 说明 / 目标发生了变化' });
  }
  if (record.kind === 'page' && record.scenarioId === `page-${scope.page.id}`) {
    const current = buildPlan({ inventory: scope.inventory, page: scope.page });
    const labels = new Map(current.filter((item) => item.guide_id).map((item) => [item.guide_id, item.label]));
    for (const item of proof.plan.filter((entry) => entry.guide_id)) {
      if (labels.has(item.guide_id) && labels.get(item.guide_id) !== item.label) {
        problems.push({ code: 'annotation-label-mismatch', message: `guide ${item.guide_id} 在图上是 ${item.label}，正文现在是 ${labels.get(item.guide_id)}` });
      }
    }
  }
  return problems;
}

module.exports = { PROOF_VERSION, inventoryRevision, planRevision, annotationArtifacts, coverageFromProof, currentScope, staleness };
