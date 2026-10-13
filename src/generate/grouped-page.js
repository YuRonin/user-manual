'use strict';

const path = require('path');
const { createCaptureStore, publishedParts } = require('../evidence/store');
const { readScenario, resolveScenario } = require('../scenarios/store');
const { derivePageScenario } = require('../scenarios/model');
const { validateArtifact } = require('../publication/validate');
const { toMarkdownHref } = require('../publication/paths');
const { layoutRevision, documentCoverage, operationsOf } = require('../annotations/section-plan');
const { RuntimeError } = require('../runtime/errors');

function groupedImages({ projectRoot, config, page, stage = 'draft' }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const store = createCaptureStore({ projectRoot, stateDirAbs });
  const latest = store.readLatest();
  const operations = new Map(operationsOf(page).map(op => [op.id, op]));
  const images = [], records = [], warnings = [];
  for (const fig of page.sections.flatMap(s => s.figureRefs.map(id => page.figures.find(f => f.id === id)))) {
    const scenarioId = fig.scenarioId || `page-${page.id}`;
    const checkpointId = fig.checkpointId || 'default';
    const captureId = latest[`figure-state:${scenarioId}:${checkpointId}`] || latest[scenarioId === `page-${page.id}` ? `page:${page.id}` : `scenario:${scenarioId}`];
    if (!captureId) { warnings.push(`manual-operation-uncovered: 图片 ${fig.id} 尚未采集`); continue; }
    const record = store.read(captureId);
    if (page.analysis?.sourceRevision && record?.sourceFingerprint !== page.analysis.sourceRevision) throw new RuntimeError('evidence-stale', `图片 ${fig.id} 的页面源码在截图后发生了变化，请重新采集`);
    const scenario = scenarioId === `page-${page.id}` ? resolveScenario(stateDirAbs, derivePageScenario(page, config), { stepIds: [] }) : readScenario(stateDirAbs, scenarioId, { stepIds: [] });
    if (!record || record.kind !== 'page' || record.subject.pageId !== page.id || record.scenarioId !== scenarioId || record.checkpointId !== checkpointId || record.layoutRevision !== layoutRevision(page) || !scenario.ok || !scenario.scenario || scenario.scenario.revision !== record.scenarioRevision) throw new RuntimeError('evidence-stale', `图片 ${fig.id} 的状态、来源或分类计划已变化，请重新采集`);
    if (!records.some(r => r.id === record.id)) records.push(record);
    for (const part of publishedParts(record).filter(p => p.figureId === fig.id)) {
      const proof = record.annotationProof?.figures?.find(f => f.figureId === fig.id && f.part === (part.part || 1));
      const image = { figureId: fig.id, sectionId: fig.sectionId, scenarioId, checkpointId, part: part.part || 1, captureId, artifactPath: part.path, sha256: part.sha256, privacy: record.privacy,
        markdownHref: toMarkdownHref({ manualFile: path.join(projectRoot, config.docs.outputDir, `${page.id}.md`), artifactFile: path.join(projectRoot, part.path) }), annotationRefs: (proof?.annotationRefs || []).map(ref => ({ ...ref, description: operations.get(ref.operationId)?.instruction || ref.description })) };
      const errors = validateArtifact(image, { projectRoot, config, stage, warnings: [] });
      if (errors.length) throw new RuntimeError(errors[0].code, errors.map(e => e.message).join('；'));
      images.push(image);
    }
  }
  const result = require('./result-evidence').resultEvidence({ projectRoot, config, page });
  const coverage = documentCoverage(page, images, records, result.claims);
  return { images, records, coverage, resultEvidence: result.claims, warnings: [...warnings, ...coverage.errors.map(e => e.message), ...result.errors.map(e => e.message)] };
}

module.exports = { groupedImages };
