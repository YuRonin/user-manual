'use strict';

/*
 * `manual update` —— 根据源码变化增量更新已发布的手册（P3-02）。
 *
 *   --plan   只读：影响分析（受影响页面 / Scenario / 章节及原因）、缓存决策、未知依赖、
 *            有人工修改或已被删除的文档、下线建议；不提交模型、不创建 Run、不写正式文档。
 *   默认     刷新源码指纹（与 inspect 相同的一次定义提交）→ 对受影响目标创建一个 Run，
 *            复用 generate 的采集 / 草稿 / 文案 / 发布门槛 / 发布节点；
 *            每个目标独立成败，失败的目标保留上一版文档并报告为 stale。
 *   无变化   退出 0，不写任何文件。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { EXIT, exitCodeFor, exitCodeForCode, exitCodeForRun, usageExit } = require('../cli/output');
const { printRun, printRuntimeError } = require('../cli/run-report');
const { loadConfig } = require('../config/load');
const { refreshModel } = require('../inspect/refresh');
const { openProject, copyPolicy, executePlanned } = require('../runtime/app');
const { analyzeProject, describeImpact } = require('../update/impact');
const { selectTargets, planUpdateTargets, previewUpdate } = require('../update/plan');
const { ChangeDetectionError } = require('../update/git-changes');

const KNOWN_FLAGS = new Set(['projectRoot', 'plan', 'base', 'copy', 'copyDefault', 'acceptReview', 'force', 'offline', 'refresh', 'noCache', 'json', 'help']);
const BOOLEAN_FLAGS = ['plan', 'copyDefault', 'acceptReview', 'offline', 'refresh', 'noCache'];

const HELP = `
manual update —— 根据源码变化增量更新已发布的手册

用法:
  manual update [--plan] [--base <提交>] [--copy <文案.json> | --copy-default] [--offline | --refresh | --no-cache] [--json]

做什么:
  1. 找出每份已发布手册"发布之后"改了哪些源码（Git：已提交 + staged + unstaged + untracked；
     非 Git 项目：与发布时的源码图逐文件比较内容）；
  2. 按旧新依赖图的并集把变化归到页面 → Scenario → 手册章节，每条影响附原因链；
     全局配置（package.json、tsconfig、next.config …）或无法归属的源码会保守扩大范围；
  3. 只重新生成受影响的手册，其他文档字节不变；有人工修改的文档走三方合并，冲突时停下等你处理。

选项:
  --plan                 只打印影响与计划，不执行、不写任何文件
  --base <提交>          与指定提交比较（默认：各手册上次发布时记录的提交 / 源码快照）
  --copy <文案.json>     文案块；缺省交给宿主模型（waiting_input）
  --copy-default         使用事实包默认文案（确定性，不等待模型）
  --offline              只用历史证据（结果标 onlineChecked=false），不打开浏览器
  --refresh              不复用已有采集，重新采集受影响的场景
  --no-cache             不读也不写缓存索引
  --accept-review        确认新出现的数字 / 单位、业务承诺属实后继续
  --force                覆盖有人工修改或已被删除的文档（覆盖前的版本可从 Git 历史找回）
  --project-root <路径>  项目根目录，默认当前工作目录
  --json                 以 JSON 输出
  --help                 显示本帮助

说明:
  - 源码没有变化时退出 0，不写任何文件；远端 build / 数据 / 权限变化不由源码检测，
    请用 manual verify --live 检查线上行为。
  - 没有任何发布记录（或旧发布记录没有源码基线）时无法增量分析：前者请用 manual generate，
    后者会保守地重建这些手册。
  - 页面被删除时只给出下线建议（pending-retirement），不会自动删除文档或旧图片。
  - update 自己写出的文档不会被下一轮当作源码变化。

退出码: 0 完成或无变化；3 等待输入；4 冲突 / 漂移；1 失败；2 参数错误。

示例:
  manual update --plan
  manual update --copy-default
  manual update --base main~3 --plan --json
`.trim();

function fail(errors, { json, code = null }) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, ...(code ? { code } : {}), errors: list }, null, 2) + '\n');
  else {
    process.stderr.write('\n[manual update] 未完成：\n');
    for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write('\n用 `manual update --help` 查看用法。\n');
  }
  return code ? exitCodeForCode(code) : exitCodeFor(list);
}

/** 影响报告的 JSON 形状（--plan 与执行结果共用）。 */
function impactBody(analysis) {
  return {
    mode: analysis.mode,
    confidence: analysis.confidence,
    baselines: analysis.groups.map((g) => ({
      key: g.key, gitCommit: g.baseline.gitCommit, graphRevision: g.baseline.graphRevision, manualIds: g.manualIds,
      changeMode: g.report.mode, changes: g.report.changes, unowned: g.report.unowned, broadImpact: g.report.broadImpact,
    })),
    sections: analysis.sections.map((s) => ({ manualId: s.manualId, documentPath: s.documentPath, confidence: s.confidence, reasonPaths: s.reasonPaths, ...(s.retirement ? { retirement: true } : {}), ...(s.brokenReference ? { brokenReference: true } : {}) })),
    fullRebuild: analysis.fullRebuild,
    runtimeFreshness: analysis.runtimeFreshness,
    warnings: analysis.warnings,
  };
}

