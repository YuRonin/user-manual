'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function authError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function validateSafeName(value, field = 'name') {
  const text = String(value || '');
  if (!SAFE_NAME.test(text)) {
    throw authError('auth-invalid-name', `${field} 只能使用字母、数字、点、下划线和连字符。`, { field });
  }
  return text;
}

function defaultCacheRoot({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local'), 'living-user-manual', 'auth');
  }
  return path.join(env.XDG_CACHE_HOME || path.join(homedir, '.cache'), 'living-user-manual', 'auth');
}

function cacheFileFor({ root = defaultCacheRoot(), cacheKey, profile }) {
  const safeKey = validateSafeName(cacheKey, 'cacheKey');
  const safeProfile = validateSafeName(profile, 'profile');
  return path.join(path.resolve(root), safeKey, `${safeProfile}.state.json`);
}

function readState(ref, { fsImpl = fs } = {}) {
  const file = cacheFileFor(ref);
  if (!fsImpl.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (_) {
    throw authError('auth-corrupt', `认证缓存无法解析，请重新登录。（${file}）`, { path: file });
  }
  if (
    !parsed || parsed.version !== 1 || parsed.cacheKey !== ref.cacheKey ||
    parsed.profile !== ref.profile || !parsed.origin || !parsed.storageState ||
    !Array.isArray(parsed.storageState.cookies) || !Array.isArray(parsed.storageState.origins)
  ) {
    throw authError('auth-corrupt', `认证缓存结构无效，请重新登录。（${file}）`, { path: file });
  }
  return parsed;
}

function writeState(ref, value, { fsImpl = fs, now = () => new Date() } = {}) {
  const file = cacheFileFor(ref);
  const envelope = {
    version: 1,
    cacheKey: validateSafeName(ref.cacheKey, 'cacheKey'),
    profile: validateSafeName(ref.profile, 'profile'),
    origin: String(value.origin),
    updatedAt: now().toISOString(),
    storageState: value.storageState,
  };
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fsImpl.openSync(temp, 'w', 0o600);
    fsImpl.writeFileSync(fd, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(temp, file);
    try { fsImpl.chmodSync(file, 0o600); } catch (_) { /* Windows ACL 由当前用户目录继承 */ }
    return envelope;
  } catch (error) {
    if (fd != null) try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ }
    try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) { /* best effort */ }
    throw authError('auth-write-failed', `认证缓存写入失败。（${file}）`, { path: file, cause: error });
  }
}

function clearState(ref, { fsImpl = fs } = {}) {
  const file = cacheFileFor(ref);
  if (!fsImpl.existsSync(file)) return false;
  fsImpl.unlinkSync(file);
  return true;
}

function publicMetadata(state, file) {
  if (!state) return null;
  return {
    status: 'ready',
    cacheKey: state.cacheKey,
    profile: state.profile,
    origin: state.origin,
    updatedAt: state.updatedAt,
    path: file,
  };
}

module.exports = {
  defaultCacheRoot,
  cacheFileFor,
  readState,
  writeState,
  clearState,
  publicMetadata,
  validateSafeName,
};
