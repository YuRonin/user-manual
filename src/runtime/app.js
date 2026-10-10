'use strict';

/*
 * Runtime 应用层：generate / capture / resume / status 命令共用（run-submit 为兼容入口）。
 *
 *   planTargets   规划（只读）：--plan 直接打印它，不创建 Run、不产生业务动作
 *   startRun      创建 Run 并执行
 *   resumeRun     读取原计划继续执行；输入变了拒绝继续（run-input-changed），--replan 创建后继 Run
 *   runStatus     只读展示 Run 的 DAG 摘要、等待、失败与缓存原因
 *   recordCapture 旧命令直接采集后写入缓存，使后续 generate 可复用
 */

const fs = require('fs');
const path = require('path');

const { loadConfig } = require('../config/load');
const { sha256Hex } = require('../util/hash');
const { createProjectStore } = require('../store/project');
const { createCacheStore } = require('../cache/store');
const { resolveMode } = require('../cache/policy');
const { collectPlanningInputs, plan, imageInputsOf, subjectKey } = require('./planner');
const { createRunStore } = require('./store');
const { runRun } = require('./runner');
const { HANDLERS } = require('./handlers');
const { RuntimeError } = require('./errors');
const { createCaptureStore } = require('../evidence/store');

function openProject(projectRoot) {
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) throw new RuntimeError('invalid-config', loaded.errors.join(' '), { errors: loaded.errors });
  const config = loaded.config;
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  return {
    config,
    stateDirAbs,
    projectStore: createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }),
    cacheStore: createCacheStore({ stateDirAbs }),
    runStore: createRunStore({ projectRoot, stateDirAbs }),
  };
}

function modeFromName(name) {
  return resolveMode({ offline: name === 'offline', refresh: name === 'refresh', noCache: name === 'no-cache' });
}

/** 文案来源：--copy <文件> / --copy-default / 缺省交给宿主模型。 */
function copyPolicy({ copy = null, copyDefault = false }) {
  if (copy && copyDefault) throw new RuntimeError('invalid-arguments', '--copy 与 --copy-default 只能选一个。');
  if (copyDefault) return { mode: 'default' };
  if (copy) {
    const file = path.resolve(copy);
    if (!fs.existsSync(file)) throw new RuntimeError('invalid-arguments', `--copy 文件不存在: ${file}`);
    return { mode: 'file', path: file, sha256: sha256Hex(fs.readFileSync(file)) };
  }
  return { mode: 'model' };
}

/**
 * 只读规划。
 * @returns {{ project, snapshot, plan, planHash, errors, mode }}
 */
function planTargets({ projectRoot, command, targets, flags = {}, copy = { mode: 'model' }, acceptReview = false, force = false, project = null, freshSource = false }) {
  const opened = project || openProject(projectRoot);
  const mode = resolveMode(flags);
  let base = opened.projectStore.load();
  // 只读的源码新鲜度：在内存里按当前源码重算页面指纹，让缓存 key 反映刚改过的源码（不写模型）
  const freshness = freshSource ? currentSourcePages({ projectRoot, config: opened.config, base }) : null;
  if (freshness?.pages) base = { ...base, model: { ...base.model, pages: freshness.pages } };
  const snapshot = collectPlanningInputs({ projectRoot, config: opened.config, base, targets, mode, cacheStore: opened.cacheStore });
  const planned = plan(snapshot, { command, copy, acceptReview, force });
  if (freshness?.warning) planned.plan.summary.warnings.push(freshness.warning);
  return { project: opened, snapshot, plan: planned.plan, planHash: planned.planHash, errors: planned.errors, mode };
}

/** 按当前源码重算页面指纹（只读）；扫描失败时沿用已提交指纹并给出警告，不假装新鲜。 */
function currentSourcePages({ projectRoot, config, base }) {
  const { buildSourceGraph } = require('../inspect/source-graph');
  const { readCurrentGraph } = require('../inspect/index-store');
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  let scanned;
  try { scanned = buildSourceGraph({ projectRoot, config, existingPages: base.model.pages, previousGraph: readCurrentGraph(stateDirAbs) }); }
  catch (error) { scanned = { ok: false, errors: [error.message] }; }
  if (!scanned.ok) return { pages: null, warning: `source-freshness-unknown: 无法重新扫描源码（${(scanned.errors || []).join('；')}），按上次 inspect 的指纹规划。` };
  // 只替换已有页面的指纹；新增 / 删除页面仍由 inspect 或 update 决定
  const byId = new Map(scanned.result.pages.map((page) => [page.id, page]));
  return { pages: base.model.pages.map((page) => byId.has(page.id) ? { ...page, analysis: byId.get(page.id).analysis } : page) };
}

/** 执行前刷新源码指纹并写回模型（与 update 相同）；扫描失败时不阻断，返回警告。 */
function refreshSource(projectRoot, config) {
  try {
    require('../inspect/refresh').refreshModel({ projectRoot, config });
    return null;
  } catch (error) {
    if (error.code === 'model-conflict') throw new RuntimeError('model-conflict', error.message);
    return `source-freshness-unknown: 执行前刷新源码指纹失败（${error.code || 'scan-failed'}: ${error.message}），按上次 inspect 的指纹执行。`;
  }
}

