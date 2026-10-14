'use strict';

/*
 * 浏览器路由审计（docs/MULTI_FRAMEWORK_PLAN.md §6.4，L4 的可选部分）。
 *
 * 用已授权的认证档案打开测试环境，收集运行时能观察到的路由，与页面模型（静态发现结果）对照，
 * 只报告差异：它负责发现缺口，不替代源码解析，也不写页面模型。确认后由人写进 routes.override.yaml。
 *
 * 观察来源：
 *   link        已登录页面里的站内链接（<a href>），所有框架通用
 *   vue-router  Vue 3 应用实例上的 $router.getRoutes()：能看到 addRoute() 动态添加的路由
 * React Router 没有公开的全局入口，只能依赖链接；用 onClick 跳转的菜单在这里看不到（报告里说明）。
 */

const path = require('path');

const { prepareAuth } = require('../auth/runtime');
const { createProjectStore } = require('../store/project');
const { routeParams } = require('../inspect/adapters/route-table');

const DEFAULT_MAX_PAGES = 20;

function joinUrl(base, route) {
  return `${String(base).replace(/\/+$/, '')}${route.startsWith('/') ? route : `/${route}`}`;
}

/** 路由模式 → URL 匹配正则：`:id` 一段、`:id?` 可选段、`:rest*` 任意剩余部分。 */
function patternRegex(route) {
  let source = '^';
  for (const seg of route.split('/').filter(Boolean)) {
    const m = /^:([\w$]+)([?*]?)$/.exec(seg);
    if (!m) source += `/${seg.replace(/[.+^${}()|[\]\\]/g, '\\$&')}`;
    else if (m[2] === '?') source += '(?:/[^/]+)?';
    else if (m[2] === '*') source += '(?:/.*)?';
    else source += '/[^/]+';
  }
  return new RegExp(`${source}/?$`);
}

function normalizePath(pathname) {
  let value = pathname;
  try { value = decodeURI(pathname); } catch (_) { value = pathname; }
  return value.length > 1 ? value.replace(/\/+$/, '') : '/';
}

/** 在页面里收集：站内链接，以及（若是 Vue 3 应用）完整的运行时路由表。 */
function collectInPage() {
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => { try { return new URL(a.getAttribute('href'), location.href); } catch (_) { return null; } })
    .filter((u) => u && u.origin === location.origin)
    .map((u) => u.pathname);
  let vueRoutes = null;
  const host = [...document.querySelectorAll('body, body *')].find((el) => el.__vue_app__);
  const router = host?.__vue_app__?.config?.globalProperties?.$router;
  if (router && typeof router.getRoutes === 'function') {
    vueRoutes = router.getRoutes().map((r) => ({
      path: r.path,
      hasComponent: !!(r.components && Object.keys(r.components).length),
      redirect: !!r.redirect,
    }));
  }
  return { links: [...new Set(links)], vueRoutes };
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config
 * @param {object} p.session          createBrowserSession() 的实例
 * @param {string} [p.authProfile]    认证档案（默认 config.auth.activeProfile）
 * @param {number} [p.maxPages]       最多打开多少个页面收集链接
 * @returns {Promise<object>} 审计报告
 */
async function auditRoutes({ projectRoot, config, session, authProfile = null, maxPages = DEFAULT_MAX_PAGES }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const committed = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).readCommitted();
  if (!committed) {
    const error = new Error('还没有提交过项目模型：先运行 manual inspect。');
    error.code = 'no-committed-model';
    throw error;
  }
  const pages = committed.model.pages || [];
  // 已知路由：在册页面（含 excluded / retired：它们是有意不进手册，不算遗漏）
  const known = pages.filter((p) => typeof p.route === 'string').map((p) => ({ route: p.route, id: p.id, lifecycle: p.lifecycle || 'active', regex: patternRegex(p.route) }));
  const knownPatterns = new Set(known.map((k) => k.route));
  const discovery = committed.model.meta?.discovery || null;

  // 打开顺序：根路由，再按路由顺序取静态页面（动态参数页面不编造参数值）
  const startRoutes = ['/', ...known.filter((k) => k.lifecycle === 'active' && !k.route.includes(':')).map((k) => k.route)];
  const queue = [...new Set(startRoutes)].slice(0, Math.max(1, maxPages));

  const profileId = config.capture.activeProfile;
  const providerId = config.browser.activeProvider;
  const auth = prepareAuth(config, { profile: authProfile || undefined });
  const visited = [];
  const errors = [];
  const observedLinks = new Map();
  let vueRoutes = null;

  await session.withScenario({ id: providerId, providerConfig: config.browser.providers[providerId], profile: config.capture.profiles[profileId], auth }, async (provider) => {
    for (const route of queue) {
      const url = joinUrl(config.project.baseUrl, route);
      try {
        const nav = await provider.open(url);
        await provider.waitUntilReady({ timeout: 15000 }).catch(() => {});
        const found = await provider.page.evaluate(collectInPage);
        visited.push({ route, finalUrl: nav.finalUrl, redirected: nav.redirected });
        for (const link of found.links) if (!observedLinks.has(link)) observedLinks.set(link, route);
        if (found.vueRoutes && !vueRoutes) vueRoutes = found.vueRoutes;
      } catch (error) {
        errors.push(`${route}: ${error.code || error.reason || 'open-failed'} ${error.message}`);
      }
    }
  });

  const basePath = new URL(config.project.baseUrl).pathname.replace(/\/+$/, '');
  const unmatched = [];
  for (const [rawPath, from] of observedLinks) {
    const local = basePath && rawPath.startsWith(basePath) ? rawPath.slice(basePath.length) || '/' : rawPath;
    const urlPath = normalizePath(local);
    if (!known.some((k) => k.regex.test(urlPath))) unmatched.push({ source: 'link', path: urlPath, from });
  }
  if (vueRoutes) {
    for (const r of vueRoutes) {
      if (!r.hasComponent || /\(\.\*\)/.test(r.path)) continue;
      const pattern = routeParams(r.path).route;
      if (!knownPatterns.has(pattern)) unmatched.push({ source: 'vue-router', path: pattern });
    }
  }

  return {
    kind: 'route-audit',
    generatedAt: new Date().toISOString(),
    baseUrl: config.project.baseUrl,
    authProfile: auth.profile,
    discovery: discovery ? { adapter: discovery.adapter, completeness: discovery.completeness } : null,
    sources: { link: true, vueRouter: !!vueRoutes },
    visited,
    observed: { links: observedLinks.size, vueRoutes: vueRoutes ? vueRoutes.length : 0 },
    unmatched: unmatched.sort((a, b) => a.path.localeCompare(b.path) || a.source.localeCompare(b.source)),
    errors,
    notes: vueRoutes ? [] : ['没有读到运行时路由表（非 Vue 3 应用）：只对照了页面里的 <a href> 链接，用 onClick 跳转的菜单项不会被观察到。'],
  };
}

module.exports = { auditRoutes, patternRegex, collectInPage };
