'use strict';

/*
 * 源码之外的更新来源（B5-07 / B5-11 / B5-12a）。update 原先只看 Git 里的源码变化，看不见：
 *
 *   model-changed      .manual/ 里的页面 / 任务定义改了（guide、features、步骤、状态断言……）
 *                      发布时按"采集相关 / 只影响文案"两个视图分别记 revision，据此区分：
 *                        model-changed:capture   需要重新采集（目标、步骤、状态、路由变了）
 *                        model-changed:docs-only 只需重新生成正文（标题、说明文字变了）
 *                        model-changed:definition 旧发布记录没有分视图 revision，无法区分，按需要重新采集处理
 *   state-changed      任务引用的页面状态断言（page.states.<id>）变了：列出状态 id
 *   image-inputs-changed  标注主题 / 渲染器自发布图之后变了：只需重新派生
 *   live-drift         发布之后的在线验证报告了失败或漂移（verify --live 的结果回流到更新计划）
 *
 * 只读；产出与源码影响分析同形的 sections，由 update/plan 统一选目标。
 */

const path = require('path');

const { revision, pickDefinitionFields } = require('../model/revision');

/** 定义的两个视图：capture（影响浏览器执行与截图）与 docs（只影响正文）。 */
const VIEW_FIELDS = {
  page: {
    capture: (p) => ({
      lifecycle: p.lifecycle, route: p.route, dynamic: p.dynamic, params: p.params, routeBindings: p.routeBindings, entry: p.entry,
      ...(p.sections?.length ? { binding: require('../annotations/section-plan').bindingLayout(p) } : {}),
      states: p.states, identityAssertions: p.identityAssertions, detectedActions: p.detectedActions,
      features: (p.features || []).map((f) => ({ id: f.id ?? f.feature_id, priority: f.priority, target: f.target ?? null, taskIds: f.taskIds ?? f.task_ids ?? null })),
      guide: (p.guide || []).map((g) => ({ id: g.id, target: g.target ?? null, featureId: g.featureId ?? null })),
    }),
    docs: (p) => ({
      sections: p.sections, figures: p.figures,
      title: p.title, purpose: p.purpose, includeInManual: p.includeInManual,
      variants: p.variants,
      features: (p.features || []).map((f) => ({ id: f.id ?? f.feature_id, label: f.label, description: f.description ?? null, operations: f.operations })),
      guide: (p.guide || []).map((g) => ({ id: g.id, title: g.title ?? null, instruction: g.instruction ?? null })),
    }),
  },
  userTask: {
    capture: (t) => ({
      entryPage: t.entryPage, environment: t.environment, fixtures: t.fixtures, writeAuthorization: t.writeAuthorization, risk: t.risk,
      steps: (t.steps || []).map(({ id, feature_id, page, pageId, stateBefore, stateAfter, pageAfter, requires, assertionTimeoutMs, action, risk, replay, capture, valueRef, result }) =>
        ({ id, feature_id, page, pageId, stateBefore, stateAfter, pageAfter, requires, assertionTimeoutMs, action, risk, replay, capture, valueRef, ...(result ? { result: { assertionRefs: result.assertionRefs } } : {}) })),
      completion: (t.completion?.claims || []).map((c) => ({ id: c.id, assertionRefs: c.assertionRefs ?? null })),
    }),
    docs: (t) => ({
      title: t.title, goal: t.goal, priority: t.priority, preconditions: t.preconditions, readerPreconditions: t.readerPreconditions,
      branches: t.branches, relatedTasks: t.relatedTasks,
      steps: (t.steps || []).map((s) => ({ id: s.id, title: s.title ?? null, instruction: s.instruction ?? null, ...(s.result ? { result: s.result.text } : {}) })),
      completion: { claims: (t.completion?.claims || []).map((c) => ({ id: c.id, text: c.text })), readerChecks: t.completion?.readerChecks ?? null },
    }),
  },
};

/** 发布时记录的分视图 revision（写入 release.definitionViews）。 */
function definitionViews(kind, entity) {
  const picked = pickDefinitionFields(kind, entity);
  const views = VIEW_FIELDS[kind];
  return { capture: revision(JSON.parse(JSON.stringify(views.capture(picked)))), docs: revision(JSON.parse(JSON.stringify(views.docs(picked)))) };
}

/** 任务引用的页面状态（stateBefore / stateAfter，含入口默认状态）各自的 revision。 */
function stateRevisions(task, pages) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const out = {};
  for (const step of task.steps || []) {
    const pageId = step.pageId ?? step.page;
    for (const state of [step.stateBefore, step.stateAfter]) {
      if (!pageId || !state) continue;
      out[`${pageId}#${state}`] = revision(JSON.parse(JSON.stringify(byId.get(pageId)?.states?.[state] ?? null)));
    }
  }
  return out;
}

