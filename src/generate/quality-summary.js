'use strict';

/*
 * 统一的质量结果（B3-08）与可配置门禁（B3-09）。
 *
 * quality 只汇总已经算出来的事实，不重新评分：步骤执行率、完成声明的验证状态、界面名称的来源、
 * 质量提示与门禁提示。它随 Run 任务保存，进入 generate --json 与 manual status。
 *
 * 门禁分两层：
 *   始终阻断   完成声明的断言实际失败（claim-failed）：文档会写出与界面相反的结论，不能靠配置放行。
 *              虚构界面名称（copy-blocked）、隐私、伪证据由各自的门槛阻断，这里不重复。
 *   可配置     config.quality.blockOn 列出的质量提示代码（如 completion-unbound、ui-term-not-observed）升级为阻断。
 *   严格模式   config.quality.mode: strict（public 受众默认）时，STRICT_BLOCK 中的提示也阻断；
 *              observe（internal 默认）只提示，但结果标 verified: false，不能当作"已验证"。
 *
 * 统一质量模型（B6-01）在一次生成里给出：inventoryReview / planCoverage / renderCoverage / documentationCoverage
 * （来自 Capture 记录的标注覆盖与正文说明）、steps（executedSteps）、claims（verifiedClaims）、privacy、freshness、warnings。
 */

/** 可以出现在 blockOn 里的提示代码（taskQuality / 事实包产生；带 :<id> 后缀的按前缀匹配）。 */
const BLOCKABLE = [
  'entry-missing', 'first-action-location-unreviewed', 'preconditions-missing', 'steps-missing', 'exceptions-unreviewed',
  'completion-unbound', 'completion-before-final-step', 'step-title-missing', 'ui-name-mismatch', 'before-image-target-mismatch',
  'screenshots-missing', 'step-image-missing', 'step-image-caption-unreviewed', 'image-timing-mismatch', 'goal-coverage-unreviewed',
  'image-unannotated', 'image-heavily-redacted', 'page-instructions-missing', 'ui-term-not-observed', 'steps-not-executed',
  'demo-evidence-legacy', 'demo-recapture-blocked',
];

const codeOf = (warning) => String(warning).split(':')[0];
const MODES = ['strict', 'observe'];
// 严格模式额外阻断：手册仍在用被门禁拦下前的旧图（B6-02）
const STRICT_BLOCK = ['demo-recapture-blocked'];

function modeOf(config) {
  return config?.quality?.mode || (config?.privacy?.audience === 'internal' ? 'observe' : 'strict');
}

/** 统一质量模型的证据部分：只用 Capture 记录里已经算好的结论，不重新评分。 */
function evidenceQuality(records = [], { markdown = null } = {}) {
  const shots = records.filter(Boolean);
  const coverages = shots.map((r) => r.annotationCoverage).filter(Boolean);
  const failures = coverages.flatMap((c) => c.failures || []);
  const planReasons = ['missing-from-plan', 'missing-from-task-plan'];
  const required = coverages.reduce((sum, c) => sum + Number(c.required?.total || 0), 0);
  const planMissing = failures.filter((f) => planReasons.includes(f.reason)).length;
  const renderFailed = failures.filter((f) => ![...planReasons, 'missing-from-inventory', 'description-missing'].includes(f.reason)).length;
  const pending = coverages.reduce((sum, c) => sum + (c.pending || []).length + (c.unresolvedCandidates || []).length, 0);
  // 没有已确认的 Required 时是 N/A（null），不是 100%
  const pct = (ok, total) => (total > 0 ? Math.round((100 * ok) / total) : null);
  let documentation = null;
  if (markdown !== null) {
    const { verifyExplanations } = require('../annotations/coverage');
    const inventory = [...new Map(shots.flatMap((r) => r.annotationProof?.inventory || []).map((item) => [item.feature_id, item])).values()];
    const total = inventory.filter((item) => item.priority === 'required').length;
    const missing = verifyExplanations(markdown, inventory).length;
    documentation = { required: total, missing, percent: pct(total - missing, total) };
  }
  return {
    inventoryReview: { pending, status: coverages.length < shots.length ? 'unknown' : pending ? 'pending-review' : 'reviewed' },
    planCoverage: { required, missing: planMissing, percent: pct(required - planMissing, required) },
    renderCoverage: { planned: required - planMissing, failed: renderFailed, percent: pct(required - planMissing - renderFailed, required - planMissing) },
    ...(documentation ? { documentationCoverage: documentation } : {}),
    privacy: {
      total: shots.length,
      passed: shots.filter((r) => r.privacy?.status === 'passed').length,
      demo: shots.filter((r) => r.privacy?.demo?.status === 'passed').length,
      legacy: shots.filter((r) => r.privacy && !r.privacy.demo).length,
    },
    freshness: { stale: shots.filter((r) => r.stale).length, observedAt: shots.map((r) => r.observedAt).filter(Boolean).sort()[0] || null },
  };
}

