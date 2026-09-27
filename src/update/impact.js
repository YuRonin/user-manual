'use strict';

/*
 * 旧新依赖图影响分析（P3-01）。
 *
 * 输入：变更文件（git-changes.detectChanges）、基线源码图（发布时）、当前源码图、当前模型。
 * 输出：file → Page → Scenario → Manual Section 的影响清单，每条影响带 reasonPath，
 *       例如 ['components/GlobalLayout.tsx', 'dashboard', 'page-dashboard', 'page-dashboard']。
 *
 * 规则：
 *   - 文件归属查旧图与新图的 union：删除 / rename 只在旧图里有记录，不能只查新图；
 *   - Git 只是线索：基线图里登记过 hash 的文件，实际内容相同则判定为未变化（touch、改回原样）；
 *   - 全局配置（tsconfig / next.config / lockfile …）变化 → 所有页面，confidence=conservative；
 *   - 无法归属的源码文件 + 依赖覆盖不完整（partial / unknown）的页面 → 保守纳入这些页面；
 *   - 远端 build / 数据漂移不由源码检测：runtimeFreshness 单独报告，交给 live verify / TTL；
 *   - 无基线 → fallback=full-rebuild-required，不返回空影响。
 */

const path = require('path');

const { GLOBAL_FILES, hashFile, impactReport } = require('../inspect/fingerprint');
const { SOURCE_EXTENSIONS, ASSET_EXTENSIONS } = require('../inspect/import-graph');
const { taskPageIds } = require('../inspect/index-builder');
const { derivePageScenario, deriveTaskScenario } = require('../scenarios/model');
const { manualIdFor } = require('../publication/release-store');
const { filterChanges, graphFileHashes } = require('./git-changes');

const CONFIDENCE = { EXACT: 'exact', CONSERVATIVE: 'conservative' };

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

/** file → 登记该文件的页面 id（旧图 ∪ 新图）。 */
function fileOwners(...graphs) {
  const owners = new Map();
  for (const graph of graphs) {
    for (const [pageId, node] of Object.entries(graph?.pages || {})) {
      for (const file of Object.keys(node.files || {})) {
        if (!owners.has(file)) owners.set(file, new Set());
        owners.get(file).add(pageId);
      }
    }
  }
  return owners;
}

function isGlobalFile(file) {
  return GLOBAL_FILES.includes(file);
}

function isSourceLike(file) {
  const ext = path.posix.extname(file).toLowerCase();
  return SOURCE_EXTENSIONS.includes(ext) || ASSET_EXTENSIONS.includes(ext);
}

/**
 * 用实际内容确认 Git 报告的变化：基线图里有 hash 且与当前一致 → 内容未变。
 * 返回 true（确认变化）/ false（内容相同）/ null（基线没有该文件的 hash，无法确认，按变化处理）。
 */
