'use strict';

/*
 * `manual inspect` —— 扫描项目，建立 Project Model。
 *
 * 只做确定性的部分：识别技术栈 → 扫路由 → 算出页面清单 → 写 project.yaml / pages/*.yaml。
 * **不读源码内容、不猜页面用途、不碰浏览器。**
 *
 * 语义信息（title / purpose / detectedActions）由 AI 读源码后经 `manual describe` 写回。
 * 本命令的输出会给出「哪些页面待分析、各自该读哪些文件」的工作清单。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { detectFramework } = require('../inspect/detect');
const { scanNextjs } = require('../inspect/nextjs');
const { buildImportGraph } = require('../inspect/import-graph');
const { frameworkDependencies } = require('../inspect/framework-dependencies');
const { applyFingerprints, impactReport } = require('../inspect/fingerprint');
const { reconcile, ANALYSIS } = require('../inspect/model');
const store = require('../inspect/store');
const { createProjectStore } = require('../store/project');
const { displayPath, writeText } = require('../util/fsx');
const { markAffectedTasks } = require('../tasks/staleness');

const KNOWN_FLAGS = new Set(['projectRoot', 'prune', 'json', 'help']);

const HELP = `
manual inspect —— 扫描项目，建立页面模型（Project Model）

用法:
  manual inspect [选项]

做什么:
  读 .manual/config.yaml → 识别技术栈 → 扫描前端路由 → 生成
    .manual/project.yaml        项目地图（索引）
    .manual/pages/<id>.yaml     每个页面的详情

  只做确定性扫描。页面的 title / purpose / detectedActions 需要读源码理解，
  由 AI 分析后用 \`manual describe\` 写回；重跑 inspect 不会覆盖这些分析结果。

选项:
  --project-root <路径>   项目根目录，默认当前工作目录
  --prune                 删除「代码里已不存在的路由」对应的页面文件（默认只报告不删）
  --json                  以 JSON 输出结果，含待分析页面的工作清单
  --help                  显示本帮助

支持的框架:
  Next.js（App Router + Pages Router）。其它框架在后续版本支持。

示例:
  manual inspect
  manual inspect --json
  manual inspect --prune
`.trim();

function fail(errors, { json }) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  } else {
    process.stderr.write('\n[manual inspect] 扫描未完成：\n');
    for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write('\n用 `manual inspect --help` 查看用法。\n');
  }
  return 1;
}

/** 待分析清单：AI 接下来该读哪些文件、补哪些页面。 */
function buildWorklist(pages) {
  return pages
    .filter((p) => p.includeInManual !== false)
    .filter((p) => p.status?.sourceAnalysis !== ANALYSIS.COMPLETED)
    .map((p) => ({
      id: p.id,
      route: p.route,
      reason: p.status?.sourceAnalysis === ANALYSIS.STALE ? 'stale' : 'pending',
      read: p.source && p.source.length > 0 ? p.source : [p.entry],
      needs: ['title', 'purpose', 'detectedActions'],
    }));
}

