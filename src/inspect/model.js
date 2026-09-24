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
  const legacyVerified = !!page.status?.browserVerified;
  const browser = page.browser && typeof page.browser === 'object'
    ? page.browser
    : { ...emptyBrowserState(), verified: legacyVerified };
  const states = page.states && typeof page.states === 'object'
    ? page.states
    : { default: { description: `${page.title || page.id || '页面'}初始状态`, assertions: [{ type: 'url', value: page.route }] } };
  return { ...page, browser, states };
}

/** 当前可采集 / 可生成的页面：lifecycle 缺省视为 active（旧文件）。 */
function isActivePage(page) {
  return (page?.lifecycle || 'active') === 'active';
}

/** 页面是否已被真实浏览器验证过。读这一个地方，别再去看 status。 */
function isBrowserVerified(page) {
  if (page?.browser && typeof page.browser === 'object') return !!page.browser.verified;
  return !!page?.status?.browserVerified; // 老文件兜底
}

function normalizeDependencies(dependencies) {
  const unresolved = Array.isArray(dependencies?.unresolved) ? dependencies.unresolved : [];
  return {
    files: Array.isArray(dependencies?.files) ? dependencies.files : [],
    // 被源码引用的样式 / 翻译 / 图片 / 字体
    assets: Array.isArray(dependencies?.assets) ? dependencies.assets : [],
    // 框架约定依赖（layout、_app 等）：不是独立页面，但会一起渲染
    scope: Array.isArray(dependencies?.scope) ? dependencies.scope : [],
    unresolved,
    // 旧文件没有这个字段：按是否有未解析项推断，不能默认成 complete
    completeness: dependencies?.completeness || (unresolved.length > 0 ? 'partial' : 'unknown'),
  };
}

/** 全新发现的页面：只有扫描能确定的字段，语义留空等 describe 补。 */
function createPage(scanned, id) {
  return {
    id,
    lifecycle: 'active',
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
    states: {
      default: { description: '页面初始状态', assertions: [{ type: 'url', value: scanned.route }] },
    },
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
    // 重新扫到即恢复为 active；用户显式 retire 的页面保持 retired
    lifecycle: existing.lifecycle === 'retired' ? 'retired' : 'active',
    ...(Array.isArray(existing.routeBindings) ? { routeBindings: existing.routeBindings } : {}),
    ...(Array.isArray(existing.identityAssertions) ? { identityAssertions: existing.identityAssertions } : {}),
    route: scanned.route,
    dynamic: scanned.dynamic,
    params: scanned.params || [],
    title: existing.title ?? null,
    purpose: existing.purpose ?? null,
    detectedActions: Array.isArray(existing.detectedActions) ? existing.detectedActions : [],
    entry: scanned.entry,
    source,
    dependencies: normalizeDependencies(scanned.dependencies),
    // 源码指纹由 inspect 在合并后重新计算；这里先带上旧值用于比较
    ...(existing.analysis ? { analysis: existing.analysis } : {}),
    includeInManual: existing.includeInManual !== false,
    confidence,
    browser,
    states: normalizePage(existing).states,
    status: {
      router: scanned.router,
      sourceAnalysis,
    },
    _changed: { routeChanged, entryChanged, wentStale: sourceAnalysis === ANALYSIS.STALE && previousAnalysis !== ANALYSIS.STALE },
  };
}

/** 路由里最后一个非参数段；只用于提示可能的改名，不用于自动合并。 */
function lastStaticSegment(route) {
  const segments = String(route).split('/').filter((seg) => seg && !seg.startsWith(':'));
  return segments[segments.length - 1] || null;
}

/** 用户在页面文件里显式声明的路由绑定（routeBindings[].template）。 */
function declaredTemplates(page) {
  return (Array.isArray(page?.routeBindings) ? page.routeBindings : []).map((b) => b?.template).filter(Boolean);
}

/**
 * 把扫描结果与已有页面文件对齐。
 *
 * 页面身份是固定的 id，不由路由重算：
 *   1. 路由相同 → 同一页面；
 *   2. 路由变了，但入口文件唯一对应、或页面文件里显式声明了 routeBindings 指向新路由 → 同一页面（改名）；
 *   3. 只有"看起来像"（末段相同）时不自动合并，输出 renameCandidates 等用户在 routeBindings 里确认；
 *   4. 找不到的旧页面不删除：lifecycle 标为 missing（被 exclude 的标为 excluded），历史与定义保留。
 * 用户显式 retire 的页面保持 retired。
 *
 * @returns {{ pages, added, updated, removed, excluded, stale, renamed, renameCandidates, newlyMissing }}
 *   removed = 本次不再活跃的已有页面（missing / excluded），仍会写回文件，--prune 才删除。
 */
