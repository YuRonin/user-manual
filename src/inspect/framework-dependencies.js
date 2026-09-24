'use strict';

/*
 * 框架的隐式依赖：不在 import 里出现，但会参与渲染同一个页面的文件。
 *
 *   App Router   从页面目录一直到 app 根目录，每一层的 layout / template / loading / error /
 *                not-found / global-error / default
 *   Pages Router pages/_app、pages/_document
 *   两者          middleware（项目根或 src/ 下）
 *
 * 这些是页面的 scope dependency：它们变化会影响页面，但它们本身不是独立 Page。
 */

const fs = require('fs');
const path = require('path');

const RENDER_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mdx'];
const APP_CONVENTIONS = ['layout', 'template', 'loading', 'error', 'not-found', 'global-error', 'default'];

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function existing(projectRoot, baseNoExt) {
  return RENDER_EXTENSIONS.map((ext) => `${baseNoExt}${ext}`).filter((file) => {
    try { return fs.statSync(path.join(projectRoot, file)).isFile(); } catch (_) { return false; }
  });
}

/**
 * @param {string} projectRoot
 * @param {{ entry, router }} page
 * @param {{ appDir?, pagesDir? }} layout  detectFramework 的结果
 * @returns {string[]} 项目根相对路径（不含页面入口本身）
 */
function frameworkDependencies(projectRoot, page, { appDir = null, pagesDir = null } = {}) {
  const out = new Set();
  const entry = toPosix(page.entry || '');
  if (page.router === 'app' && appDir) {
    const rootDir = toPosix(appDir).replace(/\/$/, '');
    let dir = path.posix.dirname(entry);
    // 页面目录 → app 根目录，逐层收集渲染约定文件
    while (dir === rootDir || dir.startsWith(`${rootDir}/`)) {
      for (const name of APP_CONVENTIONS) for (const file of existing(projectRoot, `${dir}/${name}`)) out.add(file);
      if (dir === rootDir) break;
      dir = path.posix.dirname(dir);
    }
  }
  if (page.router === 'pages' && pagesDir) {
    const rootDir = toPosix(pagesDir).replace(/\/$/, '');
    for (const name of ['_app', '_document']) for (const file of existing(projectRoot, `${rootDir}/${name}`)) out.add(file);
  }
  for (const base of ['middleware', 'src/middleware']) for (const file of existing(projectRoot, base)) out.add(file);
  out.delete(entry);
  return [...out].sort();
}

module.exports = { frameworkDependencies, APP_CONVENTIONS };
