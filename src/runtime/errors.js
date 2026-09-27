'use strict';

/*
 * 统一错误结果（契约 C08）。
 *
 * 各模块仍抛自己的错误类（CaptureError 用 reason，其余用 code）；这里把它们映射成一个形状：
 *   { code, phase, message, retryable, requiresInput, policy, scope, hint }
 * policy 对应 C08 的处理策略：retry / fail / waiting_input / outcome_unknown / cancelled。
 * 原始 code / reason 原样保留，不塌缩成笼统的 state-assertion-failed。
 *
 * message 一律经 sanitizeMessage：去掉 URL 查询参数、邮箱、手机号、凭据值，并限制长度。
 */

const { HINTS } = require('../browser/errors');
const { PHONE, EMAIL } = require('../privacy/detector');

const MAX_MESSAGE = 500;

class RuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
    Object.assign(this, details);
  }
}

const RETRY = { policy: 'retry', retryable: true, requiresInput: false };
const FAIL = { policy: 'fail', retryable: false, requiresInput: false };
const INPUT = { policy: 'waiting_input', retryable: false, requiresInput: true };

/** code → 策略。未列出的一律按 fail 处理（不猜测可重试）。 */
const POLICIES = {
  // 瞬时故障：只读导航超时、浏览器崩溃、页面仍在变化、锁等待超时。
  timeout: RETRY,
  'readiness-timeout': RETRY,
  'navigation-failed': RETRY,
  'browser-crashed': RETRY,
  'browser-launch-failed': RETRY,
  'geometry-unstable': RETRY,
  'lock-timeout': RETRY,
  'file-busy': RETRY,
  // 模型：只重试模型任务本身（由 runner 按 task kind 限定）。
  'model-timeout': RETRY,
  'invalid-model-response': RETRY,
  // 需要用户 / 宿主输入：登录、审批范围、人工编辑冲突、并发定义修改后重新规划。
  'auth-missing': INPUT,
  'auth-expired': INPUT,
  'login-required': INPUT,
  'auth-locked': RETRY,
  'approval-required': INPUT,
  'scope-changed': INPUT,
  'publication-conflict': INPUT,
  // 人工修改与新生成冲突 / 已发布文档被删除：等待用户选择（合并提案、owner=human、--force、retired）
  'merge-conflict': INPUT,
  // Fixture：环境策略拒绝 / setup 失败是确定性失败；清理失败必须显式报告，不吞掉（P3-05）
  'fixture-policy-denied': FAIL,
  'fixture-setup-failed': FAIL,
  // 清理失败：等待用户处理测试环境后 resume 重试（幂等），而不是静默结束
  'fixture-cleanup-required': INPUT,
  'fixture-setup-required': FAIL,
  'document-missing': INPUT,
  'model-conflict': INPUT,
  'run-input-changed': INPUT,
  'lock-held-remote': INPUT,
  'model-input-required': INPUT,
  // 写动作结果不明：核查业务状态，禁止盲目重放。
  'outcome-unknown': { policy: 'outcome_unknown', retryable: false, requiresInput: true },
  cancelled: { policy: 'cancelled', retryable: false, requiresInput: false },
};

/** http-error 只有 5xx 属于瞬时故障；4xx 是确定性的失败。 */
function policyFor(code, err) {
  if (code === 'http-error') {
    const status = Number(err?.details?.status ?? err?.status);
    return status >= 500 ? RETRY : FAIL;
  }
  return POLICIES[code] || FAIL;
}

const CREDENTIAL_PAIR = /\b(password|passwd|passcode|token|access[_-]?token|refresh[_-]?token|secret|api[_-]?key|cookie|set-cookie|authorization|session(?:id)?)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function stripUrl(url) {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
}

/** 去敏：URL 去查询参数与 hash、凭据值、邮箱、手机号；截断到 MAX_MESSAGE。 */
function sanitizeMessage(text) {
  if (text === undefined || text === null) return '';
  let out = String(text);
  out = out.replace(URL_RE, stripUrl);
  out = out.replace(BEARER, (_, scheme) => `${scheme} [redacted]`);
  out = out.replace(CREDENTIAL_PAIR, (_, key, sep) => `${key}${sep}[redacted]`);
  out = out.replace(new RegExp(EMAIL.source, 'gi'), '[email]');
  out = out.replace(new RegExp(PHONE.source, 'g'), '[phone]');
  if (out.length > MAX_MESSAGE) out = `${out.slice(0, MAX_MESSAGE)}…`;
  return out;
}

/** 错误的原始分类码：code 优先，CaptureError 用 reason；Playwright 超时没有 code，按名字识别。 */
function errorCode(err) {
  if (!err) return 'internal-error';
  if (typeof err.code === 'string' && err.code) return err.code;
  if (typeof err.reason === 'string' && err.reason) return err.reason;
  if (err.name === 'TimeoutError') return 'timeout';
  if (err.name === 'AbortError') return 'cancelled';
  return null;
}

const SCOPE_FIELDS = ['runId', 'taskId', 'pageId', 'scenarioId', 'captureId', 'stepId'];

function pickScope(...sources) {
  const scope = {};
  for (const source of sources) {
    if (!source) continue;
    for (const field of SCOPE_FIELDS) {
      if (source[field] !== undefined && source[field] !== null) scope[field] = String(source[field]);
    }
  }
  // TaskExecutionError 用 task / step 命名。
  for (const source of sources) {
    if (source?.task && scope.taskId === undefined && typeof source.task === 'string') scope.userTaskId = source.task;
    if (source?.step && scope.stepId === undefined && typeof source.step === 'string') scope.stepId = source.step;
  }
  return scope;
}

/**
 * 映射成 C08 ErrorResult。
 * @param {Error|object} err
 * @param {{ phase?, scope?, fallbackCode? }} [context]
 */
function toErrorResult(err, { phase = null, scope = null, fallbackCode = 'internal-error' } = {}) {
  const code = errorCode(err) || fallbackCode;
  const policy = policyFor(code, err);
  const hint = err?.hint || err?.details?.hint || HINTS[code] || null;
  const result = {
    code,
    phase: err?.phase || phase,
    message: sanitizeMessage(err?.message || code),
    retryable: policy.retryable,
    requiresInput: policy.requiresInput,
    policy: policy.policy,
    scope: pickScope(err, err?.details, scope),
    hint: hint ? sanitizeMessage(hint) : null,
  };
  if (err?.diagnostic && typeof err.diagnostic === 'string') result.diagnosticRef = err.diagnostic;
  return result;
}

/** 旧输出的兼容投影：errors 字符串数组 + CaptureError 的 reason 字段。 */
function toLegacyProjection(result) {
  return { errors: [`${result.code}: ${result.message}`], reason: result.code, hint: result.hint };
}

/** 持久化用的错误摘要（task 记录 / attempts）：只保留分类字段，不带堆栈。 */
function errorSummary(result) {
  return { code: result.code, phase: result.phase, message: result.message, policy: result.policy, retryable: result.retryable, requiresInput: result.requiresInput };
}

module.exports = { RuntimeError, POLICIES, toErrorResult, toLegacyProjection, errorSummary, errorCode, sanitizeMessage, policyFor };
