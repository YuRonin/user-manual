'use strict';

const assert = require('assert');
const { qualitySummary, qualityGate, validateQualityConfig, packWarnings } = require('../src/generate/quality-summary');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function pack(overrides = {}) {
  return {
    kind: 'task',
    steps: [
      { id: 'open', executed: true, sentence: '点击「编辑资料」', sentenceSource: 'action' },
      { id: 'save', executed: false, sentence: '点击「保存修改」', sentenceSource: 'action' },
      { id: 'card', executed: true, sentence: '点击「第 9 题」查看。', sentenceSource: 'instruction' },
    ],
    claims: [{ id: 'opened', text: '编辑面板已打开。', status: 'verified' }, { id: 'saved', text: '资料已更新。', status: 'not_run' }],
    uiEvidence: { observed: ['编辑资料', '第 3 题：……'], declared: ['导出资料'] },
    quality: { warnings: ['completion-unbound'] },
    ...overrides,
  };
}

process.stdout.write('\nquality summary\n');

test('B3-08 统一质量结果：步骤执行率、完成声明状态、名称来源、提示与门禁提示', () => {
  const summary = qualitySummary(pack(), { gateWarnings: ['inventory-review-required: …'], review: [{ code: 'unsupported-result' }] });
  assert.deepStrictEqual(summary.steps, { total: 3, executed: 2, notExecuted: 1 });
  assert.deepStrictEqual(summary.claims, { total: 2, verified: 1, failed: [], unverified: ['saved'] });
  assert.deepStrictEqual(summary.uiTerms, { observed: 2, declaredOnly: ['导出资料'] });
  assert.deepStrictEqual(summary.warnings.sort(), ['completion-unbound', 'steps-not-executed:1', 'ui-term-not-observed:card'].sort());
  assert.deepStrictEqual(summary.review, ['unsupported-result']);
  assert.deepStrictEqual(summary.gate, ['inventory-review-required: …']);
});

test('B3-09 断言实际失败的完成声明始终阻断，配置不能放行', () => {
  const failed = pack({ claims: [{ id: 'saved', text: '资料已更新。', status: 'failed' }] });
  assert.deepStrictEqual(qualityGate(failed, { quality: { blockOn: [] } }).map((e) => e.code), ['claim-failed']);
  assert.deepStrictEqual(qualityGate(pack(), {}), [], '默认只有 claim-failed 阻断');
});

test('B3-09 quality.blockOn 把指定提示升级为阻断（带后缀的按前缀匹配）；未知代码在配置校验时报错', () => {
  assert.deepStrictEqual(qualityGate(pack(), { quality: { blockOn: ['ui-term-not-observed'] } }).map((e) => e.code), ['quality-blocked']);
  assert.match(qualityGate(pack(), { quality: { blockOn: ['steps-not-executed', 'completion-unbound'] } })[0].message, /completion-unbound.*steps-not-executed:1|steps-not-executed:1.*completion-unbound/);
  const errors = [];
  validateQualityConfig({ blockOn: ['ui-term-not-observed', 'whatever'] }, errors);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /whatever/);
  validateQualityConfig(undefined, errors);
  assert.strictEqual(errors.length, 1);
});

test('只凭声明写进动作句的名称才提示；已观察到的（长名称包含它）不提示', () => {
  const ok = pack({ steps: [{ id: 'card', executed: true, sentence: '点击「第 3 题」查看。', sentenceSource: 'instruction' }] });
  assert.deepStrictEqual(packWarnings(ok).filter((w) => w.startsWith('ui-term')), []);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
