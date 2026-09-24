'use strict';

/*
 * 完成声明（completion claim）的验证状态由证据计算，而不是由任务定义里的字符串决定。
 *
 * 一条 claim 引用若干 assertionId；只有这些断言在本次证据中都 passed，且来自正确的
 * 检查点（after 阶段 / 指定步骤），claim 才是 verified。"编辑器已打开"可以被
 * 编辑器断言证明；"资料已保存"不能——保存步骤没执行，它的断言就是 not_run。
 */

const CLAIM_STATUSES = ['verified', 'failed', 'not_run', 'legacy-unbound'];

/** 任务里的 claims；旧任务只有 description/verification 时转为未绑定证据的 legacy claim。 */
function claimsOf(task) {
  const completion = task.completion || {};
  if (Array.isArray(completion.claims) && completion.claims.length > 0) return completion.claims;
  return [{ id: 'completion', text: completion.description, assertionRefs: [], legacy: true }];
}

/** 证据中所有可以支撑 claim 的验证记录（入口身份 + 各步骤 after 阶段）。 */
function collectValidations(evidence) {
  const out = [];
  for (const validation of evidence?.validations || []) {
    if (validation.assertionId) out.push({ ...validation, stepId: null });
  }
  for (const step of evidence?.steps || []) {
    for (const validation of step.validations || []) {
      if (validation.assertionId && validation.phase === 'after') out.push({ ...validation, stepId: step.id });
    }
  }
  return out;
}

/**
 * @returns {Array<{ id, text, status, assertionRefs, checkpoint, evidence: Array<{assertionId, stepId, scope, checkedAt}> }>}
 */
function computeClaims(task, evidence) {
  const validations = collectValidations(evidence);
  return claimsOf(task).map((claim) => {
    const refs = Array.isArray(claim.assertionRefs) ? claim.assertionRefs : [];
    const base = { id: claim.id, text: claim.text, assertionRefs: refs, checkpoint: claim.checkpoint || null };
    if (claim.legacy || refs.length === 0) return { ...base, status: 'legacy-unbound', evidence: [] };
    const matched = [];
    let failed = false;
    let missing = false;
    for (const ref of refs) {
      const candidates = validations.filter((v) => v.assertionId === ref && (!claim.checkpoint || v.stepId === claim.checkpoint));
      if (candidates.some((v) => v.outcome === 'failed')) failed = true;
      const hit = candidates.find((v) => v.outcome === 'passed');
      if (hit) matched.push({ assertionId: ref, stepId: hit.stepId, scope: hit.scope, checkedAt: hit.checkedAt });
      else missing = true;
    }
    const status = failed ? 'failed' : (missing ? 'not_run' : 'verified');
    return { ...base, status, evidence: status === 'verified' ? matched : [] };
  });
}

/** Markdown 中 claim 的标签：只有 verified 能写"已验证界面结果"。 */
function claimLabel(status) {
  return status === 'verified' ? '已验证界面结果：' : '预期业务结果：';
}

module.exports = { CLAIM_STATUSES, claimsOf, computeClaims, claimLabel, collectValidations };
