'use strict';

/*
 * Runtime 应用层：generate / capture / resume / status / run-submit 命令共用。
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
function planTargets({ projectRoot, command, targets, flags = {}, copy = { mode: 'model' }, acceptReview = false, force = false, project = null }) {
  const opened = project || openProject(projectRoot);
  const mode = resolveMode(flags);
  const base = opened.projectStore.load();
  const snapshot = collectPlanningInputs({ projectRoot, config: opened.config, base, targets, mode, cacheStore: opened.cacheStore });
  const planned = plan(snapshot, { command, copy, acceptReview, force });
  return { project: opened, snapshot, plan: planned.plan, planHash: planned.planHash, errors: planned.errors, mode };
}

function contextFor(projectRoot, project, mode) {
  return { projectRoot, config: project.config, stateDirAbs: project.stateDirAbs, mode, cacheStore: project.cacheStore };
}

/** SIGINT / SIGTERM → 取消当前 Run；返回清理函数。 */
function cancellation() {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { signal: controller.signal, dispose: () => { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal); } };
}

async function execute({ projectRoot, project, runId, mode, verifyInputs = null }) {
  const cancel = cancellation();
  try {
    return await runRun({ runStore: project.runStore, runId, handlers: HANDLERS, context: contextFor(projectRoot, project, mode), signal: cancel.signal, verifyInputs });
  } finally {
    cancel.dispose();
  }
}

/** 规划并执行。规划有错误时不创建 Run。 */
async function startRun({ projectRoot, command, targets, flags = {}, copy, acceptReview = false, force = false, predecessor = null }) {
  const planned = planTargets({ projectRoot, command, targets, flags, copy, acceptReview, force });
  if (planned.errors.length) {
    throw new RuntimeError(/^([a-z][a-z0-9-]+):/.exec(planned.errors[0])?.[1] || 'invalid-plan', planned.errors.join('；'), { errors: planned.errors, plan: planned.plan });
  }
  const { project, snapshot } = planned;
  const { run } = project.runStore.create({
    command, target: targets.join(' '), projectId: snapshot.projectId, modelRevision: snapshot.modelRevision, plan: planned.plan,
    budget: project.config.runtime?.budget || {}, predecessor,
  });
  const summary = await execute({ projectRoot, project, runId: run.id, mode: planned.mode });
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
      outputs: t.outputRefs.map((r) => ({ kind: r.kind, ref: r.ref || null })),
    })),
    cache: state.plan.summary?.cache || [],
    riskBoundaries: state.plan.summary?.riskBoundaries || [],
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
      meta: { imageInputs: imageInputsOf(project.config) },
    });
    return true;
  } catch (_) {
    // 缓存登记是优化：失败不影响已经提交的证据。
    return false;
  }
}

module.exports = { openProject, copyPolicy, planTargets, startRun, resumeRun, runStatus, recordCapture, changedInputs };
