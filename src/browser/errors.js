'use strict';

/*
 * 截图失败的分类错误。
 *
 * 核心原则：**页面打不开就不要产出截图**。伪造的截图比没有截图危害大得多——
 * 它会静默地进手册，没人知道那页其实是坏的。所以失败必须分类、必须可操作。
 */

/** 失败原因。每一项都对应一条用户能照着做的修复建议。 */
const REASON = {
  SERVER_UNREACHABLE: 'server-unreachable',
  DNS_FAILURE: 'dns-failure',
  HTTP_NOT_FOUND: 'http-not-found',
  HTTP_ERROR: 'http-error',
  TIMEOUT: 'timeout',
  LOGIN_REQUIRED: 'login-required',
  AUTH_MISSING: 'auth-missing',
  AUTH_EXPIRED: 'auth-expired',
  AUTH_CORRUPT: 'auth-corrupt',
  BLANK_PAGE: 'blank-page',
  UNSAFE_PORT: 'unsafe-port',
  PROVIDER_UNAVAILABLE: 'provider-unavailable',
  BROWSER_LAUNCH_FAILED: 'browser-launch-failed',
  NAVIGATION_FAILED: 'navigation-failed',
  READINESS_TIMEOUT: 'readiness-timeout',
  UNEXPECTED_REDIRECT: 'unexpected-redirect',
  SOFT_NOT_FOUND: 'soft-not-found',
  UNEXPECTED_STATE: 'unexpected-page-state',
  PAGE_IDENTITY_FAILED: 'page-identity-failed',
  GEOMETRY_UNSTABLE: 'geometry-unstable',
  PRIVACY_UNCERTAIN: 'privacy-uncertain',
};

/** 每类失败给一条「接下来做什么」。 */
const HINTS = {
  [REASON.SERVER_UNREACHABLE]: '项目大概率没在跑。先启动开发服务器，或检查 config.yaml 里的 project.baseUrl 端口是否正确。',
  [REASON.DNS_FAILURE]: '域名解析失败。检查 project.baseUrl 拼写，或确认网络/VPN 状态。',
  [REASON.HTTP_NOT_FOUND]: '服务器返回 404。这个 route 可能已经不存在了——重跑 `manual inspect` 看看页面模型是否过期。',
  [REASON.HTTP_ERROR]: '服务器返回了错误状态码。先在浏览器里手工访问这个地址确认服务端是否正常。',
  [REASON.TIMEOUT]: '页面在超时时间内没有加载完。可以用 --timeout 放宽，或用 --wait-for <选择器> 指定真正该等的元素。',
  [REASON.LOGIN_REQUIRED]: '这个页面需要登录。请使用 `manual auth login` 建立认证缓存。',
  [REASON.AUTH_MISSING]: '认证缓存不存在。请使用 `manual auth login --profile <名称>` 登录一次。',
  [REASON.AUTH_EXPIRED]: '认证缓存已过期。请重新运行 `manual auth login --profile <名称>`。',
  [REASON.AUTH_CORRUPT]: '认证缓存损坏。请清除对应档案后重新登录。',
  [REASON.BLANK_PAGE]: '页面加载完了但 body 是空的，通常是前端运行时报错。打开浏览器控制台看看有没有异常。',
  [REASON.UNSAFE_PORT]: 'Chromium 出于安全考虑屏蔽了这个端口。把开发服务器换到常用端口（3000 / 5173 / 8080 等）再试。',
  [REASON.PROVIDER_UNAVAILABLE]: '找不到 Playwright。在工具目录运行 `npm ci`，或设置 MANUAL_PLAYWRIGHT_PATH；`manual doctor` 可查看诊断。',
  [REASON.BROWSER_LAUNCH_FAILED]: '浏览器启动失败。可能是浏览器内核没下载，试试 `npx playwright install chromium`。',
  [REASON.NAVIGATION_FAILED]: '导航失败。先在浏览器里手工访问这个地址看看发生了什么。',
  [REASON.READINESS_TIMEOUT]: '页面在等待结束后仍未就绪（指定元素未出现或仍在加载中）。确认 --wait-for 选择器正确，或放宽 --timeout。',
  [REASON.UNEXPECTED_REDIRECT]: '页面被跳转到了未声明的地址。确认路由与账号是否正确，必要时在页面模型中声明允许的跳转。',
  [REASON.SOFT_NOT_FOUND]: '服务器返回 200，但页面内容是「不存在」页。这个 route 可能已失效，重跑 `manual inspect` 检查页面模型。',
  [REASON.UNEXPECTED_STATE]: '页面显示的是错误或加载状态，而不是预期的正常状态。先在浏览器里确认数据与服务是否正常。',
  [REASON.GEOMETRY_UNSTABLE]: '截图前后页面仍在变化（动画、轮询或延迟渲染）。用 --wait-for 等待真正稳定的元素后重试。',
  [REASON.PRIVACY_UNCERTAIN]: '隐私规则存在冲突（redact 与 preserve 同时命中）。修正 config.yaml 的 privacy.rules 后重试。',
  [REASON.PAGE_IDENTITY_FAILED]: '页面身份断言未通过：打开的不是预期页面。检查页面模型 states.default 的断言与当前账号权限。',
};

class CaptureError extends Error {
  /**
   * @param {string} reason  REASON 里的一项
   * @param {string} message 说清楚发生了什么（会直接展示给用户）
   * @param {object} [details] 附加证据：url / status / finalUrl 等
   */
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'CaptureError';
    this.reason = reason;
    this.details = details;
    this.hint = HINTS[reason] || null;
  }

  toJSON() {
    return { reason: this.reason, message: this.message, hint: this.hint, ...this.details };
  }
}

/**
 * 把 Playwright 抛出的底层错误翻译成分类错误。
 * 只认那些能给出确定建议的，其余归到 NAVIGATION_FAILED 并带上原始信息。
 */
function classifyNavigationError(err, url) {
  const msg = String(err && err.message ? err.message : err);

  // 这条要排在连接失败之前判断：被屏蔽的端口压根不会发起连接，
  // 归到「项目没启动」会把用户引到错误的方向。
  if (/ERR_UNSAFE_PORT/i.test(msg)) {
    return new CaptureError(REASON.UNSAFE_PORT, `Chromium 拒绝访问该端口: ${url}`, { url, cause: msg.split('\n')[0] });
  }
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|ERR_EMPTY_RESPONSE/i.test(msg)) {
    return new CaptureError(REASON.SERVER_UNREACHABLE, `连不上 ${url}`, { url, cause: msg.split('\n')[0] });
  }
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return new CaptureError(REASON.DNS_FAILURE, `域名解析失败: ${url}`, { url, cause: msg.split('\n')[0] });
  }
  if (/Timeout|timed out|ERR_TIMED_OUT/i.test(msg)) {
    return new CaptureError(REASON.TIMEOUT, `打开 ${url} 超时`, { url, cause: msg.split('\n')[0] });
  }
  return new CaptureError(REASON.NAVIGATION_FAILED, `打开 ${url} 失败: ${msg.split('\n')[0]}`, { url, cause: msg.split('\n')[0] });
}

module.exports = { CaptureError, REASON, HINTS, classifyNavigationError };
