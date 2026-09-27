'use strict';

/*
 * Run Store（契约 C07）。
 *
 * 布局：<stateDir>/runs/<runId>/
 *   plan.json          不可变：创建时写入，planHash 记录在 run.json；读取时校验未被改动
 *   tasks/<id>.json    每个 RuntimeTask 的快照 —— 恢复的唯一依据
 *   run.json           envelope；最后写入，存在即表示 Run 已完整创建
 *   events.jsonl       诊断日志，丢失或损坏不影响恢复
 *
 * 并发：同一 Run 同时只能有一个执行者，靠 locks/run-<id>.lock 租约保证（续期 = 心跳）。
 * 新进程发现 running 任务而租约已失效（进程死亡 / 过期）→ open() 把它们转成 interrupted。
 * 所有写入走原子替换；任务成功必须带通过完整性校验的 outputRefs。
 */

const fs = require('fs');
const path = require('path');

const { writeFileAtomic } = require('../util/atomic-write');
const { revisionOf } = require('../util/hash');
const { newUuid, isUuid } = require('../model/ids');
const { validateRun } = require('../model/schema');
const { acquireLock, renewLock, inspectLock, releaseLock, lockFileFor, DEFAULT_LEASE_MS } = require('../store/lock');
const { mergeStateGitignore } = require('../config/render');
const { verifyOutputRefs } = require('../evidence/integrity');
const {
  DEFAULT_BUDGET, canTransition, deriveRunStatus, normalizeTaskDefinitions, outputRefShapeErrors,
} = require('./model');
const { RuntimeError, errorSummary } = require('./errors');
const { appendEvent, readEvents } = require('./events');

const RUN_SCHEMA_VERSION = 1;

function runsDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'runs');
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 给 .manual/.gitignore 补齐 runs/ 等本机产物条目（保留用户内容，幂等）。 */
function ensureStateGitignore(stateDirAbs) {
  const file = path.join(stateDirAbs, '.gitignore');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const next = mergeStateGitignore(existing);
  if (next !== null) writeFileAtomic(file, next);
  return next !== null;
}

