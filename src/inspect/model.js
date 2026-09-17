'use strict';

/*
 * 页面模型：id 生成、路由过滤、以及「重扫时怎么合并」。
 *
 * 字段的归属是这套系统的核心约定：
 *   扫描拥有（每次 inspect 重写）    route / dynamic / params / entry / router
 *   分析拥有（inspect 绝不覆盖）      title / purpose / detectedActions / includeInManual
 *   过程状态                          confidence / status
 *
 * 页面的身份是它的 **路由**，不是文件名。所以重扫时按 route 匹配已有页面文件，
 * 这样即使 id 生成规则将来变了，也不会把用户/AI 的分析结果丢掉。
 */

/** 语义信息的可信度。none → 还没分析；inferred → 源码推断；verified → 真实浏览器验证过。 */
const CONFIDENCE = { NONE: 'none', INFERRED: 'inferred', VERIFIED: 'verified' };

/** 源码分析状态。stale = 之前分析过，但路由或入口文件已变，需要重新分析。 */
const ANALYSIS = { PENDING: 'pending', COMPLETED: 'completed', STALE: 'stale' };

// ---------------------------------------------------------------- id

/** 把路由转成稳定的 kebab id。`/` → home，`/artifact/:id` → artifact-id。 */
function routeToId(route) {
  const segments = route
    .split('/')
    .filter(Boolean)
    // :id / :slug* / :slug? 都取参数名本身
    .map((seg) => seg.replace(/^:/, '').replace(/[*?]$/, ''));

  if (segments.length === 0) return 'home';

  const id = segments
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');

  return id || 'page';
}

/** 在已用 id 集合里取一个不冲突的名字。 */
function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------- 路由排除

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 路由 glob → 正则。
 *   `/admin/**`  匹配 /admin 及其下任意层级
 *   `/debug/*`   只匹配 /debug 下恰好一段
 */
function routeGlobToRegex(pattern) {
  const segments = String(pattern).split('/').filter(Boolean);
  if (segments.length === 0) return /^\/$/;

  let source = '^';
  for (const seg of segments) {
    if (seg === '**') source += '(?:/[^/]+)*';
    else if (seg === '*') source += '/[^/]+';
    else source += '/' + escapeRegex(seg).replace(/\\\*/g, '[^/]*');
  }
  return new RegExp(source + '$');
}

/** 路由是否命中任一排除规则。 */
function isExcluded(route, patterns) {
  return (patterns || []).some((p) => {
    try {
      return routeGlobToRegex(p).test(route);
    } catch (_) {
      return false;
    }
  });
}

// ---------------------------------------------------------------- 构造与合并

/** 还没截过图时的 browser 块。 */
function emptyBrowserState() {
  return { verified: false, lastCapture: null, screenshot: null, url: null };
}

/**
 * 归一化读进来的页面文件。
 * 兼容 V0.2 的形状：那时「是否验证过」记在 status.browserVerified，V0.3 起独立成 browser 块。
 */
function normalizePage(page) {
  if (!page || typeof page !== 'object') return page;
  if (page.browser && typeof page.browser === 'object') return page;

  const legacyVerified = !!page.status?.browserVerified;
  return { ...page, browser: { ...emptyBrowserState(), verified: legacyVerified } };
}

/** 页面是否已被真实浏览器验证过。读这一个地方，别再去看 status。 */
function isBrowserVerified(page) {
  if (page?.browser && typeof page.browser === 'object') return !!page.browser.verified;
  return !!page?.status?.browserVerified; // 老文件兜底
}

function normalizeDependencies(dependencies) {
  return {
    files: Array.isArray(dependencies?.files) ? dependencies.files : [],
    unresolved: Array.isArray(dependencies?.unresolved) ? dependencies.unresolved : [],
  };
}

/** 全新发现的页面：只有扫描能确定的字段，语义留空等 describe 补。 */
function createPage(scanned, id) {
  return {
    id,
    route: scanned.route,
    dynamic: scanned.dynamic,
    params: scanned.params || [],
    title: null,
    purpose: null,
    detectedActions: [],
    entry: scanned.entry,
    source: [scanned.entry],
    dependencies: normalizeDependencies(scanned.dependencies),
    includeInManual: true,
    confidence: CONFIDENCE.NONE,
    browser: emptyBrowserState(),
    status: {
      router: scanned.router,
      sourceAnalysis: ANALYSIS.PENDING,
    },
  };
}

