'use strict';

/*
 * 用户任务的执行审批（契约 C03）。
 *
 * 审批确认的是"允许浏览器替用户做哪些事"，所以 scopeHash 只覆盖影响执行的内容：
 * 步骤顺序、所属页面、动作与目标、valueRef、风险与 replay、前后状态（连同页面上这些状态的断言）、
 * 环境 / fixture / 前置条件，以及完成声明。标题、目标描述、步骤说明文字、优先级只是措辞，
 * 修改它们会产生新的定义 revision，但不要求重新审批。
 *
 * 状态机不再由 task.status 表达：approval 决定能不能执行；新鲜度由证据与当前定义比较得出；
 * 执行结果记录在 Capture 与 lastCapture 上。
 */

const { revision, pickDefinitionFields } = require('./revision');
const { effectiveRisk } = require('../tasks/model');

const APPROVAL_STATES = {
  APPROVED: 'approved', // 有审批且范围与当前定义一致
  PENDING: 'pending', // 候选任务，还没人确认
  REJECTED: 'rejected',
  SCOPE_CHANGED: 'scope-changed', // 批准后动作/断言/风险等发生变化，需要重新确认
  LEGACY: 'legacy-unverified', // 旧版本只有 status，没有可核对的范围
};

function stateAssertions(pagesById, pageId, stateId) {
  const page = pagesById.get(pageId);
  if (!page) return null;
  if (stateId === 'default' && !page.states?.default) return [{ type: 'url', value: page.route }];
  return page.states?.[stateId]?.assertions ?? null;
}

/** 审批范围：只含影响执行与结论的字段。pages 用于把状态名解析成实际断言。 */
function approvalScope(task, pages = []) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const steps = (task.steps || []).map((step) => {
    const pageId = step.pageId ?? step.page;
    const before = step.stateBefore || 'default';
    const after = step.stateAfter || before;
    return {
      id: step.id,
      pageId: pageId ?? null,
      action: step.action ?? null,
      valueRef: step.valueRef ?? step.action?.valueRef ?? null,
      risk: effectiveRisk(task, step) ?? null,
      replay: step.replay ?? null,
      stateBefore: before,
      stateAfter: after,
      beforeAssertions: stateAssertions(pagesById, pageId, before),
      afterAssertions: stateAssertions(pagesById, pageId, after),
    };
  });
  const claims = (task.completion?.claims || task.completionClaims || []).map((claim) => ({
    id: claim.id,
    text: claim.text ?? null,
    assertionRefs: claim.assertionRefs ?? [],
    checkpoint: claim.checkpoint ?? null,
  }));
  return {
    entryPage: task.entryPage ?? null,
    entryAssertions: stateAssertions(pagesById, task.entryPage, 'default'),
    environment: task.environment ?? null,
    fixtures: task.fixtures ?? null,
    preconditions: task.preconditions ?? [],
    steps,
    claims,
  };
}

function scopeHash(task, pages = []) {
  return revision(JSON.parse(JSON.stringify(approvalScope(task, pages))));
}

/** 生成一条审批记录。actor / decisionRef 由宿主传入，仅作审计信息，不是认证。 */
function approve(task, pages, { actor = null, decisionRef = null, at = new Date().toISOString() } = {}) {
  return { status: 'approved', scopeHash: scopeHash(task, pages), approvedAt: at, actor, decisionRef };
}

/** 当前审批状态（派生，不写回）。 */
function approvalState(task, pages = []) {
  const approval = task?.approval;
  if (approval && typeof approval === 'object') {
    if (approval.status === 'rejected') return APPROVAL_STATES.REJECTED;
    if (approval.status !== 'approved') return APPROVAL_STATES.PENDING;
    if (!approval.scopeHash) return APPROVAL_STATES.LEGACY;
    return approval.scopeHash === scopeHash(task, pages) ? APPROVAL_STATES.APPROVED : APPROVAL_STATES.SCOPE_CHANGED;
  }
  // 旧文件只有 status：候选就是待审批；其它状态说明"曾经批准"，但范围无从核对。
  if (!task?.status || task.status === 'candidate') return APPROVAL_STATES.PENDING;
  return APPROVAL_STATES.LEGACY;
}

