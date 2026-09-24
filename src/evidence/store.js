'use strict';

/*
 * 不可变 Capture Store（契约 C02 / C04）。
 *
 * 目录（均在 stateDir 下，发布图除外）：
 *   evidence/staging/<captureId>/   采集中的临时文件；生成器永远不读这里
 *   evidence/captures/<captureId>.json  已提交的记录，写入后不再修改
 *   evidence/latest.json            "当前引用"：key → captureId，可以随新观察更新
 * 产物按内容寻址安装到配置的目录：<dir>/<prefix>--<sha256 前 16 位>.<ext>。
 *
 * 提交顺序固定：所有产物校验并安装 → 完整记录原子可见 → latest 引用更新。
 * 中途失败时记录不存在，已安装的内容寻址文件只是无主对象，不会被当成证据。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { newUuid, isUuid } = require('../model/ids');
const { validateCapture, isProjectRelativePath } = require('../model/schema');

const CAPTURE_SCHEMA_VERSION = 1;

class CaptureStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CaptureStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function evidenceDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'evidence');
}

function recordFileFor(stateDirAbs, captureId) {
  if (!isUuid(captureId)) throw new CaptureStoreError('invalid-capture-id', `Capture id 需要是 UUID: ${captureId}`);
  return path.join(evidenceDirFor(stateDirAbs), 'captures', `${captureId}.json`);
}

/** PNG 的 IHDR 宽高；其它格式返回 null（仍校验 hash 与字节数）。 */
function imageSize(bytes) {
  const signature = '89504e470d0a1a0a';
  if (bytes.length >= 24 && bytes.subarray(0, 8).toString('hex') === signature) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return null;
}

/** 只保留 origin + pathname：Capture 记录不能带查询参数或 hash 中的敏感值。 */
function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return { origin: parsed.origin, pathname: parsed.pathname };
  } catch (_) {
    return null;
  }
}

function toPosix(p) {
  return p.replace(/\\/g, '/');
}

