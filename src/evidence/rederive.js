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
const { createCaptureStore, publishedEntries } = require('./store');
const { verifyCaptureRecord } = require('./integrity');
const { RuntimeError } = require('../runtime/errors');
const { annotationArtifacts } = require('../annotations/proof');

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
async function rederiveCaptures({ projectRoot, config, captureIds, runId = null, layoutPage = null }) {
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
      const captured = { shot: { meta: sidecar.shotMeta || {} }, geometry: sidecar.geometry, targets: sidecar.targets || [], candidates: sidecar.candidates || [], inventory: sidecar.inventory || null, plan: sidecar.plan || null, featureCandidates: sidecar.featureCandidates || [], demoDecision: old.privacy?.demo || null, figures: sidecar.figures, bindings: sidecar.bindings, stateVerified: sidecar.stateVerified };
      if (layoutPage?.sections?.length) {
        const layout = require('../annotations/section-plan');
        if (old.bindingRevision !== layout.bindingRevision(layoutPage)) throw new RuntimeError('rederive-unavailable', '控件或状态发生变化，无法使用旧坐标重新派生');
        const nextPlan = layout.layoutPlan(layoutPage, old.scenarioId, old.checkpointId).map(p => ({ ...p, target: sidecar.bindings.find(b => b.operationId === p.operation_id)?.target || p.target }));
        const nextFigures = layout.figuresFor(layoutPage, old.scenarioId, old.checkpointId);
        captured.targets = nextPlan.map(p => {
          const prior = sidecar.targets.find(t => t.operation_id === p.operation_id && t.rect);
          if (!prior) throw new RuntimeError('rederive-unavailable', `缺少操作 ${p.operation_id} 的有效几何，需要重新采集`);
          return { ...prior, figure_id: p.figure_id, label: p.label };
        });
        captured.figures = nextFigures.map(f => ({ ...f, regionRect: sidecar.figures.find(old => JSON.stringify(old.frame?.target) === JSON.stringify(f.frame?.target))?.regionRect || null }));
        captured.plan = nextPlan;
        captured.bindings = nextPlan.map(p => ({ ...sidecar.bindings.find(b => b.operationId === p.operation_id), figureId: p.figure_id }));
        fs.writeFileSync(handle.file('derivation.json'), require('./capture-page').derivationSidecar(captured));
      }
      const safe = await derivePublished({
        captured, rawPath: stagedRaw, sanitizedPath: handle.file('sanitized.png'), publishedPath: handle.file('published.png'),
        theme: config.annotation.themes[config.annotation.activeTheme], redactionRules: config.privacy || {},
      });
      // 沿用冻结的清单与计划：重新派生只换主题 / 隐私规则，不按当前定义重新解释（定义变了由 annotation-plan-changed 要求重采）
      const annotationOut = captured.inventory ? annotationArtifacts({ inventory: captured.inventory, plan: captured.plan || [], rendered: safe.rendered, figures: safe.figures, bindings: safe.bindings, candidates: captured.featureCandidates, coverage: safe.coverage }) : null;
      if (annotationOut) fs.writeFileSync(handle.file('annotations.json'), JSON.stringify(annotationOut.document, null, 2));
      const oldSanitized = old.artifacts.find((a) => a.kind === 'sanitized');
      const oldPublished = old.artifacts.find((a) => a.kind === 'published');
      const artifacts = [
        ...(config.capture?.safety?.persistRaw === false ? [] : [{ kind: 'raw', file: stagedRaw, dir: dirOf(raw.path), prefix: prefixOf(raw.path) }]),
        { kind: 'derivation', file: handle.file('derivation.json'), dir: dirOf(derivation.path), prefix: prefixOf(derivation.path) },
        { kind: 'sanitized', file: handle.file('sanitized.png'), dir: oldSanitized ? dirOf(oldSanitized.path) : `${config.artifacts.stateDir}/artifacts/sanitized`, prefix: oldSanitized ? prefixOf(oldSanitized.path) : prefixOf(raw.path) },
      ];
      if (captured.inventory) artifacts.push({ kind: 'annotations', file: handle.file('annotations.json'), dir: `${config.artifacts.stateDir}/artifacts/annotations`, prefix: prefixOf(raw.path) });
      artifacts.push(...publishedEntries(safe, { file: handle.file('published.png'), dir: config.artifacts.annotatedDir, prefix: oldPublished ? prefixOf(oldPublished.path).replace(/--part-\d+$/, '') : prefixOf(raw.path) }));
      const { id: _id, schemaVersion: _v, artifacts: _a, ...rest } = old;
      const record = store.commit(handle, {
        artifacts,
        record: {
          ...rest,
          ...(layoutPage?.sections?.length ? { layoutRevision: require('../annotations/section-plan').layoutRevision(layoutPage) } : {}),
          rawRetained: config.capture?.safety?.persistRaw !== false,
          runId,
          privacy: safe.privacy,
          // 采集于 Demo 模式之前的证据没有门禁结论：重新派生只能沿用旧遮罩（含马赛克），提示重新采集
          quality: { ...safe.quality, warnings: [...safe.quality.warnings, ...(old.privacy?.demo ? [] : ['demo-evidence-legacy: 采集于 Demo 模式之前，重新派生沿用旧遮罩规则；需要清晰的演示截图时重新采集。'])] },
          ...(safe.coverage ? { annotationCoverage: safe.coverage } : {}),
          ...(annotationOut ? { annotationProof: annotationOut.proof } : {}),
          redactions: safe.redactions.map(({ kind, rect, result }) => ({ kind, rect, result })),
          provenance: {
            mode: 'rederived',
            derivedFrom: old.id,
            derivedFromRawHash: safe.derived.rawHash,
            geometryHash: safe.derived.geometryHash,
            rendererVersion: safe.derived.rendererVersion,
            themeRevision: safe.derived.themeRevision,
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
