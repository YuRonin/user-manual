'use strict';

/*
 * Next.js 路由扫描。
 *
 * 纯确定性：从文件路径推出 URL 路由，不读文件内容、不猜语义。
 * 语义（title / purpose / detectedActions）由 AI 读源码后经 `manual describe` 写回。
 *
 * 两套路由都支持：
 *   App Router   app/**\/page.{tsx,jsx,ts,js,mdx}
 *   Pages Router pages/**\/*.{tsx,jsx,ts,js,mdx}
 */

const fs = require('fs');
const path = require('path');

const PAGE_EXTENSIONS = ['tsx', 'jsx', 'ts', 'js', 'mdx'];

/** App Router 里与页面同级、但本身不是页面的约定文件。只匹配 `page.*` 就天然排除了它们。 */
const APP_NON_PAGE_FILES = [
  'layout', 'loading', 'error', 'not-found', 'template', 'default', 'global-error', 'route',
];

/** Pages Router 里不产生用户页面的文件。 */
const PAGES_ROUTER_SPECIAL = ['_app', '_document', '_error', 'middleware'];

/** 目录遍历时永远跳过的目录名。 */
const SKIP_DIRS = new Set(['node_modules', '__tests__', '__mocks__', '__snapshots__']);

function extOf(fileName) {
  const i = fileName.lastIndexOf('.');
  return i === -1 ? '' : fileName.slice(i + 1);
}

function stripExt(fileName) {
  const i = fileName.lastIndexOf('.');
  return i === -1 ? fileName : fileName.slice(0, i);
}

function isTestLike(baseNoExt) {
  return /\.(test|spec|stories)$/.test(baseNoExt);
}