function renderSummary(ctx) {
  const { meta, pages, added, updated, removed, excluded, stale, worklist, projectRoot, projectFile, pruned, renamed = [], renameCandidates = [] } = ctx;
  const L = [];

  L.push('');
  L.push('[manual inspect] 项目地图已生成。');
  L.push('');
  L.push(`  项目        ${meta.name}`);
  L.push(
    `  技术栈      ${meta.framework}${meta.frameworkVersion ? ` ${meta.frameworkVersion}` : ''}` +
    ` (${meta.router} router)`
  );
  const dirs = [meta.appDir, meta.pagesDir].filter(Boolean).map((d) => `${d}/`);
  L.push(`  路由目录    ${dirs.join('  ')}`);
  L.push('');
  L.push(`  发现页面    ${pages.length} 个` +
    (added.length ? `（新增 ${added.length}）` : '') +
    (updated.length ? `（入口变更 ${updated.length}）` : ''));

  if (pages.length > 0) {
    L.push('');
    const routeWidth = Math.min(38, Math.max(...pages.map((p) => p.route.length)) + 2);
    for (const p of pages) {
      const mark = p.status?.sourceAnalysis === ANALYSIS.COMPLETED ? '✓'
        : p.status?.sourceAnalysis === ANALYSIS.STALE ? '!' : '·';
      const title = p.title || '（待分析）';
      const dyn = p.dynamic ? ' [dynamic]' : '';
      L.push(`    ${mark} ${p.route.padEnd(routeWidth)}${title}${dyn}`);
    }
  }

  if (excluded.length > 0) {
    L.push('');
    L.push(`  按 config.inspect.exclude 排除 ${excluded.length} 个路由:`);
    for (const p of excluded.slice(0, 10)) L.push(`    - ${p.route}`);
    if (excluded.length > 10) L.push(`    … 另有 ${excluded.length - 10} 个`);
  }

  if (stale.length > 0) {
    L.push('');
    L.push(`  ⚠ ${stale.length} 个页面的入口文件变了，原有分析已标记为 stale，需要重新分析:`);
    for (const p of stale) L.push(`    - ${p.route}  (${p.entry})`);
  }

  if (renamed.length > 0) {
    L.push('');
    L.push(`  路由改名（页面身份保留）${renamed.length} 个:`);
    for (const r of renamed) L.push(`    - ${r.id}: ${r.from} → ${r.to}（依据 ${r.by}）`);
  }
  if (renameCandidates.length > 0) {
    L.push('');
    L.push(`  ? ${renameCandidates.length} 个可能的改名无法自动确认（未合并）:`);
    for (const c of renameCandidates) L.push(`    - ${c.pageId}: ${c.fromRoute} → ${c.toRoute}`);
  }
  if (removed.length > 0) {
    L.push('');
    if (pruned.length > 0) {
      L.push(`  已删除 ${pruned.length} 个页面文件（代码里已无对应路由）:`);
      for (const f of pruned) L.push(`    - ${displayPath(f, projectRoot)}`);
    } else {
      L.push(`  ⚠ ${removed.length} 个已有页面在代码里找不到对应路由了，已标为 missing / excluded（定义与历史保留，不能再采集）:`);
      for (const p of removed) L.push(`    - ${p.route}  [${p.lifecycle}]  (.manual/pages/${p.id}.yaml)`);
      L.push('    如果只是改了路由：在旧页面文件里加 routeBindings: [{ id: main, template: <新路由> }] 后重跑 inspect；确认要删除定义的话加 --prune。');
    }
  }

  L.push('');
  L.push(`  索引        ${displayPath(projectFile, projectRoot)}`);
  L.push(`  页面详情    ${displayPath(path.dirname(projectFile), projectRoot)}/pages/`);
  L.push('');

  if (worklist.length > 0) {
    L.push(`  下一步：${worklist.length} 个页面还缺 title / purpose / detectedActions。`);
    L.push('  读下列源码后用 `manual describe` 写回：');
    for (const item of worklist.slice(0, 8)) {
      L.push(`    ${item.id.padEnd(20)} ${item.read.join(', ')}`);
    }
    if (worklist.length > 8) L.push(`    … 另有 ${worklist.length - 8} 个，用 --json 看完整清单`);
  } else if (pages.length > 0) {
    L.push('  所有页面都已完成源码分析。');
  }
  L.push('');

  return L.join('\n');
}

