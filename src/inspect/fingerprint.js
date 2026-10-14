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
// 3：package.json / package-lock.json 只按运行相关内容计入指纹（B5-09）
const PARSER_VERSION = 'regex-import-graph-3';

// 按能力区分的解析器版本（docs/MULTI_FRAMEWORK_PLAN.md §9）：页面只纳入它实际用到的能力，
// 升级某一种语言或路由适配器的规则，不会让无关页面全部失效。
// 只用到 js-ts 的页面（所有 Next 页面）的版本串就是 PARSER_VERSION，与改造前逐字节一致。
const CAPABILITY_VERSIONS = {
  'vue-sfc': 'vue-sfc-1',
  'route:react-router-objects': 'rr-objects-1',
  'route:vue-router-objects': 'vr-objects-1',
};

/** 页面依赖文件里用到的语言能力（js-ts 是基线，不单列）。 */
function languageCapabilities(files) {
  const out = new Set();
  for (const file of files) if (/\.vue$/i.test(file)) out.add('vue-sfc');
  return out;
}

/** 页面的解析器版本串：基线 + 额外用到的能力（排序后拼接）。 */
function parserVersionFor({ files = [], routeCapability = null } = {}) {
  const extra = languageCapabilities(files);
  if (routeCapability) extra.add(routeCapability);
  const parts = [...extra].sort().map((id) => {
    if (!CAPABILITY_VERSIONS[id]) throw new Error(`未登记的解析能力版本: ${id}`);
    return CAPABILITY_VERSIONS[id];
  });
  return [PARSER_VERSION, ...parts].join('+');
}

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

/**
 * 全局文件的指纹（B5-09）：package.json 只取影响运行的字段，package-lock.json 只取运行关键依赖的解析版本；
 * 只改 scripts、描述或无关依赖时指纹不变，不会让所有页面重新采集。其余全局文件按全文 hash。
 */
function globalFileHashes(projectRoot, extraFiles = []) {
  const out = {};
  for (const file of [...new Set([...GLOBAL_FILES, ...extraFiles])]) {
    if (fs.existsSync(path.join(projectRoot, file))) out[file] = contentHash(projectRoot, file);
  }
  return out;
}

/** 与源码图登记一致的文件 hash：全局的 package.json / package-lock.json 按运行相关内容，其余按全文。 */
function contentHash(projectRoot, file) {
  if (file !== 'package.json' && file !== 'package-lock.json') return hashFile(projectRoot, file);
  const full = path.join(projectRoot, file);
  if (!fs.existsSync(full)) return 'missing';
  let json = null;
  try { json = JSON.parse(fs.readFileSync(full, 'utf8')); } catch (_) { return hashFile(projectRoot, file); }
  const { PACKAGE_RUNTIME_FIELDS, RUNTIME_PACKAGES } = require('../update/global-files');
  if (file === 'package.json') return revision(Object.fromEntries(PACKAGE_RUNTIME_FIELDS.map((key) => [key, json[key] ?? null])));
  return revision(Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, json.packages?.[`node_modules/${name}`]?.version ?? json.dependencies?.[name]?.version ?? null])));
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
 * @param {{ entry, files, assets, explicit, globals, routeRecord, routeCapability }} input
 *   routeRecord：路由表写在代码里的框架，该页面对应路由记录的 { recordId, recordHash }；
 *   Next 页面没有它，指纹输入与改造前完全相同。
 * @returns {{ sourceRevision, fileHashes, parserVersion }}
 */
function pageFingerprint(projectRoot, { entry, files = [], assets = [], explicit = [], globals = {}, routeRecord = null, routeCapability = null }) {
  const members = [...new Set([entry, ...files, ...assets, ...explicit].filter(Boolean))].sort();
  const fileHashes = {};
  for (const file of members) fileHashes[file] = hashFile(projectRoot, file);
  const parserVersion = parserVersionFor({ files: members, routeCapability: routeRecord ? routeCapability : null });
  const input = { parserVersion, entry: entry || null, files: fileHashes, globals };
  if (routeRecord) input.routeRecord = { recordId: routeRecord.recordId, recordHash: routeRecord.recordHash };
  const sourceRevision = revision(input);
  return { sourceRevision, fileHashes, parserVersion };
}

