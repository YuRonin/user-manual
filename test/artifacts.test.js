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

test('姓名学校等不确定语义会阻止发布，redact/preserve 冲突也阻止', () => {
  const { planRedactions } = require('../src/artifacts/redaction');
  const uncertain = planRedactions([{ text: '星海中学', label: '学校', rect: { x: 0, y: 0, width: 50, height: 20 } }]);
  assert.strictEqual(uncertain.ok, false);
  assert.match(uncertain.errors.join('\n'), /人工确认/);
  const conflict = planRedactions([], { redact: ['学校'], preserve: ['学校'] });
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

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
