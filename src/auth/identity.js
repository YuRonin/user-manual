'use strict';

/*
 * 认证语义：stored（缓存文件可读）≠ authenticated（服务端/UI 确认了身份）。
 *
 * - auth.enabled=false 或 profile=anonymous：不读取、不注入、不刷新任何认证缓存。
 * - 登录成功的判据是验证页上的身份断言通过，而不是"离开了 /login"。
 * - 支持的存储能力必须显式声明；未实现的能力直接报 capability-unavailable。
 */

const { runAssertions } = require('../evidence/validate-page');
const { revisionOf } = require('../util/hash');

const ANONYMOUS_PROFILE = 'anonymous';
/** 当前实现支持的浏览器存储能力。sessionStorage 不在 Playwright storageState 中，未实现。 */
const SUPPORTED_CAPABILITIES = ['cookies', 'localStorage', 'indexedDB'];
const DEFAULT_CAPABILITIES = ['cookies', 'localStorage'];

function authDisabled(config, profile) {
  return config.auth?.enabled === false || profile === ANONYMOUS_PROFILE;
}

function resolveCapabilities(config) {
  const requested = Array.isArray(config.auth?.capabilities) ? config.auth.capabilities : DEFAULT_CAPABILITIES;
  const unsupported = requested.filter((item) => !SUPPORTED_CAPABILITIES.includes(item));
  if (unsupported.length) {
    throw Object.assign(new Error(`不支持的认证存储能力: ${unsupported.join(', ')}（支持 ${SUPPORTED_CAPABILITIES.join(' / ')}）。`), {
      code: 'capability-unavailable', reason: 'capability-unavailable', unsupported,
    });
  }
  return requested;
}

/** 身份断言定义的稳定引用（不含任何账号明文），用于区分"以谁的身份"保存的快照。 */
function identityRevision(config, profile) {
  const assertions = config.auth?.identityAssertions || [];
  return assertions.length ? revisionOf({ profile, assertions }) : null;
}

/**
 * 在验证页上执行身份断言。
 * @returns {{ validationStatus: 'validated'|'unvalidated', validatedAt: string|null, identityRevision: string|null }}
 */
async function verifyIdentity(provider, { config, profile, verifyUrl, timeoutMs = 10000 }) {
  const assertions = config.auth?.identityAssertions || [];
  if (!assertions.length) return { validationStatus: 'unvalidated', validatedAt: null, identityRevision: null };
  if (verifyUrl) {
    await provider.open(verifyUrl, { timeout: 30000 });
    if (provider.waitUntilReady) await provider.waitUntilReady({ timeout: 30000 });
  }
  try {
    await runAssertions(provider, assertions, { scope: 'auth-identity', idPrefix: `auth:${profile}`, timeoutMs });
  } catch (error) {
    throw Object.assign(new Error(`登录后身份断言未通过：${error.message}`), { code: 'auth-verification-failed' });
  }
  return { validationStatus: 'validated', validatedAt: new Date().toISOString(), identityRevision: identityRevision(config, profile) };
}

module.exports = {
  ANONYMOUS_PROFILE,
  SUPPORTED_CAPABILITIES,
  DEFAULT_CAPABILITIES,
  authDisabled,
  resolveCapabilities,
  identityRevision,
  verifyIdentity,
};