function contextFor(projectRoot, project, mode) {
  return { projectRoot, config: project.config, stateDirAbs: project.stateDirAbs, mode, cacheStore: project.cacheStore };
}

/** IPC 中断消息：父进程用 child.send(INTERRUPT_MESSAGE) 请求与 SIGINT 相同的取消。 */
const INTERRUPT_MESSAGE = { type: 'manual:interrupt' };

/**
 * SIGINT / SIGTERM → 取消当前 Run；返回清理函数。
 * Windows 上 child.kill('SIGINT') 直接终止进程、不触发处理器，以编程方式中断时改走 IPC 消息
 * （仅在带 IPC 通道启动时监听，且不让通道阻止进程退出）。控制台 Ctrl+C 在各平台仍走 SIGINT。
 */
function cancellation() {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  const onMessage = (message) => { if (message?.type === INTERRUPT_MESSAGE.type) controller.abort(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.channel) {
    process.on('message', onMessage);
    process.channel.unref();
  }
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      process.removeListener('message', onMessage);
    },
  };
}

async function execute({ projectRoot, project, runId, mode, verifyInputs = null, sessionFactory = undefined }) {
  const cancel = cancellation();
  try {
    return await runRun({ runStore: project.runStore, runId, handlers: HANDLERS, context: contextFor(projectRoot, project, mode), signal: cancel.signal, verifyInputs, ...(sessionFactory ? { sessionFactory } : {}) });
  } finally {
    cancel.dispose();
  }
}

/** 规划并执行。规划有错误时不创建 Run。 */
async function startRun({ projectRoot, command, targets, flags = {}, copy, acceptReview = false, force = false, predecessor = null, sessionFactory = undefined, freshSource = false }) {
  const warning = freshSource ? refreshSource(projectRoot, openProject(projectRoot).config) : null;
  const planned = planTargets({ projectRoot, command, targets, flags, copy, acceptReview, force });
  if (warning) planned.plan.summary.warnings.push(warning);
  if (planned.errors.length) {
    throw new RuntimeError(/^([a-z][a-z0-9-]+):/.exec(planned.errors[0])?.[1] || 'invalid-plan', planned.errors.join('；'), { errors: planned.errors, plan: planned.plan });
  }
  return executePlanned({ projectRoot, project: planned.project, command, targets, planned, predecessor, sessionFactory });
}

/** 执行已经规划好的计划（update 先做影响分析再规划，之后走同一条执行路径）。 */
async function executePlanned({ projectRoot, project, command, targets, planned, predecessor = null, sessionFactory = undefined }) {
  const { snapshot } = planned;
  const { run } = project.runStore.create({
    command, target: targets.join(' '), projectId: snapshot.projectId, modelRevision: snapshot.modelRevision, plan: planned.plan,
    budget: project.config.runtime?.budget || {}, predecessor,
  });
  const summary = await execute({ projectRoot, project, runId: run.id, mode: planned.mode, sessionFactory });
  return { runId: run.id, plan: planned.plan, planHash: planned.planHash, summary };
}

/** 按原计划的策略重新规划，比较尚未成功的任务输入。 */
function changedInputs({ projectRoot, project, state }) {
  const original = state.plan;
  const policy = original.policy || { copy: { mode: 'model' }, mode: 'default' };
  const replanned = planTargets({
    projectRoot, project, command: original.command, targets: original.targets, flags: flagsFromMode(policy.mode),
    copy: policy.copy, acceptReview: policy.acceptReview, force: policy.force,
  });
  const next = new Map(replanned.plan.tasks.map((t) => [t.id, t]));
  const changed = state.tasks
    .filter((t) => t.status !== 'succeeded')
    .filter((t) => !next.has(t.id) || next.get(t.id).inputHash !== t.inputHash)
    .map((t) => t.id);
  return { changed, replanned };
}

function flagsFromMode(name) {
  return { offline: name === 'offline', refresh: name === 'refresh', noCache: name === 'no-cache' };
}

/**
 * 继续执行。输入变化时抛 run-input-changed（不改原 Run）；--replan 创建后继 Run 并记录 predecessor。
 */
async function resumeRun({ projectRoot, runId, replan = false }) {
  const project = openProject(projectRoot);
  const state = project.runStore.read(runId);
  if (!state) throw new RuntimeError('run-not-found', `找不到 Run ${runId}。`);
  const policy = state.plan.policy || { copy: { mode: 'model' }, mode: 'default' };
  if (replan) {
    const result = await startRun({
      projectRoot, command: state.plan.command, targets: state.plan.targets, flags: flagsFromMode(policy.mode),
      copy: policy.copy.mode === 'file' ? copyPolicy({ copy: policy.copy.path }) : policy.copy,
      acceptReview: policy.acceptReview, force: policy.force, predecessor: runId,
    });
    return { ...result, predecessor: runId };
  }
  const mode = modeFromName(policy.mode);
  const summary = await execute({
    projectRoot, project, runId, mode,
    verifyInputs: () => {
      const { changed } = changedInputs({ projectRoot, project, state: project.runStore.read(runId) });
      if (changed.length) {
        throw new RuntimeError('run-input-changed', `Run ${runId} 规划之后以下任务的输入发生了变化：${changed.join(', ')}。原 Run 保持不变；运行 manual resume ${runId} --replan 创建新的 Run。`, { changed });
      }
    },
  });
  return { runId, plan: state.plan, summary };
}

