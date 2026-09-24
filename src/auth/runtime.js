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
 * 采集成功后刷新认证快照。
 * 刷新前再次确认当前仍处于已登录页面；写入用 generation CAS，旧 Context 的快照不能覆盖新快照。
 */
async function refreshAuth(provider, auth) {
  if (!auth || auth.status !== 'stored') return { updated: false, warning: null };
  try {
    const observation = provider.currentObservation ? await provider.currentObservation() : null;
    if (observation?.url && LOGIN_PATH_RE.test(new URL(observation.url).pathname)) {
      return { updated: false, warning: '当前页面已回到登录页，未刷新认证缓存。' };
    }
    const storageState = await provider.exportStorageState({ indexedDB: auth.capabilities.includes('indexedDB') });
    if (!storageState) return { updated: false, warning: 'Browser Provider 不支持导出认证状态。' };
    cache.writeState(auth.ref, { origin: auth.expectedOrigin, storageState, identityRevision: auth.identityRevision }, { expectedGeneration: auth.generation });
    return { updated: true, warning: null };
  } catch (error) {
    if (error.code === 'auth-cas-conflict') return { updated: false, warning: '认证缓存已被其他进程更新，丢弃本次较旧的刷新。' };
    return { updated: false, warning: '认证状态刷新失败；已保留上一份可用缓存。' };
  }
}

module.exports = { prepareAuth, classifyAuthFailure, assertAuthenticated, refreshAuth, cacheRoot, LOGIN_PATH_RE };
