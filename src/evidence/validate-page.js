'use strict';

/*
 * 页面与任务入口共用的导航 / 页面身份 / 状态验证。
 *
 * 铁律：错页面不能被当成成功。判断依据是等待结束后**重新读取**的页面事实
 * （SPA 延迟跳转以截图时的 URL 为准），而不是 goto 返回时的旧 finalUrl。
 * 每项检查产出一条带 scope 的 validation；一个 scope 通过不推导其他 scope 通过。
 */

const { CaptureError, REASON } = require('../browser/errors');

/** 看起来像登录页的路径。 */
const LOGIN_PATH_RE = /\/(login|signin|sign-in|sign_in|auth|sso|account\/login)(\/|$|\?)/i;

const PAGE_STATES = ['normal', 'loading', 'error', 'empty'];

function pathnameOf(url) {
  try { return new URL(url).pathname; } catch (_) { return null; }
}

function originOf(url) {
  try { return new URL(url).origin; } catch (_) { return null; }
}

function passed(scope, check, extra = {}) {
  return { scope, check, outcome: 'passed', checkedAt: new Date().toISOString(), ...extra };
}

/**
 * 导航结果验证（不需要页面内断言）。失败抛分类的 CaptureError。
 * @param {object} p
 * @param {string} p.requestedUrl
 * @param {{status:number|null, finalUrl:string}} p.openResult  goto 的结果
 * @param {object|null} p.observation  等待后重新读取的页面事实 { url, hasPasswordField, bodyTextLength, elementCount, notFoundHint, busy, errorAlert, pageErrors }
 * @param {object} [p.expected] { statuses?: number[], state?: 'normal'|'loading'|'error'|'empty', allowRedirects?: string[] }
 * @returns {{ finalUrl, actualRoute, redirected, validations, warnings }}
 */
function validateNavigation({ requestedUrl, openResult, observation = null, expected = {} }) {
  const state = expected.state || 'normal';
  if (!PAGE_STATES.includes(state)) throw new Error(`未知的预期页面状态: ${state}`);
  const status = openResult.status;
  const finalUrl = (observation && observation.url) || openResult.finalUrl;
  const details = { url: requestedUrl, status, finalUrl };
  const validations = [];
  const warnings = [];

  // ---- HTTP
  if (Array.isArray(expected.statuses) && expected.statuses.length > 0) {
    if (status !== null && !expected.statuses.includes(status)) {
      const reason = status === 404 ? REASON.HTTP_NOT_FOUND : REASON.HTTP_ERROR;
      throw new CaptureError(reason, `页面返回 HTTP ${status}，预期 ${expected.statuses.join('/')}: ${requestedUrl}`, details);
    }
  } else if (status === 404) {
    throw new CaptureError(REASON.HTTP_NOT_FOUND, `页面返回 404: ${requestedUrl}`, details);
  }

  // ---- 登录跳转（含 SPA 延迟跳转：finalUrl 取自等待之后）
  const requestedIsLogin = LOGIN_PATH_RE.test(requestedUrl);
  if (!requestedIsLogin) {
    if (LOGIN_PATH_RE.test(finalUrl)) {
      throw new CaptureError(REASON.LOGIN_REQUIRED, `访问 ${requestedUrl} 被重定向到了登录页。`, details);
    }
    const looksLikeOnlyALoginForm = observation && observation.hasPasswordField &&
      observation.bodyTextLength < 200 && observation.elementCount < 80;
    if (looksLikeOnlyALoginForm) {
      throw new CaptureError(REASON.LOGIN_REQUIRED, `${requestedUrl} 渲染出的是登录表单，说明需要登录。`, details);
    }
  }

  if (!expected.statuses && status !== null && status >= 400) {
    throw new CaptureError(REASON.HTTP_ERROR, `页面返回 HTTP ${status}: ${requestedUrl}`, details);
  }
  validations.push(passed('page-identity', 'http-status', { status }));

  // ---- 跳转
  if (originOf(finalUrl) !== originOf(requestedUrl)) {
    throw new CaptureError(REASON.UNEXPECTED_REDIRECT, `${requestedUrl} 跳转到了其他站点: ${originOf(finalUrl)}`, details);
  }
  const requestedPath = pathnameOf(requestedUrl);
  const actualRoute = pathnameOf(finalUrl);
  const redirected = actualRoute !== requestedPath;
  if (redirected) {
    if (Array.isArray(expected.allowRedirects)) {
      if (!expected.allowRedirects.includes(actualRoute)) {
        throw new CaptureError(REASON.UNEXPECTED_REDIRECT, `${requestedUrl} 跳转到了未声明的地址 ${actualRoute}。`, details);
      }
    } else {
      warnings.push(`页面从 ${requestedPath} 跳转到了 ${actualRoute}，已按实际地址记录。`);
    }
  }
  validations.push(passed('page-identity', 'final-url', { actualRoute, redirected }));

  // ---- 页面内容
  if (observation && observation.elementCount === 0 && observation.bodyTextLength === 0) {
    throw new CaptureError(REASON.BLANK_PAGE, `${requestedUrl} 加载完成但页面是空的。`, {
      ...details, pageErrors: observation.pageErrors || [],
    });
  }
  if (observation && observation.notFoundHint && state !== 'error') {
    throw new CaptureError(REASON.SOFT_NOT_FOUND, `${requestedUrl} 返回 ${status}，但页面显示的是「不存在」内容。`, details);
  }

  // ---- 预期状态：Loading/Error 只在显式声明的 Scenario 中算通过
  if (observation) {
    const actual = observation.busy ? 'loading' : (observation.errorAlert ? 'error' : 'normal');
    if (state === 'normal' && actual === 'loading') {
      throw new CaptureError(REASON.READINESS_TIMEOUT, `${requestedUrl} 等待结束后仍处于加载中。`, details);
    }
    if (state === 'normal' && actual === 'error') {
      throw new CaptureError(REASON.UNEXPECTED_STATE, `${requestedUrl} 显示的是错误状态。`, details);
    }
    if ((state === 'loading' || state === 'error') && actual !== state) {
      throw new CaptureError(REASON.UNEXPECTED_STATE, `${requestedUrl} 预期为 ${state} 状态，实际为 ${actual}。`, details);
    }
    validations.push(passed('scenario-state', 'page-state', { expected: state, actual }));
  }

  return { finalUrl, actualRoute, redirected, validations, warnings };
}

