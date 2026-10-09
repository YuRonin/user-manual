'use strict';

/*
 * 手册文字的风格检查（references/manual-writing-style.md 第四节）。
 *
 * 只收判断精度高的几条：命中几乎一定要改，不会误伤正常写法。
 * 详略、语气这类需要上下文判断的问题留给写作规范，不在这里猜。
 *
 *   stock-phrase      套话与宣传腔（"值得注意的是""高效地""赋能"……）
 *   formal-you        "您"：手册统一用"你"，且尽量少用
 *   ui-quote-chain    连写三个以上「」：字段、区域写成普通文字，「」只留给要操作的控件
 *   ui-quote-repeat   同一段里同一个「」名称出现两次：第二次直接写名称或用"它"
 *
 * 文案块与页面 guide 在提交时检查（命中即拒绝，写作者改完再交）；
 * 任务模型的读者字段已经落盘，只在 taskQuality 里给警告。
 */

const STOCK_PHRASES = [
  '值得注意的是', '需要注意的是', '从而提升', '进一步提升', '更好地', '高效地', '轻松地', '即可实现',
  '助力', '赋能', '一站式', '全方位', '极大地', '显著地', '无缝', '深入探讨', '至关重要',
  '总而言之', '综上所述', '希望对你有帮助', '希望对您有帮助', '希望这对你有帮助', '希望这对您有帮助',
];

const QUOTE_CHAIN_RE = /(?:「[^」\n]+」[\s、，,和与及或以及]{0,3}){3,}/g;

/**
 * @param {string} text 一段读者可见的文字
 * @returns {Array<{code: string, detail: string}>}
 */
function lintProse(text) {
  const value = String(text || '');
  const findings = [];
  const phrases = STOCK_PHRASES.filter((phrase) => value.includes(phrase));
  if (phrases.length) findings.push({ code: 'stock-phrase', detail: `删掉套话：${phrases.join('、')}` });
  if (value.includes('您')) findings.push({ code: 'formal-you', detail: '用“你”代替“您”，能省略主语时直接省略' });
  for (const match of value.match(QUOTE_CHAIN_RE) || []) {
    findings.push({ code: 'ui-quote-chain', detail: `${match.trim()}：字段和区域写成普通文字，「」只留给要点击或选择的控件` });
  }
  const counts = new Map();
  for (const [, term] of value.matchAll(/「([^」\n]+)」/g)) counts.set(term, (counts.get(term) || 0) + 1);
  const repeated = [...counts].filter(([, n]) => n > 1).map(([term]) => `「${term}」`);
  if (repeated.length) findings.push({ code: 'ui-quote-repeat', detail: `${repeated.join('、')} 在同一段出现多次：只在第一次加「」` });
  return findings;
}

/** 把 lintProse 结果展开成 "code: detail" 字符串，便于拼进报错或警告。 */
function formatStyle(findings, where) {
  return findings.map((f) => `style-${f.code}${where ? `（${where}）` : ''}: ${f.detail}`);
}

module.exports = { lintProse, formatStyle, STOCK_PHRASES };
