'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic } = require('../util/atomic-write');

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 3000;

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
  // 旧文件没有 generation / 验证信息：按第 0 代、未验证处理。
  return { generation: 0, identityRevision: null, validatedAt: null, ...parsed };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** profile 级独占锁：同一档案的并发刷新串行化；超时的锁视为残留并清理。 */
function withProfileLock(file, fn, { fsImpl = fs, now = Date.now } = {}) {
  const lock = `${file}.lock`;
  const deadline = now() + LOCK_WAIT_MS;
  let fd = null;
  for (;;) {
    try {
      fd = fsImpl.openSync(lock, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw authError('auth-write-failed', `无法创建认证缓存锁。（${lock}）`, { path: lock, cause: error });
      try {
        if (now() - fsImpl.statSync(lock).mtimeMs > LOCK_STALE_MS) { fsImpl.unlinkSync(lock); continue; }
      } catch (_) { continue; }
      if (now() >= deadline) throw authError('auth-locked', '另一个进程正在更新这个认证档案，请稍后重试。', { path: lock });
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ }
    try { fsImpl.unlinkSync(lock); } catch (_) { /* best effort */ }
  }
}

/**
 * 写入认证快照。
 * @param {object} [options.expectedGeneration] 传入时做 CAS：磁盘上的 generation 必须等于它，
 *   否则说明其他进程已写入更新的快照，抛 auth-cas-conflict，不覆盖。
 */
function writeState(ref, value, { fsImpl = fs, now = () => new Date(), expectedGeneration } = {}) {
  const file = cacheFileFor(ref);
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(dir, 0o700); } catch (_) { /* Windows ACL 由当前用户目录继承 */ }
  return withProfileLock(file, () => {
    let current = null;
    try { current = readState(ref, { fsImpl }); } catch (_) { current = null; /* 损坏文件可被新登录覆盖 */ }
    const currentGeneration = current ? current.generation : 0;
    if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
      throw authError('auth-cas-conflict', '认证缓存已被其他进程更新，丢弃这次较旧的写入。', { expectedGeneration, currentGeneration });
    }
    const envelope = {
      version: 1,
      cacheKey: validateSafeName(ref.cacheKey, 'cacheKey'),
      profile: validateSafeName(ref.profile, 'profile'),
      origin: String(value.origin),
      updatedAt: now().toISOString(),
      generation: currentGeneration + 1,
      // 非秘密的稳定引用：身份断言定义的 hash，不保存账号等明文
      identityRevision: value.identityRevision ?? current?.identityRevision ?? null,
      validatedAt: value.validatedAt ?? null,
      storageState: value.storageState,
    };
    try {
      writeFileAtomic(file, JSON.stringify(envelope, null, 2) + '\n', { fsImpl, mode: 0o600 });
    } catch (error) {
      throw authError('auth-write-failed', `认证缓存写入失败。（${file}）`, { path: file, cause: error });
    }
    try { fsImpl.chmodSync(file, 0o600); } catch (_) { /* Windows ACL 由当前用户目录继承 */ }
    return envelope;
  }, { fsImpl });
}

function clearState(ref, { fsImpl = fs } = {}) {
  const file = cacheFileFor(ref);
  if (!fsImpl.existsSync(file)) return false;
  fsImpl.unlinkSync(file);
  return true;
}

/** Cookie 到期只是预检查；最终以服务端 / UI 身份断言为准。 */
function cookieExpiry(state, nowSeconds = Date.now() / 1000) {
  const expiring = (state?.storageState?.cookies || []).filter((cookie) => Number(cookie.expires) > 0);
  if (!expiring.length) return 'unknown';
  return expiring.every((cookie) => Number(cookie.expires) < nowSeconds) ? 'expired' : 'valid';
}

/** 白名单字段：只有状态、时间与路径，从不包含 cookie / storage 值。 */
function publicMetadata(state, file) {
  if (!state) return null;
  return {
    storageStatus: 'stored',
    validationStatus: state.validatedAt ? 'validated' : 'unvalidated',
    lastValidatedAt: state.validatedAt || null,
    cookieExpiry: cookieExpiry(state),
    generation: state.generation,
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
  cookieExpiry,
  validateSafeName,
  withProfileLock,
};
