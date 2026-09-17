'use strict';

/*
 * 技术栈探测。
 *
 * V0.2 只支持 Next.js —— 先把一个框架做透，而不是每个框架都做一半。
 * 其它框架能被**认出来**（好给出准确的「暂不支持」提示），但不扫描。
 */

const fs = require('fs');
const path = require('path');

/** 认得出的框架。supported=false 的只用于给出准确提示。 */
const FRAMEWORKS = [
  { id: 'nextjs', label: 'Next.js', pkg: 'next', supported: true },
  { id: 'nuxt', label: 'Nuxt', pkg: 'nuxt', supported: false },
  { id: 'remix', label: 'Remix', pkg: '@remix-run/react', supported: false },
  { id: 'sveltekit', label: 'SvelteKit', pkg: '@sveltejs/kit', supported: false },
  { id: 'angular', label: 'Angular', pkg: '@angular/core', supported: false },
  { id: 'react-router', label: 'React Router', pkg: 'react-router-dom', supported: false },
  { id: 'vue-router', label: 'Vue Router', pkg: 'vue-router', supported: false },
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

function firstExistingDir(projectRoot, candidates) {
  for (const rel of candidates) {
    const full = path.join(projectRoot, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return rel;
  }
  return null;
}

/**
 * 探测项目框架与路由目录。
 * @returns {{ ok: true, framework, version, router, appDir, pagesDir } | { ok: false, errors: string[] }}
 */
function detectFramework(projectRoot) {
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

  const found = FRAMEWORKS
    .map((f) => ({ ...f, version: depVersion(pkgJson, f.pkg) }))
    .filter((f) => f.version !== null);

  const next = found.find((f) => f.id === 'nextjs');
  const hasNextConfig = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs']
    .some((f) => fs.existsSync(path.join(projectRoot, f)));

  if (!next && !hasNextConfig) {
    const others = found.filter((f) => !f.supported);
    const errors = ['V0.2 的 inspect 只支持 Next.js 项目。'];
    if (others.length > 0) {
      errors.push(`检测到的框架: ${others.map((f) => `${f.label} (${f.version})`).join('、')}，暂不支持。`);
    } else {
      errors.push('未在 package.json 的依赖里找到 next，也没有 next.config.*。');
    }
    errors.push('可以先手工编辑 .manual/pages/ 下的页面文件；其它框架的扫描在后续版本支持。');
    return { ok: false, errors };
  }

  // Next.js 允许把路由目录放在项目根或 src/ 下，两者都查
  const appDir = firstExistingDir(projectRoot, ['app', path.join('src', 'app')]);
  const pagesDir = firstExistingDir(projectRoot, ['pages', path.join('src', 'pages')]);

  if (!appDir && !pagesDir) {
    return {
      ok: false,
      errors: [
        '识别为 Next.js 项目，但既没有 app/ 也没有 pages/ 路由目录（含 src/ 下）。',
        '请确认 --project-root 指向的是 Next.js 应用本身（monorepo 里通常是 apps/<name>）。',
      ],
    };
  }

  const router = appDir && pagesDir ? 'hybrid' : appDir ? 'app' : 'pages';

  return {
    ok: true,
    framework: 'nextjs',
    version: next ? next.version : null,
    router,
    appDir: appDir ? appDir.replace(/\\/g, '/') : null,
    pagesDir: pagesDir ? pagesDir.replace(/\\/g, '/') : null,
  };
}

module.exports = { detectFramework, FRAMEWORKS };
