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
const { exitCodeFor, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { ANALYSIS } = require('../inspect/model');
const { refreshModel } = require('../inspect/refresh');
const { scanSource } = require('../inspect/source-graph');
const { submitCandidates } = require('../inspect/route-inputs');
const { displayPath } = require('../util/fsx');

const KNOWN_FLAGS = new Set(['projectRoot', 'prune', 'routesInput', 'json', 'help']);

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
  --routes-input <文件>   提交 AI 读路由源码后整理的路由候选（JSON），只能补充未解析的路由记录
                          或新增静态扫描没发现的路由；校验通过后写入 .manual/routes.candidates.yaml
                          再扫描。格式：{ "routes": [ { "recordId?", "route", "entry", "layout?", "evidence?", "reason" } ] }
  --json                  以 JSON 输出结果，含待分析页面的工作清单
  --help                  显示本帮助

支持的路由体系:
  Next.js（App Router + Pages Router，按文件约定扫描）
  React Router 6 / 7 data mode 的对象路由（createBrowserRouter 等）
  Vue Router 4 的路由表（createRouter({ routes })），含 .vue 单文件组件依赖
  静态扫描确定不了的路由会列为「未解析」，完整性标为不完整；可用 --routes-input（AI 候选）
  或 .manual/routes.override.yaml（人工覆盖，优先级最高）补充。

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
  return exitCodeFor(list);
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

const COMPLETENESS_LABEL = { complete: '完整', partial: '不完整', unsupported: '不支持' };

/** 路由发现的完整性：扫出 N 个合法页面不代表项目只有 N 个页面，未确认的记录要显式列出。 */
function renderDiscovery(discovery) {
  if (!discovery) return [];
  const { counts } = discovery;
  const L = [];
  L.push(`  路由发现    ${discovery.adapter} · ${COMPLETENESS_LABEL[discovery.completeness] || discovery.completeness}` +
    ` · 记录 ${counts.routeRecords}（页面 ${counts.pageRecords} / 跳过 ${counts.skipped} / 未解析 ${counts.unresolved}）`);
  for (const item of discovery.unresolved.slice(0, 10)) {
    const where = item.location?.file ? `${item.location.file}${item.location.line ? `:${item.location.line}` : ''}` : item.recordId;
    L.push(`    ? ${where}  ${item.reason}${item.detail ? `：${item.detail}` : ''}`);
  }
  if (discovery.unresolved.length > 10) L.push(`    … 另有 ${discovery.unresolved.length - 10} 条未解析记录`);
  for (const d of discovery.diagnostics || []) L.push(`    ! ${d}`);
  return L;
}

function renderSummary(ctx) {
  const { meta, pages, added, updated, removed, excluded, stale, worklist, projectRoot, projectFile, pruned, renamed = [], renameCandidates = [] } = ctx;
  const L = [];

  L.push('');
  L.push('[manual inspect] 项目地图已生成。');
  L.push('');
  L.push(`  项目        ${meta.name}`);
  const nextRouter = ['app', 'pages', 'hybrid'].includes(meta.router);
  L.push(
    `  技术栈      ${meta.framework}${meta.frameworkVersion ? ` ${meta.frameworkVersion}` : ''}` +
    (nextRouter ? ` (${meta.router} router)` : '')
  );
  const dirs = [meta.appDir, meta.pagesDir].filter(Boolean).map((d) => `${d}/`);
  if (dirs.length > 0) L.push(`  路由目录    ${dirs.join('  ')}`);
  L.push(...renderDiscovery(meta.discovery));
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

/** --routes-input：先按当前发现结果校验候选，全部通过才写入候选文件（全或全无）。 */
function submitRoutesInput({ projectRoot, config, file }) {
  if (typeof file !== 'string' || !file) return { ok: false, errors: ['--routes-input 需要一个 JSON 文件路径。'] };
  let input;
  try {
    input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`读取路由候选失败：${error.message}`] };
  }
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const scanned = scanSource(projectRoot, { stateDirAbs });
  if (!scanned.discovery) return { ok: false, errors: scanned.errors };
  const result = submitCandidates({ projectRoot, stateDirAbs, discovery: scanned.discovery, input });
  return result.ok ? result : { ok: false, errors: ['路由候选未通过校验，没有写入任何文件：', ...result.errors.map((e) => `  ${e}`)] };
}

function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;

  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) {
    return usageExit(fail([`未知参数: ${unknownFlags.join(', ')}`], { json }));
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  if (values.routesInput !== undefined) {
    const submitted = submitRoutesInput({ projectRoot, config, file: values.routesInput });
    if (!submitted.ok) return fail(submitted.errors, { json });
  }

  let refreshed;
  try {
    refreshed = refreshModel({ projectRoot, config, prune: values.prune === true });
  } catch (e) {
    if (e.code === 'scan-failed') return fail(e.errors, { json });
    if (e.code === 'model-load-failed') {
      return fail(['已有的页面文件解析失败，先修好它们再重扫：', ...(e.errors || [e.message]).map((x) => `  ${x}`)], { json });
    }
    return fail([`${e.code || 'model-commit-failed'}: ${e.message}`], { json });
  }
  const { detected, scan, result, fingerprinted, impact, staleTasks, pruned, meta, graphRevision, written, projectFile, stateDirAbs, featureInventory } = refreshed;
  const warnings = [...loaded.warnings, ...refreshed.dependencyWarnings];
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
          // 路由发现：适配器、完整性（complete / partial / unsupported）、记录去向计数与未解析项
          discovery: refreshed.discovery,
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
          graphRevision,
          sourceChanges: fingerprinted.changed,
          skipped: scan.skipped,
          conflicts: scan.conflicts,
          worklist,
          featureInventory: { file: featureInventory.file, pending: featureInventory.snapshot.pending, pages: featureInventory.snapshot.pages },
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
