'use strict';

/*
 * 离线图像管线：发布图全部由同一份 raw 字节派生（契约 C06）。
 *
 *   raw ──遮罩（完全不透明）──▶ sanitized ──叠加标注──▶ published（annotated 目录）
 *
 * 浏览器只负责 raw 与几何；这里不再调用第二次截图，因此遮罩与标注的矩形
 * 和像素来自同一时刻。坐标约定：输入矩形是"图像 CSS 坐标"（视口截图即 client 坐标，
 * 整页截图即文档坐标），按实际 DPR 换算为像素，并裁剪到真实 PNG 宽高。
 */

const fs = require('fs');
const sharp = require('sharp');

const { DEFAULT_MOSAIC } = require('../privacy/renderer');
const { sha256Hex, revisionOf } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');

const RENDERER_VERSION = 'sharp-svg-2';
const MIN_MASK = { width: 24, height: 8 };

/** CSS 矩形 → 图像像素矩形（取整向外扩，保证完全覆盖），裁剪到图像范围；完全落在图外返回 null。 */
function toImageRect(rect, { dpr, width, height }, minimum = null) {
  let w = Number(rect.width);
  let h = Number(rect.height);
  if (minimum) { w = Math.max(w, minimum.width); h = Math.max(h, minimum.height); }
  const left = Math.floor(Number(rect.x) * dpr);
  const top = Math.floor(Number(rect.y) * dpr);
  const right = Math.ceil((Number(rect.x) + w) * dpr);
  const bottom = Math.ceil((Number(rect.y) + h) * dpr);
  const x0 = Math.max(0, left);
  const y0 = Math.max(0, top);
  const x1 = Math.min(width, right);
  const y1 = Math.min(height, bottom);
  if (!(x1 > x0 && y1 > y0)) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** rgba(...) 在 SVG 属性里拆成颜色 + 不透明度，避免依赖渲染器对 rgba 的支持。 */
function paint(value) {
  const match = String(value).match(/^rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/i);
  if (!match) return { color: value, opacity: 1 };
  return { color: `rgb(${match[1]},${match[2]},${match[3]})`, opacity: Number(match[4]) };
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

function maskSvg({ width, height, rects, dpr, style = DEFAULT_MOSAIC }) {
  const cell = Math.max(2, Math.round(style.cellSize * dpr));
  const radius = Math.round(style.radius * dpr);
  const body = rects.map((r) => (
    // 底色矩形完全不透明，先盖住原像素；马赛克图案再叠在上面。
    `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="${style.base}"/>` +
    `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="${Math.min(radius, Math.floor(r.height / 2))}" fill="url(#m)"/>`
  )).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<defs><pattern id="m" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">` +
    `<rect width="${cell * 2}" height="${cell * 2}" fill="${style.cellB}"/>` +
    `<rect width="${cell}" height="${cell}" fill="${style.cellA}"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="${style.cellA}"/>` +
    `</pattern></defs>${body}</svg>`;
}

function annotationSvg({ width, height, annotations, dpr, theme }) {
  const primary = paint(theme.primary);
  const halo = paint(theme.halo);
  const parts = [];
  for (const item of annotations) {
    const t = toImageRect(item.target, { dpr, width, height });
    const source = toImageRect(item.sourceRect || item.target, { dpr, width, height });
    const marker = item.marker && toImageRect({ x: item.marker.x, y: item.marker.y, width: item.marker.size, height: item.marker.size }, { dpr, width, height });
    if (source && t && marker) {
      const r = Math.round(theme.targetRadius * dpr);
      parts.push(`<rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" rx="${r}" fill="none" stroke="${halo.color}" stroke-opacity="${halo.opacity}" stroke-width="${Math.round(10 * dpr)}"/>`);
      parts.push(`<rect x="${t.x}" y="${t.y}" width="${t.width}" height="${t.height}" rx="${r}" fill="none" stroke="${primary.color}" stroke-opacity="${primary.opacity}" stroke-width="${Math.max(1, Math.round(theme.outlineWidth * dpr))}"/>`);
      const size = item.marker.size * dpr;
      const cx = (item.marker.x * dpr) + size / 2;
      const cy = (item.marker.y * dpr) + size / 2;
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${size / 2 - dpr}" fill="${primary.color}" stroke="#ffffff" stroke-width="${2 * dpr}"/>`);
      parts.push(`<text x="${cx}" y="${cy}" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${16 * dpr}" text-anchor="middle" dominant-baseline="central">${escapeXml(item.label)}</text>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

const area = (rect) => (rect ? rect.width * rect.height : 0);
function overlap(a, b) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return x * y;
}

/**
 * 逐项渲染结果（B2-07 / B2-08）。几何上的判断，不冒充像素验收：
 *   visibleRatio  元素本身（sourceRect）落在截图内的面积比例；低于 minVisibleRatio 记 partially-clipped
 *   redactedRatio 元素被隐私遮罩盖住的比例；超过一半记 target-redacted（框画在马赛克上没有意义）
 * visible=false 的项不算"标到了"。
 */
function renderAnnotationResults(annotations, { width, height, dpr, redactions = [], minVisibleRatio = 0.8 }) {
  const masks = redactions.map((item) => item.rect && toImageRect(item.rect, { width, height, dpr })).filter(Boolean);
  return annotations.map((item) => {
    const target = item.target && toImageRect(item.target, { width, height, dpr });
    const source = item.sourceRect && toImageRect(item.sourceRect, { width, height, dpr });
    const marker = item.marker && toImageRect({ x: item.marker.x, y: item.marker.y, width: item.marker.size, height: item.marker.size }, { width, height, dpr });
    const intersects = !!(item.sourceRect ? source : target);
    const drawn = intersects && !!marker;
    const raw = item.sourceRect || item.target;
    const full = raw ? Number(raw.width) * Number(raw.height) * dpr * dpr : 0;
    const shown = item.sourceRect ? source : target;
    const visibleRatio = full > 0 ? Math.round((area(shown) / full) * 1000) / 1000 : 0;
    const redactedRatio = shown && area(shown) > 0 ? Math.round((masks.reduce((sum, mask) => sum + overlap(shown, mask), 0) / area(shown)) * 1000) / 1000 : 0;
    const reason = !item.target ? 'target-not-located' : !intersects ? 'outside-image' : !marker ? 'marker-outside-image'
      : visibleRatio < minVisibleRatio ? 'partially-clipped' : redactedRatio > 0.5 ? 'target-redacted' : null;
    return { feature_id: item.feature_id || null, label: item.label || null, located: !!item.target, outlined: intersects, intersects, drawn, visible: drawn && !reason,
      visibleRatio, redactedRatio, imageRect: shown || null, target: target || null, marker: marker || null, reason,
      // 实际命中的定位：{ strategyIndex, fallback } 或 { source: 'declared-rect' }
      ...(item.resolution ? { locator: item.resolution } : {}) };
  });
}

/**
 * 从 raw 派生 sanitized 与 published。raw 文件本身不会被修改。
 * @param {object} p
 * @param {string} p.rawPath
 * @param {object} p.geometry     { dpr, viewport, scroll, documentSize, fullPage, mutationGeneration }
 * @param {Array}  p.redactions   [{ kind, rect(CSS), result }]
 * @param {Array}  p.annotations  layoutAnnotations 的结果（CSS 坐标）
 * @param {object} p.theme
 * @param {string} p.sanitizedPath  私有目录
 * @param {string|null} p.publishedPath  发布目录（annotatedDir）；null 表示只生成私有 sanitized
 */
async function deriveImages({ rawPath, geometry, redactions = [], annotations = [], theme, sanitizedPath, publishedPath }) {
  const rawBytes = fs.readFileSync(rawPath);
  const meta = await sharp(rawBytes).metadata();
  const dpr = Number(geometry?.dpr) || 1;
  const size = { dpr, width: meta.width, height: meta.height };

  const maskRects = [];
  for (const item of redactions) {
    const rect = item.rect ? toImageRect(item.rect, size, MIN_MASK) : null;
    if (rect) maskRects.push(rect);
  }
  const sanitized = maskRects.length
    ? await sharp(rawBytes).composite([{ input: Buffer.from(maskSvg({ width: meta.width, height: meta.height, rects: maskRects, dpr })), top: 0, left: 0 }]).png().toBuffer()
    : await sharp(rawBytes).png().toBuffer();
  const published = annotations.length
    ? await sharp(sanitized).composite([{ input: Buffer.from(annotationSvg({ width: meta.width, height: meta.height, annotations, dpr, theme })), top: 0, left: 0 }]).png().toBuffer()
    : sanitized;

  // 先写私有 sanitized，再写发布图；任何一步失败都不会留下未遮罩的发布文件。
  writeFileAtomic(sanitizedPath, sanitized);
  if (publishedPath) writeFileAtomic(publishedPath, published);

  return {
    rawHash: `sha256:${sha256Hex(rawBytes)}`,
    geometryHash: revisionOf({ geometry: geometry || null, masks: maskRects }),
    sanitizedSha256: sha256Hex(sanitized),
    publishedSha256: sha256Hex(published),
    rendererVersion: RENDERER_VERSION,
    width: meta.width,
    height: meta.height,
    maskRects,
  };
}

module.exports = { RENDERER_VERSION, toImageRect, maskSvg, annotationSvg, renderAnnotationResults, deriveImages, paint };
