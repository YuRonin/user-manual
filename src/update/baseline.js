'use strict';

/*
 * 源码基线（P3-01）。
 *
 * 发布时记录 release.sourceBaseline = { graphRevision, gitCommit, gitDirty }：
 *   graphRevision  发布时的源码依赖图快照（.manual/index/graphs/<hex>.json，不可变）
 *   gitCommit      发布时的 HEAD（非 Git 项目为 null）
 *   gitDirty       发布时工作区是否有未提交修改（仅供诊断；变更检测总会再用图快照内容比较）
 *
 * 每份手册各自有基线：不同文档可能在不同时间发布，update 按基线分组分析。
 */

const fs = require('fs');
const path = require('path');

const releases = require('../publication/release-store');
const { readCurrentGraph, writeGraphSnapshot, readGraphSnapshot } = require('../inspect/index-store');
const { gitState } = require('./git-changes');

/** 发布时调用：当前源码图（没有 inspect 过则 graphRevision=null）+ Git 状态。 */
function currentSourceBaseline(projectRoot, stateDirAbs) {
  const graph = readCurrentGraph(stateDirAbs);
  const graphRevision = graph ? writeGraphSnapshot(stateDirAbs, graph) : null;
  return { graphRevision, ...gitState(projectRoot) };
}

/** 所有有当前发布的手册 id（releases/<manualId>/current.json 存在）。 */
function publishedManualIds(stateDirAbs) {
  const dir = path.join(stateDirAbs, 'releases');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'current.json')))
    .map((entry) => entry.name)
    .sort();
}

/** 页面已下线：显式 retired，或标为不进手册。它的旧发布记录不再需要维护。 */
function isWithdrawnPage(page) {
  return Boolean(page) && (page.lifecycle === 'retired' || page.includeInManual === false);
}

/** 读取页面模型判断 page-<id> 是否已下线；读不到模型时按未下线处理（不静默跳过）。 */
function isWithdrawnManual(stateDirAbs, manualId) {
  const match = /^page-(.+)$/.exec(manualId);
  if (!match) return false;
  const file = path.join(stateDirAbs, 'pages', `${match[1]}.yaml`);
  try { return isWithdrawnPage(require('js-yaml').load(fs.readFileSync(file, 'utf8'))); } catch (_) { return false; }
}

/** 仍需维护的已发布手册：排除页面已下线的那些。 */
function activePublishedManualIds(stateDirAbs) {
  return publishedManualIds(stateDirAbs).filter((manualId) => !isWithdrawnManual(stateDirAbs, manualId));
}

/**
 * 按基线分组当前发布：同一 (gitCommit, graphRevision) 的手册共享一次影响分析。
 * 旧发布记录没有 sourceBaseline → 归入 missing 组（需要全量重建）。
 * @returns {{ groups: Array<{ key, baseline:{gitCommit, graphRevision, graph}, manualIds }>, missing: string[] }}
 */
function groupBaselines(stateDirAbs, manualIds = publishedManualIds(stateDirAbs)) {
  const groups = new Map();
  const missing = [];
  for (const manualId of manualIds) {
    const release = releases.readCurrentRelease(stateDirAbs, manualId);
    const baseline = release?.sourceBaseline;
    if (!baseline || (!baseline.gitCommit && !baseline.graphRevision)) { missing.push(manualId); continue; }
    const key = `${baseline.gitCommit || '-'}|${baseline.graphRevision || '-'}`;
    if (!groups.has(key)) {
      let graph = null;
      try { graph = baseline.graphRevision ? readGraphSnapshot(stateDirAbs, baseline.graphRevision) : null; } catch (_) { graph = null; }
      groups.set(key, { key, baseline: { gitCommit: baseline.gitCommit || null, graphRevision: baseline.graphRevision || null, graph }, manualIds: [] });
    }
    groups.get(key).manualIds.push(manualId);
  }
  return { groups: [...groups.values()], missing };
}

module.exports = { currentSourceBaseline, publishedManualIds, activePublishedManualIds, isWithdrawnPage, groupBaselines };