function textLines({ analysis, targets, retirement, blocked }) {
  const L = [];
  for (const line of describeImpact({ ...analysis, fallback: null, sections: analysis.sections })) L.push(`  影响  ${line}`);
  if (analysis.fullRebuild) L.push(`  基线缺失（${analysis.fullRebuild.reason}）：${analysis.fullRebuild.manualIds.join(', ') || '（无发布记录）'} 需要全量重建`);
  for (const t of targets) {
    const doc = t.document.state === 'edited' ? '（文档有人工修改，将三方合并）' : t.document.state === 'missing' ? '（已发布文档不存在，需要 --force 或下线）' : '';
    L.push(`  更新  ${t.target} [${t.confidence}]${doc}`);
  }
  for (const r of retirement) L.push(`  下线建议  ${r.manualId}: ${r.suggestion}`);
  for (const b of blocked) L.push(`  阻塞  ${b.target}（${b.code}）: ${b.errors[0]}`);
  for (const w of analysis.warnings) L.push(`  注意  ${w}`);
  if (analysis.runtimeFreshness) L.push(`  ${analysis.runtimeFreshness.note}`);
  return L;
}

function targetBody(t) {
  return { target: t.target, manualId: t.manualId, confidence: t.confidence, source: t.source, document: t.document, reasonPaths: t.reasonPaths };
}

function runPlan({ projectRoot, config, values, json, copy, project }) {
  const preview = previewUpdate({
    projectRoot, config, base: values.base || null,
    flags: flagsOf(values), copy, acceptReview: values.acceptReview === true, force: values.force === true, cacheStore: project.cacheStore,
  });
  const { analysis, targets, retirement, planned } = preview;
  const blocked = [...preview.blocked, ...planned.blocked];
  const planTargets = new Set(planned.ok.map((t) => t.manualId));
  const body = {
    ok: planned.errors.length === 0,
    dryRun: true,
    ...impactBody(analysis),
    targets: targets.filter((t) => planTargets.has(t.manualId)).map(targetBody),
    blocked,
    retirement,
    plan: planned.plan ? {
      planHash: planned.planHash,
      tasks: planned.plan.tasks.map((t) => ({ id: t.id, kind: t.kind, dependsOn: t.dependsOn, reason: t.reason, reuse: t.reuse })),
      summary: planned.plan.summary,
    } : null,
    errors: planned.errors,
  };
  if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  else {
    const L = ['', `[manual update] 计划（未执行，基线模式 ${analysis.mode}，置信度 ${analysis.confidence}）`];
    L.push(...textLines({ analysis, targets: targets.filter((t) => planTargets.has(t.manualId)), retirement, blocked }));
    if (planned.plan) {
      for (const c of planned.plan.summary.cache) L.push(`  缓存  ${c.subject}: ${c.reason}`);
      L.push(`  需要浏览器的场景: ${planned.plan.summary.browserScenarios}`);
    } else if (!analysis.fullRebuild) L.push('  没有需要更新的手册。');
    for (const e of planned.errors) L.push(`  ✗ ${e}`);
    L.push('');
    process.stdout.write(L.join('\n') + '\n');
  }
  if (planned.errors.length) return exitCodeFor(planned.errors);
  return 0;
}

function flagsOf(values) {
  return { offline: values.offline === true, refresh: values.refresh === true, noCache: values.noCache === true };
}

