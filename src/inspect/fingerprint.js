'use strict';

/*
 * 页面源码指纹（契约 C01 sourceFingerprint）。
 *
 * 指纹 = 真实依赖文件的字节 hash + 依赖集合本身 + 全局配置（tsconfig / next.config / lockfile …）
 *        + 解析器版本。路径不变但内容变化、依赖增删、别名配置变化、解析规则升级都会改变指纹。
 * mtime 不参与：它只能作为读取优化，不能作为正确性依据。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex } = require('../util/hash');
const { revision } = require('../model/revision');

// 解析策略版本：import-graph / framework-dependencies 的规则变化时递增，旧指纹随之失效。
const PARSER_VERSION = 'regex-import-graph-2';

// 影响所有页面的全局文件：变化时每个页面的指纹都会变（broad impact）。
const GLOBAL_FILES = [
  'tsconfig.json', 'jsconfig.json',
  'next.config.js', 'next.config.mjs', 'next.config.cjs', 'next.config.ts',
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs', 'tailwind.config.mjs',
  'postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs',
];

const SKIP_DIRS = new Set(['node_modules', '.git', '.manual', '.next', 'dist', 'build', 'out', 'coverage']);
const MAX_LISTED_FILES = 20000;

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

function hashFile(projectRoot, relative) {
  try {
    return sha256Hex(fs.readFileSync(path.join(projectRoot, relative)));
  } catch (_) {
    return 'missing';
  }
}

function globalFileHashes(projectRoot) {
  const out = {};
  for (const file of GLOBAL_FILES) {
    if (fs.existsSync(path.join(projectRoot, file))) out[file] = hashFile(projectRoot, file);
  }
  return out;
}

/** 列出项目文件（跳过依赖包与产物目录），一次 inspect 只遍历一次。 */
function createFileLister(projectRoot) {
  let cached = null;
  return function list() {
    if (cached) return cached;
    const out = [];
    let truncated = false;
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        if (out.length >= MAX_LISTED_FILES) { truncated = true; return; }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(full); }
        else if (entry.isFile()) out.push(toPosix(path.relative(projectRoot, full)));
      }
    };
    walk(projectRoot);
    cached = { files: out.sort(), truncated };
    return cached;
  };
}

