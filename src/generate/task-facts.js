'use strict';
const { listMarkdownImages, normalizeImageFact } = require('../publication/paths');
const { templateFor, TEMPLATES } = require('./render');

const CLAIM_RE = /<!-- claim:([^ ]+) -->[ \t]*\r?\n[ \t]*([^\n]*)/g;

function languageOf(facts) {
  return facts?.factPack?.language && TEMPLATES[facts.factPack.language] ? facts.factPack.language : 'zh-CN';
}

function extract(markdown, language = 'zh-CN') {
  const template = templateFor(language);
  const labelOf = (line) => [template.verified, template.expected].find((label) => line.startsWith(label)) || null;
  return {
    title: (/^# (.+)$/m.exec(markdown) || [])[1] || null,
    stepIds: [...markdown.matchAll(/<!-- step:([^ ]+) -->/g)].map((m) => m[1]),
    images: listMarkdownImages(markdown),
    uiTexts: [...markdown.matchAll(/「([^」]+)」/g)].map((m) => m[1]),
    claims: [...markdown.matchAll(CLAIM_RE)].map((m) => ({ id: m[1], label: labelOf(m[2]) })),
    verifiedLabels: markdown.split(template.verified).length - 1,
    legacyVerified: /已验证结果：/.test(markdown),
  };
}

/** 完成声明必须与 facts 一一对应，等级标签只能来自证据计算结果。 */
function checkClaims(got, facts, errors, template) {
  if (!Array.isArray(facts.claims)) {
    errors.push('事实文件缺少完成声明（旧版格式），请重新运行 generate-task 生成草稿。');
    return;
  }
  const labelFor = (status) => (status === 'verified' ? template.verified : template.expected);
  const known = new Map(facts.claims.map((claim) => [claim.id, claim]));
  for (const block of got.claims) {
    if (!known.has(block.id)) errors.push(`unsupported-claim: 文档包含事实文件中不存在的完成声明 ${block.id}。`);
  }
  if (JSON.stringify(got.claims.map((c) => c.id)) !== JSON.stringify(facts.claims.map((c) => c.id))) {
    errors.push('完成声明（claim）缺失或顺序发生变化。');
  }
  for (const block of got.claims) {
    const claim = known.get(block.id);
    if (claim && block.label !== labelFor(claim.status)) {
      errors.push(`claim ${block.id} 的验证等级被改动：证据状态为 ${claim.status}，只能写「${labelFor(claim.status)}」。`);
    }
  }
  const verified = facts.claims.filter((claim) => claim.status === 'verified').length;
  if (got.verifiedLabels !== verified) errors.push('unsupported-claim: 文档中"已验证界面结果"的数量与有证据的声明不一致。');
  if (got.legacyVerified) errors.push('unsupported-claim: 不允许使用未绑定证据的"已验证结果"表述。');
}

/**
 * 结构一致性检查。图片只比对文档 href；产物存在性与发布根由 publication/paths 校验。
 * renderedFromPack：正文由事实包渲染（--copy 路径），UI 名称已由 validateCopy 限定在事实范围内，
 * 不再要求与草稿的 UI 名称序列逐项相同（说明段落可以重复提到已有的界面名称）。
 */
function validateTaskFinal(markdown, facts, { renderedFromPack = false } = {}) {
  const language = languageOf(facts);
  const got = extract(markdown, language);
  const errors = [];
  if (got.title !== facts.title) errors.push('一级标题与任务标题不一致。');
  if (JSON.stringify(got.stepIds) !== JSON.stringify(facts.stepIds)) errors.push('step.id 或步骤顺序发生变化。');
  const expected = (facts.images || []).map(normalizeImageFact);
  if (expected.some((item) => item.legacy)) {
    errors.push('事实文件使用旧版图片路径格式，请重新运行 generate-task 生成草稿。');
  } else if (JSON.stringify(got.images.map((i) => i.src)) !== JSON.stringify(expected.map((i) => i.markdownHref))) {
    errors.push('截图引用发生变化。');
  }
  if (got.images.some((i) => i.kind === 'html')) errors.push('正式文档不允许原始 HTML 图片。');
  if (!renderedFromPack && JSON.stringify(got.uiTexts) !== JSON.stringify(facts.uiTexts)) errors.push('已确认的 UI 原文发生变化。');
  checkClaims(got, facts, errors, templateFor(language));
  return errors.length ? { ok: false, errors } : { ok: true };
}

module.exports = { extract, validateTaskFinal };
