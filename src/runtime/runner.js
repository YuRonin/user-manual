'use strict';

/*
 * 串行 Runner（契约 C07）。
 *
 * 每轮挑选依赖全部 succeeded 的 pending 任务（按计划顺序）：
 *   保存 running → 执行 handler → 校验 outputRefs → 保存 succeeded。
 * 关键进度都在 Run Store 里；进程随时退出，新进程 open() 后从任务快照继续。
 *
 * - 失败：按 retry 策略有界重试（只重试失败任务，已提交的前置任务不重跑）；不可重试的失败留在 failed，
 *   其后续任务保持 pending，不会越过它去发布；互不依赖的目标照常推进。
 * - 等待输入：任务记 waiting_input，后续保持 pending；本次执行结束时释放 Browser 与租约，不在内存里等待。
 *   下次 resume 时 waiting_input 任务回到 pending 重新检查（不计入重试次数）。
 * - 预算：活跃时间 / 动作次数按 Run 累计（resume 沿用已消耗值）；单任务超时 → budget-exceeded，
 *   并关闭浏览器会话中断进行中的库调用，结果按不确定处理（不记成功）。
 * - 取消：signal 触发后当前任务记 interrupted，停止调度；Browser 在 finally 中关闭。
 */

const { createBrowserSession } = require('../browser/session');
const { toErrorResult, RuntimeError } = require('./errors');
const { decideRetry } = require('./retry');
const { checkpoint } = require('./faults');
const { reconcileInterrupted } = require('./recovery');

