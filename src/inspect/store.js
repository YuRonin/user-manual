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
const { buildIndexes } = require('./index-builder');
const { checkSchemaVersion } = require('../model/schema');

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

function indexDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'index');
}

function forwardIndexFileFor(stateDirAbs) {
  return path.join(indexDirFor(stateDirAbs), 'forward.json');
}

function reverseIndexFileFor(stateDirAbs) {
  return path.join(indexDirFor(stateDirAbs), 'reverse.json');
}

function taskForwardIndexFileFor(stateDirAbs) {
  return path.join(indexDirFor(stateDirAbs), 'task-forward.json');
}

function taskReverseIndexFileFor(stateDirAbs) {
  return path.join(indexDirFor(stateDirAbs), 'task-reverse.json');
}

function writeIndexes(stateDirAbs, pages, options = {}) {
  let tasks = options.tasks;
  if (!Array.isArray(tasks)) {
    const existingTasks = require('../tasks/store').readTasks(stateDirAbs);
    tasks = existingTasks.errors.length === 0 ? existingTasks.tasks : [];
  }
  const { forward, reverse, taskForward, taskReverse } = buildIndexes(pages, { ...options, tasks });
  const forwardFile = forwardIndexFileFor(stateDirAbs);
  const reverseFile = reverseIndexFileFor(stateDirAbs);
  writeText(forwardFile, JSON.stringify(forward, null, 2) + '\n');
  writeText(reverseFile, JSON.stringify(reverse, null, 2) + '\n');
  const taskForwardFile = taskForwardIndexFileFor(stateDirAbs);
  const taskReverseFile = taskReverseIndexFileFor(stateDirAbs);
  writeText(taskForwardFile, JSON.stringify(taskForward || {}, null, 2) + '\n');
  writeText(taskReverseFile, JSON.stringify(taskReverse || {}, null, 2) + '\n');
  return [forwardFile, reverseFile, taskForwardFile, taskReverseFile];
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
      if (!parsed || typeof parsed !== 'object') { errors.push(`${name}: 内容为空或不是对象`); continue; }
      // 更高版本由新工具写入：本版本不理解其字段，读取后再写回会丢数据，直接拒绝。
      const version = checkSchemaVersion('page', parsed);
      if (!version.ok) errors.push(`${name}: ${version.code}: ${version.message}`);
      else pages.push(normalizePage(parsed));
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
    // active / missing（代码里找不到）/ excluded（被 inspect.exclude 排除）/ retired（显式退役）
    lifecycle: page.lifecycle || 'active',
    ...(Array.isArray(page.routeBindings) ? { routeBindings: page.routeBindings } : {}),
    route: page.route,
    dynamic: page.dynamic,
    params: page.params || [],
    title: page.title ?? null,
    purpose: page.purpose ?? null,
    detectedActions: page.detectedActions || [],
    entry: page.entry,
    source: page.source || [],
    dependencies: {
      files: page.dependencies?.files || [],
      unresolved: page.dependencies?.unresolved || [],
    },
    includeInManual: page.includeInManual !== false,
    confidence: page.confidence,
    // 真实浏览器验证的结果，由 `manual capture` 写入
    browser: {
      verified: !!browser.verified,
      // 以下是最近一次 Capture 记录（.manual/evidence/captures/<id>.json）的投影，权威数据在记录里
      latestCaptureId: browser.latestCaptureId ?? null,
      lastCapture: browser.lastCapture ?? null,
      screenshot: browser.screenshot ?? null,
      url: browser.url ?? null,
      viewport: browser.viewport ?? null,
      deviceScaleFactor: browser.deviceScaleFactor ?? null,
      provider: browser.provider ?? null,
      // 截图时的真实路由（可能因跳转与 route 不同）与页面身份验证结果（verified / url-only）
      actualRoute: browser.actualRoute ?? null,
      identity: browser.identity ?? null,
      // 经过发布门槛的页面发布图 { artifactPath, sha256, privacy }；没有则只能出文字版手册
      published: browser.published ?? null,
    },
    states: page.states || {},
    ...(Array.isArray(page.identityAssertions) ? { identityAssertions: page.identityAssertions } : {}),
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
function writeModel(stateDirAbs, meta, pages, options = {}) {
  const written = [];

  for (const page of pages) {
    const file = pageFileFor(stateDirAbs, page.id);
    writeText(file, renderPageYaml(page));
    written.push(file);
  }

  const projectFile = projectFileFor(stateDirAbs);
  writeText(projectFile, renderProjectYaml(meta, pages));
  written.push(projectFile);

  const indexFiles = options.docsOutputDir
    ? writeIndexes(stateDirAbs, pages, options)
    : [];
  written.push(...indexFiles);

  return { written, projectFile, indexFiles };
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
  indexDirFor,
  forwardIndexFileFor,
  reverseIndexFileFor,
  taskForwardIndexFileFor,
  taskReverseIndexFileFor,
  readExistingPages,
  readPage: (stateDirAbs, id) => {
    const file = pageFileFor(stateDirAbs, id);
    if (!fs.existsSync(file)) return null;
    return yaml.load(fs.readFileSync(file, 'utf8'));
  },
  renderPageYaml,
  renderProjectYaml,
  writeModel,
  writeIndexes,
  removePageFiles,
};
