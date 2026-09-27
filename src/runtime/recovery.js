'use strict';

/*
 * 中断恢复（P2-08）。
 *
 * 新进程 open() 后，租约失效时仍为 running 的任务已被标成 interrupted。这里按任务种类对账：
 *   - 产物其实已经提交（Capture 与投影已写入、发布事务已推进），只是没来得及记 succeeded
 *     → 按 inputHash / 产物完整性补记成功，不重复采集、不重复发布；
 *   - 发布事务停在中途 → 只对本 Run 的事务按 journal 继续；文档被人改过 → publication-conflict，等待处理；
 *   - 没有已提交产物：可安全重放（replay=safe）→ 回到 pending 从 Scenario 起点重做；
 *     否则 → waiting_input（outcome-unknown），先核查业务状态，绝不盲目重放。
 * 残留的 evidence staging（所属进程已退出）一并回收。
 * 每个决定都记入事件（reason = recovery:<结果>），status 据此解释恢复理由。
 */

const path = require('path');

const { createProjectStore } = require('../store/project');
const { createCaptureStore } = require('../evidence/store');
const { listJournals } = require('../publication/publisher');
const { repairTransaction } = require('../publication/reconcile');
const { manualIdFor } = require('../publication/release-store');
const { fileRef, writeCaptureCache, readRecords, currentSubjectInputs } = require('./handlers');

function loadModel(ctx) {
  const store = createProjectStore({ stateDirAbs: ctx.stateDirAbs, docsOutputDir: ctx.config.docs.outputDir });
  return { store, base: store.load() };
}

/** 采集：Capture 与投影已在本次尝试开始之后提交，且输入未变 → 补记成功。 */
function reconcileCapture(ctx, task, since) {
  const subject = task.input.subject;
  const current = currentSubjectInputs(ctx, subject);
  if (current.captureKey !== task.input.captureKey) return null;
  const { base } = loadModel(ctx);
  let outputs;
  let observedAt;
  if (subject.type === 'task') {
    const entity = base.model.tasks.find((t) => t.id === subject.id);
    const last = entity?.lastCapture;
    if (!last || Date.parse(last.capturedAt) < since || !entity.evidenceManifest) return null;
    outputs = [...last.captureIds.map((id) => ({ kind: 'capture', ref: id })), fileRef(ctx, path.join(ctx.projectRoot, entity.evidenceManifest))];
    observedAt = last.capturedAt;
  } else {
    const page = base.model.pages.find((p) => p.id === subject.id);
    const captureId = page?.browser?.latestCaptureId;
    const [record] = captureId ? readRecords(ctx, [captureId]) : [];
    if (!record || Date.parse(record.observedAt) < since) return null;
    outputs = [{ kind: 'capture', ref: record.id }];
    observedAt = record.observedAt;
  }
  writeCaptureCache(ctx, task, current, outputs, readRecords(ctx, outputs.filter((r) => r.kind === 'capture').map((r) => r.ref)), observedAt);
  return { outputs };
}

/** 发布：只看本 Run 创建的事务。已完成 → 补记；中途 → 按 journal 继续；被人改过 → 冲突。 */
function reconcilePublish(ctx, task) {
  const subject = task.input.subject;
  const manualId = manualIdFor(subject.type, subject.id);
  const journals = listJournals(ctx.stateDirAbs)
    .filter((j) => j.runId === ctx.runId && j.manualId === manualId && j.state !== 'aborted')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const journal = journals[journals.length - 1];
  if (!journal) return null;
  let state = journal.state;
  if (state === 'conflict') return { conflict: journal };
  if (state !== 'completed') {
    const result = repairTransaction(ctx.projectRoot, ctx.stateDirAbs, journal);
    if (result.result === 'conflict') return { conflict: journal };
    if (result.result !== 'completed') return null;
    state = 'completed';
  }
  // 任务状态投影在发布之后提交；中断在两者之间时补上（只改 status）。
  if (subject.type === 'task') {
    const { store, base } = loadModel(ctx);
    const entity = base.model.tasks.find((t) => t.id === subject.id);
    if (entity && entity.status !== 'generated') store.commit({ base, kind: 'observation', changes: { tasks: [{ ...entity, status: 'generated' }] } });
  }
  return { outputs: [{ kind: 'release', ref: `${manualId}/${journal.releaseId}` }] };
}

const RECONCILERS = { capture: reconcileCapture, publish: reconcilePublish };

/**
 * @returns {Array<{ taskId, result: 'reconciled'|'replay'|'outcome-unknown'|'conflict' }>}
 */
async function reconcileInterrupted({ ctx, runStore, runId, lease }) {
  const interrupted = runStore.read(runId).tasks.filter((t) => t.status === 'interrupted');
  if (interrupted.length === 0) return [];
  if (ctx.projectRoot && ctx.stateDirAbs) createCaptureStore({ projectRoot: ctx.projectRoot, stateDirAbs: ctx.stateDirAbs }).cleanupStaging();
  const results = [];
  for (const task of interrupted) {
    const attempt = task.attempts[task.attempts.length - 1];
    const since = attempt ? Date.parse(attempt.startedAt) : 0;
    let outcome = null;
    try {
      outcome = RECONCILERS[task.kind] && ctx.config ? await RECONCILERS[task.kind](ctx, task, since) : null;
    } catch (_) {
      outcome = null; // 对账失败不猜测：按 replay 策略处理
    }
    if (outcome?.outputs) {
      try {
        runStore.transition(runId, task.id, 'succeeded', { lease, outputRefs: outcome.outputs, reason: 'recovery:reconciled' });
        results.push({ taskId: task.id, result: 'reconciled' });
        continue;
      } catch (_) { /* 产物校验不过：当作没有提交 */ }
    }
    if (outcome?.conflict) {
      runStore.transition(runId, task.id, 'waiting_input', {
        lease, reason: 'recovery:conflict',
        error: { code: 'publication-conflict', phase: task.kind, message: `${outcome.conflict.documentPath} 在发布中途被修改过，已保留修改；确认后用 --force 重新发布。`, policy: 'waiting_input', retryable: false, requiresInput: true },
      });
      results.push({ taskId: task.id, result: 'conflict' });
      continue;
    }
    if (task.retry.replay === 'safe') {
      runStore.transition(runId, task.id, 'pending', { lease, reason: 'recovery:replay' });
      results.push({ taskId: task.id, result: 'replay' });
    } else {
      runStore.transition(runId, task.id, 'waiting_input', {
        lease, reason: 'recovery:outcome-unknown',
        error: { code: 'outcome-unknown', phase: task.kind, message: '上次执行在任务完成前中断，且该任务不能安全重放；请核查业务状态后再继续。', policy: 'outcome_unknown', retryable: false, requiresInput: true },
      });
      results.push({ taskId: task.id, result: 'outcome-unknown' });
    }
  }
  return results;
}

module.exports = { reconcileInterrupted };
