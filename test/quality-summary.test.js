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

test('B6-01 统一质量模型：计划 / 绘制 / 说明覆盖、待确认功能、隐私与新鲜度来自 Capture 记录；没有 Required 时是 N/A', () => {
  const { evidenceQuality } = require('../src/generate/quality-summary');
  const record = {
    observedAt: '2026-10-10T00:00:00.000Z', privacy: { status: 'passed', demo: { status: 'passed' } },
    annotationCoverage: { required: { total: 8, verified: 5 }, pending: [{ feature_id: 'x' }], unresolvedCandidates: [],
      failures: [{ feature_id: 'a', reason: 'missing-from-plan' }, { feature_id: 'b', reason: 'missing-from-plan' }, { feature_id: 'c', reason: 'partially-clipped' }] },
    annotationProof: { inventory: [{ feature_id: 'f1', priority: 'required', description: '上传资料', explanation_ref: null }] },
  };
  const q = evidenceQuality([record, { privacy: { status: 'passed' } }], { markdown: '正文没有提到这个功能' });
  assert.deepStrictEqual(q.planCoverage, { required: 8, missing: 2, percent: 75 });
  assert.deepStrictEqual(q.renderCoverage, { planned: 6, failed: 1, percent: 83 });
  assert.deepStrictEqual(q.documentationCoverage, { required: 1, missing: 1, percent: 0 });
  assert.deepStrictEqual(q.inventoryReview, { pending: 1, status: 'unknown' }, '有记录缺覆盖结论时不能宣称已审阅');
  assert.deepStrictEqual(q.privacy, { total: 2, passed: 2, demo: 1, legacy: 1 });
  assert.strictEqual(evidenceQuality([{ annotationCoverage: { required: { total: 0 }, failures: [] } }]).planCoverage.percent, null, '没有 Required 是 N/A 不是 100%');
});

test('B6-02 质量模式：public 默认 strict（demo-recapture-blocked 阻断）、internal 默认 observe（只提示且 verified=false）；非法模式报错', () => {
  const { qualitySummary, modeOf } = require('../src/generate/quality-summary');
  const blocked = pack({ artifacts: [{ id: 'img-1', privacy: { demo: { status: 'passed' } }, demoRecapture: { reasons: ['demo-blocked'] } }] });
  assert.strictEqual(modeOf({ privacy: { audience: 'public' } }), 'strict');
  assert.strictEqual(modeOf({ privacy: { audience: 'internal' } }), 'observe');
  assert.deepStrictEqual(qualityGate(blocked, { privacy: { audience: 'public' } }).map((e) => e.code), ['quality-blocked']);
  assert.deepStrictEqual(qualityGate(blocked, { privacy: { audience: 'internal' } }), []);
  const observed = qualitySummary(pack(), { config: { privacy: { audience: 'internal' } } });
  assert.strictEqual(observed.mode, 'observe');
  assert.strictEqual(observed.verified, false);
  const errors = [];
  validateQualityConfig({ mode: 'lenient' }, errors);
  assert.match(errors.join('\n'), /quality\.mode/);
});

test('B6-03 质量趋势：发布后记录计数，对比上次并标出回退；只留最近 20 次', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { recordQuality, readTrend, compareTrend, trendLine } = require('../src/generate/quality-trend');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-trend-'));
  try {
    recordQuality(dir, 'page-chat', { quality: { planCoverage: { missing: 0 }, renderCoverage: { failed: 0 }, warnings: [] } });
    recordQuality(dir, 'page-chat', { quality: { planCoverage: { missing: 2 }, renderCoverage: { failed: 0 }, warnings: ['x'] } });
    const diff = compareTrend(readTrend(dir, 'page-chat'));
    assert.deepStrictEqual(diff.changed.requiredMissingFromPlan, { previous: 0, current: 2 });
    assert.strictEqual(diff.regressed, true);
    assert.match(trendLine('page-chat', readTrend(dir, 'page-chat')), /requiredMissingFromPlan 0→2.*（有回退）/);
    for (let i = 0; i < 25; i++) recordQuality(dir, 'page-chat', { quality: { warnings: [] } });
    assert.strictEqual(readTrend(dir, 'page-chat').length, 20);
    assert.strictEqual(compareTrend([]), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('B6-13 写授权临近到期 / 已到期：规划提示，不改变授权本身', () => {
  const { writeAuthorizationWarnings } = require('../src/runtime/planner');
  const now = Date.parse('2026-10-11T00:00:00Z');
  const task = (expiresAt) => ({ writeAuthorization: { expiresAt } });
  assert.deepStrictEqual(writeAuthorizationWarnings(task('2026-10-20T00:00:00Z'), { now }), []);
  assert.match(writeAuthorizationWarnings(task('2026-10-11T01:00:00Z'), { now })[0], /^write-authorization-expiring: .*60 分钟后/);
  assert.match(writeAuthorizationWarnings(task('2026-10-10T00:00:00Z'), { now })[0], /^write-authorization-expired/);
  assert.deepStrictEqual(writeAuthorizationWarnings({}, { now }), []);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
