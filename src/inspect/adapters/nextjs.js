'use strict';

/*
 * Next.js 适配器（L1 约定式扫描）：包装 nextjs.js 的文件路由扫描与 framework-dependencies.js 的
 * 隐式依赖。行为与改造前逐字节一致：同样的页面、同样的跳过原因、同样的冲突处理与依赖范围。
 */

const fs = require('fs');
const path = require('path');

const { scanAppRouter, scanPagesRouter } = require('../nextjs');
const { frameworkDependencies } = require('../framework-dependencies');
const { DISPOSITION, finalizeDiscovery } = require('./records');

const NEXT_CONFIGS = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'];

function firstExistingDir(projectRoot, candidates) {
  for (const rel of candidates) {
    const full = path.join(projectRoot, rel);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) return rel;
  }
  return null;
}

/**
 * @param {{ projectRoot, depVersion: (name) => string|null }} ctx
 * @returns {{ status: 'absent' } | { status: 'error', errors } | { status: 'supported', version, context }}
 */
function detect(ctx) {
  const version = ctx.depVersion('next');
  const hasConfig = NEXT_CONFIGS.some((f) => fs.existsSync(path.join(ctx.projectRoot, f)));
  if (!version && !hasConfig) return { status: 'absent' };

  // Next.js 允许把路由目录放在项目根或 src/ 下，两者都查
  const appDir = firstExistingDir(ctx.projectRoot, ['app', path.join('src', 'app')]);
  const pagesDir = firstExistingDir(ctx.projectRoot, ['pages', path.join('src', 'pages')]);
  if (!appDir && !pagesDir) {
    return {
      status: 'error',
      errors: [
        '识别为 Next.js 项目，但既没有 app/ 也没有 pages/ 路由目录（含 src/ 下）。',
        '请确认 --project-root 指向的是 Next.js 应用本身（monorepo 里通常是 apps/<name>）。',
      ],
    };
  }
  return {
    status: 'supported',
    version,
    context: {
      router: appDir && pagesDir ? 'hybrid' : appDir ? 'app' : 'pages',
      appDir: appDir ? appDir.replace(/\\/g, '/') : null,
      pagesDir: pagesDir ? pagesDir.replace(/\\/g, '/') : null,
    },
  };
}

function discover(ctx) {
  const { projectRoot, context } = ctx;
  const candidates = [];
  const skipped = [];
  if (context.appDir) {
    const r = scanAppRouter(projectRoot, context.appDir);
    candidates.push(...r.pages);
    skipped.push(...r.skipped);
  }
  if (context.pagesDir) {
    const r = scanPagesRouter(projectRoot, context.pagesDir);
    candidates.push(...r.pages);
    skipped.push(...r.skipped);
  }
  // 每个被扫描的文件是一条记录：入口文件路径天然唯一，直接作 recordId
  const records = [
    ...candidates.map((page) => ({
      recordId: page.entry,
      location: { file: page.entry },
      rawPath: null,
      fullPath: page.route,
      disposition: DISPOSITION.PAGE,
      entry: page.entry,
      layoutChain: [],
      isLayout: false,
      source: 'L1',
      _page: page,
    })),
    ...skipped.map((item) => ({
      recordId: item.file,
      location: { file: item.file },
      rawPath: null,
      fullPath: null,
      disposition: DISPOSITION.SKIPPED,
      reason: item.reason,
      layoutChain: [],
      isLayout: false,
      source: 'L1',
    })),
  ];
  const result = finalizeDiscovery({
    adapter: 'nextjs',
    records,
    toPage: (record) => ({ ...record._page }),
  });
  for (const record of result.records) delete record._page;
  return result;
}

function implicitDependencies(ctx, page) {
  return frameworkDependencies(ctx.projectRoot, page, ctx.context);
}

module.exports = {
  id: 'nextjs',
  label: 'Next.js',
  level: 'convention',
  // Next 页面的路由由文件路径决定，记录 hash 不进指纹：保持改造前的 sourceRevision 不变
  recordsInFingerprint: false,
  capability: null,
  detect,
  discover,
  implicitDependencies,
  globalFiles: () => [],
};