/**
 * 把新扫描结果合并进已有页面。
 * 扫描字段覆盖；分析字段保留；入口或路由变了就把分析标记成 stale。
 */
function mergePage(existing, scanned) {
  const routeChanged = existing.route !== scanned.route;
  const entryChanged = existing.entry !== scanned.entry;

  // source 里用户/AI 可能补了组件 glob，只替换入口那一项，其余原样保留
  const extraSource = (existing.source || []).filter((s) => s !== existing.entry);
  const source = [scanned.entry, ...extraSource.filter((s) => s !== scanned.entry)];

  const previousAnalysis = existing.status?.sourceAnalysis || ANALYSIS.PENDING;
  let sourceAnalysis = previousAnalysis;
  if (previousAnalysis === ANALYSIS.COMPLETED && (routeChanged || entryChanged)) {
    sourceAnalysis = ANALYSIS.STALE;
  }

  // 路由变了意味着这已经是另一个 URL，之前截的图和验证都不再作数
  const previousBrowser = normalizePage(existing).browser;
  const browser = routeChanged ? emptyBrowserState() : { ...emptyBrowserState(), ...previousBrowser };

  let confidence = existing.confidence || CONFIDENCE.NONE;
  if (routeChanged && confidence === CONFIDENCE.VERIFIED) confidence = CONFIDENCE.INFERRED;

  return {
    id: existing.id,
    route: scanned.route,
    dynamic: scanned.dynamic,
    params: scanned.params || [],
    title: existing.title ?? null,
    purpose: existing.purpose ?? null,
    detectedActions: Array.isArray(existing.detectedActions) ? existing.detectedActions : [],
    entry: scanned.entry,
    source,
    dependencies: normalizeDependencies(scanned.dependencies),
    includeInManual: existing.includeInManual !== false,
    confidence,
    browser,
    status: {
      router: scanned.router,
      sourceAnalysis,
    },
    _changed: { routeChanged, entryChanged, wentStale: sourceAnalysis === ANALYSIS.STALE && previousAnalysis !== ANALYSIS.STALE },
  };
}

/**
 * 把扫描结果与已有页面文件对齐。
 * @param {object[]} scannedPages  scanNextjs() 的产出
 * @param {object[]} existingPages 已有的 pages/*.yaml 内容
 * @param {string[]} excludePatterns
 * @returns {{ pages, added, updated, removed, excluded, stale }}
 */
function reconcile(scannedPages, existingPages, excludePatterns) {
  const kept = scannedPages.filter((p) => !isExcluded(p.route, excludePatterns));
  const excluded = scannedPages.filter((p) => isExcluded(p.route, excludePatterns));

  // 页面的身份是路由
  const existingByRoute = new Map();
  for (const page of existingPages) {
    if (page && typeof page.route === 'string') existingByRoute.set(page.route, page);
  }

  const takenIds = new Set(existingPages.map((p) => p && p.id).filter(Boolean));
  const pages = [];
  const added = [];
  const updated = [];
  const stale = [];

  for (const scanned of kept) {
    const existing = existingByRoute.get(scanned.route);
    if (existing) {
      const merged = mergePage(existing, scanned);
      const changed = merged._changed;
      delete merged._changed;
      pages.push(merged);
      if (changed.entryChanged) updated.push(merged);
      if (changed.wentStale) stale.push(merged);
    } else {
      const id = uniqueId(routeToId(scanned.route), takenIds);
      takenIds.add(id);
      const page = createPage(scanned, id);
      pages.push(page);
      added.push(page);
    }
  }

  // 已有文件里、这次扫不到的路由：可能是被删了，也可能是被 exclude 了
  const scannedRoutes = new Set(kept.map((p) => p.route));
  const removed = existingPages.filter((p) => p && p.route && !scannedRoutes.has(p.route));

  pages.sort((a, b) => a.route.localeCompare(b.route));
  return { pages, added, updated, removed, excluded, stale };
}

module.exports = {
  CONFIDENCE,
  ANALYSIS,
  emptyBrowserState,
  normalizePage,
  isBrowserVerified,
  normalizeDependencies,
  routeToId,
  uniqueId,
  routeGlobToRegex,
  isExcluded,
  createPage,
  mergePage,
  reconcile,
};
