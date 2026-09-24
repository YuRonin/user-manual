'use strict';

/*
 * 页面采集与任务采集共用的"稳定截图 + 安全派生"流程（契约 C06）。
 *
 * 1. 截图前读取几何快照（DOM mutation generation、滚动、视口、文档尺寸），
 *    在截图时刻重新解析标注目标并收集敏感元素；
 * 2. 截 raw；再读一次几何。前后不一致就丢弃本次尝试，有限重试后报 geometry-unstable；
 * 3. 离线从同一份 raw 派生 sanitized 与发布图，并生成 privacy 记录。
 * 不声称 DOM 与像素完全原子，只保证检测到变化时不产出发布图。
 */

const { planRedactions } = require('../artifacts/redaction');
const { layoutAnnotations } = require('../artifacts/annotation');
const { buildPrivacyRecord } = require('../publication/validate');
const { deriveImages } = require('./image-pipeline');

const MAX_ATTEMPTS = 3;

function captureError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function sameGeometry(a, b) {
  return a.mutationGeneration === b.mutationGeneration &&
    a.scroll?.x === b.scroll?.x && a.scroll?.y === b.scroll?.y &&
    a.viewport?.width === b.viewport?.width && a.viewport?.height === b.viewport?.height &&
    a.documentSize?.width === b.documentSize?.width && a.documentSize?.height === b.documentSize?.height;
}

/**
 * @param provider
 * @param {object} p
 * @param {string} p.rawPath
 * @param {boolean} [p.fullPage]
 * @param {() => Promise<Array<{label, rect}>>} [p.resolveTargets]  截图时刻的标注目标（CSS 坐标）
 * @returns {{ shot, geometry, targets, candidates, attempts }}
 */
async function captureStable(provider, { rawPath, fullPage = false, format = 'png', resolveTargets = async () => [], maxAttempts = MAX_ATTEMPTS }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const before = provider.collectGeometry ? await provider.collectGeometry({ fullPage }) : null;
    const targets = await resolveTargets();
    const candidates = provider.collectSensitiveElements ? await provider.collectSensitiveElements({ fullPage }) : null;
    const shot = await provider.screenshot({ path: rawPath, fullPage, format });
    const after = provider.collectGeometry ? await provider.collectGeometry({ fullPage }) : null;
    if (!before || sameGeometry(before, after)) {
      const geometry = after
        ? { ...after, fullPage }
        : { dpr: shot.meta?.deviceScaleFactor || 1, viewport: shot.meta?.viewport, scroll: { x: 0, y: 0 }, documentSize: null, fullPage, mutationGeneration: null };
      return { shot, geometry, targets, candidates, attempts: attempt };
    }
  }
  throw captureError('geometry-unstable', `截图前后页面仍在变化，重试 ${maxAttempts} 次后放弃；不会产出发布图。`);
}

/**
 * 从 raw 派生发布图并生成隐私记录。
 * @returns {{ redactions, annotations, privacy, derived }}
 */
async function derivePublished({ captured, rawPath, sanitizedPath, publishedPath, theme, redactionRules = {} }) {
  const detection = planRedactions(captured.candidates || [], redactionRules);
  if (!detection.ok) throw captureError('privacy-uncertain', detection.errors.join('；'));
  const { geometry } = captured;
  const canvas = geometry.fullPage && geometry.documentSize ? geometry.documentSize : (geometry.viewport || captured.shot.meta.viewport);
  const layout = layoutAnnotations(captured.targets || [], canvas, theme);
  if (!layout.ok) throw captureError('annotation-layout-failed', layout.errors.join('；'));
  const privacy = buildPrivacyRecord({ redactions: detection.redactions, config: { privacy: redactionRules } });
  // 隐私检测未通过（如高风险项无法定位）时只留私有 sanitized，不向文档目录写发布图。
  const published = privacy.status === 'passed' ? publishedPath : null;
  const derived = await deriveImages({
    rawPath, geometry, redactions: detection.redactions, annotations: layout.annotations, theme, sanitizedPath, publishedPath: published,
  });
  return { redactions: detection.redactions, annotations: layout.annotations, privacy, derived, published: !!published };
}

module.exports = { captureStable, derivePublished, sameGeometry, MAX_ATTEMPTS };
