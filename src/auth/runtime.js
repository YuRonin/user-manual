'use strict';

const cache = require('./cache');
const { authDisabled, resolveCapabilities, identityRevision } = require('./identity');
const { CaptureError, REASON } = require('../browser/errors');

const LOGIN_PATH_RE = /\/(login|signin|sign-in|sign_in|auth|sso|account\/login)(\/|$|\?)/i;

function cacheRoot() {
  return process.env.MANUAL_AUTH_CACHE_DIR || cache.defaultCacheRoot();
}

/**
 * 准备本次采集的认证状态。
 * status: disabled（未启用/匿名，不读缓存）/ missing / stored（文件可读，尚未证明线上有效）。
 */
function prepareAuth(config, options = {}) {
  const profile = String(options.profile || config.auth.activeProfile);
  if (authDisabled(config, profile)) {
    // 匿名场景绝不接触认证缓存：不读、不注入、不刷新。
    return { ref: null, profile, status: 'disabled', storageState: null, generation: null, capabilities: [] };
  }
  const capabilities = resolveCapabilities(config);
  const ref = {
    root: options.root || cacheRoot(),
    cacheKey: config.auth.cacheKey,
    profile,
  };
  let state;
  try {
    state = cache.readState(ref);
  } catch (error) {
    if (error.code === 'auth-corrupt') {
      const wrapped = new CaptureError(REASON.AUTH_CORRUPT, error.message, { profile });
      wrapped.hint = `运行 \`manual auth clear --profile ${profile}\`，然后重新执行 \`manual auth login --profile ${profile}\`。`;
      throw wrapped;
    }
    throw error;
  }
  const expectedOrigin = new URL(config.project.baseUrl).origin;
  if (state && state.origin !== expectedOrigin) {
    const error = new CaptureError(REASON.AUTH_CORRUPT, '认证缓存属于另一个站点，不能用于当前项目。', { profile });
    error.hint = `运行 \`manual auth login --profile ${profile}\` 重新建立当前站点的认证缓存。`;
    throw error;
  }
  return {
    ref,
    profile,
    expectedOrigin,
    status: state ? 'stored' : 'missing',
    storageState: state?.storageState || null,
    generation: state ? state.generation : null,
    identityRevision: identityRevision(config, profile),
    capabilities,
  };
}

function classifyAuthFailure(error, auth) {
  if (!(error instanceof CaptureError) || error.reason !== REASON.LOGIN_REQUIRED) return error;
  if (auth.status === 'disabled') {
    const classified = new CaptureError(REASON.LOGIN_REQUIRED, error.message, { ...error.details, profile: auth.profile });
    classified.hint = '当前场景未启用认证（auth.enabled=false 或匿名档案），但页面要求登录。确认该页面是否应以匿名身份采集。';
    return classified;
  }
  const reason = auth.status === 'stored' ? REASON.AUTH_EXPIRED : REASON.AUTH_MISSING;
  const classified = new CaptureError(reason, error.message, { ...error.details, profile: auth.profile });
  classified.hint = `运行 \`manual auth login --profile ${auth.profile}\` 建立新的认证缓存。`;
  return classified;
}

function assertAuthenticated(openResult, auth) {
  const finalUrl = String(openResult?.finalUrl || '');
  if (LOGIN_PATH_RE.test(finalUrl)) {
    const base = new CaptureError(REASON.LOGIN_REQUIRED, '访问后被重定向到了登录页。', { finalUrl });
    throw classifyAuthFailure(base, auth);
  }
}

/**
 * 把内存里的认证快照同步到磁盘上的最新一代。
 * 一次 Run 会多次使用同一个 auth（重试、多个 Scenario）；很多站点每次刷新都会轮换 refresh token，
 * 并把旧 token 的复用当作盗用、吊销该用户全部令牌。所以每个 Context 注入前都必须拿最新快照，
 * 不能反复注入 prepareAuth 时读到的那一份。
 */