/** 递归收集目录下的文件（相对 root 的 POSIX 路径）。 */
function walk(root, dir = root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(path.relative(root, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 路由段转换

/** 私有目录 `_foo`：Next 不会把它变成路由。 */
function isPrivateSegment(seg) {
  return seg.startsWith('_');
}

/** 路由组 `(marketing)`：参与组织但不出现在 URL 里。注意与拦截路由区分。 */
function isRouteGroup(seg) {
  return /^\(.+\)$/.test(seg) && !isInterceptingSegment(seg);
}

/** 拦截路由 `(.)foo` / `(..)foo` / `(...)foo` / `(..)(..)foo`：不是独立可访问 URL。 */
function isInterceptingSegment(seg) {
  return /^\(\.{1,3}\)/.test(seg);
}

/** 并行路由插槽 `@modal`：渲染进布局的槽位，没有独立 URL。 */
function isParallelSlot(seg) {
  return seg.startsWith('@');
}

/**
 * 动态段转成 `:param` 形式。
 *   [[...slug]] → :slug?   可选 catch-all
 *   [...slug]   → :slug*   catch-all
 *   [id]        → :id
 * 非动态段原样返回。
 */
function toRouteSegment(seg) {
  let m = /^\[\[\.\.\.(.+)\]\]$/.exec(seg);
  if (m) return { text: `:${m[1]}?`, dynamic: true, param: m[1] };
  m = /^\[\.\.\.(.+)\]$/.exec(seg);
  if (m) return { text: `:${m[1]}*`, dynamic: true, param: m[1] };
  m = /^\[(.+)\]$/.exec(seg);
  if (m) return { text: `:${m[1]}`, dynamic: true, param: m[1] };
  return { text: seg, dynamic: false, param: null };
}

/**
 * 把一串目录段转成路由。
 * @returns {{ route, dynamic, params } | { skip: 原因 }}
 */
function segmentsToRoute(segments) {
  const parts = [];
  const params = [];
  let dynamic = false;

  for (const seg of segments) {
    if (seg === '') continue;
    if (isInterceptingSegment(seg)) return { skip: 'intercepting' };
    if (isParallelSlot(seg)) return { skip: 'parallel-slot' };
    if (isPrivateSegment(seg)) return { skip: 'private-folder' };
    if (isRouteGroup(seg)) continue;

    const converted = toRouteSegment(seg);
    if (converted.dynamic) {
      dynamic = true;
      params.push(converted.param);
    }
    parts.push(converted.text);
  }

  return { route: '/' + parts.join('/'), dynamic, params };
}

/** 去掉重复斜杠、去掉非根路由的结尾斜杠。 */
function normalizeRoute(route) {
  const cleaned = route.replace(/\/{2,}/g, '/');
  return cleaned.length > 1 ? cleaned.replace(/\/$/, '') : '/';
}

// ---------------------------------------------------------------- 扫描

/** App Router：只认 `page.<ext>`。 */
function scanAppRouter(projectRoot, appDir) {
  const root = path.join(projectRoot, appDir);
  const results = [];
  const skipped = [];

  for (const rel of walk(root)) {
    const base = path.posix.basename(rel);
    const ext = extOf(base);
    if (!PAGE_EXTENSIONS.includes(ext)) continue;
    if (stripExt(base) !== 'page') continue;

    const dirSegments = path.posix.dirname(rel) === '.' ? [] : path.posix.dirname(rel).split('/');
    const converted = segmentsToRoute(dirSegments);
    const file = `${appDir}/${rel}`;

    if (converted.skip) {
      skipped.push({ file, reason: converted.skip });
      continue;
    }

    results.push({
      route: normalizeRoute(converted.route),
      dynamic: converted.dynamic,
      params: converted.params,
      entry: file,
      router: 'app',
    });
  }

  return { pages: results, skipped };
}

/** Pages Router：目录下的普通文件即路由，api/ 与下划线开头的除外。 */
function scanPagesRouter(projectRoot, pagesDir) {
  const root = path.join(projectRoot, pagesDir);
  const results = [];
  const skipped = [];

  for (const rel of walk(root)) {
    const base = path.posix.basename(rel);
    const ext = extOf(base);
    if (!PAGE_EXTENSIONS.includes(ext)) continue;

    const baseNoExt = stripExt(base);
    const file = `${pagesDir}/${rel}`;

    if (isTestLike(baseNoExt)) { skipped.push({ file, reason: 'test-file' }); continue; }
    if (PAGES_ROUTER_SPECIAL.includes(baseNoExt)) { skipped.push({ file, reason: 'framework-file' }); continue; }
    if (baseNoExt.startsWith('_')) { skipped.push({ file, reason: 'private-file' }); continue; }

    const dirPart = path.posix.dirname(rel);
    const dirSegments = dirPart === '.' ? [] : dirPart.split('/');
    if (dirSegments[0] === 'api') { skipped.push({ file, reason: 'api-route' }); continue; }

    // index.tsx 代表所在目录本身，其余文件名自己是一段
    const fileSegments = baseNoExt === 'index' ? [] : [baseNoExt];
    const converted = segmentsToRoute([...dirSegments, ...fileSegments]);

    if (converted.skip) { skipped.push({ file, reason: converted.skip }); continue; }

    results.push({
      route: normalizeRoute(converted.route),
      dynamic: converted.dynamic,
      params: converted.params,
      entry: file,
      router: 'pages',
    });
  }

  return { pages: results, skipped };
}

/**
 * 扫描 Next.js 项目的全部用户可访问页面。
 * @returns {{ pages, skipped, conflicts }}  pages 按路由排序；conflicts 是同一路由的多个入口文件
 */
function scanNextjs(projectRoot, { appDir, pagesDir }) {
  const collected = [];
  const skipped = [];

  if (appDir) {
    const r = scanAppRouter(projectRoot, appDir);
    collected.push(...r.pages);
    skipped.push(...r.skipped);
  }
  if (pagesDir) {
    const r = scanPagesRouter(projectRoot, pagesDir);
    collected.push(...r.pages);
    skipped.push(...r.skipped);
  }

  // 同一路由被多个文件命中（app 与 pages 并存时常见）：保留先出现的，其余记为冲突交给用户判断
  const byRoute = new Map();
  const conflicts = [];
  for (const page of collected) {
    const existing = byRoute.get(page.route);
    if (existing) conflicts.push({ route: page.route, entries: [existing.entry, page.entry] });
    else byRoute.set(page.route, page);
  }

  const pages = [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route));
  return { pages, skipped, conflicts };
}

module.exports = {
  scanNextjs,
  scanAppRouter,
  scanPagesRouter,
  segmentsToRoute,
  toRouteSegment,
  normalizeRoute,
  walk,
  PAGE_EXTENSIONS,
  APP_NON_PAGE_FILES,
};
