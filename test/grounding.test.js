'use strict';

const assert = require('assert');
const { validateCopy, checkPolishedMarkdown } = require('../src/generate/markdown-validate');
const { observedNamesOf } = require('../src/generate/grounding');
const { buildTaskFactPack } = require('../src/generate/fact-pack');
const { renderTask } = require('../src/generate/render');
const { computeClaims } = require('../src/evidence/claims');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const codes = (result) => result.review.map((item) => item.code).sort();

function task(overrides = {}) {
  return {
    id: 'edit-profile', title: '修改资料', goal: '修改个人资料。', entryPage: 'profile', risk: 'read',
    steps: [
      { id: 'open', page: 'profile', instruction: '点击「编辑资料」打开编辑面板。', action: { type: 'click', target: { role: 'button', name: '编辑资料' } } },
      { id: 'save', page: 'profile', instruction: '点击「保存修改」保存资料。', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion: { description: '资料已更新', claims: [{ id: 'saved', text: '页面提示资料已更新。', assertionRefs: ['save-toast'], checkpoint: 'save' }] },
    ...overrides,
  };
}
const evidence = {
  steps: [
    { id: 'open', status: 'verified', screenshots: [{ captureId: 'cap-open', timing: 'after' }], validations: [] },
    { id: 'save', status: 'not-executed', screenshots: [], validations: [] },
  ],
};
function pack(overrides = {}, observedTerms = []) {
  const t = task(overrides);
  const ids = new Set(t.steps.map((step) => step.id));
  const scoped = { steps: evidence.steps.filter((step) => ids.has(step.id)) };
  return buildTaskFactPack({ task: t, evidence: scoped, images: [], claims: computeClaims(t, scoped), language: 'zh-CN', observedTerms });
}

process.stdout.write('\ngrounding\n');

test('AC-10 "点击右上角的导出按钮，系统会生成 PDF 报告并发送到邮箱" 没有依据：需要确认，不是 ok', () => {
  const result = validateCopy(pack(), { intro: '然后点击右上角的导出按钮，系统会生成 PDF 报告并发送到邮箱。' });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(codes(result), ['ui-term-not-observed', 'unsupported-result']);
  assert.deepStrictEqual(result.review.find((item) => item.code === 'unsupported-result').detail, ['生成pdf报告', '发送到邮箱']);
});

test('有依据的文案照常通过：已执行的控件、完成声明里的结果、默认文案', () => {
  const p = pack();
  assert.deepStrictEqual(validateCopy(p, { intro: '点击编辑资料按钮，改好后保存，页面会提示资料已更新。' }).review, []);
  assert.deepStrictEqual(validateCopy(p, { intro: '修改个人资料。' }).review, []);
});

test('AC-11 只写在 instruction 里、页面上没观察到的名称：标为 ui-term-not-observed；观察到后通过', () => {
  const declared = pack({ goal: '修改个人资料，也可以用「导出资料」备份。' });
  assert.deepStrictEqual(declared.uiEvidence.declared.includes('导出资料'), true);
  assert.deepStrictEqual(codes(validateCopy(declared, { 'step.open': '需要时点击「导出资料」备份。' })), ['ui-term-not-observed']);
  const observed = pack({ goal: '修改个人资料，也可以用「导出资料」备份。' }, ['导出资料']);
  assert.deepStrictEqual(validateCopy(observed, { 'step.open': '需要时点击「导出资料」备份。' }).review, []);
});

test('AC-12 弹窗里真实出现的菜单项：对应步骤截图的无障碍树里有它，就不算虚构', () => {
  const records = [{ semantic: { items: [{ role: 'menuitem', name: '复制链接' }, { role: 'button', name: '[redacted]' }] } }];
  const names = observedNamesOf(records);
  assert.deepStrictEqual(names, ['复制链接']);
  assert.deepStrictEqual(validateCopy(pack({}, names), { intro: '在弹出的菜单里选择复制链接选项即可分享。' }).review, []);
  assert.deepStrictEqual(codes(validateCopy(pack(), { intro: '在弹出的菜单里选择复制链接选项即可分享。' })), ['ui-term-not-observed']);
});

test('润色稿路径：新增的无依据结果同样需要确认', () => {
  const p = pack();
  const result = checkPolishedMarkdown('# 修改资料\n\n修改个人资料。\n', '# 修改资料\n\n修改个人资料，完成后系统会自动发送通知短信。\n', p);
  assert.ok(result.review.some((item) => item.code === 'unsupported-result'));
});

test('AC-14 风险边界后未执行的步骤带"未验证"标识，已执行的步骤没有', () => {
  const markdown = renderTask(pack());
  const save = markdown.slice(markdown.indexOf('<!-- step:save -->'));
  const open = markdown.slice(markdown.indexOf('<!-- step:open -->'), markdown.indexOf('<!-- step:save -->'));
  assert.match(save, /未验证：生成手册时没有实际执行这一步/);
  assert.doesNotMatch(open, /未验证/);
});

test('AC-15 完成声明的证据带截图引用（断言所在步骤的"操作后"截图）', () => {
  const t = task();
  const withAssertion = { steps: [{ id: 'save', status: 'verified', screenshots: [{ captureId: 'cap-before', timing: 'before' }, { captureId: 'cap-after', timing: 'after' }], validations: [{ scope: 'scenario-state', phase: 'after', assertionId: 'save-toast', outcome: 'passed', checkedAt: '2026-10-10T00:00:00.000Z' }] }] };
  const [claim] = computeClaims(t, withAssertion);
  assert.strictEqual(claim.status, 'verified');
  assert.strictEqual(claim.evidence[0].captureId, 'cap-after');
});

test('AC-15a 题目卡这类很长的 aria-label：动作句改用已审核的 instruction，定位目标不变；instruction 里的名称仍受观察检查', () => {
  const card = '第 3 题：已知函数 f(x)=x²+2x，求 f(1) 的值并说明理由（5 分）';
  const p = pack({ steps: [{ id: 'open', page: 'profile', instruction: '点击「第 3 题」查看题目详情。', action: { type: 'click', target: { role: 'button', name: card } } }] });
  assert.strictEqual(p.steps[0].sentence, '点击「第 3 题」查看题目详情。');
  assert.strictEqual(p.steps[0].sentenceSource, 'instruction');
  assert.strictEqual(p.steps[0].action.target.name, card, '定位仍用真实控件名');
  assert.doesNotMatch(renderTask(p), /求 f\(1\)/);
  assert.deepStrictEqual(codes(validateCopy(p, { intro: '先点击「第 3 题」。' })), [], '执行过的长名称包含它，算已观察');
  const fake = pack({ steps: [{ id: 'open', page: 'profile', instruction: '点击「第 9 题」查看。', action: { type: 'click', target: { role: 'button', name: card } } }] });
  assert.deepStrictEqual(codes(validateCopy(fake, { intro: '先点击「第 9 题」。' })), ['ui-term-not-observed'], '虚构的 instruction 名称仍被发现');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
