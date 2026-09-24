'use strict';

/*
 * 项目写锁（契约 C02）。
 *
 * 用排他创建（wx）的锁文件，内容带 owner token、pid、host、createdAt、leaseUntil。
 * 只有持有 token 的人能释放。判断残留锁时不单看 PID（可能被复用）：
 *   - 同一台机器：进程已不存在，或租约已过期 → 视为残留，原子改名后重新获取；
 *   - 其他机器的锁：无法确认对方是否还活着，从不自动清理，返回 lock-held-remote 并给出恢复方法。
 * 锁只保护短暂的提交阶段；长时间的浏览器 / 模型工作不持有锁（提交前再做 CAS）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LEASE_MS = 30000;
const DEFAULT_TIMEOUT_MS = 10000;
const POLL_MS = 50;

class LockError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    Object.assign(this, details);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function lockFileFor(stateDirAbs, name = 'project') {
  return path.join(stateDirAbs, 'locks', `${name}.lock`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readOwner(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** 残留判断：同机且进程已死或租约过期。解析不了的锁文件按"未知"处理（不自动清理，除非很旧）。 */
function isStale(owner, file, now = Date.now()) {
  if (!owner) {
    try { return now - fs.statSync(file).mtimeMs > DEFAULT_LEASE_MS; } catch (_) { return true; }
  }
  if (owner.host !== os.hostname()) return false;
  if (Date.parse(owner.leaseUntil) < now) return true;
  return !processAlive(owner.pid);
}

/**
 * 获取锁。返回 { token, release() }。
 * @param {{ timeoutMs?, leaseMs?, name? }} options
 */
function acquireLock(stateDirAbs, { name = 'project', timeoutMs = DEFAULT_TIMEOUT_MS, leaseMs = DEFAULT_LEASE_MS } = {}) {
  const file = lockFileFor(stateDirAbs, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const token = crypto.randomUUID();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const createdAt = new Date();
    const owner = {
      token, pid: process.pid, host: os.hostname(),
      createdAt: createdAt.toISOString(), leaseUntil: new Date(createdAt.getTime() + leaseMs).toISOString(),
    };
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
      return { token, file, release: () => releaseLock(file, token) };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const current = readOwner(file);
    if (current && current.host !== os.hostname()) {
      throw new LockError('lock-held-remote', `项目锁被另一台机器（${current.host}）持有，无法确认其是否仍在运行。`, {
        owner: { host: current.host, pid: current.pid, createdAt: current.createdAt },
        hint: `确认对方已结束后删除 ${file} 再重试。`,
      });
    }
    if (isStale(current, file)) {
      // 原子改名抢占残留锁：并发的两个清理者只有一个能成功，另一个拿到 ENOENT 后重新竞争。
      try { fs.renameSync(file, `${file}.${token}.stale`); fs.rmSync(`${file}.${token}.stale`, { force: true }); } catch (_) { /* 别人先清理了 */ }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new LockError('lock-timeout', `等待项目锁超时（${timeoutMs}ms），另一个 manual 命令正在提交。`, {
        owner: current ? { host: current.host, pid: current.pid, createdAt: current.createdAt } : null,
      });
    }
    sleepSync(POLL_MS);
  }
}

/** 只有持有者能释放；token 不符返回 false 且不动文件。 */
function releaseLock(file, token) {
  const owner = readOwner(file);
  if (!owner || owner.token !== token) return false;
  fs.rmSync(file, { force: true });
  return true;
}

function withLock(stateDirAbs, fn, options) {
  const lock = acquireLock(stateDirAbs, options);
  try {
    return fn(lock);
  } finally {
    lock.release();
  }
}

module.exports = { acquireLock, releaseLock, withLock, lockFileFor, isStale, LockError, DEFAULT_LEASE_MS };
