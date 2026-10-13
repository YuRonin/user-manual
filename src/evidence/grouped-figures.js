'use strict';

const fs = require('fs');
const sharp = require('sharp');
const { layoutAnnotations } = require('../artifacts/annotation');
const { deriveImages, annotationSvg, renderAnnotationResults, toImageRect, RENDERER_VERSION } = require('./image-pipeline');
const { sha256Hex, revisionOf } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { verifyCoverage } = require('../annotations/coverage');

// 图片取景：默认（auto）保留原尺寸截图，只在上面画标注，读者能看到控件在整页中的位置；
// 只有显式声明 region 时才裁到命名区域。viewport 用于整页截图里取当时可见的那一屏。
function frameFor(figure, targets, canvas, geometry = {}) {
  const mode = figure.frame?.mode || 'auto';
  if (mode === 'auto') return { x: 0, y: 0, width: canvas.width, height: canvas.height };
  if (mode === 'viewport') {
    const width = Math.min(canvas.width, geometry.viewport?.width || canvas.width);
    const height = Math.min(canvas.height, geometry.viewport?.height || canvas.height);
    return { x: geometry.fullPage ? Math.max(0, Math.min(canvas.width - width, geometry.scroll?.x || 0)) : 0, y: geometry.fullPage ? Math.max(0, Math.min(canvas.height - height, geometry.scroll?.y || 0)) : 0, width, height };
  }
  if (!targets.length && !figure.regionRect) return { x: 0, y: 0, ...canvas };
  const rects = figure.regionRect ? [figure.regionRect] : targets.map(t => t.rect);
  const padding = figure.frame?.padding ?? 64;
  const x = Math.min(...rects.map(r => r.x));
  const y = Math.min(...rects.map(r => r.y));
  const right = Math.max(...rects.map(r => r.x + r.width));
  const bottom = Math.max(...rects.map(r => r.y + r.height));
  const width = Math.min(canvas.width, Math.max(360, right - x + padding * 2));
  const height = Math.min(canvas.height, Math.max(180, bottom - y + padding * 2));
  return { x: Math.max(0, Math.min(canvas.width - width, x - (width - (right - x)) / 2)), y: Math.max(0, Math.min(canvas.height - height, y - (height - (bottom - y)) / 2)), width, height };
}

async function deriveGrouped({ captured, rawPath, sanitizedPath, publishedPath, theme, redactions, privacy, canvas }) {
  // Complete privacy processing on the full source before any crop is made.
  const derived = await deriveImages({ rawPath, geometry: captured.geometry, redactions, theme, sanitizedPath, publishedPath: null });
  const source = fs.readFileSync(sanitizedPath);
  const dpr = captured.geometry.dpr || 1;
  const meta = await sharp(source).metadata();
  const rendered = [], annotations = [], parts = [], figures = [];
  let part = 0;
  for (const figure of captured.figures) {
    const all = (captured.targets || []).filter(t => t.figure_id === figure.id && t.rect);
    const limit = theme.maxMarkersPerImage || 5;
    const chunks = [];
    for (let i = 0; i < all.length; i += limit) chunks.push(all.slice(i, i + limit));
    if (!chunks.length) chunks.push([]);
    for (const group of chunks) {
      part++;
      const crop = frameFor(figure, group, canvas, captured.geometry);
      const pixels = toImageRect(crop, { dpr, width: meta.width, height: meta.height });
      if (!pixels) throw Object.assign(new Error(`图片 ${figure.id} 的区域不在原图内`), { code: 'figure-region-invalid' });
      const origin = { x: pixels.x / dpr, y: pixels.y / dpr };
      const shift = r => ({ ...r, x: r.x - origin.x, y: r.y - origin.y });
      const localMasks = redactions.map(r => ({ ...r, rect: shift(r.rect) }));
      const local = group.map((t, i) => ({ ...t, part, label: String(i + 1), rect: shift(t.rect) }));
      const size = { width: pixels.width / dpr, height: pixels.height / dpr };
      const layout = layoutAnnotations(local, size, theme, { avoid: localMasks });
      if (!layout.ok) throw Object.assign(new Error(`图片 ${figure.id}: ${layout.errors.join('；')}`), { code: 'annotation-layout-crowded' });
      for (const a of layout.annotations) {
        const t = local.find(t => t.label === a.label);
        Object.assign(a, { operation_id: t.operation_id, figure_id: figure.id, part });
      }
      const results = renderAnnotationResults(layout.annotations, { width: pixels.width, height: pixels.height, dpr, redactions: localMasks, minVisibleRatio: theme.minVisibleRatio ?? 0.8 });
      for (const r of results) { const a = layout.annotations.find(a => a.label === r.label); Object.assign(r, { operation_id: a.operation_id, figure_id: figure.id, part }); }
      rendered.push(...results); annotations.push(...layout.annotations);
      const unresolved = (captured.targets || []).filter(t => t.figure_id === figure.id && !t.rect);
      if (chunks.length === 1) rendered.push(...unresolved.map(t => ({ feature_id: t.feature_id, operation_id: t.operation_id, figure_id: figure.id, part, drawn: false, located: false, outlined: false, intersects: false, reason: t.reason })));
      const verified = !unresolved.length && results.every(r => r.visible && r.drawn);
      const file = part === 1 ? publishedPath : publishedPath.replace(/(\.[a-z]+)$/i, `.part-${part}$1`);
      const base = await sharp(source).extract({ left: pixels.x, top: pixels.y, width: pixels.width, height: pixels.height }).png().toBuffer();
      const bytes = layout.annotations.length ? await sharp(base).composite([{ input: Buffer.from(annotationSvg({ width: pixels.width, height: pixels.height, annotations: layout.annotations, dpr, theme })) }]).png().toBuffer() : base;
      if (privacy.status === 'passed') writeFileAtomic(file, bytes);
      parts.push({ part, file, figureId: figure.id, sha256: sha256Hex(bytes) });
      figures.push({ figureId: figure.id, sectionId: figure.sectionId, part, purpose: figure.purpose, crop: { ...pixels, dpr }, stateVerified: !!captured.stateVerified, status: verified ? 'verified' : 'incomplete', annotationRefs: results.map(r => ({ operationId: r.operation_id, featureId: r.feature_id, label: r.label, description: captured.plan.find(p => p.operation_id === r.operation_id)?.description || '' })) });
    }
  }
  const coverage = verifyCoverage({ inventory: captured.inventory || [], plan: captured.plan || [], rendered, candidates: captured.featureCandidates || [] });
  return { redactions, annotations, rendered, coverage, privacy, figures, bindings: captured.bindings || [],
    derived: { ...derived, publishedSha256: parts[0]?.sha256 || derived.publishedSha256, parts: parts.map(({ part, sha256 }) => ({ part, sha256 })), rendererVersion: RENDERER_VERSION, geometryHash: revisionOf({ source: derived.geometryHash, figures }) },
    quality: require('../generate/quality').imageQuality(captured, redactions, annotations), published: privacy.status === 'passed', parts };
}

module.exports = { deriveGrouped, frameFor };
