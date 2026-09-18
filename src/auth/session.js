'use strict';

async function establishSession({ provider, loginUrl, verifyUrl = null, timeout = 300000 }) {
  await provider.open(loginUrl, { timeout });
  const verified = await provider.waitForAuthentication({ loginUrl, verifyUrl, timeout });
  const storageState = await provider.exportStorageState();
  if (!storageState || !Array.isArray(storageState.cookies) || !Array.isArray(storageState.origins)) {
    throw Object.assign(new Error('浏览器未返回有效的认证状态。'), { code: 'auth-export-failed' });
  }
  return { ok: true, finalUrl: verified.finalUrl, storageState };
}

module.exports = { establishSession };
