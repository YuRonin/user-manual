'use strict';

const cache = require('./cache');
const { CaptureError, REASON } = require('../browser/errors');

function cacheRoot() {
  return process.env.MANUAL_AUTH_CACHE_DIR || cache.defaultCacheRoot();
}

function prepareAuth(config, options = {}) {
  const profile = String(options.profile || config.auth.activeProfile);
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
    status: state ? 'ready' : 'missing',
    storageState: state?.storageState || null,
  };
}

function classifyAuthFailure(error, auth) {
  if (!(error instanceof CaptureError) || error.reason !== REASON.LOGIN_REQUIRED) return error;
  const reason = auth.status === 'ready' ? REASON.AUTH_EXPIRED : REASON.AUTH_MISSING;
  const classified = new CaptureError(reason, error.message, { ...error.details, profile: auth.profile });
  classified.hint = `运行 \`manual auth login --profile ${auth.profile}\` 建立新的认证缓存。`;
  return classified;
}

function assertAuthenticated(openResult, auth) {
  const finalUrl = String(openResult?.finalUrl || '');
  if (/\/(login|signin|sign-in|sign_in|auth|sso|account\/login)(\/|$|\?)/i.test(finalUrl)) {
    const base = new CaptureError(REASON.LOGIN_REQUIRED, `访问后被重定向到了登录页。`, { finalUrl });
    throw classifyAuthFailure(base, auth);
  }
}

async function refreshAuth(provider, auth) {
  if (!auth || auth.status !== 'ready') return { updated: false, warning: null };
  try {
    const storageState = await provider.exportStorageState();
    if (!storageState) return { updated: false, warning: 'Browser Provider 不支持导出认证状态。' };
    cache.writeState(auth.ref, { origin: auth.expectedOrigin, storageState });
    return { updated: true, warning: null };
  } catch (_) {
    return { updated: false, warning: '认证状态刷新失败；已保留上一份可用缓存。' };
  }
}

module.exports = { prepareAuth, classifyAuthFailure, assertAuthenticated, refreshAuth, cacheRoot };
