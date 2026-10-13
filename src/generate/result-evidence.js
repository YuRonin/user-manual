'use strict';

const path = require('path');
const releases = require('../publication/release-store');
const { loadVerify, prepareVerify } = require('../verify/artifacts');
const { operationsOf } = require('../annotations/section-plan');
const { createCaptureStore } = require('../evidence/store');
const { verifyCaptureRecord } = require('../evidence/integrity');

function frozenClaimValid(projectRoot, store, claim) {
  if (claim?.status !== 'verified' || !claim.releaseId || !claim.assertionRefs?.length || !claim.evidence?.length) return false;
  return claim.assertionRefs.every(id => claim.evidence.some(e => {
    if (e.assertionId !== id || !e.captureId || !e.stepId || (claim.checkpoint && claim.checkpoint !== e.stepId)) return false;
    const record = store.read(e.captureId);
    return record?.kind === 'task-step' && record.subject?.taskId === claim.taskId && record.subject?.stepId === e.stepId && record.subject?.timing === 'after'
      && record.provenance?.mode !== 'simulated' && record.privacy?.status === 'passed'
      && verifyCaptureRecord(projectRoot, record, { kinds: ['published'] }).ok
      && record.validations?.some(v => v.assertionId === id && v.phase === 'after' && v.outcome === 'passed');
  }));
}

// A page may cite an approved task's published result, never manufacture a claim
// from an entry screenshot. Simulated and unexecuted claims remain unverified.
function resultEvidence({ projectRoot, config, page, frozen = null }) {
  const state = path.join(projectRoot, config.artifacts.stateDir);
  const claims = [], errors = [];
  const store = createCaptureStore({ projectRoot, stateDirAbs: state });
  const included = new Set((page.sections || []).flatMap(s => s.featureRefs));
  const requested = operationsOf(page).filter(o => o.evidenceRequirement === 'result' && included.has(o.featureId));
  for (const op of requested) {
    const prior = frozen?.find(c => c.taskId === op.taskId && c.id === op.claimId);
    if (frozen !== null) {
      if (frozenClaimValid(projectRoot, store, prior)) claims.push(prior);
      else errors.push({ code: 'manual-result-unverified', operationId: op.id, message: `${op.id}: 冻结的任务结果证据缺失、失效或不属于动作后的真实检查点` });
      continue;
    }
    const release = prior ? releases.readRelease(state, releases.manualIdFor('task', op.taskId), prior.releaseId)
      : releases.readCurrentRelease(state, releases.manualIdFor('task', op.taskId));
    const loaded = loadVerify(projectRoot, config, op.taskId);
    const checked = loaded.ok ? prepareVerify({ root: projectRoot, config, ...loaded, ...(prior && release ? { release, facts: release.facts } : {}) }) : loaded;
    const claim = release?.facts?.factPack?.claims?.find(c => c.id === op.claimId);
    if (!checked.ok || claim?.status !== 'verified' || !claim.evidence?.length || (prior && prior.factsHash !== release.facts?.factPack?.factsHash)) {
      errors.push({ code: 'manual-result-unverified', operationId: op.id, message: `${op.id}: 任务 ${op.taskId} 的 ${op.claimId} 没有有效的已发布真实结果证据` });
      continue;
    }
    const frozenClaim = { ...claim, taskId: op.taskId, releaseId: release.id, factsHash: release.facts.factPack.factsHash, provenance: 'task-executed' };
    if (!frozenClaimValid(projectRoot, store, frozenClaim)) { errors.push({ code: 'manual-result-unverified', operationId: op.id, message: `${op.id}: 结果必须有动作后 Capture 及对应真实断言` }); continue; }
    claims.push(frozenClaim);
  }
  return { claims, errors };
}

module.exports = { resultEvidence, frozenClaimValid };