function reloadAuth(auth) {
  if (!auth || auth.status !== 'stored' || !auth.ref) return auth;
  try {
    const state = cache.readState(auth.ref);
    if (state && state.generation !== auth.generation) {
      auth.storageState = state.storageState;
      auth.generation = state.generation;
    }
  } catch (_) { /* 读不到就沿用内存中的快照，由后续导航结果判断是否失效 */ }
  return auth;
}

function cookieKey(cookie) {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}

/** 原先未过期的 Cookie 在新快照里消失，说明站点已经登出（清掉了会话 / refresh Cookie），不能写回。 */
function lostCookies(previous, next, now = Date.now() / 1000) {
  const kept = new Set((next?.cookies || []).map(cookieKey));
  return (previous?.cookies || [])
    .filter((cookie) => !(cookie.expires > 0 && cookie.expires <= now))
    .filter((cookie) => !kept.has(cookieKey(cookie)))
    .map((cookie) => cookie.name);
}

/**
 * 把当前 Context 的认证状态写回缓存（Scenario 结束时，或站点下发新 Cookie 时）。
 * 写回前确认仍处于登录状态：不在登录页、原有 Cookie 没有被清掉；写入用 generation CAS，
 * 成功后同步内存快照，让同一 Run 里下一个 Context 使用刚轮换出的新令牌。
 * @param {{ onlyIfChanged?: boolean }} [options] 只在凭据与注入时不同的情况下写入（失败的 Scenario 用）
 */
async function refreshAuth(provider, auth, { onlyIfChanged = false } = {}) {
  if (!auth || auth.status !== 'stored') return { updated: false, warning: null };
  try {
    const observation = provider.currentObservation ? await provider.currentObservation() : null;
    if (observation?.url && LOGIN_PATH_RE.test(new URL(observation.url).pathname)) {
      return { updated: false, warning: '当前页面已回到登录页，未刷新认证缓存。' };
    }
    const storageState = await provider.exportStorageState({ indexedDB: auth.capabilities.includes('indexedDB') });
    if (!storageState) return { updated: false, warning: 'Browser Provider 不支持导出认证状态。' };
    const lost = lostCookies(auth.storageState, storageState);
    if (lost.length) {
      return { updated: false, warning: `登录 Cookie（${lost.join('、')}）已被站点清除，疑似已登出，未写回认证缓存。` };
    }
    if (onlyIfChanged && JSON.stringify(storageState) === JSON.stringify(auth.storageState)) {
      return { updated: false, warning: null };
    }
    const written = cache.writeState(auth.ref, { origin: auth.expectedOrigin, storageState, identityRevision: auth.identityRevision }, { expectedGeneration: auth.generation });
    auth.storageState = storageState;
    auth.generation = written.generation;
    return { updated: true, warning: null };
  } catch (error) {
    if (error.code === 'auth-cas-conflict') {
      reloadAuth(auth);
      return { updated: false, warning: '认证缓存已被其他进程更新，丢弃本次较旧的刷新。' };
    }
    return { updated: false, warning: '认证状态刷新失败；已保留上一份可用缓存。' };
  }
}

/**
 * 执行器使用的认证钩子。在 BrowserSession 中运行时由 session 在 Scenario 成功结束后刷新，
 * 传 { refresh: false } 避免同一 Context 刷新两次。
 */
function authRuntimeFor(auth, { refresh = true } = {}) {
  return {
    assertAuthenticated: (openResult) => assertAuthenticated(openResult, auth),
    classify: (error) => classifyAuthFailure(error, auth),
    ...(refresh ? { refresh: (provider) => refreshAuth(provider, auth) } : {}),
  };
}

module.exports = { prepareAuth, classifyAuthFailure, assertAuthenticated, refreshAuth, reloadAuth, lostCookies, authRuntimeFor, cacheRoot, LOGIN_PATH_RE };
