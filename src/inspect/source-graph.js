'use strict';

/*
 * 源码扫描 → 页面依赖 → 指纹图。inspect（提交模型）与 update（只读计算当前图）共用。
 *
 * 只读：不写 .manual；调用方决定是否提交模型、是否写 graph.json / 快照。
 */

const { detectFramework } = require('./detect');
const { scanNextjs } = require('./nextjs');
const { buildImportGraph } = require('./import-graph');
const { frameworkDependencies } = require('./framework-dependencies');
const { applyFingerprints } = require('./fingerprint');
const { reconcile } = require('./model');

/** 识别框架并扫描页面及其依赖（含框架约定文件）。 */
function scanSource(projectRoot) {
  const detected = detectFramework(projectRoot);
  if (!detected.ok) return { ok: false, errors: detected.errors };
  const scan = scanNextjs(projectRoot, { appDir: detected.appDir, pagesDir: detected.pagesDir });
  const dependencyWarnings = [];
  scan.pages = scan.pages.map((page) => {
    // 框架约定文件（祖先 layout、_app 等）与页面一起渲染：作为 scope 依赖一并遍历
    const scope = frameworkDependencies(projectRoot, page, detected);
    const graph = buildImportGraph(projectRoot, [page.entry, ...scope]);
    for (const unresolved of graph.unresolved) {
      dependencyWarnings.push(`${page.route}: 无法解析依赖 ${unresolved}`);
    }
    return { ...page, dependencies: { ...graph, scope } };
  });
  return { ok: true, detected, scan, dependencyWarnings };
}

/**
 * 扫描并与已有页面合并、计算指纹。
 * @returns {{ ok, errors?, detected, scan, result, fingerprinted, dependencyWarnings }}
 */
function buildSourceGraph({ projectRoot, config, existingPages = [], previousGraph = null }) {
  const scanned = scanSource(projectRoot);
  if (!scanned.ok) return scanned;
  const result = reconcile(scanned.scan.pages, existingPages, config.inspect.exclude);
  const fingerprinted = applyFingerprints(projectRoot, result.pages, previousGraph);
  result.pages = fingerprinted.pages;
  return { ...scanned, result, fingerprinted };
}

module.exports = { scanSource, buildSourceGraph };
