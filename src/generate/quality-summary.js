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
 */

/** 可以出现在 blockOn 里的提示代码（taskQuality / 事实包产生；带 :<id> 后缀的按前缀匹配）。 */
const BLOCKABLE = [
  'entry-missing', 'first-action-location-unreviewed', 'preconditions-missing', 'steps-missing', 'exceptions-unreviewed',
  'completion-unbound', 'completion-before-final-step', 'step-title-missing', 'ui-name-mismatch', 'before-image-target-mismatch',
  'screenshots-missing', 'step-image-missing', 'step-image-caption-unreviewed', 'image-timing-mismatch', 'goal-coverage-unreviewed',
  'image-unannotated', 'image-heavily-redacted', 'page-instructions-missing', 'ui-term-not-observed', 'steps-not-executed',
];

const codeOf = (warning) => String(warning).split(':')[0];

function validateQualityConfig(quality, errors) {
  if (quality === undefined) return;
  if (!quality || typeof quality !== 'object' || Array.isArray(quality)) { errors.push('quality 需要是对象。'); return; }
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
function qualitySummary(pack, { gateWarnings = [], review = [] } = {}) {
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
  return {
    kind: pack.kind,
    ...(steps ? { steps } : {}),
    ...(claims ? { claims } : {}),
    uiTerms: { observed: (pack.uiEvidence?.observed || []).length, declaredOnly: pack.uiEvidence?.declared || [] },
    warnings: packWarnings(pack),
    review: [...new Set(review.map((item) => item.code))],
    gate: gateWarnings,
  };
}

/** 发布前的质量门禁；返回 [{ code, message }]，空数组表示放行。 */
function qualityGate(pack, config) {
  const errors = [];
  const failed = (pack?.claims || []).filter((claim) => claim.status === 'failed');
  if (failed.length) errors.push({ code: 'claim-failed', message: `完成声明的断言实际未通过：${failed.map((claim) => `${claim.id}（${claim.text}）`).join('、')}；文档不能写出与界面相反的结论。` });
  const blockOn = new Set(config?.quality?.blockOn || []);
  const hits = packWarnings(pack).filter((warning) => blockOn.has(codeOf(warning)));
  if (hits.length) errors.push({ code: 'quality-blocked', message: `质量提示按 quality.blockOn 阻断发布：${hits.join('、')}` });
  return errors;
}

module.exports = { BLOCKABLE, validateQualityConfig, packWarnings, qualitySummary, qualityGate };
