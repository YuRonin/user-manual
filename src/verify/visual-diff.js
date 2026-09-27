'use strict';

/*
 * 视觉漂移（P3-04）：同规格、同隐私 / 标注版本的发布图逐像素比较。
 *
 *   - 规格（浏览器、平台、视口、DPR、语言、时区）不一致 → environment-incompatible，不比较，不报页面回归；
 *   - 发布图的隐私策略 / 渲染器版本与当前不同 → baseline-incompatible（渲染升级不是 UI 漂移）；
 *   - 动态区域 mask 只作用于比较；与页面身份 / 声明断言目标重叠的区域不允许被 mask（关键区域不能被泛化忽略）；
 *   - 产出差异像素数、比例、变化包围盒与差异 PNG（红色标出变化像素，基于已脱敏的发布图）。
 */

const sharp = require('sharp');

const ENV_FIELDS = ['browserVersion', 'platform', 'viewportWidth', 'viewportHeight', 'dpr', 'locale', 'timezone', 'fullPage'];

/** 采集环境指纹；缺失字段为 null。 */
function environmentOf({ browserVersion = null, platform = process.platform, viewport = {}, dpr = null, locale = null, timezone = null, fullPage = false } = {}) {
  return {
    browserVersion, platform,
    viewportWidth: viewport.width ?? null, viewportHeight: viewport.height ?? null,
    dpr, locale: locale || null, timezone: timezone || null, fullPage: !!fullPage,
  };
}

/** 两个环境是否可比较：任一字段不同或基线缺失都不可比较。 */
function environmentCompatible(baseline, current) {
  if (!baseline) return { ok: false, mismatches: ['baseline-environment-unknown'] };
  const mismatches = ENV_FIELDS.filter((field) => (baseline[field] ?? null) !== (current[field] ?? null)).map((field) => `${field}: ${baseline[field] ?? '∅'} → ${current[field] ?? '∅'}`);
  return { ok: mismatches.length === 0, mismatches };
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * 过滤 mask：与关键区域相交的不采用。
 * @param {Array<{id, rect}>} masks       CSS 像素
 * @param {Array<{id, rect}>} critical    页面身份 / 声明断言目标
 */
function applicableMasks(masks, critical) {
  const used = [];
  const refused = [];
  for (const mask of masks) {
    const hit = critical.find((c) => c.rect && intersects(mask.rect, c.rect));
    if (hit) refused.push({ id: mask.id, overlaps: hit.id });
    else used.push(mask);
  }
  return { used, refused };
}

async function rawOf(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * @param {object} p
 * @param {string} p.baseline        基线发布图
 * @param {string} p.current         本次（同管线派生）的发布图
 * @param {Array<{x,y,width,height}>} [p.masks]  图像像素坐标
 * @param {number} [p.tolerance]     单通道差异容忍（0-255）
 * @param {number} [p.threshold]     判定变化的差异像素比例
 * @param {string} [p.diffPath]      差异 PNG 输出位置
 */
async function compareImages({ baseline, current, masks = [], tolerance = 24, threshold = 0.002, diffPath = null }) {
  const a = await rawOf(baseline);
  const b = await rawOf(current);
  if (a.width !== b.width || a.height !== b.height) {
    return { status: 'size-changed', baselineSize: [a.width, a.height], currentSize: [b.width, b.height], diffPixels: null, ratio: 1, bbox: null, diffPath: null };
  }
  const masked = (x, y) => masks.some((m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
  const out = Buffer.from(b.data);
  let diffPixels = 0;
  let considered = 0;
  let bbox = null;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4;
      if (masked(x, y)) {
        out[i] = 128; out[i + 1] = 128; out[i + 2] = 128; out[i + 3] = 255;
        continue;
      }
      considered++;
      const d = Math.max(Math.abs(a.data[i] - b.data[i]), Math.abs(a.data[i + 1] - b.data[i + 1]), Math.abs(a.data[i + 2] - b.data[i + 2]));
      if (d > tolerance) {
        diffPixels++;
        out[i] = 255; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 255;
        bbox = bbox ? { x0: Math.min(bbox.x0, x), y0: Math.min(bbox.y0, y), x1: Math.max(bbox.x1, x), y1: Math.max(bbox.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
      } else {
        // 未变化像素淡化，便于定位
        out[i] = Math.round(out[i] * 0.3 + 178); out[i + 1] = Math.round(out[i + 1] * 0.3 + 178); out[i + 2] = Math.round(out[i + 2] * 0.3 + 178);
      }
    }
  }
  const ratio = considered ? diffPixels / considered : 0;
  const changed = ratio > threshold;
  let written = null;
  if (diffPath && changed) {
    await sharp(out, { raw: { width: a.width, height: a.height, channels: 4 } }).png().toFile(diffPath);
    written = diffPath;
  }
  return {
    status: changed ? 'changed' : 'same',
    diffPixels, ratio: Number(ratio.toFixed(6)), threshold, tolerance, maskedRegions: masks.length,
    bbox: bbox ? { x: bbox.x0, y: bbox.y0, width: bbox.x1 - bbox.x0 + 1, height: bbox.y1 - bbox.y0 + 1 } : null,
    diffPath: written,
  };
}

module.exports = { ENV_FIELDS, environmentOf, environmentCompatible, applicableMasks, compareImages, intersects };
