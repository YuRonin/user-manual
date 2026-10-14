'use strict';

/*
 * 源码扫描 → 页面依赖 → 指纹图。inspect（提交模型）与 update（只读计算当前图）共用。
 *
 * 框架相关的部分只有「路由发现」与「隐式依赖」，由检测选中的适配器提供；
 * 依赖图、指纹、合并都与框架无关（docs/MULTI_FRAMEWORK_PLAN.md §4）。
 *
 * 只读：不写 .manual；调用方决定是否提交模型、是否写 graph.json / 快照。
 */

const path = require('path');

const { detectProject } = require('./detect');
const { adapterById } = require('./adapters');
const { DISPOSITION, discoverySummary } = require('./adapters/records');
const { buildImportGraph } = require('./import-graph');
const { applyFingerprints } = require('./fingerprint');
const { reconcile } = require('./model');
const { readOverrides, readCandidates, applyRouteInputs } = require('./route-inputs');

/**
 * 识别框架并扫描页面及其依赖（含框架约定文件）。
 * @returns {{ ok, errors?, detected, scan, discovery, dependencyWarnings, fingerprintOptions }}
 *   scan.skipped / scan.conflicts 保持改造前的形状（{ file, reason } / { route, entries }）。
 */
function scanSource(projectRoot, { stateDirAbs = null } = {}) {
  const detected = detectProject(projectRoot);
  if (!detected.ok) return { ok: false, errors: detected.errors };
  const adapter = adapterById(detected.adapter);
  const ctx = { projectRoot, context: detected.context, languages: detected.languages, routing: detected.routing };
  const discovered = adapter.discover(ctx);

  // L4 人工覆盖 / L3 AI 候选：作为扫描输入合并进发现结果（§6.3、§6.4）
  const overrides = stateDirAbs ? readOverrides(projectRoot, stateDirAbs) : { items: [], errors: [] };
  const candidates = stateDirAbs ? readCandidates(projectRoot, stateDirAbs) : { items: [], stale: [], errors: [] };
  const inputErrors = [...overrides.errors, ...candidates.errors];
  if (inputErrors.length) return { ok: false, errors: inputErrors };
  const discovery = applyRouteInputs({ discovery: discovered, router: detected.router, overrides, candidates });

  // 认出了路由体系但一条页面都没确定：不能当成"项目没有页面"，明确失败并告诉用户怎么补
  if (discovery.pages.length === 0 && discovery.completeness !== 'complete') {
    return {
      ok: false,
      discovery,
      errors: [
        `识别为 ${detected.routing.label} 项目，但没有扫描出任何可确定的页面（${discovery.completeness}）。`,
        ...discovery.diagnostics,
        ...discovery.records.filter((r) => r.disposition === 'unresolved').slice(0, 5).map((r) => `未解析：${r.location?.file || r.recordId}${r.location?.line ? `:${r.location.line}` : ''} ${r.reason}${r.detail ? `（${r.detail}）` : ''}`),
        '可以在 .manual/routes.override.yaml 里人工登记路由，或让 AI 读路由源码后用 `manual inspect --routes-input <候选.json>` 提交候选。',
      ],
    };
  }

  const dependencyWarnings = [...detected.warnings];
  const pages = discovery.pages.map((page) => {
    // 框架约定文件（祖先 layout、_app、父路由组件等）与页面一起渲染：作为 scope 依赖一并遍历
    const scope = adapter.implicitDependencies(ctx, page);
    const graph = buildImportGraph(projectRoot, [page.entry, ...scope], { languages: detected.languages, boundary: discovery.routeSources });
    for (const unresolved of graph.unresolved) {
      dependencyWarnings.push(`${page.route}: 无法解析依赖 ${unresolved}`);
    }
    const dependencies = { ...graph, scope };
    // 路由表写在代码里的框架：单条路由记录的变化（path / 入口 / props / 布局链）要进页面指纹
    if (adapter.recordsInFingerprint && page.routeRecord) dependencies.route = page.routeRecord;
    return { ...page, dependencies };
  });

  const scan = {
    pages,
    skipped: discovery.records
      .filter((record) => record.disposition === DISPOSITION.SKIPPED)
      .map((record) => ({ file: record.location?.file ?? null, reason: record.reason, ...(record.fullPath ? { route: record.fullPath } : {}) })),
    conflicts: discovery.conflicts.map(({ route, entries }) => ({ route, entries })),
  };
  const fingerprintOptions = {
    extraGlobalFiles: adapter.globalFiles(ctx),
    routeSources: discovery.routeSources,
    routeCapability: adapter.capability || null,
  };
  return { ok: true, detected, scan, discovery, summary: discoverySummary(discovery), dependencyWarnings, fingerprintOptions };
}

/**
 * 扫描并与已有页面合并、计算指纹。
 * @returns {{ ok, errors?, detected, scan, result, fingerprinted, dependencyWarnings }}
 */
function buildSourceGraph({ projectRoot, config, existingPages = [], previousGraph = null }) {
  const scanned = scanSource(projectRoot, { stateDirAbs: path.join(projectRoot, config.artifacts.stateDir) });
  if (!scanned.ok) return scanned;
  const result = reconcile(scanned.scan.pages, existingPages, config.inspect.exclude);
  const fingerprinted = applyFingerprints(projectRoot, result.pages, previousGraph, scanned.fingerprintOptions);
  result.pages = fingerprinted.pages;
  return { ...scanned, result, fingerprinted };
}

module.exports = { scanSource, buildSourceGraph };
