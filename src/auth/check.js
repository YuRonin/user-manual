'use strict';

const { createBrowserSession } = require('../browser/session');
const { CaptureError, REASON } = require('../browser/errors');
const { prepareAuth, classifyAuthFailure, assertAuthenticated } = require('./runtime');
const { verifyIdentity } = require('./identity');
const { validateNavigation } = require('../evidence/validate-page');
const { sanitizeUrl } = require('../evidence/store');

/** Probe a protected page with the saved profile; no business actions or screenshots. */
async function checkAuthOnline({ config, profile, path = null, sessionFactory = createBrowserSession, closeSession = true }) {
  const auth = prepareAuth(config, { profile });
  if (auth.status === 'disabled') return { status: 'disabled', onlineChecked: false, validationStatus: 'not-applicable' };
  if (auth.status === 'missing') {
    const error = new CaptureError(REASON.AUTH_MISSING, `认证档案 ${profile} 尚未登录。`);
    error.hint = `运行 manual auth login --profile ${profile}。`;
    throw error;
  }
  const base = new URL(config.project.baseUrl);
  const target = new URL(path || config.auth.verifyPath || '/', `${base.origin}/`);
  if (target.origin !== base.origin) throw Object.assign(new Error('认证检查地址必须属于当前项目站点。'), { code: 'invalid-auth-path' });
  if (target.search || target.hash) throw Object.assign(new Error('认证检查地址只接受路径，不接受查询参数或片段。'), { code: 'invalid-auth-path' });
  const providerId = config.browser.activeProvider;
  const session = sessionFactory();
  try {
    const result = await session.withScenario({
      id: providerId,
      providerConfig: config.browser.providers[providerId],
      profile: config.capture.profiles[config.capture.activeProfile], auth,
    }, async (provider) => {
      // 慢环境可放宽 capture.waits.authCheckMs（有上限）；就绪等待取同一预算的一半，至少保持原来的 8 秒
      const authCheckMs = require('../config/waits').resolveWaits(config).authCheckMs;
      const opened = await provider.open(target.href, { timeout: authCheckMs });
      await provider.waitUntilReady({ timeout: Math.max(8000, Math.round(authCheckMs / 2)), networkIdleTimeout: 1000 });
      const observed = await provider.currentObservation();
      try {
        assertAuthenticated({ finalUrl: observed?.url || opened.finalUrl }, auth);
        const navigation = validateNavigation({ requestedUrl: target.href, openResult: opened, observation: observed });
        const identity = await verifyIdentity(provider, { config, profile, verifyUrl: null, timeoutMs: 3000 });
        if (identity.validatedAt) auth.validatedAt = identity.validatedAt;
        return {
          status: identity.validationStatus === 'validated' ? 'authenticated' : 'reachable-unvalidated',
          onlineChecked: true, validationStatus: identity.validationStatus,
          checkedAt: new Date().toISOString(), finalUrl: sanitizeUrl(navigation.finalUrl),
        };
      } catch (error) {
        if (error.code === 'auth-verification-failed' && auth.status === 'stored') {
          const expired = new CaptureError(REASON.AUTH_EXPIRED, `身份断言未通过：${error.message}`);
          expired.hint = `重新运行 manual auth login --profile ${profile}；若仍失败，检查 auth.identityAssertions 是否与当前页面一致。`;
          throw expired;
        }
        throw classifyAuthFailure(error, auth);
      }
    });
    return { ...result.value, ...(result.warnings.length ? { warnings: result.warnings } : {}) };
  } finally { if (closeSession) await session.close(); }
}

module.exports = { checkAuthOnline };
