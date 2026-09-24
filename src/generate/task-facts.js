'use strict';
const { listMarkdownImages, normalizeImageFact } = require('../publication/paths');

function extract(markdown) {
  return {
    title: (/^# (.+)$/m.exec(markdown) || [])[1] || null,
    stepIds: [...markdown.matchAll(/<!-- step:([^ ]+) -->/g)].map((m) => m[1]),
    images: listMarkdownImages(markdown),
    uiTexts: [...markdown.matchAll(/「([^」]+)」/g)].map((m) => m[1]),
    verified: /已验证结果：/.test(markdown),
    expected: /预期结果：/.test(markdown),
  };
}

/** 结构一致性检查。图片只比对文档 href；产物存在性与发布根由 publication/paths 校验。 */
function validateTaskFinal(markdown, facts) {
  const got = extract(markdown);
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
  if (JSON.stringify(got.uiTexts) !== JSON.stringify(facts.uiTexts)) errors.push('已确认的 UI 原文发生变化。');
  if (facts.completionVerification === 'expected' && got.verified) errors.push('未执行写操作时不能声称结果已验证。');
  if (facts.completionVerification === 'verified' && !got.verified) errors.push('完成标志丢失 verified 语义。');
  return errors.length ? { ok: false, errors } : { ok: true };
}

module.exports = { extract, validateTaskFinal };
