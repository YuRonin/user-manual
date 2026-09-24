'use strict';

const assert = require('assert');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

process.stdout.write('\nprivacy and annotation artifacts\n');

test('默认标注主题满足 PRD 的颜色与数量约束', () => {
  const { DEFAULT_ANNOTATION, resolveAnnotationConfig } = require('../src/config/annotation');
  const result = resolveAnnotationConfig();
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.config.activeTheme, 'default');
  assert.strictEqual(result.config.themes.default.primary, '#E86349');
  assert.strictEqual(result.config.themes.default.maxMarkersPerImage, 5);
  assert.deepStrictEqual(result.config.themes.default, DEFAULT_ANNOTATION.themes.default);
});

test('非法主题配置一次性报告错误', () => {
  const { resolveAnnotationConfig } = require('../src/config/annotation');
  const result = resolveAnnotationConfig({ activeTheme: 'missing', themes: { default: { markerSize: 2, maxMarkersPerImage: 99 } } });
  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => /activeTheme/.test(e)));
  assert.ok(result.errors.some((e) => /markerSize/.test(e)));
  assert.ok(result.errors.some((e) => /maxMarkersPerImage/.test(e)));
});

test('脱敏清单只保存类型和区域，不保存敏感原文', () => {
  const { planRedactions } = require('../src/artifacts/redaction');
  const result = planRedactions([
    { text: '13812345678', label: '手机号', rect: { x: 1, y: 2, width: 100, height: 20 } },
    { text: 'user@example.com', label: '邮箱', rect: { x: 1, y: 30, width: 120, height: 20 } },
  ]);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.redactions.map((r) => r.kind), ['phone', 'email']);
  assert.ok(!JSON.stringify(result).includes('13812345678'));
  assert.ok(!JSON.stringify(result).includes('user@example.com'));
});

test('公开模式遮盖模糊个人字段但跳过已脱敏内容', () => {
  const { detectRedactions } = require('../src/privacy/detector');
  const result = detectRedactions([
    { text: '星海中学', label: '学校', rect: { x: 0, y: 0, width: 50, height: 20 }, source: 'form-control' },
    { text: '134****1255', label: '联系电话', rect: { x: 0, y: 30, width: 80, height: 20 }, source: 'form-control' },
    { text: 'secret-token', label: 'access_token', inputType: 'password', rect: { x: 0, y: 60, width: 80, height: 20 }, source: 'form-control' },
  ], { audience: 'public', rules: { redact: [], preserve: [] } });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.redactions.map((item) => item.kind), ['semantic', 'credential']);
  assert.ok(result.redactions.every((item) => item.result === 'neutral-mosaic'));
  assert.ok(!JSON.stringify(result).includes('星海中学'));
  assert.ok(!JSON.stringify(result).includes('secret-token'));
});

test('含省略号的文字仍检测其中完整的手机号/邮箱，已整段脱敏的值才跳过', () => {
  const { detectRedactions } = require('../src/privacy/detector');
  const rect = { x: 0, y: 0, width: 50, height: 20 };
  const result = detectRedactions([
    { text: '联系人…请拨 13812345678', label: '', rect, source: 'text-pattern' },
    { text: '更多…写信到 a.b@example.com', label: '', rect, source: 'text-pattern' },
    { text: '134****1255', label: '联系电话', rect, source: 'form-control' },
  ], { audience: 'public', rules: { redact: [], preserve: [] } });
  assert.deepStrictEqual(result.redactions.map((item) => item.kind), ['phone', 'email']);
});

test('高风险规则、显式规则和账号标签按优先级处理', () => {
  const { detectRedactions } = require('../src/privacy/detector');
  const rect = { x: 1, y: 2, width: 30, height: 10 };
  const result = detectRedactions([
    { text: '13812345678', label: '手机号', rect, source: 'text-pattern' },
    { text: 'user@example.com', label: '邮箱', rect, source: 'text-pattern' },
    { text: 'u-123', label: '用户ID', rect, source: 'form-control' },
    { text: '安全演示标题', label: '标题', rect, source: 'explicit' },
  ], { audience: 'public', rules: { redact: [], preserve: ['手机号', '邮箱', '用户ID'] } });
  assert.deepStrictEqual(result.redactions.map((item) => item.kind), ['phone', 'email', 'account', 'explicit']);
});

test('内部模式允许 preserve 普通语义字段，配置冲突仍阻止', () => {
  const { detectRedactions } = require('../src/privacy/detector');
  const preserved = detectRedactions([
    { text: '星海中学', label: '学校', rect: { x: 0, y: 0, width: 50, height: 20 }, source: 'form-control' },
  ], { audience: 'internal', rules: { redact: [], preserve: ['学校'] } });
  assert.strictEqual(preserved.ok, true);
  assert.deepStrictEqual(preserved.redactions, []);
  const conflict = detectRedactions([], { audience: 'public', rules: { redact: ['学校'], preserve: ['学校'] } });
  assert.strictEqual(conflict.ok, false);
  assert.match(conflict.errors.join('\n'), /冲突/);
});

test('标注布局限制数量并将标签放在目标外侧', () => {
  const { layoutAnnotations } = require('../src/artifacts/annotation');
  const targets = Array.from({ length: 6 }, (_, i) => ({ label: i + 1, rect: { x: 50 + i * 80, y: 50, width: 60, height: 30 } }));
  const tooMany = layoutAnnotations(targets, { width: 800, height: 600 }, { maxMarkersPerImage: 5, markerSize: 30, targetPadding: 5 });
  assert.strictEqual(tooMany.ok, false);
  const result = layoutAnnotations(targets.slice(0, 3), { width: 800, height: 600 }, { maxMarkersPerImage: 5, markerSize: 30, targetPadding: 5 });
  assert.strictEqual(result.ok, true);
  assert.ok(result.annotations.every((item) => item.marker.x < item.target.x));
});

test('隐私矩形会裁剪、去重并丢弃零面积区域', () => {
  const { normalizeRects } = require('../src/privacy/geometry');
  assert.deepStrictEqual(
    normalizeRects([
      { x: -5, y: 10, width: 20, height: 10 },
      { x: -5, y: 10, width: 20, height: 10 },
      { x: 20, y: 20, width: 0, height: 10 },
    ], { width: 100, height: 100 }),
    [{ x: 0, y: 10, width: 15, height: 10 }]
  );
});

test('neutral mosaic 完全不透明且不采样底图', () => {
  const { neutralMosaicStyle } = require('../src/privacy/renderer');
  const style = neutralMosaicStyle({ x: 1, y: 2, width: 10, height: 12 });
  assert.match(style, /background-color:#[0-9A-F]{6}/i);
  assert.match(style, /repeating-conic-gradient/);
  assert.doesNotMatch(style, /blur|backdrop-filter|rgba\([^)]*,\s*0\./i);
  assert.match(style, /width:24px/);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