function createCaptureStore({ projectRoot, stateDirAbs }) {
  const evidenceDir = evidenceDirFor(stateDirAbs);
  const stagingRoot = path.join(evidenceDir, 'staging');
  const latestFile = path.join(evidenceDir, 'latest.json');

  /** 开始一次采集：分配唯一 captureId 与私有 staging 目录。 */
  function begin() {
    const captureId = newUuid();
    const stagingDir = path.join(stagingRoot, captureId);
    fs.mkdirSync(stagingDir, { recursive: true });
    return { captureId, stagingDir, file: (name) => path.join(stagingDir, name) };
  }

  function abort(handle) {
    if (handle?.stagingDir) fs.rmSync(handle.stagingDir, { recursive: true, force: true });
  }

  /** 按内容安装一个产物；已存在则校验字节后复用，同名不同内容报 immutable-conflict。 */
  function install(bytes, sha, { dir, prefix, ext }) {
    const relative = toPosix(path.posix.join(toPosix(dir), `${prefix}--${sha.slice(0, 16)}${ext}`));
    if (!isProjectRelativePath(relative)) {
      throw new CaptureStoreError('invalid-artifact-path', `产物目录需要在项目根内: ${dir}`);
    }
    const target = path.join(projectRoot, relative);
    if (fs.existsSync(target)) {
      const existing = sha256Hex(fs.readFileSync(target));
      if (existing !== sha) {
        throw new CaptureStoreError('immutable-conflict', `产物 ${relative} 已存在且内容不同，拒绝覆盖。`, { path: relative });
      }
      return { path: relative, reused: true };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeFileAtomic(target, bytes);
    return { path: relative, reused: false };
  }

  /**
   * 提交一次采集。
   * @param handle  begin() 的返回值
   * @param {object} p
   * @param {object} p.record     记录主体（不含 id / artifacts / schemaVersion）
   * @param {Array<{kind, file, dir, prefix}>} p.artifacts  staging 中的文件及其安装位置
   * @returns 已提交的完整记录
   */
  function commit(handle, { record, artifacts }) {
    if (!handle || !fs.existsSync(handle.stagingDir)) {
      throw new CaptureStoreError('capture-not-staged', 'staging 目录不存在，无法提交。');
    }
    const recordFile = recordFileFor(stateDirAbs, handle.captureId);
    if (fs.existsSync(recordFile)) {
      throw new CaptureStoreError('immutable-conflict', `Capture ${handle.captureId} 已提交过，记录不可修改。`);
    }

    // 1. 先校验全部文件，再安装任何一个：缺文件或空文件时整次提交失败。
    const checked = artifacts.map((artifact) => {
      const stagingFile = path.resolve(artifact.file);
      if (!stagingFile.startsWith(path.resolve(handle.stagingDir) + path.sep)) {
        throw new CaptureStoreError('invalid-artifact-path', `产物必须来自本次 staging 目录: ${artifact.kind}`);
      }
      if (!fs.existsSync(stagingFile)) throw new CaptureStoreError('capture-incomplete', `staging 中缺少 ${artifact.kind} 产物。`);
      const bytes = fs.readFileSync(stagingFile);
      if (bytes.length === 0) throw new CaptureStoreError('capture-incomplete', `${artifact.kind} 产物为空文件。`);
      const ext = path.extname(stagingFile).toLowerCase() || '.bin';
      const size = imageSize(bytes);
      if (ext === '.png' && !size) throw new CaptureStoreError('capture-incomplete', `${artifact.kind} 不是完整的 PNG。`);
      return { artifact, bytes, sha: sha256Hex(bytes), ext, size };
    });

    // 2. 安装产物（内容寻址，不覆盖旧文件）。
    const installed = checked.map(({ artifact, bytes, sha, ext, size }) => {
      const { path: artifactPath, reused } = install(bytes, sha, { dir: artifact.dir, prefix: artifact.prefix, ext });
      return {
        kind: artifact.kind,
        path: artifactPath,
        sha256: sha,
        bytes: bytes.length,
        ...(size ? { width: size.width, height: size.height } : {}),
        ...(reused ? { reused: true } : {}),
      };
    });

    // 3. 完整记录校验后原子写入；此刻记录才可被生成器看到。
    const full = { schemaVersion: CAPTURE_SCHEMA_VERSION, id: handle.captureId, ...record, artifacts: installed };
    const validation = validateCapture(full);
    if (!validation.ok) {
      throw new CaptureStoreError('invalid-capture-record', `Capture 记录不完整: ${validation.errors.map((e) => `${e.path} ${e.message}`).join('；')}`);
    }
    fs.mkdirSync(path.dirname(recordFile), { recursive: true });
    writeFileAtomic(recordFile, JSON.stringify(full, null, 2) + '\n');
    abort(handle);
    return full;
  }

  function read(captureId) {
    const file = recordFileFor(stateDirAbs, captureId);
    if (!fs.existsSync(file)) return null;
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    const validation = validateCapture(record);
    if (!validation.ok) {
      throw new CaptureStoreError('invalid-capture-record', `Capture ${captureId} 记录无效: ${validation.errors.map((e) => e.path).join(', ')}`);
    }
    return record;
  }

  function list() {
    const dir = path.join(evidenceDir, 'captures');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).filter(isUuid).sort();
  }

  function readLatest() {
    if (!fs.existsSync(latestFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
    return parsed && typeof parsed.refs === 'object' ? parsed.refs : {};
  }

  /** 记录提交之后才更新当前引用；引用的记录必须已经存在。 */
  function setLatest(entries) {
    for (const captureId of Object.values(entries)) {
      if (!fs.existsSync(recordFileFor(stateDirAbs, captureId))) {
        throw new CaptureStoreError('capture-not-committed', `不能引用尚未提交的 Capture: ${captureId}`);
      }
    }
    const refs = { ...readLatest(), ...entries };
    fs.mkdirSync(evidenceDir, { recursive: true });
    writeFileAtomic(latestFile, JSON.stringify({ version: 1, refs }, null, 2) + '\n');
    return refs;
  }

  /**
   * 迁移专用：为旧版本已存在的产物登记一条记录（不经 staging、不复制文件）。
   * 同 id 已存在且内容相同则复用（重复迁移幂等），不同则 immutable-conflict。
   */
  function importRecord(record) {
    const full = { schemaVersion: CAPTURE_SCHEMA_VERSION, ...record };
    const validation = validateCapture(full);
    if (!validation.ok) {
      throw new CaptureStoreError('invalid-capture-record', `Capture 记录不完整: ${validation.errors.map((e) => `${e.path} ${e.message}`).join('；')}`);
    }
    const file = recordFileFor(stateDirAbs, full.id);
    if (fs.existsSync(file)) {
      if (fs.readFileSync(file, 'utf8') === JSON.stringify(full, null, 2) + '\n') return { record: full, reused: true };
      throw new CaptureStoreError('immutable-conflict', `Capture ${full.id} 已存在且内容不同。`);
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(full, null, 2) + '\n');
    return { record: full, reused: false };
  }

  return { begin, abort, commit, importRecord, read, list, readLatest, setLatest, evidenceDir, stagingRoot };
}

module.exports = { createCaptureStore, CaptureStoreError, sanitizeUrl, imageSize, evidenceDirFor, recordFileFor, CAPTURE_SCHEMA_VERSION };
