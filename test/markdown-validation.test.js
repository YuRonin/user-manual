'use strict';

const assert = require('assert');

const { validateCopy, checkPolishedMarkdown, proseText, numberUnits, negatedTerms } = require('../src/generate/markdown-validate');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const draft = [
  '# 修改资料', '', '更新昵称。', '',
  '<!-- step:open -->', '1. 点击「编辑资料」', '', '   面板会在 2 秒内打开。', '',
  '```', '不要点击「编辑资料」 5 分钟', '```', '',
].join('\n');

const pack = {
  blocks: { intro: { default: '更新昵称。' }, 'step.open': { default: '面板会在 2 秒内打开。' } },
  allowedUiTerms: ['编辑资料', '保存'],
};

process.stdout.write('\nmarkdown validation\n');

test('正文抽取基于 Markdown AST：跳过代码块与注释', () => {
  const text = proseText(draft);
  assert.match(text, /点击「编辑资料」/);
  assert.doesNotMatch(text, /5 分钟/);
  assert.doesNotMatch(text, /step:open/);
});

test('润色稿：同样的 UI 名称但动作被否定 → 硬拦截', () => {
  const final = draft.replace('1. 点击「编辑资料」', '1. 不要点击「编辑资料」');
  assert.deepStrictEqual(checkPolishedMarkdown(draft, final).blocked, [{ code: 'negated-action', detail: ['编辑资料'] }]);
  assert.deepStrictEqual(negatedTerms('请勿按下「保存」', ['保存']), ['保存']);
  assert.deepStrictEqual(negatedTerms('点击「保存」后不要关闭', ['保存']), []);
});

test('润色稿：同数字换单位、新增数字 → review-required（不是硬拦截）', () => {
  const unit = checkPolishedMarkdown(draft, draft.replace('2 秒', '2 分钟'));
  assert.deepStrictEqual(unit.blocked, []);
  assert.deepStrictEqual(unit.review, [{ code: 'number-unit', detail: ['2 分钟'] }]);
  assert.deepStrictEqual(numberUnits('约 30 MB，耗时 5s'), ['30 mb', '5 s']);
  assert.deepStrictEqual(checkPolishedMarkdown(draft, draft).review, []);
});

test('润色稿：插入未知业务承诺 → review-required', () => {
  const result = checkPolishedMarkdown(draft, draft.replace('更新昵称。', '更新昵称，保存后永久生效并自动同步。'));
  assert.deepStrictEqual(result.review.map((r) => r.code), ['business-claim']);
  assert.deepStrictEqual(result.review[0].detail.sort(), ['永久', '自动同步'].sort());
});

test('文案块：只能填写声明过的块，不能带结构，不能编造或否定界面名称', () => {
  assert.strictEqual(validateCopy(pack, { intro: '改一下你的昵称。' }).ok, true);
  const bad = validateCopy(pack, {
    'step.open.action': '点击「删除」',
    intro: '## 新标题',
    'step.open': '别点「保存」，也可以用「导出」。',
  });
  assert.deepStrictEqual(bad.blocked.map((b) => `${b.blockId}:${b.code}`).sort(), [
    'intro:structure-in-copy', 'step.open.action:unknown-block', 'step.open:negated-action', 'step.open:ui-term-unknown',
  ].sort());
  assert.strictEqual(validateCopy(pack, []).blocked[0].code, 'invalid-copy');
});

test('文案块：沿用默认文字里已有的数字不需要审阅，新数字需要', () => {
  assert.deepStrictEqual(validateCopy(pack, { 'step.open': '通常 2 秒内就能看到面板。' }).review, []);
  assert.deepStrictEqual(validateCopy(pack, { 'step.open': '通常 10 秒内就能看到面板。' }).review.map((r) => r.code), ['number-unit']);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
