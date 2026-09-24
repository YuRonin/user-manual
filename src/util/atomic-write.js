'use strict';

/*
 * 单文件原子替换：同目录唯一 temp → 独占创建 → 写入 → fsync → rename。
 *
 * - 失败只清理自己创建的 temp，绝不先删目标再 rename；旧文件字节保持不变。
 * - temp 名含 pid 与随机数，并发写入不会撞上固定的 .tmp。
 * - Windows 上目标被占用时 rename 失败，返回 file-busy。
 * 多文件之间的一致性不在这里保证（见 P1-07 发布 journal）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

class AtomicWriteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AtomicWriteError';
    this.code = code;
    Object.assign(this, details);
  }
}

function tempPathFor(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

/**
 * @param {string} file
 * @param {string|Buffer} content
 * @param {{ fsImpl?: typeof fs, mode?: number, renameRetries?: number }} [options]
 * @returns {string} file
 */
function writeFileAtomic(file, content, { fsImpl = fs, mode = 0o644, renameRetries = 2 } = {}) {
  const dir = path.dirname(file);
  fsImpl.mkdirSync(dir, { recursive: true });
  const temp = tempPathFor(file);
  let fd = null;
  try {
    fd = fsImpl.openSync(temp, 'wx', mode);
    fsImpl.writeFileSync(fd, content);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
  } catch (error) {
    cleanup(fsImpl, fd, temp);
    throw new AtomicWriteError('write-failed', `写入临时文件失败: ${file}（${error.code || error.message}）`, { path: file, cause: error });
  }

  // Windows 上杀毒/索引进程可能短暂占用目标，重试有限次后报 file-busy。
  for (let attempt = 0; ; attempt++) {
    try {
      fsImpl.renameSync(temp, file);
      break;
    } catch (error) {
      if (BUSY_CODES.has(error.code) && attempt < renameRetries) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        continue;
      }
      cleanup(fsImpl, null, temp);
      const code = BUSY_CODES.has(error.code) ? 'file-busy' : 'write-failed';
      throw new AtomicWriteError(code, `替换目标文件失败（${code}）: ${file}`, { path: file, cause: error });
    }
  }
  syncDirectory(fsImpl, dir);
  return file;
}

function cleanup(fsImpl, fd, temp) {
  if (fd != null) { try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ } }
  try { if (fsImpl.existsSync(temp)) fsImpl.unlinkSync(temp); } catch (_) { /* best effort */ }
}

/** POSIX 上 fsync 目录让 rename 持久化；Windows 不支持打开目录，忽略。 */
function syncDirectory(fsImpl, dir) {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    fd = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(fd);
  } catch (_) { /* best effort */ } finally {
    if (fd != null) { try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ } }
  }
}

module.exports = { writeFileAtomic, AtomicWriteError, tempPathFor };
