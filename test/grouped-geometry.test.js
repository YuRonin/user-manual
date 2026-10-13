'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const fx = require('./fixtures');
const { deriveGrouped } = require('../src/evidence/grouped-figures');
const { DEFAULT_THEME } = require('../src/config/annotation');

(async () => {
  const root = fx.makeTempDir('manual-grouped-geometry-');
  try {
    for (const dpr of [1, 2]) {
      const rawPath = path.join(root, `raw-${dpr}.png`);
      const sanitizedPath = path.join(root, `safe-${dpr}.png`);
      const publishedPath = path.join(root, `figure-${dpr}.png`);
      await sharp({ create: { width: 900 * dpr, height: 800 * dpr, channels: 3, background: '#ff0000' } }).png().toFile(rawPath);
      const operations = Array.from({ length: 7 }, (_, i) => ({ operation_id: `op-${i}`, figure_id: 'form', feature_id: `f-${i}`, label: String(i + 1), rect: { x: 250 + (i % 2) * 100, y: 260 + Math.floor(i / 2) * 70, width: 70, height: 28 } }));
      const captured = { geometry: { dpr, fullPage: true, viewport: { width: 900, height: 600 }, documentSize: { width: 900, height: 800 } },
        targets: operations, plan: operations.map(t => ({ ...t, description: '点击入口。' })), inventory: [], figures: [{ id: 'form', sectionId: 'controls', purpose: 'entry', frame: { mode: 'auto' } }] };
      const mask = { rect: { x: 305, y: 240, width: 50, height: 12 }, kind: 'password', result: 'neutral-mosaic' };
      const safe = await deriveGrouped({ captured, rawPath, sanitizedPath, publishedPath, theme: { ...DEFAULT_THEME, maxMarkersPerImage: 5 }, redactions: [mask], privacy: { status: 'passed' }, canvas: captured.geometry.documentSize });
      assert.equal(safe.parts.length, 2, 'marker limit must split figures');
      assert.deepEqual(safe.figures.map(f => f.annotationRefs.map(r => r.label)), [['1', '2', '3', '4', '5'], ['1', '2']]);
      assert(safe.rendered.every(r => r.visible && r.drawn && r.located));
      const crop = safe.figures[0].crop;
      assert.equal(crop.dpr, dpr);
      assert(crop.width < 900 * dpr && crop.height < 800 * dpr);
      // A mask well away from the annotated controls must survive the full-image crop.
      const { data, info } = await sharp(publishedPath).raw().toBuffer({ resolveWithObject: true });
      const x = Math.floor(320 * dpr - crop.x), y = Math.floor(245 * dpr - crop.y);
      const index = (y * info.width + x) * info.channels;
      assert.notDeepEqual([...data.subarray(index, index + 3)], [255, 0, 0], 'secret pixels must not come from raw');
      const sample = (300 * dpr * 900 * dpr + 320 * dpr) * 3;
      const original = await sharp(rawPath).raw().toBuffer();
      assert.deepEqual([...original.subarray(sample, sample + 3)], [255, 0, 0], 'raw must remain unchanged');
      const viewport = await deriveGrouped({ captured: { ...captured, geometry: { ...captured.geometry, scroll: { x: 0, y: 200 } }, figures: [{ ...captured.figures[0], frame: { mode: 'viewport' } }] }, rawPath, sanitizedPath, publishedPath: path.join(root, `viewport-${dpr}.png`), theme: { ...DEFAULT_THEME, maxMarkersPerImage: 5 }, redactions: [mask], privacy: { status: 'passed' }, canvas: captured.geometry.documentSize });
      assert.deepEqual(viewport.figures.map(f => [f.crop.x, f.crop.y, f.crop.width, f.crop.height]), [[0, 200 * dpr, 900 * dpr, 600 * dpr], [0, 200 * dpr, 900 * dpr, 600 * dpr]], 'viewport figures must use the observed scroll and viewport, rather than the entire document');
      assert(viewport.rendered.every(r => r.visible && r.drawn), 'viewport crop must retain its visible targets');
      if (dpr === 2 && process.env.MANUAL_QA_IMAGE) fs.copyFileSync(publishedPath, process.env.MANUAL_QA_IMAGE);
    }
    console.log('grouped-geometry: DPR 1/2, full-page coordinates, safe crops and local numbering passed');
  } finally { fx.cleanup(root); }
})().catch(e => { console.error(e); process.exitCode = 1; });
