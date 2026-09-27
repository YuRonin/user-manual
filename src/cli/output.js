'use strict';

/*
 * 退出码（契约 C08）。
 *
 *   0  成功，或显式 dry-run（--plan）
 *   1  执行失败
 *   2  参数错误 / 不支持的命令
 *   3  等待输入（登录、审批、模型文案、人工确认、写操作结果需核查）
 *   4  检测到漂移或需要处理的冲突（证据 / 草稿过期、发布冲突、并发修改、Run 输入已变）
 *
 * 调用方以 JSON 里的 code 作细分；退出码只给脚本做粗分支。
 */

const EXIT = { OK: 0, FAILED: 1, USAGE: 2, WAITING: 3, CONFLICT: 4 };

const USAGE_CODES = new Set(['invalid-arguments', 'unknown-target', 'ambiguous-target', 'invalid-target', 'unknown-command']);
const WAITING_CODES = new Set([
  'approval-required', 'approval-scope-unknown', 'scope-changed', 'approval-scope-changed', 'pending', 'legacy-unverified',
  'auth-missing', 'auth-expired', 'login-required', 'review-required', 'model-input-required', 'outcome-unknown', 'lock-held-remote',
  'analysis-required',
]);
const CONFLICT_CODES = new Set(['publication-conflict', 'merge-conflict', 'document-missing', 'model-conflict', 'run-input-changed', 'draft-stale', 'evidence-stale', 'plan-tampered']);

/** 从错误对象、ErrorResult、"code: 说明" 字符串或它们的数组中取第一个分类码。 */
function codeOf(input) {
  const first = Array.isArray(input) ? input[0] : input;
  if (!first) return null;
  if (typeof first === 'string') {
    const match = /^([a-z][a-z0-9-]+):/.exec(first.trim());
    return match ? match[1] : null;
  }
  if (typeof first === 'object') return first.code || first.reason || codeOf(first.errors) || null;
  return null;
}

function exitCodeForCode(code) {
  if (!code) return EXIT.FAILED;
  if (USAGE_CODES.has(code)) return EXIT.USAGE;
  if (WAITING_CODES.has(code)) return EXIT.WAITING;
  if (CONFLICT_CODES.has(code)) return EXIT.CONFLICT;
  return EXIT.FAILED;
}

/** 失败输出对应的退出码。 */
function exitCodeFor(input) {
  return exitCodeForCode(codeOf(input));
}

/** 参数错误：先按命令自己的格式输出，再返回 2。 */
function usageExit() {
  return EXIT.USAGE;
}

/** Run 汇总 → 退出码：成功 0；等待输入 3；失败按第一个失败任务的 code；中断 1。 */
function exitCodeForRun(summary) {
  if (summary.status === 'succeeded') return EXIT.OK;
  if (summary.failed?.length) return exitCodeForCode(summary.failed[0].code) === EXIT.WAITING ? EXIT.FAILED : exitCodeForCode(summary.failed[0].code);
  if (summary.status === 'waiting_input') {
    const code = summary.waiting?.[0]?.code;
    return exitCodeForCode(code) === EXIT.CONFLICT ? EXIT.CONFLICT : EXIT.WAITING;
  }
  return EXIT.FAILED;
}

module.exports = { EXIT, codeOf, exitCodeFor, exitCodeForCode, exitCodeForRun, usageExit };