/**
 * @param {object} p
 * @param {string} p.stateDirAbs
 * @param {{ pages, tasks }} p.model    当前（已提交 + 源码刷新）的模型
 * @param {string[]} p.published        已发布 manualId
 * @param {object} p.imageInputs        runtime/planner.imageInputsOf(config)
 * @param {string} p.docsDir
 */
function modelChangeSections({ projectRoot, stateDirAbs, model, published, imageInputs, docsDir }) {
  const releases = require('../publication/release-store');
  const { definitionRevision } = require('../model/revision');
  const { createCaptureStore } = require('../evidence/store');
  const { listReports } = require('../verify/report');
  const store = createCaptureStore({ projectRoot, stateDirAbs });
  const reports = listReports(stateDirAbs);
  const sections = [];
  for (const manualId of published) {
    const match = /^(page|task)-(.+)$/.exec(manualId);
    if (!match) continue;
    const [, type, id] = match;
    const kind = type === 'page' ? 'page' : 'userTask';
    const entity = (type === 'page' ? model.pages : model.tasks).find((item) => item.id === id);
    const release = releases.readCurrentRelease(stateDirAbs, manualId);
    if (!entity || !release) continue;
    const reasons = [];
    const views = release.definitionViews?.[id];
    if (views) {
      const current = definitionViews(kind, entity);
      if (current.capture !== views.capture) reasons.push('model-changed:capture');
      else if (current.docs !== views.docs) reasons.push('model-changed:docs-only');
    } else if (release.definitionRevisions?.[id] && release.definitionRevisions[id] !== definitionRevision(kind, entity)) {
      reasons.push('model-changed:definition');
    }
    // 共享页面状态（如 page:chat 的 reply-ready）改了：指出具体状态与它影响的任务（B5-12a）
    if (type === 'task' && release.stateRevisions) {
      const current = stateRevisions(entity, model.pages);
      const changed = Object.keys(release.stateRevisions).filter((key) => current[key] !== release.stateRevisions[key]);
      for (const key of changed.sort()) reasons.push(`state-changed:${key}`);
    }
    // 主题 / 渲染器变化只需重新派生
    const records = (release.captureIds || []).map((captureId) => { try { return store.read(captureId); } catch (_) { return null; } }).filter(Boolean);
    if (type === 'page') {
      for (const variant of entity.sections?.length ? [...new Set(entity.figures.map(f => f.scenarioId || `page-${id}`))].filter(s => s !== `page-${id}`).map(scenarioId => ({ scenarioId })) : entity.variants || []) {
        const resolved = require('../scenarios/store').readScenario(stateDirAbs, variant.scenarioId, { stepIds: [] });
        const baseline = records.find((r) => r.scenarioId === variant.scenarioId);
        if (!resolved.ok || !resolved.scenario || !baseline || baseline.scenarioRevision !== resolved.scenario.revision
          || store.readLatest()[`scenario:${variant.scenarioId}`] !== baseline.id) reasons.push(`scenario-changed:${variant.scenarioId}`);
      }
    }
    if (records.some((r) => (r.provenance?.rendererVersion && r.provenance.rendererVersion !== imageInputs.rendererVersion)
      || (r.provenance?.themeRevision && r.provenance.themeRevision !== imageInputs.themeRevision))) reasons.push('image-inputs-changed');
    // 发布之后最近一次在线验证失败 / 漂移（B5-11）
    const latest = reports.filter((r) => r.manualId === manualId && r.kind !== 'artifacts' && String(r.startedAt) >= String(release.createdAt)).pop();
    if (latest && (latest.result === 'failed' || ['behavior-breaking', 'content-changed', 'visual-only'].includes(latest.drift?.classification))) {
      const category = latest.drift?.classification && latest.drift.classification !== 'none' ? latest.drift.classification
        : (latest.checks || []).find((c) => c.outcome === 'failed')?.category || 'failed';
      reasons.push(`live-drift:${category}`);
    }
    if (!reasons.length) continue;
    const documentPath = release.documentPath || path.posix.join(docsDir, type === 'task' ? `tasks/${id}.md` : `${id}.md`);
    sections.push({ manualId, kind: type, subjectId: id, documentPath, confidence: 'exact', baseline: 'model',
      reasonPaths: reasons.map((reason) => ['(.manual)', reason, manualId]) });
  }
  return sections;
}

module.exports = { definitionViews, stateRevisions, modelChangeSections };
