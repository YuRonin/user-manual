'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { createProjectStore } = require('../store/project');
const { validatePage, validateScenario } = require('../model/schema');
const { applyPatch } = require('../commands/describe');
const { definitionRevision } = require('../model/revision');
const { newUuid, isUuid } = require('../model/ids');
const { revisionOf, sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { RuntimeError } = require('../runtime/errors');
const { grouped } = require('./section-plan');

function proposalFor(page) {
  const inventory = require('./coverage').buildInventory({ page });
  return { pageId: page.id, needsSemanticPlan: !grouped(page),
    guideBlocks: (page.guide || []).map(g => ({ guideId: g.id, featureId: g.featureId || require('./section-plan').featureId((page.features || []).find(f => f.guideId === g.id)) || inventory.find(i => i.guide_id === g.id)?.feature_id || `page:${page.id}:${g.id}`, title: g.title, instruction: g.instruction, targetHint: g.target || null, bindingStatus: 'unresolved' })),
    retainedCaptureId: page.browser?.latestCaptureId || null, warnings: ['已有 target 只作为 hint；旧截图不自动升级为完整证据。'] };
}

/** 分类计划里读者会读到的文字（小节标题 / 场景、步骤、结果、提示、常见问题）按写作规范检查，命中即拒绝。 */
function layoutStyle(page) {
  const { lintProse, formatStyle } = require('../generate/style-lint');
  const texts = [
    ...page.sections.flatMap((s) => [[`sections.${s.id}.title`, s.title], [`sections.${s.id}.goal`, s.goal], ...(s.tips || []).map((t, i) => [`sections.${s.id}.tips[${i}]`, t])]),
    ...require('./section-plan').operationsOf(page).flatMap((o) => [[`operations.${o.id}.instruction`, o.instruction], [`operations.${o.id}.outcome`, o.outcome]]),
    ...(page.faq || []).flatMap((f) => [[`faq.${f.id}.question`, f.question], [`faq.${f.id}.answer`, f.answer]]),
  ];
  return texts.filter(([, text]) => text).flatMap(([where, text]) => formatStyle(lintProse(text), where));
}

function prepareLayouts({ projectRoot, config, payload }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const store = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
  const base = store.load();
  if (!payload) return { store, base, pages: [], scenarios: [], report: base.model.pages.filter(p => p.guide?.length || p.detectedActions?.length > 1 || grouped(p)).map(proposalFor) };
  if (!Array.isArray(payload.pages) || !payload.pages.length) throw new RuntimeError('invalid-manual-layout', '分类迁移需要 pages 数组');
  const pages = [], scenarios = [], seen = new Set();
  const fail = messages => { throw new RuntimeError('invalid-manual-layout', messages.join('；')); };
  for (const patch of payload.pages) {
    const old = base.model.pages.find(p => p.id === patch.id);
    if (!old || seen.has(patch.id)) fail([`页面不存在或重复: ${patch.id}`]);
    seen.add(patch.id);
    const allowed = new Set(['id', 'title', 'purpose', 'features', 'sections', 'figures', 'states', 'variants', 'faq']);
    if (Object.keys(patch).some(k => !allowed.has(k))) fail(['分类迁移只能更新语义与图文定义']);
    const next = { ...applyPatch(old, patch), schemaVersion: 3 };
    if (!next.title?.trim() || !next.purpose?.trim()) fail(['分类计划需要源码支持的 title 与 purpose']);
    if (patch.states) next.states = { ...(old.states || {}), ...patch.states };
    const result = validatePage(next);
    if (!result.ok || !grouped(next)) fail(result.ok ? ['需要分类 sections'] : result.errors.map(e => `${e.path}: ${e.message}`));
    const style = layoutStyle(next);
    if (style.length) fail(style);
    // Every legacy guide survives under its stable content block identity.
    for (const g of old.guide || []) {
      const feature = next.features.find(f => f.guideId === g.id);
      if (!feature || (feature.id ?? feature.feature_id) !== proposalFor(old).guideBlocks.find(b => b.guideId === g.id).featureId || !next.sections.some(s => s.featureRefs.includes(feature.id ?? feature.feature_id))) fail([`旧 guide ${g.id} 须保留稳定功能 id、guideId 和正文收录，保护原有内容`]);
    }
    pages.push(next);
  }
  const ids = new Set();
  for (const scenario of payload.scenarios || []) {
    const result = validateScenario(scenario, { stepIds: [] });
    if (!result.ok || ids.has(scenario.id)) fail(result.ok ? ['Scenario id 重复'] : result.errors.map(e => `${e.path}: ${e.message}`));
    ids.add(scenario.id);
    if (scenario.userTaskId || !pages.some(p => p.id === scenario.entry?.pageId)) fail(['分类 Scenario 须属于本次页面，不能修改任务']);
    const file = path.join(stateDirAbs, 'scenarios', `${scenario.id}.yaml`);
    if (fs.existsSync(file) && revisionOf(yaml.load(fs.readFileSync(file, 'utf8'))) !== revisionOf(scenario)) fail([`Scenario ${scenario.id} 已存在且不同；选择新 id 或显式维护原定义`]);
    scenarios.push({ scenario, file, existed: fs.existsSync(file) });
  }
  for (const page of pages) for (const fig of page.figures) {
    const id = fig.scenarioId || `page-${page.id}`;
    const supplied = scenarios.find(s => s.scenario.id === id)?.scenario;
    const read = require('../scenarios/store').readScenario(stateDirAbs, id, { stepIds: [] });
    const scenario = supplied || read.scenario || (id === `page-${page.id}` ? require('../scenarios/model').derivePageScenario(page, config) : null);
    if (!read.ok || !scenario || scenario.entry.pageId !== page.id || scenario.userTaskId) fail([`图片 ${fig.id} 的 Scenario 无效或不属于页面`]);
    const checkpoint = scenario.checkpoints.find(c => c.id === (fig.checkpointId || 'default'));
    if (!checkpoint) fail([`图片 ${fig.id} 缺少检查点`]);
    if (fig.purpose === 'state' && !(checkpoint.assertions || []).some(a => a.type !== 'url')) fail([`状态图 ${fig.id} 需要非 URL 状态断言`]);
    // 写操作只有两条路：已批准任务的真实执行，或本 Scenario 的 mock Fixture 在浏览器内完整模拟（mocked: true）
    if ((scenario.setup || []).some(s => s.risk && !['read', 'local'].includes(s.risk) && s.mocked !== true)) fail([`Scenario ${id} 的写操作应交由已批准任务执行，或标 mocked: true 并由 mock Fixture 拦截`]);
    if ((scenario.setup || []).some(s => s.mocked === true)) {
      let fixture = null;
      try { fixture = require('../scenarios/fixtures').readFixture(stateDirAbs, scenario.data?.fixture); } catch (error) { fail([`Scenario ${id} 的模拟写操作需要已登记的 mock Fixture：${error.message}`]); }
      if (fixture.kind !== 'mock') fail([`Scenario ${id} 的模拟写操作需要 kind: mock 的 Fixture，${fixture.id} 是 ${fixture.kind}`]);
    }
  }
  return { store, base, pages, scenarios, report: pages.map(p => ({ pageId: p.id, sections: p.sections.map(s => s.id), figures: p.figures.map(f => ({ id: f.id, scenarioId: f.scenarioId || `page-${p.id}`, checkpointId: f.checkpointId || 'default' })), unresolvedOperations: require('./section-plan').operationsOf(p).filter(o => !o.targetHint).map(o => o.id), prior: proposalFor(base.model.pages.find(old => old.id === p.id)) })) };
}

function applyLayouts(options) {
  const prepared = prepareLayouts(options);
  const { store, base, pages, scenarios } = prepared;
  const unchanged = pages.every(p => definitionRevision('page', p) === definitionRevision('page', base.model.pages.find(old => old.id === p.id)));
  if (unchanged && scenarios.every(s => s.existed)) return { ok: true, idempotent: true, report: prepared.report };
  const id = newUuid();
  const dir = path.join(options.projectRoot, options.config.artifacts.stateDir, 'migrations', 'layout', id);
  const snapshot = { id, pages: pages.map(p => base.model.pages.find(old => old.id === p.id)), nextRevisions: Object.fromEntries(pages.map(p => [p.id, definitionRevision('page', p)])), scenarios: scenarios.filter(s => !s.existed).map(s => ({ path: path.relative(options.projectRoot, s.file), sha256: sha256Hex(yaml.dump(s.scenario)) })), status: 'prepared' };
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  const created = [];
  try {
    for (const item of scenarios.filter(s => !s.existed)) { fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.writeFileSync(item.file, yaml.dump(item.scenario), { flag: 'wx' }); created.push(item.file); }
    store.commit({ base, kind: 'definition', changes: { pages } });
  } catch (error) { for (const file of created) fs.rmSync(file, { force: true }); throw error; }
  snapshot.status = 'applied';
  writeFileAtomic(path.join(dir, 'snapshot.json'), JSON.stringify(snapshot, null, 2));
  return { ok: true, migrationId: id, report: prepared.report };
}

function rollbackLayout({ projectRoot, config, id }) {
  if (!isUuid(id)) throw new RuntimeError('invalid-arguments', '迁移 id 非法');
  const file = path.join(projectRoot, config.artifacts.stateDir, 'migrations', 'layout', id, 'snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (snapshot.status === 'rolled-back') return { ok: true, idempotent: true };
  const store = createProjectStore({ stateDirAbs: path.join(projectRoot, config.artifacts.stateDir), docsOutputDir: config.docs.outputDir });
  const base = store.load();
  for (const old of snapshot.pages) if (definitionRevision('page', base.model.pages.find(p => p.id === old.id)) !== snapshot.nextRevisions[old.id]) throw new RuntimeError('model-conflict', '迁移后定义已改变，不能自动回退');
  for (const s of snapshot.scenarios) if (sha256Hex(fs.readFileSync(path.join(projectRoot, s.path))) !== s.sha256) throw new RuntimeError('model-conflict', '迁移后 Scenario 已改变，不能自动回退');
  store.commit({ base, kind: 'definition', changes: { pages: snapshot.pages } });
  for (const s of snapshot.scenarios) fs.rmSync(path.join(projectRoot, s.path), { force: true });
  snapshot.status = 'rolled-back'; writeFileAtomic(file, JSON.stringify(snapshot, null, 2));
  return { ok: true, migrationId: id };
}

module.exports = { proposalFor, prepareLayouts, applyLayouts, rollbackLayout, layoutStyle };