/**
 * 给合并后的页面计算指纹并与上一次比较。只写 page.analysis，不改定义字段。
 * 指纹变化且源码分析曾完成 → sourceAnalysis 变为 stale（分析结论需要复核），并给出原因。
 * @param {object} [options]
 * @param {string[]} [options.extraGlobalFiles]  适配器贡献的全局配置（如 vite.config.*）
 * @param {string[]} [options.routeSources]      路由定义文件：变化触发重新发现，不作为普通依赖扩散（§8）
 * @param {string|null} [options.routeCapability] 发现页面的路由适配器能力 id
 * @returns {{ pages, changed: Array<{ id, reasons }>, graph }}
 */
function applyFingerprints(projectRoot, pages, previousGraph = null, { extraGlobalFiles = [], routeSources = [], routeCapability = null } = {}) {
  const globals = globalFileHashes(projectRoot, extraGlobalFiles);
  const lister = createFileLister(projectRoot);
  const graph = { version: 1, parserVersion: PARSER_VERSION, generatedAt: new Date().toISOString(), globals, pages: {} };
  // 只在有路由定义文件时写入：Next 项目的 graph.json 结构不变
  if (routeSources.length > 0) graph.routeSources = Object.fromEntries(routeSources.map((file) => [file, hashFile(projectRoot, file)]));
  const changed = [];
  const out = pages.map((page) => {
    const deps = page.dependencies || {};
    const explicitPatterns = (page.source || []).filter((item) => item !== page.entry);
    const explicit = expandSourcePatterns(projectRoot, explicitPatterns, lister);
    const { sourceRevision, fileHashes, parserVersion } = pageFingerprint(projectRoot, {
      entry: page.entry, files: deps.files, assets: deps.assets, explicit: explicit.files, globals,
      routeRecord: deps.route || null, routeCapability,
    });
    const partial = deps.completeness === 'partial' || explicit.unmatched.length > 0 || explicit.truncated;
    const analysis = {
      sourceRevision,
      parserVersion,
      origin: 'source',
      completeness: partial ? 'partial' : (deps.completeness || 'unknown'),
      ...(explicit.unmatched.length ? { unmatchedSources: explicit.unmatched } : {}),
    };
    graph.pages[page.id] = {
      route: page.route, lifecycle: page.lifecycle || 'active', sourceRevision, completeness: analysis.completeness,
      files: fileHashes, unresolved: deps.unresolved || [],
      ...(deps.route ? { routeRecord: { recordId: deps.route.recordId, recordHash: deps.route.recordHash } } : {}),
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
  // 单条路由记录变化（path / 入口 / props / 布局链）：只影响这一个页面
  if (before.routeRecord && after.routeRecord && before.routeRecord.recordHash !== after.routeRecord.recordHash) {
    reasons.push(`route-record-changed:${after.routeRecord.recordId}`);
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

/**
 * captureKey 使用的 sourceHash：即页面的 analysis.sourceRevision（文件内容 + 依赖集合 + 解析器版本 + 全局配置）。
 * 尚未分析过的页面返回 null，调用方据此记录不确定性，而不是用空值当作"未变化"。
 */
function sourceHashOf(page) {
  return page?.analysis?.sourceRevision || null;
}

module.exports = {
  sourceHashOf,
  PARSER_VERSION, CAPABILITY_VERSIONS, parserVersionFor, GLOBAL_FILES, hashFile, contentHash, globalFileHashes, createFileLister, globToRegex, expandSourcePatterns, pageFingerprint,
  applyFingerprints, changeReasons, impactReport,
};
