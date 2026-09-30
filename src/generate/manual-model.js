'use strict';

/*
 * Manual / ManualSection 模型（P3-06）。
 *
 *   Manual  { id, kind, subjectId, audience, language, documentPath, sections[] }
 *   Section { id, kind, pageRefs, taskRefs, claimRefs, captureRefs, ownership }
 *
 * 初期映射：旧页面文档 = 单页 overview 手册；旧任务文档 = task guide。文档 URL 不变。
 * route / page / manual 不再一对一：一个页面可以出现在多个任务指南的多个章节里，
 * 反向索引 pageSections() 从当前发布记录里的 sections 计算"页面 → 章节"。
 * Section id 与渲染块 id 相同（render.js），合并与影响分析用同一个身份。
 */

const releases = require('../publication/release-store');

function unique(list) {
  return [...new Set(list.filter(Boolean))];
}

function section(id, kind, refs = {}) {
  return {
    id,
    kind,
    pageRefs: unique(refs.pageRefs || []),
    taskRefs: unique(refs.taskRefs || []),
    claimRefs: unique(refs.claimRefs || []),
    captureRefs: unique(refs.captureRefs || []),
    ownership: 'generated',
  };
}

/** 任务指南的章节。步骤章节引用步骤所在页面与截图的 Capture。 */
function taskSections(pack) {
  const taskRefs = [pack.manualId];
  const captureOf = new Map(pack.artifacts.map((a) => [a.id, a.captureId || null]));
  const pages = unique(pack.steps.map((s) => s.pageId));
  const out = [
    section('overview', 'overview', { taskRefs, pageRefs: pages }),
    section('before', 'preconditions', { taskRefs }),
    section('steps', 'heading', { taskRefs }),
  ];
  for (const step of pack.steps) {
    out.push(section(`step.${step.id}`, 'step', { taskRefs, pageRefs: [step.pageId], captureRefs: step.artifactRefs.map((ref) => captureOf.get(ref)) }));
  }
  out.push(section('completion', 'completion', {
    taskRefs,
    pageRefs: pages,
    claimRefs: pack.claims.map((c) => c.id),
    captureRefs: pack.claims.flatMap((c) => (c.evidence || []).map((e) => e?.captureId)),
  }));
  if (pack.branches.length) out.push(section('branches', 'branches', { taskRefs }));
  if (pack.relatedTasks.length) out.push(section('related', 'related', { taskRefs: [pack.manualId, ...pack.relatedTasks] }));
  return out;
}

/** 页面 overview 手册的章节。 */
function pageSections(pack) {
  const pageRefs = [pack.manualId];
  const out = [
    section('overview', 'overview', { pageRefs }),
    section('location', 'location', { pageRefs, captureRefs: pack.artifacts.map((a) => a.captureId) }),
  ];
  for (const item of pack.guide || []) out.push(section(`guide.${item.id}`, 'instructions', { pageRefs, taskRefs: item.taskId ? [item.taskId] : [] }));
  if (!pack.guide?.length && pack.actions.length) out.push(section('actions', 'actions-inferred', { pageRefs }));
  return out;
}

/**
 * @param {object} pack           FactPack（task / page）
 * @param {object} p
 * @param {string} p.documentPath 项目根相对路径
 * @param {string} [p.audience]
 */
function manualFromPack(pack, { documentPath, audience = 'public' } = {}) {
  const kind = pack.kind === 'task' ? 'task-guide' : 'page-overview';
  return {
    id: releases.manualIdFor(pack.kind, pack.manualId),
    kind,
    subjectId: pack.manualId,
    audience,
    language: pack.language,
    documentPath: documentPath || null,
    sections: pack.kind === 'task' ? taskSections(pack) : pageSections(pack),
  };
}

/** 发布记录里只存章节（手册其余字段可由发布记录本身推出）。 */
function sectionsOf(release) {
  if (Array.isArray(release?.sections)) return release.sections;
  const pack = release?.facts?.factPack;
  return pack ? manualFromPack(pack).sections : [];
}

/**
 * 页面 → 引用它的所有手册章节（当前发布）。同一页面可属于多个任务 / 章节。
 * @returns {Map<pageId, Array<{ manualId, sectionId, kind }>>}
 */
function pageSectionIndex(stateDirAbs, manualIds) {
  const index = new Map();
  for (const manualId of manualIds) {
    const release = releases.readCurrentRelease(stateDirAbs, manualId);
    for (const s of sectionsOf(release)) {
      for (const pageId of s.pageRefs || []) {
        if (!index.has(pageId)) index.set(pageId, []);
        index.get(pageId).push({ manualId, sectionId: s.id, kind: s.kind });
      }
    }
  }
  return index;
}

module.exports = { manualFromPack, sectionsOf, pageSectionIndex, taskSections, pageSections };