/** 只读状态：不打开租约、不改任何文件。 */
function runStatus({ projectRoot, runId = null }) {
  const project = openProject(projectRoot);
  if (!runId) return { runs: project.runStore.list().reverse() };
  const state = project.runStore.read(runId);
  if (!state) throw new RuntimeError('run-not-found', `找不到 Run ${runId}。`);
  const events = project.runStore.events(runId);
  const planTasks = new Map(state.plan.tasks.map((t) => [t.id, t]));
  const { waitingHint, publishedDocuments } = require('../cli/run-report');
  const documents = publishedDocuments(state.plan, {
    succeeded: state.tasks.filter((task) => task.status === 'succeeded').map((task) => task.id),
  }, projectRoot, project.config.docs.outputDir);
  return {
    run: {
      id: state.run.id, command: state.run.command, target: state.run.target, status: state.run.effectiveStatus,
      predecessor: state.run.predecessor, createdAt: state.run.createdAt, updatedAt: state.run.updatedAt,
      budget: state.run.budget, consumed: state.run.consumed, executing: state.lease.live,
    },
    tasks: state.tasks.map((t) => ({
      id: t.id, kind: t.kind, status: t.effectiveStatus, dependsOn: t.dependsOn, attempt: t.attempt,
      reason: planTasks.get(t.id)?.reason || null,
      reuse: t.reuse ? { from: t.reuse.from, observedAt: t.reuse.observedAt, onlineChecked: false } : null,
      error: t.error ? { code: t.error.code, policy: t.error.policy, message: t.error.message } : null,
      next: t.effectiveStatus === 'waiting_input' && t.error ? waitingHint(runId, { id: t.id, code: t.error.code }, state.plan) : null,
      outputs: t.outputRefs.map((r) => ({ kind: r.kind, ref: r.ref || null })),
      warnings: t.warnings || [],
    })),
    cache: state.plan.summary?.cache || [],
    riskBoundaries: state.plan.summary?.riskBoundaries || [],
    documents,
    warnings: [...(state.plan.summary?.warnings || []), ...state.tasks.flatMap((t) => (t.warnings || []).map((warning) => `${t.id}：${warning}`))],
    // 恢复理由与复用来源：来自事件日志（日志缺失时为空，不影响任务状态）。
    recovery: events.events.filter((e) => /^recovery:/.test(e.message || '')).map((e) => ({ taskId: e.taskId, result: e.message.slice('recovery:'.length), at: e.at })),
    events: { count: events.events.length, truncated: events.truncated, skipped: events.skipped },
  };
}

/**
 * 旧入口（capture / capture-task）直接采集后登记缓存；使用自定义地址、规格等覆盖参数的采集不登记，
 * 因为它们与规划使用的缓存输入不一致。
 */
function recordCapture({ projectRoot, subject, captureIds, extraRefs = [], observedAt }) {
  try {
    const project = openProject(projectRoot);
    const mode = resolveMode({});
    const base = project.projectStore.load();
    const snapshot = collectPlanningInputs({ projectRoot, config: project.config, base, targets: [`${subject.type}:${subject.id}`], mode });
    const s = snapshot.subjects[subjectKey(subject)];
    const store = createCaptureStore({ projectRoot, stateDirAbs: project.stateDirAbs });
    const records = captureIds.map((id) => store.read(id)).filter(Boolean);
    const all = records.flatMap((r) => r.validations || []);
    const scopes = [...new Set(all.map((v) => v.scope))].filter((scope) => all.filter((v) => v.scope === scope).every((v) => v.outcome === 'passed'));
    const statuses = records.map((r) => r.privacy?.status || 'unknown');
    project.cacheStore.put({
      kind: 'capture', key: s.captureKey, input: s.captureKeyInput, uncertainty: s.captureUncertainty, subject: `capture:${subjectKey(subject)}`,
      outputRefs: [...captureIds.map((id) => ({ kind: 'capture', ref: id })), ...extraRefs], observedAt,
      validationScopes: scopes,
      privacy: { status: statuses.every((st) => st === 'passed') ? 'passed' : (statuses.some((st) => st === 'unknown' || st === 'not-run') ? 'unknown' : 'failed') },
      annotation: require('../evidence/integrity').annotationSummary(records),
      meta: { imageInputs: imageInputsOf(project.config) },
    });
    return true;
  } catch (_) {
    // 缓存登记是优化：失败不影响已经提交的证据。
    return false;
  }
}

module.exports = { INTERRUPT_MESSAGE, openProject, copyPolicy, planTargets, startRun, executePlanned, resumeRun, runStatus, recordCapture, changedInputs };