function globToRegex(pattern) {
  let source = '^';
  const text = toPosix(pattern).replace(/^\.\//, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '*' && text[i + 1] === '*') {
      source += '.*';
      i++;
      if (text[i + 1] === '/') i++;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

/**
 * 展开 page.source 中用户 / AI 补充的文件、目录与受限 glob（不进入 node_modules）。
 * @returns {{ files: string[], unmatched: string[], truncated: boolean }}
 */
function expandSourcePatterns(projectRoot, patterns, lister = createFileLister(projectRoot)) {
  const files = new Set();
  const unmatched = [];
  let truncated = false;
  for (const raw of patterns || []) {
    const pattern = toPosix(String(raw)).replace(/\/+$/, '');
    if (!pattern || pattern.startsWith('/') || pattern.split('/').includes('..')) { unmatched.push(String(raw)); continue; }
    const hasGlob = /[*?]/.test(pattern);
    const full = path.join(projectRoot, pattern);
    let stat = null;
    if (!hasGlob) { try { stat = fs.statSync(full); } catch (_) { stat = null; } }
    if (stat?.isFile()) { files.add(pattern); continue; }
    const listed = lister();
    truncated = truncated || listed.truncated;
    const matcher = hasGlob ? globToRegex(pattern) : null;
    const before = files.size;
    for (const file of listed.files) {
      if (matcher ? matcher.test(file) : file.startsWith(`${pattern}/`)) files.add(file);
    }
    if (files.size === before) unmatched.push(String(raw));
  }
  return { files: [...files].sort(), unmatched, truncated };
}

/**
 * @param {string} projectRoot
 * @param {{ entry, files, assets, explicit, globals }} input
 * @returns {{ sourceRevision, fileHashes }}
 */
function pageFingerprint(projectRoot, { entry, files = [], assets = [], explicit = [], globals = {} }) {
  const members = [...new Set([entry, ...files, ...assets, ...explicit].filter(Boolean))].sort();
  const fileHashes = {};
  for (const file of members) fileHashes[file] = hashFile(projectRoot, file);
  const sourceRevision = revision({ parserVersion: PARSER_VERSION, entry: entry || null, files: fileHashes, globals });
  return { sourceRevision, fileHashes };
}

/**
 * 给合并后的页面计算指纹并与上一次比较。只写 page.analysis，不改定义字段。
 * 指纹变化且源码分析曾完成 → sourceAnalysis 变为 stale（分析结论需要复核），并给出原因。
 * @returns {{ pages, changed: Array<{ id, reasons }>, graph }}
 */
function applyFingerprints(projectRoot, pages, previousGraph = null) {
  const globals = globalFileHashes(projectRoot);
  const lister = createFileLister(projectRoot);
  const graph = { version: 1, parserVersion: PARSER_VERSION, generatedAt: new Date().toISOString(), globals, pages: {} };
  const changed = [];
  const out = pages.map((page) => {
    const deps = page.dependencies || {};
    const explicitPatterns = (page.source || []).filter((item) => item !== page.entry);
    const explicit = expandSourcePatterns(projectRoot, explicitPatterns, lister);
    const { sourceRevision, fileHashes } = pageFingerprint(projectRoot, {
      entry: page.entry, files: deps.files, assets: deps.assets, explicit: explicit.files, globals,
    });
    const partial = deps.completeness === 'partial' || explicit.unmatched.length > 0 || explicit.truncated;
    const analysis = {
      sourceRevision,
      parserVersion: PARSER_VERSION,
      origin: 'source',
      completeness: partial ? 'partial' : (deps.completeness || 'unknown'),
      ...(explicit.unmatched.length ? { unmatchedSources: explicit.unmatched } : {}),
    };
    graph.pages[page.id] = {
      route: page.route, lifecycle: page.lifecycle || 'active', sourceRevision, completeness: analysis.completeness,
      files: fileHashes, unresolved: deps.unresolved || [],
    };
    const previous = page.analysis?.sourceRevision;
    let next = { ...page, analysis };
    if (previous && previous !== sourceRevision) {
      const reasons = changeReasons(previousGraph?.pages?.[page.id], graph.pages[page.id], previousGraph?.globals, globals);
      changed.push({ id: page.id, reasons });
      if (page.status?.sourceAnalysis === 'completed') next = { ...next, status: { ...page.status, sourceAnalysis: 'stale' } };
    }
    return next;
  });
  return { pages: out, changed, graph };
}

/** 两次快照之间单页的变化原因：文件新增 / 删除 / 内容变化、全局配置变化、解析器升级。 */
function changeReasons(before, after, globalsBefore = {}, globalsAfter = {}) {
  if (!before) return ['fingerprint-changed'];
  const reasons = [];
  const files = new Set([...Object.keys(before.files || {}), ...Object.keys(after.files || {})]);
  for (const file of [...files].sort()) {
    const a = before.files?.[file];
    const b = after.files?.[file];
    if (a === undefined) reasons.push(`dependency-added:${file}`);
    else if (b === undefined) reasons.push(`dependency-removed:${file}`);
    else if (a !== b) reasons.push(`content-changed:${file}`);
  }
  const globals = new Set([...Object.keys(globalsBefore || {}), ...Object.keys(globalsAfter || {})]);
  for (const file of [...globals].sort()) {
    if ((globalsBefore || {})[file] !== (globalsAfter || {})[file]) reasons.push(`global-changed:${file}`);
  }
  return reasons.length ? reasons : ['parser-or-config-changed'];
}

/**
 * 影响清单（供 inspect --json 与 Phase 3 update 使用）。部分覆盖的页面即使指纹未变也标 uncertain，
 * 不能被报告为"零影响"。
 */
function impactReport(previousGraph, graph) {
  const report = [];
  const ids = new Set([...Object.keys(previousGraph?.pages || {}), ...Object.keys(graph.pages)]);
  const broad = Object.keys({ ...(previousGraph?.globals || {}), ...graph.globals })
    .filter((file) => previousGraph && (previousGraph.globals || {})[file] !== graph.globals[file]);
  for (const id of [...ids].sort()) {
    const before = previousGraph?.pages?.[id];
    const after = graph.pages[id];
    if (!before && after) { report.push({ id, status: previousGraph ? 'added' : 'initialized', reasons: [] }); continue; }
    if (before && !after) { report.push({ id, status: 'removed', reasons: [] }); continue; }
    if (before.sourceRevision !== after.sourceRevision) {
      report.push({ id, status: 'changed', reasons: changeReasons(before, after, previousGraph.globals, graph.globals), broadImpact: broad.length > 0 });
    } else if (after.completeness !== 'complete') {
      report.push({ id, status: 'uncertain', reasons: [`coverage-${after.completeness}`, ...after.unresolved.map((u) => `unresolved:${u}`)] });
    } else {
      report.push({ id, status: 'unchanged', reasons: [] });
    }
  }
  return { pages: report, broadImpact: broad.map((file) => `global-changed:${file}`) };
}

module.exports = {
  PARSER_VERSION, GLOBAL_FILES, hashFile, globalFileHashes, createFileLister, globToRegex, expandSourcePatterns, pageFingerprint,
  applyFingerprints, changeReasons, impactReport,
};
