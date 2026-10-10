'use strict';

/*
 * 从已有 raw 重新派生发布图（契约 C06 / C09）。
 *
 * 隐私规则、标注主题或渲染器变化时，不必重新执行任务：读取 Capture 的 raw 与私有派生输入
 * （几何、标注目标、敏感元素候选），按当前配置重新遮罩与标注，提交一条新的不可变 Capture
 * （provenance.mode = rederived，derivedFrom 指向原记录，observedAt 沿用原观察时间）。
 * 原记录与原图不改。raw 或派生输入已被清理时报 rederive-unavailable，需要重新采集。
 */

const fs = require('fs');
const path = require('path');

const { derivePublished } = require('./capture-safe');
const { createCaptureStore } = require('./store');
const { verifyCaptureRecord } = require('./integrity');
const { RuntimeError } = require('../runtime/errors');

function prefixOf(artifactPath) {
  const base = path.posix.basename(artifactPath).replace(/\.[^.]+$/, '');
  return base.replace(/--[0-9a-f]{16}$/, '');
}

function dirOf(artifactPath) {
  return path.posix.dirname(artifactPath);
}

/**
 * @returns {Promise<{ records: object[], mapping: Record<string, string> }>}  mapping: 旧 captureId → 新 captureId
 */
async function rederiveCaptures({ projectRoot, config, captureIds, runId = null }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const store = createCaptureStore({ projectRoot, stateDirAbs });
  const records = [];
  const mapping = {};
  for (const captureId of captureIds) {
    const old = store.read(captureId);
    if (!old) throw new RuntimeError('rederive-unavailable', `Capture ${captureId} 不存在，需要重新采集。`);
    const raw = old.artifacts.find((a) => a.kind === 'raw');
    const derivation = old.artifacts.find((a) => a.kind === 'derivation');
    const integrity = verifyCaptureRecord(projectRoot, old, { kinds: ['raw', 'derivation'] });
    if (!raw || !derivation || !integrity.ok) {
      throw new RuntimeError('rederive-unavailable', `Capture ${captureId} 的原图或派生输入不可用（${integrity.problems.map((p) => p.code).join(', ') || '缺少派生输入'}），需要重新采集（--refresh）。`);
    }
    const sidecar = JSON.parse(fs.readFileSync(path.join(projectRoot, derivation.path), 'utf8'));
    const handle = store.begin();
    fs.mkdirSync(handle.stagingDir, { recursive: true });
    const rawExt = path.extname(raw.path) || '.png';
    const stagedRaw = handle.file(`raw${rawExt}`);
    fs.copyFileSync(path.join(projectRoot, raw.path), stagedRaw);
    fs.copyFileSync(path.join(projectRoot, derivation.path), handle.file('derivation.json'));
    try {
      const captured = { shot: { meta: sidecar.shotMeta || {} }, geometry: sidecar.geometry, targets: sidecar.targets || [], candidates: sidecar.candidates || [], inventory: sidecar.inventory || null, plan: sidecar.plan || null };
      const safe = await derivePublished({
        captured, rawPath: stagedRaw, sanitizedPath: handle.file('sanitized.png'), publishedPath: handle.file('published.png'),
        theme: config.annotation.themes[config.annotation.activeTheme], redactionRules: config.privacy || {},
      });
      if (captured.inventory) fs.writeFileSync(handle.file('annotations.json'), JSON.stringify({ version: 1, inventory: captured.inventory, plan: captured.plan, rendered: safe.rendered, coverage: safe.coverage }, null, 2));
      const oldSanitized = old.artifacts.find((a) => a.kind === 'sanitized');
      const oldPublished = old.artifacts.find((a) => a.kind === 'published');
      const artifacts = [
        { kind: 'raw', file: stagedRaw, dir: dirOf(raw.path), prefix: prefixOf(raw.path) },
        { kind: 'derivation', file: handle.file('derivation.json'), dir: dirOf(derivation.path), prefix: prefixOf(derivation.path) },
        { kind: 'sanitized', file: handle.file('sanitized.png'), dir: oldSanitized ? dirOf(oldSanitized.path) : `${config.artifacts.stateDir}/artifacts/sanitized`, prefix: oldSanitized ? prefixOf(oldSanitized.path) : prefixOf(raw.path) },
      ];
      if (captured.inventory) artifacts.push({ kind: 'annotations', file: handle.file('annotations.json'), dir: `${config.artifacts.stateDir}/artifacts/annotations`, prefix: prefixOf(raw.path) });
      if (safe.published) {
        artifacts.push({ kind: 'published', file: handle.file('published.png'), dir: config.artifacts.annotatedDir, prefix: oldPublished ? prefixOf(oldPublished.path) : prefixOf(raw.path) });
      }
      const { id: _id, schemaVersion: _v, artifacts: _a, ...rest } = old;
      const record = store.commit(handle, {
        artifacts,
        record: {
          ...rest,
          runId,
          privacy: safe.privacy,
          ...(safe.coverage ? { annotationCoverage: safe.coverage } : {}),
          redactions: safe.redactions.map(({ kind, rect, result }) => ({ kind, rect, result })),
          provenance: {
            mode: 'rederived',
            derivedFrom: old.id,
            derivedFromRawHash: safe.derived.rawHash,
            geometryHash: safe.derived.geometryHash,
            rendererVersion: safe.derived.rendererVersion,
          },
        },
      });
      records.push({ record, safe });
      mapping[old.id] = record.id;
    } catch (error) {
      store.abort(handle);
      throw error;
    }
  }
  return { records, mapping };
}

module.exports = { rederiveCaptures, prefixOf };
