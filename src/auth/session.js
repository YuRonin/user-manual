'use strict';

const { verifyIdentity } = require('./identity');

/**
 * 登录编排：打开登录页 → 等待离开登录页 → 在验证页执行身份断言 → 导出状态。
 * "离开 /login" 只是前提；只有身份断言通过才记为 validated。
 */
async function establishSession({ provider, loginUrl, verifyUrl = null, timeout = 300000, config = null, profile = 'default', capabilities = [] }) {
  await provider.open(loginUrl, { timeout });
  const verified = await provider.waitForAuthentication({ loginUrl, verifyUrl, timeout });
  const identity = config
    ? await verifyIdentity(provider, { config, profile, verifyUrl: null })
    : { validationStatus: 'unvalidated', validatedAt: null, identityRevision: null };
  const storageState = await provider.exportStorageState({ indexedDB: capabilities.includes('indexedDB') });
  if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) {
    throw Object.assign(new Error('浏览器未返回有效的认证状态。'), { code: 'auth-export-failed' });
  }
  return { ok: true, finalUrl: verified.finalUrl, storageState, ...identity };
}

module.exports = { establishSession };
