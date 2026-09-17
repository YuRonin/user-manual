'use strict';

function layoutAnnotations(targets, image, theme) {
  if (!Array.isArray(targets)) return { ok: false, errors: ['targets 需要是数组。'] };
  if (targets.length > theme.maxMarkersPerImage) return { ok: false, errors: [`单图最多 ${theme.maxMarkersPerImage} 个标注，收到 ${targets.length} 个。`] };
  const size = theme.markerSize;
  const padding = theme.targetPadding;
  const annotations = targets.map((item) => {
    const target = {
      x: Math.max(0, item.rect.x - padding),
      y: Math.max(0, item.rect.y - padding),
      width: item.rect.width + padding * 2,
      height: item.rect.height + padding * 2,
    };
    let x = target.x - size - 5;
    let y = target.y - size / 2;
    if (x < 0) x = Math.min(image.width - size, target.x + target.width + 5);
    y = Math.max(0, Math.min(image.height - size, y));
    return { label: item.label, target, marker: { x, y, size }, line: x > target.x ? 'right' : 'left' };
  });
  return { ok: true, annotations };
}

module.exports = { layoutAnnotations };
