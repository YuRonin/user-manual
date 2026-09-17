'use strict';

/*
 * project.yaml 与 pages/<id>.yaml 的读写。
 *
 * 分工：
 *   pages/<id>.yaml   每个页面的**事实来源**，扫描与分析都往这里写
 *   project.yaml      索引，每次写页面后由页面文件重新生成，不手工维护
 *
 * 重新生成索引而不是双写，是为了避免两处描述同一件事导致漂移。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { emit } = require('../util/yaml-emit');
const { writeText } = require('../util/fsx');
const { normalizePage, isBrowserVerified } = require('./model');

const PROJECT_MODEL_VERSION = 1;

function pagesDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'pages');
}

function pageFileFor(stateDirAbs, id) {
  return path.join(pagesDirFor(stateDirAbs), `${id}.yaml`);
}

function projectFileFor(stateDirAbs) {
  return path.join(stateDirAbs, 'project.yaml');
}

/** 读出 pages/ 下所有页面文件。解析失败的记进 errors，不静默吞掉。 */
function readExistingPages(stateDirAbs) {
  const dir = pagesDirFor(stateDirAbs);
  const pages = [];
  const errors = [];

  if (!fs.existsSync(dir)) return { pages, errors };

  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    const full = path.join(dir, name);
    try {
      const parsed = yaml.load(fs.readFileSync(full, 'utf8'));
      // normalizePage 兼容 V0.2 的形状（browserVerified 当时记在 status 里）
      if (parsed && typeof parsed === 'object') pages.push(normalizePage(parsed));
      else errors.push(`${name}: 内容为空或不是对象`);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }

  return { pages, errors };
}

/** 渲染单个页面文件。字段顺序固定，便于 diff。 */
function renderPageYaml(page) {
  const header = [
    `# .manual/pages/${page.id}.yaml`,
    '#',
    '# route / dynamic / params / entry 由 `manual inspect` 扫描维护，重跑会更新。',
    '# title / purpose / detectedActions 是分析产物，`manual inspect` 不会覆盖它们。',
    '# 想重置某页的分析，删掉这个文件再跑一次 inspect 即可。',
    '',
  ].join('\n');

  const browser = page.browser || {};

  // 显式给出键顺序：id/route 在最前，状态在最后
  const ordered = {
    id: page.id,
    route: page.route,
    dynamic: page.dynamic,
    params: page.params || [],
    title: page.title ?? null,
    purpose: page.purpose ?? null,
    detectedActions: page.detectedActions || [],
    entry: page.entry,
    source: page.source || [],
    includeInManual: page.includeInManual !== false,
    confidence: page.confidence,
    // 真实浏览器验证的结果，由 `manual capture` 写入
    browser: {
      verified: !!browser.verified,
      lastCapture: browser.lastCapture ?? null,
      screenshot: browser.screenshot ?? null,
      url: browser.url ?? null,
      viewport: browser.viewport ?? null,
      deviceScaleFactor: browser.deviceScaleFactor ?? null,
      provider: browser.provider ?? null,
    },
    status: {
      router: page.status?.router ?? null,
      sourceAnalysis: page.status?.sourceAnalysis,
    },
  };

  return header + emit(ordered);
}

/** 渲染 project.yaml —— 项目元信息 + 页面索引。 */
function renderProjectYaml(meta, pages) {
  const header = [
    '# .manual/project.yaml',
    '#',
    '# 由 `manual inspect` 生成的项目地图。这是**索引**，每页详情在 .manual/pages/<id>.yaml。',
    '# 每次 inspect / describe 后由页面文件重新生成，不要手工编辑。',
    '',
  ].join('\n');

  const body = {
    version: PROJECT_MODEL_VERSION,
    generatedAt: meta.generatedAt,
    project: {
      name: meta.name,
      framework: meta.framework,
      frameworkVersion: meta.frameworkVersion ?? null,
      router: meta.router,
      appDir: meta.appDir ?? null,
      pagesDir: meta.pagesDir ?? null,
    },
    summary: {
      total: pages.length,
      analyzed: pages.filter((p) => p.status?.sourceAnalysis === 'completed').length,
      pending: pages.filter((p) => p.status?.sourceAnalysis === 'pending').length,
      stale: pages.filter((p) => p.status?.sourceAnalysis === 'stale').length,
      browserVerified: pages.filter((p) => isBrowserVerified(p)).length,
      captured: pages.filter((p) => p.browser?.screenshot).length,
      dynamic: pages.filter((p) => p.dynamic).length,
    },
    pages: pages.map((p) => ({
      id: p.id,
      route: p.route,
      title: p.title ?? null,
      dynamic: p.dynamic,
      includeInManual: p.includeInManual !== false,
      sourceAnalysis: p.status?.sourceAnalysis,
      browserVerified: isBrowserVerified(p),
      screenshot: p.browser?.screenshot ?? null,
      detail: `${path.posix.join('.manual', 'pages')}/${p.id}.yaml`,
    })),
  };

  return header + emit(body);
}

/** 写入全部页面文件与索引。返回写了哪些文件。 */
function writeModel(stateDirAbs, meta, pages) {
  const written = [];

  for (const page of pages) {
    const file = pageFileFor(stateDirAbs, page.id);
    writeText(file, renderPageYaml(page));
    written.push(file);
  }

  const projectFile = projectFileFor(stateDirAbs);
  writeText(projectFile, renderProjectYaml(meta, pages));
  written.push(projectFile);

  return { written, projectFile };
}

/** 删除页面文件（--prune 用）。返回真正删掉的路径。 */
function removePageFiles(stateDirAbs, ids) {
  const removed = [];
  for (const id of ids) {
    const file = pageFileFor(stateDirAbs, id);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(file);
    }
  }
  return removed;
}

module.exports = {
  PROJECT_MODEL_VERSION,
  pagesDirFor,
  pageFileFor,
  projectFileFor,
  readExistingPages,
  readPage: (stateDirAbs, id) => {
    const file = pageFileFor(stateDirAbs, id);
    if (!fs.existsSync(file)) return null;
    return yaml.load(fs.readFileSync(file, 'utf8'));
  },
  renderPageYaml,
  renderProjectYaml,
  writeModel,
  removePageFiles,
};
