'use strict';

/*
 * Run / RuntimeTask 模型（契约 C07）。
 *
 * - Task 七态：pending / running / waiting_input / succeeded / failed / interrupted / cancelled。
 * - 状态只能按 TRANSITIONS 表推进；succeeded、cancelled 为终态。
 * - 进入 running 即开启一次新 attempt；失败重试必须经 failed → pending → running，
 *   上一次 attempt 的错误摘要保留在 attempts[] 里，不被覆盖。
 * - Run 的状态由 Task 派生，不单独维护，避免两份状态源不一致。
 */

const { isSafeId } = require('../model/ids');

// fixture-setup / fixture-cleanup：hook 类 Fixture 的测试数据准备与清理（P3-05）
const TASK_KINDS = ['inspect', 'analyze', 'capture', 'derive-image', 'draft', 'rewrite', 'validate', 'publish', 'fixture-setup', 'fixture-cleanup'];
const TASK_STATUSES = ['pending', 'running', 'waiting_input', 'succeeded', 'failed', 'interrupted', 'cancelled'];
const RUN_STATUSES = TASK_STATUSES;
const REPLAYS = ['safe', 'requires-input', 'unsafe'];
const OUTPUT_KINDS = ['file', 'capture', 'release', 'request', 'value'];

const TRANSITIONS = {
  pending: ['running', 'waiting_input', 'cancelled'],
  running: ['succeeded', 'failed', 'waiting_input', 'interrupted', 'cancelled'],
  // 等待输入：输入提交后回到 pending；模型交接的响应本身就是产物，可直接 succeeded。
  waiting_input: ['pending', 'succeeded', 'cancelled'],
  failed: ['pending', 'cancelled'],
  // 恢复：对账发现产物已提交 → succeeded；可安全重放 → pending；写操作结果不明 → waiting_input。
  interrupted: ['pending', 'succeeded', 'waiting_input', 'failed', 'cancelled'],
  succeeded: [],
  cancelled: [],
};

const TERMINAL = new Set(['succeeded', 'cancelled']);

/** C07 起步默认预算。等待模型 / 用户期间不计活跃时间。 */
const DEFAULT_BUDGET = {
  navigationMs: 30000,
  assertionMs: 10000,
  scenarioActiveMs: 8 * 60 * 1000,
  runActiveMs: 30 * 60 * 1000,
  maxActions: 200,
};

const DEFAULT_RETRY = { maxAttempts: 3, backoffMs: [1000, 3000], replay: 'safe' };

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

/** 由 Task 状态派生 Run 状态。优先级：running > interrupted > failed > waiting_input > pending > cancelled > succeeded。 */
function deriveRunStatus(tasks) {
  const statuses = new Set(tasks.map((task) => task.status));
  if (statuses.size === 0) return 'succeeded';
  for (const status of ['running', 'interrupted', 'failed', 'waiting_input']) {
    if (statuses.has(status)) return status;
  }
  if (statuses.has('pending')) return 'pending';
  if (statuses.has('cancelled')) return 'cancelled';
  return 'succeeded';
}

/**
 * 校验并规范化 Task 定义（创建 Run 时使用）。
 * @returns {{ ok, errors: string[], tasks }}
 */
function normalizeTaskDefinitions(definitions) {
  const errors = [];
  if (!Array.isArray(definitions) || definitions.length === 0) {
    return { ok: false, errors: ['tasks 需要是非空数组。'], tasks: [] };
  }
  const ids = new Set();
  const tasks = definitions.map((def, index) => {
    const where = `tasks[${index}]`;
    if (!isSafeId(def?.id)) errors.push(`${where}.id 非法: ${def?.id}`);
    else if (ids.has(def.id)) errors.push(`${where}.id 重复: ${def.id}`);
    ids.add(def?.id);
    if (!TASK_KINDS.includes(def?.kind)) errors.push(`${where}.kind 需要是 ${TASK_KINDS.join(' / ')} 之一，收到: ${def?.kind}`);
    if (typeof def?.inputHash !== 'string' || def.inputHash === '') errors.push(`${where}.inputHash 必填。`);
    const retry = { ...DEFAULT_RETRY, ...(def?.retry || {}) };
    if (!Number.isInteger(retry.maxAttempts) || retry.maxAttempts < 1) errors.push(`${where}.retry.maxAttempts 需要是正整数。`);
    if (!REPLAYS.includes(retry.replay)) errors.push(`${where}.retry.replay 需要是 ${REPLAYS.join(' / ')} 之一。`);
    return {
      id: def?.id,
      kind: def?.kind,
      dependsOn: Array.isArray(def?.dependsOn) ? [...def.dependsOn] : [],
      // 软顺序：after 中的任务全部结束（成功、失败或因前置失败而无法执行）后才开始，不要求它们成功。
      // 用于"无论采集成败都要清理测试数据"。
      after: Array.isArray(def?.after) ? [...def.after] : [],
      inputHash: def?.inputHash,
      input: def?.input === undefined ? null : def.input,
      // 规划期的复用候选与依赖原因：执行前仍会重新校验，这里只是随任务保存的说明。
      reuse: def?.reuse || null,
      reason: typeof def?.reason === 'string' ? def.reason : null,
      retry,
      status: 'pending',
      attempt: 0,
      attempts: [],
      outputRefs: [],
      error: null,
    };
  });
  for (const task of tasks) {
    for (const dep of task.after) if (!ids.has(dep)) errors.push(`任务 ${task.id} 的 after 引用未知任务 ${dep}。`);
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) errors.push(`任务 ${task.id} 依赖未知任务 ${dep}。`);
      if (dep === task.id) errors.push(`任务 ${task.id} 不能依赖自己。`);
    }
  }
  return { ok: errors.length === 0, errors, tasks };
}

/** 输出引用的形状校验（完整性校验在 store 里做，需要读文件）。 */
function outputRefShapeErrors(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return ['succeeded 需要至少一个 outputRef。'];
  const errors = [];
  refs.forEach((ref, index) => {
    const where = `outputRefs[${index}]`;
    if (!OUTPUT_KINDS.includes(ref?.kind)) { errors.push(`${where}.kind 需要是 ${OUTPUT_KINDS.join(' / ')} 之一。`); return; }
    if (ref.kind === 'value') {
      if (typeof ref.sha256 !== 'string') errors.push(`${where}.sha256 必填。`);
    } else if (typeof ref.ref !== 'string' || ref.ref === '') {
      errors.push(`${where}.ref 必填。`);
    }
  });
  return errors;
}

module.exports = {
  TASK_KINDS,
  TASK_STATUSES,
  RUN_STATUSES,
  OUTPUT_KINDS,
  TRANSITIONS,
  TERMINAL,
  DEFAULT_BUDGET,
  DEFAULT_RETRY,
  canTransition,
  deriveRunStatus,
  normalizeTaskDefinitions,
  outputRefShapeErrors,
};
