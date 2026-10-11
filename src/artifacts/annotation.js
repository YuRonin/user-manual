'use strict';

/*
 * 标注布局（B4-01）：目标框 + 编号圆点。坐标都是图像 CSS 坐标（视口截图为 client 坐标，整页截图为文档坐标）。
 *
 * 目标框 = 元素矩形外扩 targetPadding，再裁剪到画布（贴边的目标框不会整体平移、指向别的元素）。
 * 编号按候选位置依次尝试：左上（框左侧、与上边线居中，默认）→ 右上 → 上方 → 下方 → 左中 → 右中 → 框内左上 / 右上角。
 * 候选必须完整落在画布内，且不能压住：已放置的编号、其他目标的元素矩形、隐私遮罩。
 * 框内角只在外侧都放不下时使用（会盖住目标的一角，但不会盖住别的元素）。
 * 全部候选都不可用时这一项不画，记 annotation-layout-crowded，由覆盖率门禁决定是否阻断，而不是硬塞到重叠位置。
 */

const GAP = 4;

function intersects(a, b, margin = 0) {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

function inside(rect, canvas) {
  return rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= canvas.width && rect.y + rect.height <= canvas.height;
}

/** 元素矩形外扩 padding 后裁剪到画布；完全在画布外时保留原始位置（渲染时判定 outside-image）。 */
function targetBox(rect, padding, canvas) {
  const x0 = rect.x - padding;
  const y0 = rect.y - padding;
  const x1 = rect.x + rect.width + padding;
  const y1 = rect.y + rect.height + padding;
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(canvas.width, x1);
  const cy1 = Math.min(canvas.height, y1);
  if (!(cx1 > cx0 && cy1 > cy0)) return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  return { x: cx0, y: cy0, width: cx1 - cx0, height: cy1 - cy0 };
}

function candidates(box, size) {
  const outer = [
    { at: 'left', x: box.x - size - GAP, y: box.y - size / 2 },
    { at: 'right', x: box.x + box.width + GAP, y: box.y - size / 2 },
    { at: 'top', x: box.x, y: box.y - size - GAP },
    { at: 'bottom', x: box.x, y: box.y + box.height + GAP },
    { at: 'left-middle', x: box.x - size - GAP, y: box.y + box.height / 2 - size / 2 },
    { at: 'right-middle', x: box.x + box.width + GAP, y: box.y + box.height / 2 - size / 2 },
    { at: 'top-right', x: box.x + box.width - size, y: box.y - size - GAP },
    { at: 'bottom-right', x: box.x + box.width - size, y: box.y + box.height + GAP },
  ];
  const inner = box.width >= size + GAP * 2 && box.height >= size + GAP * 2
    ? [{ at: 'inner-top-left', x: box.x + GAP, y: box.y + GAP }, { at: 'inner-top-right', x: box.x + box.width - size - GAP, y: box.y + GAP }]
    : [];
  return [...outer, ...inner];
}

/**
 * @param {Array<{ rect, label, feature_id?, resolution? }>} targets
 * @param {{ width, height }} image  画布（CSS 尺寸）
 * @param {object} theme             markerSize / targetPadding / maxMarkersPerImage
 * @param {object} [options]
 * @param {Array<{ rect }>} [options.avoid]  不能被编号压住的区域（隐私遮罩）
 */
function layoutAnnotations(targets, image, theme, { avoid = [] } = {}) {
  if (!Array.isArray(targets)) return { ok: false, errors: ['targets 需要是数组。'] };
  if (targets.length > theme.maxMarkersPerImage) return { ok: false, errors: [`单图最多 ${theme.maxMarkersPerImage} 个标注，收到 ${targets.length} 个。`] };
  const size = theme.markerSize;
  const padding = theme.targetPadding;
  const blocked = avoid.map((item) => item.rect || item).filter((rect) => rect && rect.width > 0 && rect.height > 0);
  const placed = [];
  const annotations = targets.map((item, index) => {
    const target = targetBox(item.rect, padding, image);
    const others = targets.filter((_, j) => j !== index).map((other) => other.rect);
    let marker = null;
    let at = null;
    for (const candidate of candidates(target, size)) {
      const rect = { x: candidate.x, y: candidate.y, width: size, height: size };
      if (!inside(rect, image)) continue;
      if (placed.some((p) => intersects(rect, p, 2))) continue;
      if (others.some((other) => intersects(rect, other))) continue;
      if (blocked.some((mask) => intersects(rect, mask))) continue;
      marker = { x: candidate.x, y: candidate.y, size };
      at = candidate.at;
      break;
    }
    if (marker) placed.push({ x: marker.x, y: marker.y, width: size, height: size });
    return {
      feature_id: item.feature_id || null, label: item.label, sourceRect: item.rect, target, marker,
      ...(marker ? { placement: at } : { layoutReason: 'annotation-layout-crowded' }),
      ...(item.part ? { part: item.part } : {}),
      ...(item.resolution ? { resolution: item.resolution } : {}),
    };
  });
  return { ok: true, annotations };
}

module.exports = { layoutAnnotations, targetBox, intersects };
