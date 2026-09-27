'use strict';

/*
 * 重试策略（契约 C07 / C08）。
 *
 * - 只有 policy=retry 的错误可以重试；需要输入、写操作结果不明、确定性失败都不重试。
 * - 浏览器相关的瞬时故障只在 replay=safe 的任务上重试（重放不会产生业务副作用）。
 * - 模型无响应 / 格式错误只重试模型任务（analyze / rewrite），不会因此重新截图。
 * - 失败次数达到 maxAttempts（含首次）后不再重试；退避时间按 backoffMs 表取值。
 */

const MODEL_CODES = new Set(['model-timeout', 'invalid-model-response']);
const MODEL_KINDS = new Set(['analyze', 'rewrite']);

/**
 * @param {object} error  ErrorResult（toErrorResult 的结果）
 * @param {object} task   RuntimeTask 快照（失败已记录之后）
 * @returns {{ retry: boolean, delayMs: number, reason: string }}
 */
function decideRetry(error, task) {
  if (!error || error.policy !== 'retry') return { retry: false, delayMs: 0, reason: `policy-${error?.policy || 'unknown'}` };
  if (MODEL_CODES.has(error.code) && !MODEL_KINDS.has(task.kind)) return { retry: false, delayMs: 0, reason: 'model-error-on-non-model-task' };
  if (!MODEL_CODES.has(error.code) && task.retry?.replay !== 'safe') return { retry: false, delayMs: 0, reason: `replay-${task.retry?.replay}` };
  const failures = (task.attempts || []).filter((a) => a.status === 'failed' || a.status === 'interrupted').length;
  const max = task.retry?.maxAttempts ?? 3;
  if (failures >= max) return { retry: false, delayMs: 0, reason: 'retry-exhausted' };
  const table = task.retry?.backoffMs || [1000, 3000];
  const delayMs = table[Math.min(failures - 1, table.length - 1)] ?? 0;
  return { retry: true, delayMs: Math.max(0, delayMs), reason: 'transient' };
}

module.exports = { decideRetry, MODEL_CODES, MODEL_KINDS };