function confirmContent(projectRoot, change, baselineHashes) {
  if (change.status === 'D') return true;
  const expected = baselineHashes[change.path];
  if (expected === undefined) return null;
  return hashFile(projectRoot, change.path) !== expected;
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config                 loadConfig().config
 * @param {object} p.detection              detectChanges() 的结果
 * @param {object|null} p.baseGraph         基线源码图（发布时的快照）
 * @param {object} p.currentGraph           当前源码图（只读扫描）
 * @param {{ pages, tasks }} p.model        当前模型（已提交快照）
 * @returns 影响报告
 */
function analyzeImpact({ projectRoot, config, detection, baseGraph = null, currentGraph, model, confirmGraph = baseGraph }) {
  const docsDir = toPosix(config.docs.outputDir);
  const stateDir = toPosix(config.artifacts.stateDir);
  const runtimeFreshness = {
    checked: false,
    deployedBuild: config.runtime?.deployedBuild || 'unknown',
    note: '源码影响不代表线上行为：远端 build / 数据 / 权限变化需要 verify --live 或按 TTL 重新采集确认。',
  };
  if (detection.fallback) {
    return {
      mode: detection.mode, base: detection.base || null, fallback: detection.fallback, reason: detection.reason,
      confidence: CONFIDENCE.CONSERVATIVE, changes: [], excluded: [], unowned: [], broadImpact: [],
      pages: [], scenarios: [], sections: [], runtimeFreshness, warnings: detection.warnings || [],
    };
  }

  const owners = fileOwners(baseGraph, currentGraph);
  // 内容二次确认只能用与基线同一时刻的图；显式 --base 时没有对应图，不做确认（宁可多报）。
  const baselineHashes = graphFileHashes(confirmGraph);
  // 显式登记的依赖即使位于默认排除目录下也保留（例如页面直接 import 了 docs 下的 JSON）。
  const keep = new Set([...owners.keys(), ...Object.keys(baseGraph?.globals || {}), ...Object.keys(currentGraph.globals || {})]);
  const filtered = filterChanges(detection.changes, { excludes: [docsDir, stateDir], keep });

  const changes = [];
  const identical = [];
  for (const change of filtered.changes) {
    const contentChanged = confirmContent(projectRoot, change, baselineHashes);
    if (contentChanged === false && !change.oldPath) { identical.push({ ...change, contentChanged }); continue; }
    changes.push({ ...change, contentChanged });
  }

  // 页面层：影响原因 → reasonPath 前缀（文件链）
  const pageHits = new Map();
  const hit = (pageId, reason, chain, confidence) => {
    if (!pageHits.has(pageId)) pageHits.set(pageId, { reasons: new Set(), chains: [], confidence: CONFIDENCE.EXACT });
    const entry = pageHits.get(pageId);
    entry.reasons.add(reason);
    if (!entry.chains.some((c) => c.join('\0') === chain.join('\0'))) entry.chains.push(chain);
    if (confidence === CONFIDENCE.CONSERVATIVE) entry.confidence = CONFIDENCE.CONSERVATIVE;
  };

  const pageIds = new Set([...Object.keys(baseGraph?.pages || {}), ...Object.keys(currentGraph.pages || {})]);
  const coverageOf = (pageId) => currentGraph.pages[pageId]?.completeness || baseGraph?.pages?.[pageId]?.completeness || 'unknown';

  const broadImpact = [];
  const unowned = [];
  for (const change of changes) {
    const paths = [change.oldPath, change.path].filter(Boolean);
    const global = paths.find(isGlobalFile);
    if (global) {
      broadImpact.push(`global-changed:${global}`);
      for (const pageId of pageIds) hit(pageId, `global-changed:${global}`, [global], CONFIDENCE.CONSERVATIVE);
      continue;
    }
    let owned = false;
    for (const file of paths) {
      for (const pageId of owners.get(file) || []) {
        owned = true;
        const kind = change.status === 'D' ? 'dependency-removed' : change.oldPath && file === change.oldPath ? 'dependency-renamed' : 'content-changed';
        hit(pageId, `${kind}:${file}`, [file], coverageOf(pageId) === 'complete' ? CONFIDENCE.EXACT : CONFIDENCE.CONSERVATIVE);
      }
    }
    if (owned) continue;
    if (!paths.some(isSourceLike)) { unowned.push(change.path); continue; }
    // 无法归属的源码：依赖覆盖不完整的页面可能通过动态 import / 未解析别名用到它 → 保守扩大
    const partial = [...pageIds].filter((pageId) => coverageOf(pageId) !== 'complete');
    if (partial.length === 0) { unowned.push(change.path); continue; }
    broadImpact.push(`unresolved-dependency:${change.path}`);
    for (const pageId of partial) hit(pageId, `unresolved-dependency:${change.path}`, [change.path], CONFIDENCE.CONSERVATIVE);
  }

  // 图层面的变化（指纹不同 / 页面新增 / 删除）：Git 之外的第二道确认，例如依赖集合变化、解析器升级。
  const graphImpact = impactReport(baseGraph, currentGraph);
  for (const entry of graphImpact.pages) {
    if (entry.status === 'removed') hit(entry.id, 'page-removed', ['(page-removed)'], CONFIDENCE.EXACT);
    else if (entry.status === 'added' || entry.status === 'initialized') hit(entry.id, 'page-added', ['(page-added)'], CONFIDENCE.EXACT);
    else if (entry.status === 'changed' && !pageHits.has(entry.id)) {
      for (const reason of entry.reasons) {
        const file = reason.includes(':') ? reason.slice(reason.indexOf(':') + 1) : `(${reason})`;
        hit(entry.id, reason, [file], coverageOf(entry.id) === 'complete' ? CONFIDENCE.EXACT : CONFIDENCE.CONSERVATIVE);
      }
    }
  }

  // 页面 → Scenario → Manual Section
  const pagesById = new Map(model.pages.map((page) => [page.id, page]));
  const pages = [];
  const scenarios = new Map();
  const sections = new Map();
  const addSection = (manualId, kind, subjectId, documentPath, chain, confidence, extra = {}) => {
    if (!sections.has(manualId)) sections.set(manualId, { manualId, kind, subjectId, documentPath, confidence: CONFIDENCE.EXACT, reasonPaths: [], ...extra });
    const section = sections.get(manualId);
    section.reasonPaths.push(chain);
    if (confidence === CONFIDENCE.CONSERVATIVE) section.confidence = CONFIDENCE.CONSERVATIVE;
    Object.assign(section, extra);
  };

  for (const pageId of [...pageHits.keys()].sort()) {
    const entry = pageHits.get(pageId);
    const page = pagesById.get(pageId);
    const lifecycle = page?.lifecycle || (currentGraph.pages[pageId] ? 'active' : 'missing');
    const status = !currentGraph.pages[pageId] || (page && page.lifecycle && page.lifecycle !== 'active') ? 'removed'
      : !baseGraph?.pages?.[pageId] ? 'added' : 'changed';
    pages.push({ id: pageId, status, lifecycle, confidence: entry.confidence, reasons: [...entry.reasons].sort() });
    if (!page) continue;

    const pageScenario = derivePageScenario(page, config).id;
    const pageManual = manualIdFor('page', pageId);
    if (page.includeInManual !== false) {
      for (const chain of entry.chains) {
        addScenario(scenarios, pageScenario, { type: 'page', id: pageId }, pageId);
        addSection(pageManual, 'page', pageId, path.posix.join(docsDir, `${pageId}.md`), [...chain, pageId, pageScenario, pageManual], entry.confidence,
          status === 'removed' ? { retirement: true } : {});
      }
    }
  }

  for (const task of model.tasks) {
    if (task.status === 'candidate') continue;
    const taskPages = new Set(taskPageIds(task));
    const evidenceFiles = new Set((task.evidence || []).map((item) => toPosix(item?.file || '')).filter(Boolean));
    const scenarioId = deriveTaskScenario(task, model.pages, config).id;
    const manualId = manualIdFor('task', task.id);
    const documentPath = path.posix.join(docsDir, 'tasks', `${task.id}.md`);
    for (const pageId of [...taskPages].sort()) {
      const entry = pageHits.get(pageId);
      if (!entry) continue;
      const removed = pages.find((p) => p.id === pageId)?.status === 'removed';
      for (const chain of entry.chains) {
        addScenario(scenarios, scenarioId, { type: 'task', id: task.id }, pageId);
        addSection(manualId, 'task', task.id, documentPath, [...chain, pageId, scenarioId, manualId], entry.confidence, removed ? { brokenReference: true } : {});
      }
    }
    // 任务证据里直接声明的源码文件（不一定在页面依赖图里）
    for (const change of changes) {
      const file = [change.path, change.oldPath].find((f) => f && evidenceFiles.has(f));
      if (!file) continue;
      addScenario(scenarios, scenarioId, { type: 'task', id: task.id }, null);
      addSection(manualId, 'task', task.id, documentPath, [file, '(task-evidence)', scenarioId, manualId], CONFIDENCE.EXACT);
    }
  }

  const sectionList = [...sections.values()].sort((a, b) => a.manualId.localeCompare(b.manualId));
  const conservative = pages.some((p) => p.confidence === CONFIDENCE.CONSERVATIVE) || broadImpact.length > 0;
  return {
    mode: detection.mode,
    base: detection.base || null,
    head: detection.head || null,
    fallback: null,
    confidence: conservative ? CONFIDENCE.CONSERVATIVE : CONFIDENCE.EXACT,
    changes,
    identical,
    excluded: filtered.excluded,
    unowned: [...new Set(unowned)].sort(),
    broadImpact: [...new Set(broadImpact)].sort(),
    pages,
    scenarios: [...scenarios.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sections: sectionList,
    runtimeFreshness,
    warnings: detection.warnings || [],
  };
}

function addScenario(map, id, subject, pageId) {
  if (!map.has(id)) map.set(id, { id, subject, pages: [] });
  const entry = map.get(id);
  if (pageId && !entry.pages.includes(pageId)) entry.pages.push(pageId);
}

/** 人读摘要：每个受影响 section 一行，附第一条 reasonPath。 */
function describeImpact(report) {
  if (report.fallback) return [`无法做增量分析（${report.reason}）：需要全量重建（${report.fallback}）。`];
  if (report.sections.length === 0) return ['没有受影响的手册章节。'];
  return report.sections.map((section) => `${section.manualId}  [${section.confidence}]  ${section.reasonPaths[0].join(' → ')}`);
}

/**
 * 整个项目的影响分析（只读）：按每份已发布手册的源码基线分组分析，或用显式 --base 统一分析。
 * @returns {{ ok, mode, groups, sections, fullRebuild, confidence, runtimeFreshness, warnings, currentGraph, model }}
 */
function analyzeProject({ projectRoot, config, base = null }) {
  const { createProjectStore } = require('../store/project');
  const { buildSourceGraph } = require('../inspect/source-graph');
  const { readCurrentGraph } = require('../inspect/index-store');
  const { detectChanges } = require('./git-changes');
  const { groupBaselines, publishedManualIds } = require('./baseline');

  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const committed = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).readCommitted();
  if (!committed) {
    return fullRebuild('no-committed-model', '还没有提交过项目模型：先运行 manual inspect。');
  }
  const lastGraph = readCurrentGraph(stateDirAbs);
  const scanned = buildSourceGraph({ projectRoot, config, existingPages: committed.model.pages, previousGraph: lastGraph });
  if (!scanned.ok) {
    const error = new Error(scanned.errors.join('；'));
    error.code = 'source-scan-failed';
    throw error;
  }
  const currentGraph = scanned.fingerprinted.graph;
  const model = { pages: [...scanned.result.pages, ...scanned.result.removed], tasks: committed.model.tasks };
  const published = publishedManualIds(stateDirAbs);

  const groups = [];
  const warnings = [...scanned.dependencyWarnings];
  let missing = [];
  if (base) {
    // 显式基线：所有已发布手册统一与该提交比较；归属查询用最近一次 inspect 的图 ∪ 当前图
    const detection = detectChanges({ projectRoot, base });
    const report = analyzeImpact({ projectRoot, config, detection, baseGraph: lastGraph, confirmGraph: null, currentGraph, model });
    groups.push({ key: `base:${detection.base}`, baseline: { gitCommit: detection.base, graphRevision: null }, manualIds: published, report });
  } else {
    const grouped = groupBaselines(stateDirAbs, published);
    missing = grouped.missing;
    for (const group of grouped.groups) {
      const detection = detectChanges({ projectRoot, baseline: group.baseline });
      if (!group.baseline.graph) warnings.push(`基线图 ${group.baseline.graphRevision || '(无)'} 不可用：删除 / rename 的归属只能按当前图判断，结果按保守处理。`);
      const report = analyzeImpact({ projectRoot, config, detection, baseGraph: group.baseline.graph, currentGraph, model });
      if (!group.baseline.graph && !report.fallback) report.confidence = CONFIDENCE.CONSERVATIVE;
      groups.push({ key: group.key, baseline: { gitCommit: group.baseline.gitCommit, graphRevision: group.baseline.graphRevision }, manualIds: group.manualIds, report });
    }
  }

  const sections = [];
  for (const group of groups) {
    const members = new Set(group.manualIds);
    for (const section of group.report.sections || []) {
      // 分组模式下只报告属于该基线的手册；未发布过的手册由 generate 负责，不在 update 范围
      if (!members.has(section.manualId)) continue;
      sections.push({ ...section, baseline: group.key });
    }
    for (const warning of group.report.warnings || []) warnings.push(warning);
  }
  const fallbackGroups = groups.filter((g) => g.report.fallback).flatMap((g) => g.manualIds);
  const rebuild = [...new Set([...missing, ...fallbackGroups])].sort();
  if (published.length === 0) return { ...fullRebuild('no-baseline', '还没有任何发布记录，没有可比较的基线：先用 manual generate <目标> 生成手册。'), currentGraph, model };
  const conservative = groups.some((g) => g.report.confidence === CONFIDENCE.CONSERVATIVE) || rebuild.length > 0;
  return {
    ok: true,
    mode: base ? 'explicit-base' : 'per-release',
    groups,
    sections: sections.sort((a, b) => a.manualId.localeCompare(b.manualId)),
    fullRebuild: rebuild.length ? { manualIds: rebuild, reason: 'baseline-missing', fallback: 'full-rebuild-required' } : null,
    confidence: conservative ? CONFIDENCE.CONSERVATIVE : CONFIDENCE.EXACT,
    runtimeFreshness: groups[0]?.report.runtimeFreshness || null,
    warnings: [...new Set(warnings)],
    currentGraph,
    model,
  };
}

function fullRebuild(reason, message) {
  return {
    ok: true, mode: 'none', groups: [], sections: [],
    fullRebuild: { manualIds: [], reason, fallback: 'full-rebuild-required', message },
    confidence: CONFIDENCE.CONSERVATIVE, runtimeFreshness: null, warnings: [],
  };
}

module.exports = { CONFIDENCE, analyzeImpact, analyzeProject, describeImpact, fileOwners, confirmContent };