function createRunStore({ projectRoot, stateDirAbs, now = () => Date.now(), leaseMs = DEFAULT_LEASE_MS } = {}) {
  if (!projectRoot || !stateDirAbs) throw new Error('createRunStore 需要 projectRoot 与 stateDirAbs。');
  const runsDir = runsDirFor(stateDirAbs);
  const iso = () => new Date(now()).toISOString();

  const dirFor = (runId) => {
    if (!isUuid(runId)) throw new RuntimeError('invalid-run-id', `Run id 需要是 UUID: ${runId}`);
    return path.join(runsDir, runId);
  };
  const files = (runId) => {
    const dir = dirFor(runId);
    return {
      dir,
      run: path.join(dir, 'run.json'),
      plan: path.join(dir, 'plan.json'),
      tasks: path.join(dir, 'tasks'),
      task: (taskId) => path.join(dir, 'tasks', `${taskId}.json`),
      events: path.join(dir, 'events.jsonl'),
      lock: lockFileFor(stateDirAbs, `run-${runId}`),
    };
  };
  const event = (runId, payload) => appendEvent(files(runId).events, { runId, ...payload }, { now: now() });

  /**
   * 创建 Run：先写 plan 与全部 task，最后发布 run.json。
   * @param {{ command, target, projectId?, modelRevision?, plan: { tasks: object[] }, budget?, predecessor? }} input
   */
  function create({ command, target = null, projectId = null, modelRevision = null, plan, budget = {}, predecessor = null }) {
    if (typeof command !== 'string' || command === '') throw new RuntimeError('invalid-run', 'command 必填。');
    if (!plan || typeof plan !== 'object') throw new RuntimeError('invalid-run', 'plan 必填。');
    const normalized = normalizeTaskDefinitions(plan.tasks);
    if (!normalized.ok) throw new RuntimeError('invalid-plan', `计划无效：${normalized.errors.join('；')}`, { errors: normalized.errors });
    if (predecessor !== null && !isUuid(predecessor)) throw new RuntimeError('invalid-run', `predecessor 需要是 Run id: ${predecessor}`);

    const runId = newUuid();
    const f = files(runId);
    const planHash = revisionOf(plan);
    ensureStateGitignore(stateDirAbs);
    writeJson(f.plan, plan);
    for (const task of normalized.tasks) writeJson(f.task(task.id), task);
    const createdAt = iso();
    const run = {
      schemaVersion: RUN_SCHEMA_VERSION,
      id: runId,
      command,
      target,
      projectId,
      modelRevision,
      planHash,
      predecessor,
      taskOrder: normalized.tasks.map((task) => task.id),
      status: deriveRunStatus(normalized.tasks),
      budget: { ...DEFAULT_BUDGET, ...budget },
      consumed: { activeMs: 0, actions: 0 },
      createdAt,
      updatedAt: createdAt,
    };
    writeJson(f.run, run);
    event(runId, { type: 'run-created', result: run.status });
    return read(runId);
  }

  /** 只读还原 Run 进度；run.json 不存在（创建未完成）返回 null。不做任何写入。 */
  function read(runId) {
    const f = files(runId);
    if (!fs.existsSync(f.run)) return null;
    const run = readJson(f.run);
    const validation = validateRun(run);
    if (!validation.ok) {
      throw new RuntimeError(validation.errors[0].code === 'schema-too-new' ? 'schema-too-new' : 'run-corrupt',
        `Run ${runId} 记录无效: ${validation.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    }
    if (!fs.existsSync(f.plan)) throw new RuntimeError('run-corrupt', `Run ${runId} 缺少 plan.json。`);
    const plan = readJson(f.plan);
    if (revisionOf(plan) !== run.planHash) throw new RuntimeError('plan-tampered', `Run ${runId} 的 plan.json 与创建时的 planHash 不一致；计划不可修改，请新建 Run。`);
    const tasks = run.taskOrder.map((taskId) => {
      const file = f.task(taskId);
      if (!fs.existsSync(file)) throw new RuntimeError('run-corrupt', `Run ${runId} 缺少任务 ${taskId}。`);
      return readJson(file);
    });
    const lease = inspectLock(f.lock, now());
    const leaseLive = lease.held && !lease.stale;
    // 只读视图：租约已失效的 running 任务显示为 interrupted（真正改写由 open() 在拿到租约后完成）。
    const view = tasks.map((task) => ({ ...task, effectiveStatus: task.status === 'running' && !leaseLive ? 'interrupted' : task.status }));
    return {
      run: { ...run, status: deriveRunStatus(tasks), effectiveStatus: deriveRunStatus(view.map((t) => ({ status: t.effectiveStatus }))) },
      plan,
      tasks: view,
      lease: { live: leaseLive, owner: lease.held && lease.owner ? { pid: lease.owner.pid, host: lease.owner.host } : null },
    };
  }

  function list() {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir).filter(isUuid).map((runId) => {
      const file = files(runId).run;
      if (!fs.existsSync(file)) return null;
      try {
        const run = readJson(file);
        return { id: run.id, command: run.command, target: run.target, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt };
      } catch (_) {
        return { id: runId, status: 'corrupt' };
      }
    }).filter(Boolean).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  /**
   * 以执行者身份打开 Run：获取租约；租约失效遗留的 running 任务转为 interrupted。
   * 另一个活着的进程正在执行 → run-busy。
   * @returns {{ lease, state, interrupted: string[] }}
   */
  function open(runId) {
    const f = files(runId);
    if (!fs.existsSync(f.run)) throw new RuntimeError('run-not-found', `找不到 Run ${runId}。`);
    let lock;
    try {
      lock = acquireLock(stateDirAbs, { name: `run-${runId}`, timeoutMs: 0, leaseMs });
    } catch (error) {
      if (error.code === 'lock-timeout') throw new RuntimeError('run-busy', `Run ${runId} 正由另一个进程执行（pid ${error.owner?.pid}）。`, { owner: error.owner });
      throw error;
    }
    const lease = {
      runId,
      token: lock.token,
      renew: () => renewLock(lock.file, lock.token, leaseMs),
      release: () => releaseLock(lock.file, lock.token),
    };
    const interrupted = [];
    const state = read(runId);
    for (const task of state.tasks) {
      if (task.status !== 'running') continue;
      transition(runId, task.id, 'interrupted', {
        lease,
        error: { code: 'interrupted', phase: task.kind, message: '执行进程在任务完成前退出（租约失效）。', policy: 'retry', retryable: true, requiresInput: false },
      });
      interrupted.push(task.id);
    }
    return { lease, state: read(runId), interrupted };
  }

  function assertLease(lease, runId) {
    if (!lease || lease.runId !== runId || typeof lease.renew !== 'function') {
      throw new RuntimeError('lease-required', `修改 Run ${runId} 需要先 open() 获得执行租约。`);
    }
    if (!lease.renew()) throw new RuntimeError('lease-lost', `Run ${runId} 的执行租约已失效或被接管，停止写入。`);
  }

  /** 校验输出引用：形状 + 不可变产物完整性（与缓存共用 verifyOutputRefs）。 */
  function checkOutputRefs(refs) {
    const problems = outputRefShapeErrors(refs).map((message) => ({ code: 'invalid-output', message }));
    if (problems.length > 0) return problems;
    return verifyOutputRefs(projectRoot, stateDirAbs, refs);
  }

  /**
   * 推进任务状态。
   * @param {{ lease, outputRefs?, error?, reason? }} options  error 为 ErrorResult 或其摘要
   */
  function transition(runId, taskId, to, { lease, outputRefs, error, reason } = {}) {
    assertLease(lease, runId);
    const f = files(runId);
    const file = f.task(taskId);
    if (!fs.existsSync(file)) throw new RuntimeError('task-not-found', `Run ${runId} 中没有任务 ${taskId}。`);
    const task = readJson(file);
    const from = task.status;
    if (!canTransition(from, to)) {
      throw new RuntimeError('invalid-transition', `任务 ${taskId} 不能从 ${from} 转为 ${to}。`, { from, to });
    }
    const at = iso();
    const current = task.attempts[task.attempts.length - 1];
    if (to === 'running') {
      if (task.attempt >= task.retry.maxAttempts) {
        throw new RuntimeError('retry-exhausted', `任务 ${taskId} 已尝试 ${task.attempt} 次，达到上限 ${task.retry.maxAttempts}。`);
      }
      task.attempt += 1;
      task.attempts.push({ n: task.attempt, startedAt: at, endedAt: null, status: 'running', error: null });
    } else if (to === 'succeeded') {
      const problems = checkOutputRefs(outputRefs);
      if (problems.length > 0) {
        throw new RuntimeError('invalid-output', `任务 ${taskId} 的产物未通过校验，不能标记成功：${problems.map((p) => `${p.code}${p.ref ? ` ${p.ref}` : ''}`).join('，')}`, { problems });
      }
      task.outputRefs = outputRefs.map((ref) => ({ ...ref }));
      task.error = null;
    } else if (to === 'failed' || to === 'interrupted') {
      if (!error || typeof error.code !== 'string') throw new RuntimeError('invalid-transition', `任务 ${taskId} 转为 ${to} 需要错误信息。`);
      task.error = errorSummary(error);
    } else if (to === 'waiting_input') {
      task.error = error ? errorSummary(error) : task.error;
    }
    if (current && current.status === 'running' && to !== 'running') {
      current.status = to;
      current.endedAt = at;
      if (task.error && to !== 'succeeded') current.error = task.error;
    }
    task.status = to;
    task.updatedAt = at;
    writeJson(file, task);
    touchRun(runId);
    event(runId, { type: 'task-transition', taskId, kind: task.kind, attempt: task.attempt, from, to, code: task.error?.code, message: reason });
    return task;
  }

  function touchRun(runId, patch = null) {
    const f = files(runId);
    const run = readJson(f.run);
    const tasks = run.taskOrder.map((taskId) => readJson(f.task(taskId)));
    const next = { ...run, ...(patch || {}), status: deriveRunStatus(tasks), updatedAt: iso() };
    writeJson(f.run, next);
    return next;
  }

  /** 记录已消耗预算（活跃时间 / 动作次数）；resume 沿用已消耗的值。 */
  function consume(runId, lease, { activeMs = 0, actions = 0 } = {}) {
    assertLease(lease, runId);
    const run = readJson(files(runId).run);
    return touchRun(runId, { consumed: { activeMs: run.consumed.activeMs + activeMs, actions: run.consumed.actions + actions } });
  }

  function events(runId) {
    return readEvents(files(runId).events);
  }

  return { create, read, list, open, transition, consume, events, checkOutputRefs, runDirFor: (runId) => files(runId).dir, runsDir };
}

module.exports = { createRunStore, ensureStateGitignore, runsDirFor, RUN_SCHEMA_VERSION };