function reconcile(scannedPages, existingPages, excludePatterns) {
  const kept = scannedPages.filter((p) => !isExcluded(p.route, excludePatterns));
  const excluded = scannedPages.filter((p) => isExcluded(p.route, excludePatterns));
  const existing = existingPages.filter((p) => p && typeof p.route === 'string');

  const byRoute = new Map(existing.map((page) => [page.route, page]));
  const matched = new Map(); // scanned → existing
  const used = new Set();
  for (const scanned of kept) {
    const page = byRoute.get(scanned.route);
    if (page && !used.has(page)) { matched.set(scanned, page); used.add(page); }
  }

  // 显式声明的绑定优先，其次是唯一对应的入口文件。
  const renamed = [];
  const renameCandidates = [];
  const unmatchedScanned = () => kept.filter((s) => !matched.has(s));
  const unmatchedExisting = () => existing.filter((p) => !used.has(p));
  for (const scanned of unmatchedScanned()) {
    const bound = unmatchedExisting().filter((page) => declaredTemplates(page).includes(scanned.route));
    const sameEntry = unmatchedExisting().filter((page) => page.entry && page.entry === scanned.entry);
    const scannedWithEntry = unmatchedScanned().filter((s) => s.entry === scanned.entry);
    const candidates = bound.length ? bound : (sameEntry.length === 1 && scannedWithEntry.length === 1 ? sameEntry : []);
    if (candidates.length === 1) {
      matched.set(scanned, candidates[0]);
      used.add(candidates[0]);
      renamed.push({ id: candidates[0].id, from: candidates[0].route, to: scanned.route, by: bound.length ? 'route-binding' : 'entry' });
    } else if (bound.length > 1 || sameEntry.length > 1) {
      for (const page of bound.length ? bound : sameEntry) renameCandidates.push({ pageId: page.id, fromRoute: page.route, toRoute: scanned.route, reason: 'ambiguous' });
    }
  }
  for (const scanned of unmatchedScanned()) {
    const tail = lastStaticSegment(scanned.route);
    for (const page of unmatchedExisting()) {
      if (tail && lastStaticSegment(page.route) === tail) renameCandidates.push({ pageId: page.id, fromRoute: page.route, toRoute: scanned.route, reason: 'similar-route' });
    }
  }

  const takenIds = new Set(existing.map((p) => p.id).filter(Boolean));
  const pages = [];
  const added = [];
  const updated = [];
  const stale = [];

  for (const scanned of kept) {
    const page = matched.get(scanned);
    if (page) {
      const merged = mergePage(page, scanned);
      const changed = merged._changed;
      delete merged._changed;
      pages.push(merged);
      if (changed.entryChanged || changed.routeChanged) updated.push(merged);
      if (changed.wentStale || (changed.routeChanged && !changed.wentStale && page.lifecycle !== 'retired')) stale.push(merged);
    } else {
      const id = uniqueId(routeToId(scanned.route), takenIds);
      takenIds.add(id);
      const created = createPage(scanned, id);
      pages.push(created);
      added.push(created);
    }
  }

  // 这次没有扫到的已有页面：保留定义与历史，只改生命周期。
  const removed = [];
  const newlyMissing = [];
  for (const page of unmatchedExisting()) {
    const lifecycle = page.lifecycle === 'retired'
      ? 'retired'
      : (isExcluded(page.route, excludePatterns) ? 'excluded' : 'missing');
    if (lifecycle !== (page.lifecycle || 'active')) newlyMissing.push(page);
    removed.push({ ...page, lifecycle });
  }

  pages.sort((a, b) => a.route.localeCompare(b.route));
  return { pages, added, updated, removed, excluded, stale, renamed, renameCandidates, newlyMissing };
}

module.exports = {
  CONFIDENCE,
  ANALYSIS,
  emptyBrowserState,
  normalizePage,
  isBrowserVerified,
  isActivePage,
  normalizeDependencies,
  routeToId,
  uniqueId,
  routeGlobToRegex,
  isExcluded,
  createPage,
  mergePage,
  reconcile,
};