const DEFAULT_ASSERTION_TIMEOUT_MS = 10000;

/**
 * 有界自动等待地执行一条状态断言：直到通过或超时。
 * 失败保留定位分类（target-not-visible / target-ambiguous）。
 */
async function assertWithin(provider, assertion, { timeoutMs = DEFAULT_ASSERTION_TIMEOUT_MS, intervalMs = 100, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      return await provider.assertCondition(assertion);
    } catch (error) {
      lastError = error;
    }
    if (now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  const code = lastError && ['target-not-visible', 'target-ambiguous'].includes(lastError.code)
    ? lastError.code : 'state-assertion-failed';
  throw Object.assign(new Error(lastError ? lastError.message : '断言失败'), { code, cause: lastError });
}

/** 断言是否只靠 URL —— 这类旧状态只能作为 legacy observation，不能证明页面身份。 */
function isUrlOnly(assertions) {
  return !(assertions || []).some((assertion) => assertion && assertion.type !== 'url');
}

/**
 * 依次执行一组断言，返回带 assertionId 的 validation 记录。
 * @param {string} scope     page-identity / scenario-state
 * @param {string} idPrefix  断言没有显式 id 时用 `${idPrefix}#${index}`
 */
async function runAssertions(provider, assertions, { scope, idPrefix, phase = null, stepId = null, timeoutMs } = {}) {
  const validations = [];
  for (const [index, assertion] of (assertions || []).entries()) {
    const assertionId = assertion.id || `${idPrefix}#${index}`;
    try {
      await assertWithin(provider, assertion, { timeoutMs });
      validations.push(passed(scope, assertion.type, { assertionId, phase, stepId }));
    } catch (error) {
      error.validation = { scope, check: assertion.type, assertionId, phase, stepId, outcome: 'failed', checkedAt: new Date().toISOString() };
      throw error;
    }
  }
  return validations;
}

module.exports = {
  LOGIN_PATH_RE,
  PAGE_STATES,
  validateNavigation,
  assertWithin,
  runAssertions,
  isUrlOnly,
  DEFAULT_ASSERTION_TIMEOUT_MS,
};
