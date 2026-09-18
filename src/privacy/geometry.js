'use strict';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function clipRect(rect, viewport) {
  const left = Math.max(0, finite(rect.x));
  const top = Math.max(0, finite(rect.y));
  const right = Math.min(finite(viewport.width), finite(rect.x) + Math.max(0, finite(rect.width)));
  const bottom = Math.min(finite(viewport.height), finite(rect.y) + Math.max(0, finite(rect.height)));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function dedupeRects(rects, epsilon = 0.5) {
  const out = [];
  for (const rect of rects) {
    const duplicate = out.some((item) =>
      Math.abs(item.x - rect.x) <= epsilon && Math.abs(item.y - rect.y) <= epsilon &&
      Math.abs(item.width - rect.width) <= epsilon && Math.abs(item.height - rect.height) <= epsilon
    );
    if (!duplicate) out.push(rect);
  }
  return out;
}

function mergeTextFragments(rects, maxGap = 2) {
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const rect of sorted) {
    const previous = out[out.length - 1];
    const sameLine = previous && Math.abs(previous.y - rect.y) <= 1 && Math.abs(previous.height - rect.height) <= 1;
    const gap = previous ? rect.x - (previous.x + previous.width) : Infinity;
    if (sameLine && gap >= 0 && gap <= maxGap) previous.width = rect.x + rect.width - previous.x;
    else out.push({ ...rect });
  }
  return out;
}

function normalizeRects(rects, viewport) {
  return dedupeRects((rects || []).map((rect) => clipRect(rect, viewport)).filter(Boolean));
}

module.exports = { clipRect, dedupeRects, mergeTextFragments, normalizeRects };
