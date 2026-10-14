'use strict';

/*
 * 路由记录 → 统一发现结果（docs/MULTI_FRAMEWORK_PLAN.md §5）。
 *
 * 每个适配器只产出 RouteRecord[]；去向、冲突、计数与完整性在这里统一判定，
 * 不让各适配器各算一套。核心不变式：每条记录恰好一个去向（page / skipped / unresolved），
 *   routeRecords = 产出页面的记录 + skipped + unresolved
 * 完整性看「每条记录都有去向且 unresolved 为 0」，不看页面数量。
 */

const { revision } = require('../../model/revision');

const DISPOSITION = { PAGE: 'page', SKIPPED: 'skipped', UNRESOLVED: 'unresolved' };
const COMPLETENESS = { COMPLETE: 'complete', PARTIAL: 'partial', UNSUPPORTED: 'unsupported' };

const SKIP_REASONS = new Set([
  'redirect', 'catch-all', 'layout-only', 'excluded',
  // Next.js 扫描沿用的原因
  'framework-file', 'private-file', 'private-folder', 'api-route', 'intercepting', 'parallel-slot', 'test-file',
]);
const UNRESOLVED_REASONS = new Set([
  'dynamic-path', 'dynamic-component', 'unresolved-spread', 'unsupported-syntax', 'runtime-routes',
]);

/** 记录内容的稳定 hash：path、入口、静态 props / meta、布局链。行号不参与（格式化不应改变它）。 */
function recordHash(record) {
  return revision({
    path: record.fullPath ?? null,
    entry: record.entry ?? null,
    props: record.props ?? null,
    meta: record.meta ?? null,
    layoutChain: record.layoutChain || [],
  });
}

/** 去向与原因必须合法；不合法是适配器的 bug，直接抛出而不是悄悄归类。 */
function checkRecord(record) {
  const where = `${record.recordId || '(no id)'}`;
  if (!record.recordId) throw new Error(`路由记录缺少 recordId: ${JSON.stringify(record)}`);
  if (record.disposition === DISPOSITION.PAGE) {
    if (!record.fullPath || !record.entry) throw new Error(`页面记录缺少 fullPath / entry: ${where}`);
  } else if (record.disposition === DISPOSITION.SKIPPED) {
    if (!SKIP_REASONS.has(record.reason)) throw new Error(`未知的 skipped 原因 ${record.reason}: ${where}`);
  } else if (record.disposition === DISPOSITION.UNRESOLVED) {
    if (!UNRESOLVED_REASONS.has(record.reason)) throw new Error(`未知的 unresolved 原因 ${record.reason}: ${where}`);
  } else {
    throw new Error(`路由记录去向非法 ${record.disposition}: ${where}`);
  }
}

/**
 * @param {object} p
 * @param {string} p.adapter
 * @param {object[]} p.records                RouteRecord[]（按适配器的发现顺序）
 * @param {(record) => object} p.toPage       页面记录 → DiscoveredPage
 * @param {string[]} [p.routeSources]         参与发现的路由定义文件
 * @param {string[]} [p.diagnostics]
 * @param {'supported'|'partial'|'unsupported'} [p.detectStatus]
 * @param {boolean} [p.sortPages]             页面按路由排序（Next 现有行为）
 * @returns {RouteDiscoveryResult}
 */
function finalizeDiscovery({ adapter, records, toPage, routeSources = [], diagnostics = [], detectStatus = 'supported', sortPages = true }) {
  const seen = new Set();
  for (const record of records) {
    checkRecord(record);
    if (seen.has(record.recordId)) throw new Error(`路由记录 id 重复: ${record.recordId}`);
    seen.add(record.recordId);
    if (record.disposition === DISPOSITION.PAGE && !record.recordHash) record.recordHash = recordHash(record);
  }

  // 同一路由被多条记录命中：保留先出现的，其余记为冲突交给用户判断（与 Next 现有行为一致）
  const byRoute = new Map();
  const conflicts = [];
  for (const record of records.filter((r) => r.disposition === DISPOSITION.PAGE)) {
    const page = toPage(record);
    const existing = byRoute.get(page.route);
    if (existing) conflicts.push({ route: page.route, entries: [existing.entry, page.entry], recordIds: [existing.__recordId, record.recordId] });
    else byRoute.set(page.route, Object.defineProperty(page, '__recordId', { value: record.recordId, enumerable: false }));
  }
  const pages = [...byRoute.values()];
  if (sortPages) pages.sort((a, b) => a.route.localeCompare(b.route));

  const counts = {
    routeRecords: records.length,
    pageRecords: records.filter((r) => r.disposition === DISPOSITION.PAGE).length,
    pages: pages.length,
    skipped: records.filter((r) => r.disposition === DISPOSITION.SKIPPED).length,
    unresolved: records.filter((r) => r.disposition === DISPOSITION.UNRESOLVED).length,
    conflicts: conflicts.length,
  };
  if (counts.routeRecords !== counts.pageRecords + counts.skipped + counts.unresolved) {
    throw new Error(`路由记录去向不变式被破坏: ${JSON.stringify(counts)}`);
  }

  let completeness = COMPLETENESS.COMPLETE;
  if (detectStatus === 'unsupported') completeness = COMPLETENESS.UNSUPPORTED;
  else if (detectStatus === 'partial' || counts.unresolved > 0) completeness = COMPLETENESS.PARTIAL;

  return {
    adapter,
    completeness,
    detectStatus,
    records,
    pages,
    conflicts,
    routeSources: [...new Set(routeSources)].sort(),
    counts,
    diagnostics,
  };
}

/** 发现结果的摘要（写进 project.yaml / --json，不含整份记录）。 */
function discoverySummary(discovery) {
  return {
    adapter: discovery.adapter,
    completeness: discovery.completeness,
    counts: discovery.counts,
    unresolved: discovery.records
      .filter((r) => r.disposition === DISPOSITION.UNRESOLVED)
      .map((r) => ({ recordId: r.recordId, reason: r.reason, location: r.location || null, ...(r.detail ? { detail: r.detail } : {}) })),
    diagnostics: discovery.diagnostics,
  };
}

module.exports = { DISPOSITION, COMPLETENESS, SKIP_REASONS, UNRESOLVED_REASONS, recordHash, finalizeDiscovery, discoverySummary };
