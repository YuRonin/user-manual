'use strict';

/*
 * 刷新项目模型：扫描源码 → 与已有页面合并 → 源码指纹 → 给受影响任务打 stale 标记 → 一次定义提交 →
 * 写源码图（graph.json / graph.previous.json / 不可变图快照）。
 *
 * `manual inspect` 与 `manual update`（执行前刷新指纹，使缓存 key 反映源码变化）共用。
 * 失败抛带 code 的错误：scan-failed / model-load-failed / model-conflict 等，调用方负责输出。
 */

const fs = require('fs');
const path = require('path');

const { applyFingerprints, impactReport } = require('./fingerprint');
const { reconcile } = require('./model');
const { scanSource } = require('./source-graph');
const { writeGraphSnapshot } = require('./index-store');
const store = require('./store');
const { createProjectStore } = require('../store/project');
const { writeText } = require('../util/fsx');
const { markAffectedTasks } = require('../tasks/staleness');
const { writeInventory } = require('../annotations/store');

function coded(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config
 * @param {boolean} [p.prune]   删除代码里已不存在的路由对应的页面文件（retired 除外）
 */
function refreshModel({ projectRoot, config, prune = false }) {
  const scanned = scanSource(projectRoot);
  if (!scanned.ok) throw coded('scan-failed', scanned.errors.join('；'), { errors: scanned.errors });
  const { detected, scan, dependencyWarnings } = scanned;

  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
  let base;
  try {
    base = projectStore.load();
  } catch (e) {
    throw coded('model-load-failed', e.message, { errors: e.errors || [e.message] });
  }

  const result = reconcile(scan.pages, base.model.pages, config.inspect.exclude);

  // 源码指纹：同路径内容变化、依赖增删、全局配置变化都会被识别；旧图快照保留供影响计算。
  const graphFile = path.join(store.indexDirFor(stateDirAbs), 'graph.json');
  let previousGraph = null;
  try { previousGraph = fs.existsSync(graphFile) ? JSON.parse(fs.readFileSync(graphFile, 'utf8')) : null; } catch (_) { previousGraph = null; }
  const fingerprinted = applyFingerprints(projectRoot, result.pages, previousGraph);
  result.pages = fingerprinted.pages;
  const staleIds = new Set(result.stale.map((p) => p.id));
  for (const change of fingerprinted.changed) {
    if (!staleIds.has(change.id)) { result.stale.push(result.pages.find((p) => p.id === change.id)); staleIds.add(change.id); }
  }
  const impact = impactReport(previousGraph, fingerprinted.graph);

  // 代码里已不存在的路由：默认只报告，加 --prune 才删。
  // 这些文件里可能有 AI 或人写的分析结果，静默删掉代价太大。
  // 显式 retired 的页面是有意保留的历史，prune 只清理 missing / excluded
  const prunedIds = prune ? result.removed.filter((p) => p.lifecycle !== 'retired').map((p) => p.id) : [];
  const pruned = prunedIds.map((id) => store.pageFileFor(stateDirAbs, id));

  const meta = {
    name: config.project.name,
    framework: detected.framework,
    frameworkVersion: detected.version,
    router: detected.router,
    appDir: detected.appDir,
    pagesDir: detected.pagesDir,
    generatedAt: new Date().toISOString(),
  };

  // 没有 --prune 时，保留下来的页面文件也要重写进索引，否则索引会漏掉它们
  const keptRemoved = prune ? result.removed.filter((p) => p.lifecycle === 'retired') : result.removed;
  const indexPages = [...result.pages, ...keptRemoved].sort((a, b) => String(a.route).localeCompare(String(b.route)));

  const staleTasks = markAffectedTasks(base.model.tasks, {
    // 只有这次新变化的页面才标记；已经是 missing 的页面不会每次 inspect 都重复打标
    pageIds: [...result.stale, ...result.newlyMissing].map((page) => page.id),
    // 指纹变化原因里的具体文件：任务 evidence 直接引用的源码变了也要标 stale
    files: fingerprinted.changed.flatMap((change) => change.reasons)
      .filter((reason) => /^(content-changed|dependency-removed|dependency-added):/.test(reason))
      .map((reason) => reason.slice(reason.indexOf(':') + 1)),
  });

  // 一次定义提交：页面、被 prune 的页面、受影响任务的 stale 标记、项目元信息。
  // 扫描期间有别的命令改过模型 → model-conflict，重新执行即可。
  projectStore.commit({
    base,
    kind: 'definition',
    changes: {
      pages: indexPages,
      removePages: prunedIds,
      tasks: staleTasks.tasks.filter((task) => staleTasks.staleIds.includes(task.id)),
      meta,
    },
  });
  const projectFile = store.projectFileFor(stateDirAbs);
  const written = [
    ...indexPages.map((p) => store.pageFileFor(stateDirAbs, p.id)),
    projectFile,
    store.forwardIndexFileFor(stateDirAbs), store.reverseIndexFileFor(stateDirAbs),
    store.taskForwardIndexFileFor(stateDirAbs), store.taskReverseIndexFileFor(stateDirAbs),
  ];
  if (previousGraph) writeText(path.join(store.indexDirFor(stateDirAbs), 'graph.previous.json'), JSON.stringify(previousGraph, null, 2) + '\n');
  writeText(graphFile, JSON.stringify(fingerprinted.graph, null, 2) + '\n');
  // 不可变快照：release 记录 graphRevision，update 据此取回发布时的依赖图
  const graphRevision = writeGraphSnapshot(stateDirAbs, fingerprinted.graph);
  const featureInventory = writeInventory(stateDirAbs, indexPages, staleTasks.tasks);

  return {
    detected, scan, dependencyWarnings, stateDirAbs, result, fingerprinted, impact, staleTasks,
    prunedIds, pruned, indexPages, meta, graphRevision, written, projectFile, featureInventory,
  };
}

module.exports = { refreshModel };
