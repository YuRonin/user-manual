'use strict';

/*
 * 模型文案的校验（契约 C11）。
 *
 * 两类结论：
 *   blocked         必须拒绝：未声明的文案块、在文案里塞结构（标题 / 图片 / 列表 / 注释）、
 *                   编造的界面名称、对事实动作的否定（"不要点击「保存」"）。
 *   review-required 规则无法证明对错，需要人确认：新出现的数字 + 单位（含同数字换单位）、
 *                   业务承诺（"保证""立即""自动完成"……）。
 * 这是结构与关键事实的一致性检查，不声称能证明任意自由文本与事实语义等价。
 * 文本抽取基于 Markdown AST（markdown-it），不在围栏代码和注释里找事实。
 */

const MarkdownIt = require('markdown-it');

const parser = new MarkdownIt({ html: true });

const NEGATION_RE = /(不要|别|无需|不用|切勿|不能|不可|禁止|请勿|do not|don't|never|no need to)\s*$/i;
const PROMISE_RE = /保证|一定会|立即|马上|自动(?:完成|保存|同步|生效)|永久|免费|无限|100%|guarantee|always|instantly|automatically|forever|unlimited|free of charge/gi;
const NUMBER_UNIT_RE = /(\d+(?:\.\d+)?)\s*(毫秒|秒|分钟|小时|天|周|个月|月|年|%|元|次|条|个|项|MB|GB|KB|ms|seconds?|minutes?|hours?|days?|weeks?|months?|years?|s\b|min\b|h\b)/gi;

/** 从 Markdown AST 取正文文字（跳过代码、注释和 HTML）。 */
function proseText(markdown) {
  const out = [];
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'text') out.push(token.content);
      else if (token.type === 'softbreak' || token.type === 'hardbreak') out.push('\n');
      if (token.children) walk(token.children);
    }
  };
  walk(parser.parse(String(markdown || ''), {}));
  return out.join('');
}

function numberUnits(text) {
  return [...String(text).matchAll(NUMBER_UNIT_RE)].map((m) => `${m[1]} ${m[2].toLowerCase()}`);
}

function promises(text) {
  return [...new Set([...String(text).matchAll(PROMISE_RE)].map((m) => m[0].toLowerCase()))];
}

/** 文字里被否定的界面名称：名称前紧挨否定词。 */
function negatedTerms(text, terms) {
  const hits = [];
  for (const term of terms) {
    const marker = `「${term}」`;
    let from = 0;
    for (;;) {
      const at = text.indexOf(marker, from);
      if (at === -1) break;
      const before = text.slice(Math.max(0, at - 12), at).replace(/(点击|点按|按下|选择|勾选|填写|打开|点|按|选|click|press|tap|select|open)\s*(一下)?\s*$/i, '');
      if (NEGATION_RE.test(before)) hits.push(term);
      from = at + marker.length;
    }
  }
  return [...new Set(hits)];
}

function termsIn(text) {
  return [...String(text).matchAll(/「([^」]+)」/g)].map((m) => m[1]);
}

/**
 * 校验模型返回的文案块。
 * @returns {{ ok, blocked: Array<{blockId, code, detail}>, review: Array<{blockId, code, detail}> }}
 */
function validateCopy(pack, copy) {
  const blocked = [];
  const review = [];
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) {
    return { ok: false, blocked: [{ blockId: null, code: 'invalid-copy', detail: '文案需要是 { blockId: 文本 } 对象。' }], review };
  }
  const allowed = new Set(pack.allowedUiTerms || []);
  const factText = JSON.stringify(pack);
  const factNumbers = new Set(numberUnits(factText));
  for (const [blockId, value] of Object.entries(copy)) {
    if (!pack.blocks[blockId]) { blocked.push({ blockId, code: 'unknown-block', detail: '事实包没有声明这个文案块；动作、声明、图片不能由文案覆盖。' }); continue; }
    if (typeof value !== 'string') { blocked.push({ blockId, code: 'invalid-copy', detail: '文案块需要是字符串。' }); continue; }
    if (/!\[|^\s{0,3}#|<!--|^\s*(\d+[.)]|[-*+])\s/m.test(value)) blocked.push({ blockId, code: 'structure-in-copy', detail: '文案块不能包含标题、图片、列表或注释。' });
    const unknown = termsIn(value).filter((term) => !allowed.has(term));
    if (unknown.length) blocked.push({ blockId, code: 'ui-term-unknown', detail: unknown });
    const negated = negatedTerms(value, [...allowed]);
    if (negated.length) blocked.push({ blockId, code: 'negated-action', detail: negated });
    const numbers = numberUnits(value).filter((n) => !factNumbers.has(n) && !numberUnits(pack.blocks[blockId].default).includes(n));
    if (numbers.length) review.push({ blockId, code: 'number-unit', detail: numbers });
    const promised = promises(value).filter((p) => !promises(pack.blocks[blockId].default).includes(p));
    if (promised.length) review.push({ blockId, code: 'business-claim', detail: promised });
  }
  return { ok: blocked.length === 0 && review.length === 0, blocked, review };
}

/**
 * 旧的 --finalize 路径：对照草稿检查润色稿的正文（结构与图片 / 声明另有 validateTaskFinal / compareFacts）。
 * @returns {{ blocked, review }}
 */
function checkPolishedMarkdown(draftMarkdown, finalMarkdown, pack = null) {
  const draft = proseText(draftMarkdown);
  const final = proseText(finalMarkdown);
  const blocked = [];
  const review = [];
  const terms = pack?.allowedUiTerms?.length ? pack.allowedUiTerms : [...new Set(termsIn(draft))];
  const negated = negatedTerms(final, terms).filter((term) => !negatedTerms(draft, terms).includes(term));
  if (negated.length) blocked.push({ code: 'negated-action', detail: negated });
  const draftNumbers = new Set(numberUnits(draft));
  const numbers = numberUnits(final).filter((n) => !draftNumbers.has(n));
  if (numbers.length) review.push({ code: 'number-unit', detail: numbers });
  const draftPromises = new Set(promises(draft));
  const promised = promises(final).filter((p) => !draftPromises.has(p));
  if (promised.length) review.push({ code: 'business-claim', detail: promised });
  return { blocked, review };
}

function formatFindings(findings, label) {
  return findings.map((f) => `${label} ${f.code}${f.blockId ? `（${f.blockId}）` : ''}: ${Array.isArray(f.detail) ? f.detail.join('、') : f.detail}`);
}

module.exports = { validateCopy, checkPolishedMarkdown, proseText, numberUnits, negatedTerms, promises, formatFindings };
