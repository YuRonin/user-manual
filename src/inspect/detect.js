'use strict';

/*
 * 技术栈探测（docs/MULTI_FRAMEWORK_PLAN.md §10）。
 *
 * 只建模两个维度：路由体系（决定用哪个发现适配器）与源码语言（决定启用哪些依赖解析器）。
 * 构建工具（Vite / webpack）不单独建模，它们只通过适配器贡献全局配置文件。
 * 认得出但还不支持的框架也要报出来，给出准确的「暂不支持」提示，而不是扫出 0 个页面。
 */

const fs = require('fs');
const path = require('path');

const { ADAPTERS } = require('./adapters');

/** 认得出的框架。只用于没有适配器命中时给出准确提示。 */
const FRAMEWORKS = [
  { id: 'nextjs', label: 'Next.js', pkg: 'next' },
  { id: 'nuxt', label: 'Nuxt', pkg: 'nuxt' },
  { id: 'remix', label: 'Remix', pkg: '@remix-run/react' },
  { id: 'sveltekit', label: 'SvelteKit', pkg: '@sveltejs/kit' },
  { id: 'angular', label: 'Angular', pkg: '@angular/core' },
  { id: 'react-router', label: 'React Router', pkg: 'react-router-dom' },
  { id: 'vue-router', label: 'Vue Router', pkg: 'vue-router' },
];

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 从 package.json 的各类 deps 字段里找某个包的版本号。 */
function depVersion(pkgJson, name) {
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    const v = pkgJson?.[field]?.[name];
    if (v) return String(v);
  }
  return null;
}

/** 项目用到的源码语言：决定依赖图启用哪些解析器。 */
function detectLanguages(pkgJson) {
  const languages = ['js-ts'];
  if (depVersion(pkgJson, 'vue')) languages.push('vue-sfc');
  return languages;
}

/**
 * 探测项目的路由体系与源码语言。
 * @returns {{ ok: true, adapter, routing, languages, framework, version, router, appDir, pagesDir, context, warnings }
 *         | { ok: false, errors: string[] }}
 *   framework / version / router / appDir / pagesDir 是改造前的字段，保留给 project.yaml 与 --json 兼容。
 */
function detectProject(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkgJson = readJson(pkgPath);

  if (!pkgJson) {
    return {
      ok: false,
      errors: [
        `在 ${projectRoot} 下找不到可解析的 package.json。`,
        'inspect 需要从 package.json 判断技术栈；请确认 --project-root 指向前端项目根目录。',
      ],
    };
  }

  const ctx = { projectRoot, pkgJson, depVersion: (name) => depVersion(pkgJson, name) };
  const hits = [];
  for (const adapter of ADAPTERS) {
    const result = adapter.detect(ctx);
    if (result.status === 'absent') continue;
    // 已认出框架但项目结构不对（如 Next 没有路由目录）：报具体原因，不再往下猜
    if (result.status === 'error') return { ok: false, errors: result.errors };
    hits.push({ adapter, result });
  }

  if (hits.length === 0) {
    const supported = ADAPTERS.map((adapter) => adapter.label).join('、');
    const found = FRAMEWORKS
      .map((f) => ({ ...f, version: depVersion(pkgJson, f.pkg) }))
      .filter((f) => f.version !== null);
    const errors = [`目前 inspect 只支持 ${supported} 项目。`];
    if (found.length > 0) {
      errors.push(`检测到的框架: ${found.map((f) => `${f.label} (${f.version})`).join('、')}，暂不支持。`);
    } else {
      errors.push('未在 package.json 的依赖里找到可识别的路由体系。');
    }
    errors.push('可以先手工编辑 .manual/pages/ 下的页面文件；其它框架的扫描在后续版本支持。');
    return { ok: false, errors };
  }

  const [{ adapter, result }, ...others] = hits;
  const warnings = [...(result.warnings || [])];
  let status = result.status;
  if (others.length > 0) {
    warnings.push(`同时检测到多个路由体系（${hits.map((h) => h.adapter.label).join('、')}），按 ${adapter.label} 扫描；其余未覆盖。`);
    if (status === 'supported') status = 'partial';
  }
  const context = result.context || {};
  return {
    ok: true,
    adapter: adapter.id,
    routing: { adapter: adapter.id, label: adapter.label, status, detected: hits.map((h) => h.adapter.id), ...(result.reason ? { reason: result.reason } : {}) },
    languages: detectLanguages(pkgJson),
    framework: adapter.id,
    version: result.version ?? null,
    router: context.router ?? adapter.id,
    appDir: context.appDir ?? null,
    pagesDir: context.pagesDir ?? null,
    context,
    warnings,
  };
}

/** 兼容旧调用：只关心 Next 字段的地方。 */
function detectFramework(projectRoot) {
  return detectProject(projectRoot);
}

module.exports = { detectProject, detectFramework, FRAMEWORKS, depVersion };