function validateQualityConfig(quality, errors) {
  if (quality === undefined) return;
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) { errors.push('quality 需要是对象。'); return; }
  if (quality.mode !== undefined && !MODES.includes(quality.mode)) errors.push(`quality.mode 只能是 ${MODES.join(' / ')}。`);
  if (quality.blockOn !== undefined) {
    if (!Array.isArray(quality.blockOn)) errors.push('quality.blockOn 需要是提示代码数组。');
    else for (const code of quality.blockOn) if (!BLOCKABLE.includes(code)) errors.push(`quality.blockOn 不认识的代码: ${code}（可用: ${BLOCKABLE.join(', ')}）`);
  }
}

/** 事实包派生的质量提示：taskQuality 的结果 + 只凭声明写进动作句的界面名称 + 未执行的步骤。 */
function packWarnings(pack) {
  const warnings = [...(pack?.quality?.warnings || [])];
  const observed = pack?.uiEvidence?.observed || [];
  for (const step of pack?.steps || []) {
    if (step.sentenceSource !== 'instruction' || !pack.uiEvidence) continue;
    const unseen = [...String(step.sentence || '').matchAll(/「([^」]+)」/g)].map((m) => m[1])
      .filter((term) => !observed.some((name) => name.includes(term) || term.includes(name)));
    if (unseen.length) warnings.push(`ui-term-not-observed:${step.id}`);
  }
  // Demo 截图状态（D-6）：采集于 Demo 模式之前的旧图（遮罩沿用旧版马赛克），或之后的重新采集被门禁阻断、仍在用旧图
  for (const artifact of pack?.artifacts || []) {
    if (artifact.privacy && !artifact.privacy.demo) warnings.push(`demo-evidence-legacy:${artifact.stepId || artifact.id}`);
    if (artifact.demoRecapture) warnings.push(`demo-recapture-blocked:${artifact.stepId || artifact.id}（${(artifact.demoRecapture.reasons || []).join(', ')}）`);
  }
  const skipped = (pack?.steps || []).filter((step) => step.executed === false).length;
  if (skipped) warnings.push(`steps-not-executed:${skipped}`);
  return [...new Set(warnings)];
}

/**
 * @param {object} pack           事实包
 * @param {object} [extra]
 * @param {string[]} [extra.gateWarnings]  发布门槛的提示（internal 下的待确认功能等）
 * @param {Array} [extra.review]           文案需要确认的发现
 */
function qualitySummary(pack, { gateWarnings = [], review = [], records = null, markdown = null, config = null } = {}) {
  if (!pack) return null;
  const steps = pack.kind === 'task' ? {
    total: pack.steps.length,
    executed: pack.steps.filter((step) => step.executed === true).length,
    notExecuted: pack.steps.filter((step) => step.executed === false).length,
  } : null;
  const claims = pack.kind === 'task' ? {
    total: (pack.claims || []).length,
    verified: (pack.claims || []).filter((claim) => claim.status === 'verified').length,
    failed: (pack.claims || []).filter((claim) => claim.status === 'failed').map((claim) => claim.id),
    unverified: (pack.claims || []).filter((claim) => !['verified', 'failed'].includes(claim.status)).map((claim) => claim.id),
  } : null;
  const warnings = packWarnings(pack);
  const mode = modeOf(config);
  return {
    kind: pack.kind,
    mode,
    // observe 模式、或仍有质量提示时都不能宣称"已验证"
    verified: mode === 'strict' && !warnings.length && !gateWarnings.length,
    ...(steps ? { steps, executedSteps: steps.executed } : {}),
    ...(claims ? { claims, verifiedClaims: claims.verified } : {}),
    ...(records ? evidenceQuality(records, { markdown }) : {}),
    ...(pack.evidenceCoverage ? { operationCoverage: pack.evidenceCoverage, resultEvidence: (pack.resultEvidence || []).map(c => ({ taskId: c.taskId, claimId: c.id, status: c.status, provenance: c.provenance })) } : {}),
    ...(pack.sections?.length ? { featureScope: { total: pack.features.length, selected: new Set(pack.sections.flatMap(s => s.featureRefs)).size,
      decisions: Object.fromEntries(['required', 'optional', 'skip', 'undecided'].map(priority => [priority, pack.features.filter(f => f.priority === priority).length])) } } : {}),
    uiTerms: { observed: (pack.uiEvidence?.observed || []).length, declaredOnly: pack.uiEvidence?.declared || [] },
    warnings,
    review: [...new Set(review.map((item) => item.code))],
    gate: gateWarnings,
  };
}

/** 发布前的质量门禁；返回 [{ code, message }]，空数组表示放行。 */
function qualityGate(pack, config) {
  const errors = [];
  const failed = (pack?.claims || []).filter((claim) => claim.status === 'failed');
  if (failed.length) errors.push({ code: 'claim-failed', message: `完成声明的断言实际未通过：${failed.map((claim) => `${claim.id}（${claim.text}）`).join('、')}；文档不能写出与界面相反的结论。` });
  const blockOn = new Set([...(config?.quality?.blockOn || []), ...(modeOf(config) === 'strict' ? STRICT_BLOCK : [])]);
  const hits = packWarnings(pack).filter((warning) => blockOn.has(codeOf(warning)));
  if (hits.length) errors.push({ code: 'quality-blocked', message: `质量提示按 quality.blockOn 阻断发布：${hits.join('、')}` });
  return errors;
}

module.exports = { BLOCKABLE, MODES, STRICT_BLOCK, modeOf, validateQualityConfig, packWarnings, qualitySummary, qualityGate, evidenceQuality };