async function runUpdate({ projectRoot, config, values, json, copy, project }) {
  // 1. 只读分析：没有受影响的手册 → 零写入退出
  const analysis = analyzeProject({ projectRoot, config, base: values.base || null });
  if (analysis.mode === 'none' && analysis.fullRebuild?.reason) {
    return fail([`${analysis.fullRebuild.reason === 'no-committed-model' ? 'no-committed-model' : 'no-baseline'}: ${analysis.fullRebuild.message}`], { json, code: 'no-baseline' });
  }
  const selected = selectTargets({ projectRoot, stateDirAbs: project.stateDirAbs, analysis });
  const noWork = selected.targets.length === 0;
  if (noWork) {
    const body = { ok: selected.blocked.length === 0, status: 'no-change', ...impactBody(analysis), targets: [], blocked: selected.blocked, retirement: selected.retirement, written: [] };
    if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    else {
      const L = ['', '[manual update] 没有需要重新生成的手册（未写入任何文件）。', ...textLines({ analysis, targets: [], retirement: selected.retirement, blocked: selected.blocked }), ''];
      process.stdout.write(L.join('\n') + '\n');
    }
    return selected.blocked.length ? EXIT.FAILED : EXIT.OK;
  }

  // 2. 刷新源码指纹（一次定义提交），使采集缓存 key 反映源码变化
  try {
    refreshModel({ projectRoot, config });
  } catch (error) {
    return fail(error.errors || [`${error.code || 'model-commit-failed'}: ${error.message}`], { json, code: error.code === 'model-conflict' ? 'model-conflict' : null });
  }

  // 3. 用已提交模型逐目标规划（有规划错误的目标单独阻塞），再合成一个 Run
  const base = project.projectStore.load();
  const planned = planUpdateTargets({
    projectRoot, config, base, targets: selected.targets, flags: flagsOf(values), copy,
    acceptReview: values.acceptReview === true, force: values.force === true, cacheStore: project.cacheStore,
  });
  const blocked = [...selected.blocked, ...planned.blocked];
  if (!planned.plan) {
    return fail(blocked.flatMap((b) => b.errors.map((e) => `${b.target}: ${e}`)), { json, code: blocked[0]?.code || null });
  }
  if (planned.errors.length) return fail(planned.errors, { json });
  const targets = planned.ok.map((t) => t.target);
  let result;
  try {
    result = await executePlanned({ projectRoot, project, command: 'update', targets, planned });
  } catch (error) {
    return printRuntimeError({ json, error, label: 'update' });
  }

  // 4. 每个目标各自的结果：发布成功 → updated；否则保留上一版并标 stale
  const state = project.runStore.read(result.runId);
  const outcomes = planned.ok.map((t) => {
    const [type, id] = t.target.split(':');
    const tasks = state.tasks.filter((task) => task.input?.subject?.type === type && task.input?.subject?.id === id);
    const publish = tasks.find((task) => task.kind === 'publish');
    if (publish?.status === 'succeeded') return { ...targetBody(t), result: 'updated', release: publish.outputRefs[0]?.ref || null };
    const blocker = tasks.find((task) => ['failed', 'waiting_input', 'interrupted'].includes(task.status));
    return { ...targetBody(t), result: 'stale', kept: 'previous-release', ...(blocker ? { at: blocker.id, status: blocker.status, code: blocker.error?.code || null, message: blocker.error?.message || null } : { status: 'not-started' }) };
  });
  const code = exitCodeForRun(result.summary);
  const finalCode = code === EXIT.OK && blocked.length ? EXIT.FAILED : code;
  const lines = [
    ...textLines({ analysis, targets: planned.ok, retirement: selected.retirement, blocked }),
    ...outcomes.map((o) => `  结果  ${o.target}: ${o.result === 'updated' ? '已更新' : `未更新，保留上一版（${o.code || o.status}）`}`),
  ];
  printRun({ json, result, label: 'update', projectRoot, extra: { ...impactBody(analysis), targets: outcomes, blocked, retirement: selected.retirement }, lines });
  return finalCode;
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: BOOLEAN_FLAGS });
  const json = values.json === true;
  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length) return usageExit(fail([`未知参数: ${unknownFlags.join(', ')}`], { json }));
  if (positional.length) return usageExit(fail([`update 不接受目标参数（范围由源码变化决定），收到: ${positional.join(' ')}`], { json }));
  if (values.base === true || values.base === '') return usageExit(fail(['--base 需要一个提交，例如 --base main~1'], { json }));
  if ([values.offline, values.refresh, values.noCache].filter((v) => v === true).length > 1) {
    return usageExit(fail(['--offline / --refresh / --no-cache 只能选一个。'], { json }));
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });

  let copy;
  try {
    copy = copyPolicy({ copy: typeof values.copy === 'string' ? values.copy : null, copyDefault: values.copyDefault === true });
  } catch (error) {
    return usageExit(fail([error.message], { json }));
  }
  try {
    const project = openProject(projectRoot);
    const common = { projectRoot, config: loaded.config, values, json, copy, project };
    return values.plan ? runPlan(common) : await runUpdate(common);
  } catch (error) {
    if (error instanceof ChangeDetectionError) {
      return error.code === 'git-base-invalid' ? usageExit(fail([`${error.code}: ${error.message}`], { json })) : fail([`${error.code}: ${error.message}`], { json, code: error.code });
    }
    return printRuntimeError({ json, error, label: 'update' });
  }
}

module.exports = { run, HELP, KNOWN_FLAGS };