const TASK_TIMEOUT_KIND = { capture: 'scenarioActiveMs', 'derive-image': 'scenarioActiveMs', 'fixture-setup': 'scenarioActiveMs', 'fixture-cleanup': 'scenarioActiveMs' };

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, onTimeout) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new RuntimeError('budget-exceeded', `任务超过活跃时间预算（${ms}ms），结果不确定，未记为成功。`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function summarize(state) {
  const by = (status) => state.tasks.filter((t) => t.status === status);
  return {
    runId: state.run.id,
    status: state.run.status,
    succeeded: by('succeeded').map((t) => t.id),
    pending: by('pending').map((t) => t.id),
    waiting: by('waiting_input').map((t) => ({ id: t.id, kind: t.kind, code: t.error?.code || null, message: t.error?.message || null })),
    failed: by('failed').map((t) => ({ id: t.id, kind: t.kind, code: t.error?.code || null, message: t.error?.message || null })),
    interrupted: by('interrupted').map((t) => t.id),
    // 执行期提示（与规划期 plan.summary.warnings 区分）
    warnings: state.tasks.flatMap((t) => (t.warnings || []).map((warning) => `${t.id}：${warning}`)),
  };
}

/**
 * 执行（或继续执行）一个 Run。
 * @param {object} p
 * @param {object} p.runStore          createRunStore()
 * @param {string} p.runId
 * @param {object} p.handlers          kind → handler
 * @param {object} p.context           传给 handler 的上下文（projectRoot / config / stateDirAbs / mode / cacheStore / modelHandoff …）
 * @param {AbortSignal} [p.signal]
 * @param {() => number} [p.clock]
 * @param {(ms) => Promise} [p.sleep]
 * @param {() => object} [p.sessionFactory]  测试可注入
 * @param {(state) => void} [p.verifyInputs] 开始前确认输入未变（resume 使用），不通过时抛错且不改动 Run
 */
/**
 * 任务是否已经"结束"：成功、失败、取消，或者仍在 pending 但某个前置任务已经结束且没有成功（它永远不会开始）。
 * 等待输入 / 运行中 / 中断的任务未结束——清理要等它们，避免在恢复前删掉还要用的测试数据。
 */
function settled(byId, id, seen = new Set()) {
  const task = byId.get(id);
  if (!task || seen.has(id)) return true;
  seen.add(id);
  if (['succeeded', 'failed', 'cancelled'].includes(task.status)) return true;
  if (task.status !== 'pending') return false;
  return task.dependsOn.some((dep) => { const d = byId.get(dep); return d && d.status !== 'succeeded' && settled(byId, dep, seen); });
}

async function runRun({ runStore, runId, handlers, context = {}, signal = null, clock = () => Date.now(), sleep = defaultSleep, sessionFactory = () => createBrowserSession(), verifyInputs = null, onEvent = null }) {
  const opened = runStore.open(runId);
  const { lease } = opened;
  const heartbeat = setInterval(() => { try { lease.renew(); } catch (_) { /* 下次写入时报告 lease-lost */ } }, 10000);
  if (heartbeat.unref) heartbeat.unref();
  let session = null;
  const ctx = {
    ...context,
    authChecks: new Map(),
    runId,
    runDir: runStore.runDirFor(runId),
    now: clock,
    signal,
    plan: opened.state.plan,
    task: (id) => runStore.read(runId).tasks.find((t) => t.id === id) || null,
    session: () => { if (!session) session = sessionFactory(); return session; },
  };
  const closeSession = async () => { if (session) { const s = session; session = null; await s.close(); } };
  // 取消时立即关闭浏览器，让进行中的采集尽快失败；任务随后记 interrupted，结果不当作成功。
  const onAbort = () => { closeSession().catch(() => {}); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const emit = (event) => { if (onEvent) onEvent(event); };

  try {
    if (verifyInputs) await verifyInputs(opened.state);
    // 恢复：上次等待输入的任务重新检查；中断的任务先按产物对账（已提交则补记成功），
    // 否则按 replay 策略决定能否重放（见 recovery.js）。
    for (const task of runStore.read(runId).tasks) {
      if (task.status === 'waiting_input') runStore.transition(runId, task.id, 'pending', { lease, reason: 'resume-recheck' });
    }
    await reconcileInterrupted({ ctx, runStore, runId, lease });

    for (;;) {
      if (signal?.aborted) break;
      const state = runStore.read(runId);
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      const ready = state.tasks.find((t) => t.status === 'pending' && t.dependsOn.every((dep) => byId.get(dep)?.status === 'succeeded') && (t.after || []).every((dep) => settled(byId, dep)));
      if (!ready) break;

      const budget = state.run.budget;
      const consumed = state.run.consumed;
      runStore.transition(runId, ready.id, 'running', { lease });
      checkpoint('task-running');
      emit({ type: 'task-start', taskId: ready.id, kind: ready.kind });
      if (consumed.activeMs >= budget.runActiveMs || consumed.actions >= budget.maxActions) {
        const error = toErrorResult(new RuntimeError('budget-exceeded', `Run 预算已用尽（活跃 ${consumed.activeMs}ms / 动作 ${consumed.actions} 次）；需要显式追加预算后继续。`), { phase: ready.kind, scope: { taskId: ready.id } });
        runStore.transition(runId, ready.id, 'failed', { lease, error });
        break;
      }

      const handler = handlers[ready.kind];
      const started = clock();
      const limit = Math.min(budget[TASK_TIMEOUT_KIND[ready.kind]] || budget.runActiveMs, budget.runActiveMs - consumed.activeMs);
      let result;
      let failure = null;
      try {
        if (!handler) throw new RuntimeError('unsupported-task', `没有 ${ready.kind} 任务的执行器。`);
        const current = runStore.read(runId).tasks.find((t) => t.id === ready.id);
        result = await withTimeout(Promise.resolve().then(() => handler(ctx, current)), limit, () => { closeSession().catch(() => {}); });
      } catch (error) {
        failure = error;
      }
      const activeMs = Math.max(0, clock() - started);
      runStore.consume(runId, lease, { activeMs, actions: result?.actions || 0 });

      if (signal?.aborted) {
        runStore.transition(runId, ready.id, 'interrupted', { lease, error: { code: 'cancelled', phase: ready.kind, message: '用户取消；任务结果未确认。', policy: 'cancelled', retryable: false, requiresInput: false } });
        break;
      }
      if (failure) {
        const error = toErrorResult(failure, { phase: ready.kind, scope: { taskId: ready.id, ...(ready.input?.subject ? { [`${ready.input.subject.type}Id`]: ready.input.subject.id } : {}) } });
        if (error.requiresInput && error.policy === 'waiting_input') {
          runStore.transition(runId, ready.id, 'waiting_input', { lease, error });
          emit({ type: 'task-waiting', taskId: ready.id, code: error.code });
          continue;
        }
        const failed = runStore.transition(runId, ready.id, 'failed', { lease, error });
        emit({ type: 'task-failed', taskId: ready.id, code: error.code });
        const decision = decideRetry(error, failed);
        if (decision.retry) {
          await sleep(decision.delayMs);
          runStore.transition(runId, ready.id, 'pending', { lease, reason: `retry:${error.code}` });
        }
        continue;
      }
      if (result?.waiting) {
        const waiting = result.waiting;
        runStore.transition(runId, ready.id, 'waiting_input', {
          lease,
          error: { code: waiting.code, phase: ready.kind, message: waiting.message, policy: 'waiting_input', retryable: false, requiresInput: true },
          reason: waiting.request ? `request:${waiting.request}` : undefined,
        });
        emit({ type: 'task-waiting', taskId: ready.id, code: waiting.code });
        continue;
      }
      try {
        runStore.transition(runId, ready.id, 'succeeded', { lease, outputRefs: result?.outputs, reason: result?.reused ? `reused:${result.reused.from}` : undefined, warnings: result?.warnings });
        emit({ type: 'task-succeeded', taskId: ready.id, reused: !!result?.reused });
      } catch (error) {
        runStore.transition(runId, ready.id, 'failed', { lease, error: toErrorResult(error, { phase: ready.kind, scope: { taskId: ready.id } }) });
      }
    }
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    clearInterval(heartbeat);
    await closeSession().catch(() => {});
    lease.release();
  }
  return summarize(runStore.read(runId));
}

module.exports = { runRun, summarize, withTimeout };