/** 审批状态对应的用户提示。 */
function approvalMessage(state, taskId) {
  switch (state) {
    case APPROVAL_STATES.PENDING:
      return `approval-required: 任务 ${taskId} 还没有被批准，先运行 manual approve-tasks。`;
    case APPROVAL_STATES.REJECTED:
      return `approval-rejected: 任务 ${taskId} 已被拒绝。`;
    case APPROVAL_STATES.SCOPE_CHANGED:
      return `approval-scope-changed: 任务 ${taskId} 批准后动作、断言或风险发生了变化，需要用 manual approve-tasks 重新确认。`;
    case APPROVAL_STATES.LEGACY:
      return `approval-scope-unknown: 任务 ${taskId} 来自旧版本，只有状态没有审批范围；用 manual approve-tasks 重新确认一次。`;
    default:
      return null;
  }
}

/**
 * 页面中会影响"看到什么"的定义部分：路由、入口与源文件、状态与身份断言。
 * 标题、用途这类文案改动不让已有截图过期。
 */
function pageObservationRevision(page) {
  const picked = pickDefinitionFields('page', page);
  const { title, purpose, detectedActions, includeInManual, ...observable } = picked;
  return revision(observable);
}

/** 任务涉及的页面及其当前可观察定义 revision。 */
function pageRevisionsFor(task, pages = []) {
  const ids = new Set([task.entryPage, ...(task.steps || []).map((step) => step.pageId ?? step.page)].filter(Boolean));
  const out = {};
  for (const page of pages) if (ids.has(page.id)) out[page.id] = pageObservationRevision(page);
  return out;
}

const LEGACY_EVIDENCE_STATUSES = ['captured', 'generated', 'verified'];

/**
 * 证据新鲜度（派生，不存储）：把最近一次采集时记录的输入与当前定义比较。
 * @returns {{ status: 'fresh'|'stale'|'missing'|'legacy', reasons: string[] }}
 *   legacy = 旧版本采集（没有 lastCapture），无法比较，只能沿用并提示重新采集。
 */
function evidenceFreshness(task, pages = []) {
  const reasons = [];
  if (task?.status === 'stale') reasons.push('legacy-stale-status');
  if (task?.stale && typeof task.stale === 'object') reasons.push(...(task.stale.reasons || ['marked-stale']));
  const last = task?.lastCapture;
  if (!last || typeof last !== 'object') {
    if (reasons.length) return { status: 'stale', reasons };
    if (task?.evidenceManifest && LEGACY_EVIDENCE_STATUSES.includes(task.status)) return { status: 'legacy', reasons: ['no-capture-record'] };
    return { status: 'missing', reasons: ['never-captured'] };
  }
  if (last.scopeHash !== scopeHash(task, pages)) reasons.push('scope-changed');
  const current = pageRevisionsFor(task, pages);
  for (const [pageId, rev] of Object.entries(last.pageRevisions || {})) {
    if (current[pageId] !== rev) reasons.push(`page-changed:${pageId}`);
  }
  return reasons.length ? { status: 'stale', reasons } : { status: 'fresh', reasons: [] };
}

/**
 * 生成 / 定稿 / 验证共用的前提：任务已获批（或来自旧版本的已采集任务），且证据没有过期。
 * 不看 status 的先后顺序，所以这些操作都可以重复执行。
 */
function checkEvidenceUsable(task, pages = []) {
  const approval = approvalState(task, pages);
  if (approval === APPROVAL_STATES.PENDING || approval === APPROVAL_STATES.REJECTED) {
    return { ok: false, code: approval, errors: [approvalMessage(approval, task.id)] };
  }
  const freshness = evidenceFreshness(task, pages);
  if (freshness.status === 'missing') {
    return { ok: false, code: 'evidence-missing', errors: [`evidence-missing: 任务 ${task.id} 还没有采集证据，先运行 manual capture-task ${task.id}。`] };
  }
  if (freshness.status === 'stale') {
    return {
      ok: false,
      code: 'evidence-stale',
      errors: [`evidence-stale: 任务 ${task.id} 的证据已过期（${freshness.reasons.join(', ')}）。${approval === APPROVAL_STATES.SCOPE_CHANGED ? '先用 manual approve-tasks 重新确认，再' : ''}重新运行 manual capture-task ${task.id}。`],
    };
  }
  return { ok: true, approval, freshness };
}

module.exports = {
  APPROVAL_STATES, approvalScope, scopeHash, approve, approvalState, approvalMessage,
  pageObservationRevision, pageRevisionsFor, evidenceFreshness, checkEvidenceUsable,
};