function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;

  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) {
    return fail([`未知参数: ${unknownFlags.join(', ')}`], { json });
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  const detected = detectFramework(projectRoot);
  if (!detected.ok) return fail(detected.errors, { json });

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

  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
  let base;
  try {
    base = projectStore.load();
  } catch (e) {
    return fail(
      ['已有的页面文件解析失败，先修好它们再重扫：', ...(e.errors || [e.message]).map((x) => `  ${x}`)],
      { json }
    );
  }
  const existing = { pages: base.model.pages };

  const result = reconcile(scan.pages, existing.pages, config.inspect.exclude);

  // 源码指纹：同路径内容变化、依赖增删、全局配置变化都会被识别；旧图快照保留供影响计算。
  const graphFile = path.join(store.indexDirFor(stateDirAbs), 'graph.json');
  let previousGraph = null;
  try { previousGraph = fs.existsSync(graphFile) ? JSON.parse(fs.readFileSync(graphFile, 'utf8')) : null; } catch (_) { previousGraph = null; }
  const fingerprinted = applyFingerprints(projectRoot, result.pages, previousGraph);
  result.pages = fingerprinted.pages;
  const staleIds = new Set(result.stale.map((p) => p.id));
  for (const change of fingerprinted.changed) {
    if (!staleIds.has(change.id)) { result.stale.push(result.pages.find((p) => p.id === change.id)); staleIds.add(change.id); }
  }
  const impact = impactReport(previousGraph, fingerprinted.graph);
  const warnings = [...loaded.warnings, ...dependencyWarnings];

  // 代码里已不存在的路由：默认只报告，加 --prune 才删。
  // 这些文件里可能有 AI 或人写的分析结果，静默删掉代价太大。
  // 显式 retired 的页面是有意保留的历史，prune 只清理 missing / excluded
  const prunedIds = values.prune ? result.removed.filter((p) => p.lifecycle !== 'retired').map((p) => p.id) : [];
  const pruned = prunedIds.map((id) => store.pageFileFor(stateDirAbs, id));

  const meta = {
    name: config.project.name,
    framework: detected.framework,
    frameworkVersion: detected.version,
    router: detected.router,
    appDir: detected.appDir,
    pagesDir: detected.pagesDir,
    generatedAt: new Date().toISOString(),
  };

  // 没有 --prune 时，保留下来的页面文件也要重写进索引，否则索引会漏掉它们
  const keptRemoved = values.prune ? result.removed.filter((p) => p.lifecycle === 'retired') : result.removed;
  const indexPages = [...result.pages, ...keptRemoved].sort((a, b) => String(a.route).localeCompare(String(b.route)));

  const staleTasks = markAffectedTasks(base.model.tasks, {
    // 只有这次新变化的页面才标记；已经是 missing 的页面不会每次 inspect 都重复打标
    pageIds: [...result.stale, ...result.newlyMissing].map((page) => page.id),
  });

  // 一次定义提交：页面、被 prune 的页面、受影响任务的 stale 标记、项目元信息。
  // 扫描期间有别的命令改过模型 → model-conflict，重新 inspect 即可。
  try {
    projectStore.commit({
      base,
      kind: 'definition',
      changes: {
        pages: indexPages,
        removePages: prunedIds,
        tasks: staleTasks.tasks.filter((task) => staleTasks.staleIds.includes(task.id)),
        meta,
      },
    });
  } catch (e) {
    return fail([`${e.code || 'model-commit-failed'}: ${e.message}`], { json });
  }
  const projectFile = store.projectFileFor(stateDirAbs);
  const written = [
    ...indexPages.map((p) => store.pageFileFor(stateDirAbs, p.id)),
    projectFile,
    store.forwardIndexFileFor(stateDirAbs), store.reverseIndexFileFor(stateDirAbs),
    store.taskForwardIndexFileFor(stateDirAbs), store.taskReverseIndexFileFor(stateDirAbs),
  ];
  if (previousGraph) writeText(path.join(store.indexDirFor(stateDirAbs), 'graph.previous.json'), JSON.stringify(previousGraph, null, 2) + '\n');
  writeText(graphFile, JSON.stringify(fingerprinted.graph, null, 2) + '\n');
  const worklist = buildWorklist(result.pages);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          projectRoot,
          projectFile,
          framework: detected.framework,
          frameworkVersion: detected.version,
          router: detected.router,
          appDir: detected.appDir,
          pagesDir: detected.pagesDir,
          counts: {
            total: result.pages.length,
            added: result.added.length,
            entryChanged: result.updated.length,
            stale: result.stale.length,
            excluded: result.excluded.length,
            missing: result.removed.length,
            pruned: pruned.length,
          },
          pages: result.pages.map((p) => ({
            id: p.id,
            route: p.route,
            title: p.title,
            dynamic: p.dynamic,
            entry: p.entry,
            sourceAnalysis: p.status.sourceAnalysis,
            sourceRevision: p.analysis?.sourceRevision ?? null,
            dependencyCompleteness: p.analysis?.completeness ?? null,
            browserVerified: !!p.browser?.verified,
            screenshot: p.browser?.screenshot ?? null,
          })),
          excluded: result.excluded.map((p) => ({ route: p.route, entry: p.entry })),
          missing: result.removed.map((p) => ({ id: p.id, route: p.route, lifecycle: p.lifecycle })),
          renamed: result.renamed,
          // 无法证明是同一页面的改名：不自动合并，在旧页面文件的 routeBindings 里声明新路由后重跑 inspect 确认
          renameCandidates: result.renameCandidates,
          // 源码影响清单：changed / uncertain（覆盖不完整，不能视为零影响）/ added / removed / unchanged
          impact,
          sourceChanges: fingerprinted.changed,
          skipped: scan.skipped,
          conflicts: scan.conflicts,
          worklist,
          warnings,
          staleTasks: staleTasks.staleIds,
          writtenFiles: written,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    for (const w of warnings) process.stderr.write(`[manual inspect] 注意: ${w}\n`);
    if (scan.conflicts.length > 0) {
      for (const c of scan.conflicts) {
        process.stderr.write(
          `[manual inspect] 注意: 路由 ${c.route} 被多个文件命中 (${c.entries.join(' / ')})，只保留了前一个。\n`
        );
      }
    }
    process.stdout.write(
      renderSummary({
        meta, pages: result.pages, added: result.added, updated: result.updated,
        removed: result.removed, excluded: result.excluded, stale: result.stale,
        renamed: result.renamed, renameCandidates: result.renameCandidates,
        worklist, projectRoot, projectFile, pruned,
      }) + '\n'
    );
  }

  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, buildWorklist };
