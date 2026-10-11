'use strict';
/*
 * B4 标注布局与视觉质量（不启动浏览器）：
 *   B4-01 编号避让（紧邻、贴边、全宽、遮罩、拥挤时明确失败）
 *   B4-02 超出单图上限自动拆图（AC-16），编号全局连续
 *   B4-03 主题参数全部生效、弃用字段提示
 *   B4-04 坐标换算（整页 + fixed）、截图尺寸自检
 *   B4-05 遮罩并集、编号压在遮罩 / 图外
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const sharp = require('sharp');

const { layoutAnnotations, intersects } = require('../src/artifacts/annotation');
const { renderAnnotationResults, annotationSvg, unionArea } = require('../src/evidence/image-pipeline');
const { derivePublished } = require('../src/evidence/capture-safe');
const { DEFAULT_THEME, resolveAnnotationConfig } = require('../src/config/annotation');
const { toCanvasRect } = require('../src/browser/playwright');
const { publishedEntries } = require('../src/evidence/store');
const { annotationArtifacts } = require('../src/annotations/proof');

const THEME = { ...DEFAULT_THEME };
const canvas = { width: 1000, height: 700 };
const markerRect = (a) => ({ x: a.marker.x, y: a.marker.y, width: a.marker.size, height: a.marker.size });

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'manual-layout-')); }
function png(width, height) { return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer(); }

test('B4-01 紧邻按钮：编号互不重叠，也不压住相邻按钮', () => {
  const targets = Array.from({ length: 5 }, (_, i) => ({ label: String(i + 1), rect: { x: 100 + i * 70, y: 300, width: 60, height: 32 } }));
  const { annotations } = layoutAnnotations(targets, canvas, THEME);
  assert.ok(annotations.every((a) => a.marker), JSON.stringify(annotations.map((a) => a.layoutReason)));
  for (const a of annotations) {
    assert.ok(!targets.some((t) => intersects(markerRect(a), t.rect)), `编号 ${a.label} 压住了按钮`);
    assert.ok(!annotations.some((b) => b !== a && intersects(markerRect(a), markerRect(b))), `编号 ${a.label} 与其他编号重叠`);
  }
});

test('B4-01 四边贴边与全宽目标：编号完整落在画布内；目标框裁剪到画布而不是整体平移', () => {
  const cases = [
    { x: 0, y: 300, width: 80, height: 30 }, { x: 920, y: 300, width: 80, height: 30 },
    { x: 400, y: 0, width: 80, height: 30 }, { x: 400, y: 670, width: 80, height: 30 },
    { x: 0, y: 200, width: 1000, height: 48 },
  ];
  for (const rect of cases) {
    const [a] = layoutAnnotations([{ label: '1', rect }], canvas, THEME).annotations;
    assert.ok(a.marker, `无编号位置: ${JSON.stringify(rect)}`);
    const m = markerRect(a);
    assert.ok(m.x >= 0 && m.y >= 0 && m.x + m.width <= canvas.width && m.y + m.height <= canvas.height);
    assert.ok(!intersects(m, rect) || a.placement.startsWith('inner'), `编号压住目标: ${a.placement}`);
    assert.ok(a.target.x >= 0 && a.target.x <= rect.x, '框左边不能越过元素左边');
    assert.ok(a.target.x + a.target.width >= Math.min(canvas.width, rect.x + rect.width), '框右边必须覆盖元素右边');
  }
});

test('B4-01 编号避开隐私遮罩；所有位置都不安全时记 annotation-layout-crowded，不硬塞', () => {
  const rect = { x: 300, y: 300, width: 80, height: 30 };
  const plain = layoutAnnotations([{ label: '1', rect }], canvas, THEME).annotations[0];
  const avoid = [{ rect: markerRect(plain) }];
  const moved = layoutAnnotations([{ label: '1', rect }], canvas, THEME, { avoid }).annotations[0];
  assert.ok(moved.marker && !intersects(markerRect(moved), avoid[0].rect));
  // 小画布被目标填满：外侧放不下，框内也不够放一个编号
  const [crowded] = layoutAnnotations([{ label: '1', rect: { x: 2, y: 2, width: 30, height: 30 } }], { width: 34, height: 34 }, THEME).annotations;
  assert.equal(crowded.marker, null);
  assert.equal(crowded.layoutReason, 'annotation-layout-crowded');
  const [result] = renderAnnotationResults([crowded], { width: 34, height: 34, dpr: 1 });
  assert.equal(result.drawn, false);
  assert.equal(result.reason, 'annotation-layout-crowded');
});

test('AC-16 7 个目标、单图上限 5：拆成 2 张图（1–5、6–7），编号连续，产物带 part', async () => {
  const root = tmp();
  try {
    const rawPath = path.join(root, 'raw.png');
    fs.writeFileSync(rawPath, await png(1000, 700));
    const inventory = Array.from({ length: 7 }, (_, i) => ({ feature_id: `f${i + 1}`, label: `功能${i + 1}`, priority: 'required', description: `说明${i + 1}` }));
    const plan = inventory.map((item, i) => ({ feature_id: item.feature_id, label: String(i + 1), priority: 'required' }));
    const captured = {
      shot: { meta: { viewport: canvas } }, geometry: { viewport: canvas, dpr: 1 }, candidates: [], inventory, plan,
      targets: plan.map((item, i) => ({ feature_id: item.feature_id, label: item.label, rect: { x: 80 + (i % 4) * 220, y: 120 + Math.floor(i / 4) * 200, width: 120, height: 36 } })),
    };
    const publishedPath = path.join(root, 'published.png');
    const safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 'sanitized.png'), publishedPath, theme: THEME });
    assert.equal(safe.coverage.ok, true, JSON.stringify(safe.coverage.failures));
    assert.deepEqual(safe.parts.map((p) => p.part), [1, 2]);
    assert.ok(fs.existsSync(publishedPath) && fs.existsSync(path.join(root, 'published.part-2.png')));
    assert.deepEqual(safe.annotations.map((a) => [a.label, a.part]), [['1', 1], ['2', 1], ['3', 1], ['4', 1], ['5', 1], ['6', 2], ['7', 2]]);
    assert.ok(safe.rendered.every((r) => r.drawn && r.visible));
    const proof = annotationArtifacts({ inventory, plan, rendered: safe.rendered, coverage: safe.coverage }).proof;
    assert.deepEqual(proof.rendered.map((r) => r.part), [1, 1, 1, 1, 1, 2, 2], '证明里记录每项在哪张图');
    const entries = publishedEntries(safe, { file: publishedPath, dir: 'docs/manual/images/annotated', prefix: 'page--chat' });
    assert.deepEqual(entries.map((e) => [e.part, e.prefix]), [[1, 'page--chat'], [2, 'page--chat--part-2']]);
    const a = await sharp(publishedPath).raw().toBuffer();
    const b = await sharp(path.join(root, 'published.part-2.png')).raw().toBuffer();
    assert.ok(!a.equals(b), '两张拆分图画的是不同的标注');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('B4-03 主题参数生效：字号随 markerSize 缩放，光晕宽度 / 描边 / 文字颜色来自主题；弃用字段提示', () => {
  const svg = annotationSvg({ width: 400, height: 300, dpr: 2, annotations: [{ label: '1', target: { x: 100, y: 100, width: 50, height: 20 }, sourceRect: { x: 105, y: 105, width: 40, height: 10 }, marker: { x: 60, y: 90, size: 20 } }],
    theme: { ...THEME, markerSize: 20, haloWidth: 0, markerStrokeWidth: 3, markerText: '#112233', fontScale: 0.6 } });
  assert.match(svg, /font-size="24"/, '20 × 2 × 0.6');
  assert.match(svg, /fill="#112233"/);
  assert.match(svg, /stroke-width="6"/);
  assert.doesNotMatch(svg, /stroke-width="20"/, 'haloWidth: 0 时不画光晕');
  const partial = annotationSvg({ width: 100, height: 100, dpr: 1, annotations: [{ label: '1', target: { x: 40, y: 40, width: 20, height: 20 }, marker: { x: 5, y: 5, size: 30 } }], theme: { maxMarkersPerImage: 5, markerSize: 30, targetPadding: 5 } });
  assert.match(partial, /<circle/, '只给部分主题字段时其余取默认值');
  const loaded = resolveAnnotationConfig({ themes: { default: { labelText: '#000', focusMask: 'red' } } });
  assert.equal(loaded.ok, true);
  assert.match(loaded.warnings.join('\n'), /annotation-theme-deprecated: .*labelText、focusMask/);
  const bad = resolveAnnotationConfig({ themes: { default: { fontScale: 2, outlineWidth: 0 } } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /fontScale/);
  assert.match(bad.errors.join('\n'), /outlineWidth/);
});

test('B4-04 坐标换算：整页截图加滚动偏移；fixed 贴顶不加、贴底落到文档底部；视口截图不变', () => {
  const geometry = { scroll: { x: 0, y: 900 }, viewport: { width: 1000, height: 700 }, documentSize: { width: 1000, height: 3000 } };
  const rect = { x: 10, y: 20, width: 100, height: 30 };
  assert.deepEqual(toCanvasRect(rect, { fullPage: false, geometry }), rect);
  assert.equal(toCanvasRect(rect, { fullPage: true, geometry }).y, 920);
  assert.equal(toCanvasRect(rect, { fullPage: true, geometry, pinned: 'top' }).y, 20);
  assert.equal(toCanvasRect({ ...rect, y: 650 }, { fullPage: true, geometry, pinned: 'bottom' }).y, 650 + 2300);
});

test('B4-04 截图像素尺寸与画布 × DPR 不一致：geometry-scale-mismatch，不出发布图', async () => {
  const root = tmp();
  try {
    const rawPath = path.join(root, 'raw.png');
    fs.writeFileSync(rawPath, await png(1000, 700));
    const captured = { shot: { meta: { viewport: canvas } }, geometry: { viewport: canvas, dpr: 1.5 }, candidates: [], targets: [] };
    await assert.rejects(derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 's.png'), publishedPath: path.join(root, 'p.png'), theme: THEME }), (e) => e.code === 'geometry-scale-mismatch');
    assert.ok(!fs.existsSync(path.join(root, 'p.png')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('B4-05 遮罩按并集计算（重叠不重复计）；编号压在遮罩上记 marker-redacted；编号部分出图记 marker-outside-image', () => {
  assert.equal(unionArea([{ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 0, width: 10, height: 10 }]), 150);
  const item = { feature_id: 'f', label: '1', sourceRect: { x: 100, y: 100, width: 60, height: 20 }, target: { x: 95, y: 95, width: 70, height: 30 }, marker: { x: 55, y: 80, size: 30 } };
  // 两块重叠的遮罩合起来盖住 60%（100–136）：逐块求和会算成 80%
  const [overlapping] = renderAnnotationResults([item], { width: 400, height: 300, dpr: 1, minVisibleRatio: 0.8, redactions: [{ rect: { x: 100, y: 100, width: 24, height: 20 } }, { rect: { x: 112, y: 100, width: 24, height: 20 } }] });
  assert.equal(overlapping.redactedRatio, 0.6);
  assert.equal(overlapping.reason, 'target-redacted');
  const [small] = renderAnnotationResults([item], { width: 400, height: 300, dpr: 1, redactions: [{ rect: { x: 100, y: 100, width: 24, height: 20 } }, { rect: { x: 106, y: 100, width: 24, height: 20 } }] });
  assert.equal(small.redactedRatio, 0.5, '重叠部分只计一次（逐块求和是 0.8）');
  assert.equal(small.reason, null);
  const [onMask] = renderAnnotationResults([item], { width: 400, height: 300, dpr: 1, redactions: [{ rect: { x: 50, y: 80, width: 30, height: 20 } }] });
  assert.equal(onMask.reason, 'marker-redacted');
  const [clipped] = renderAnnotationResults([{ ...item, marker: { x: -10, y: 80, size: 30 } }], { width: 400, height: 300, dpr: 1 });
  assert.equal(clipped.reason, 'marker-outside-image');
  assert.equal(small.outlineRatio, 1);
});
