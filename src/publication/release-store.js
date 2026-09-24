'use strict';

/*
 * 发布记录（契约 C10）：正式文档本身不承担唯一历史记录职责。
 *
 *   .manual/releases/<manualId>/<releaseId>.json   一次发布：文档 hash、facts（含事实包）、Capture、
 *                                                  定义 revision、图片 hash、语言 / 模板版本；写入后不改
 *   .manual/releases/<manualId>/current.json       当前发布指针（最后更新）
 *
 * verify 读取当前发布记录里的 facts，而不是可变的 drafts：草稿删了，已发布文档仍可检查。
 */

const fs = require('fs');
const path = require('path');

const { writeFileAtomic } = require('../util/atomic-write');
const { validateRelease } = require('../model/schema');
const { isSafeId, isUuid } = require('../model/ids');

class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReleaseError';
    this.code = code;
  }
}

function releasesDirFor(stateDirAbs, manualId) {
  if (!isSafeId(manualId)) throw new ReleaseError('invalid-manual-id', `manualId 非法: ${manualId}`);
  return path.join(stateDirAbs, 'releases', manualId);
}

function releaseFileFor(stateDirAbs, manualId, releaseId) {
  if (!isUuid(releaseId)) throw new ReleaseError('invalid-release-id', `releaseId 需要是 UUID: ${releaseId}`);
  return path.join(releasesDirFor(stateDirAbs, manualId), `${releaseId}.json`);
}

/** 任务与页面的 manualId 带类型前缀，避免同名页面与任务共用发布历史。 */
function manualIdFor(kind, id) {
  return `${kind}-${id}`;
}

/** 写不可变发布记录；同 id 已存在时内容必须一致（恢复时可重复调用）。 */
function writeRelease(stateDirAbs, release) {
  const checked = validateRelease(release);
  if (!checked.ok) throw new ReleaseError('invalid-release', `发布记录不完整: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('；')}`);
  const file = releaseFileFor(stateDirAbs, release.manualId, release.id);
  const text = JSON.stringify(release, null, 2) + '\n';
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== text) throw new ReleaseError('immutable-conflict', `发布记录 ${release.id} 已存在且内容不同。`);
    return { file, reused: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
  return { file, reused: false };
}

function readRelease(stateDirAbs, manualId, releaseId) {
  const file = releaseFileFor(stateDirAbs, manualId, releaseId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readCurrentPointer(stateDirAbs, manualId) {
  const file = path.join(releasesDirFor(stateDirAbs, manualId), 'current.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function setCurrent(stateDirAbs, release) {
  const file = path.join(releasesDirFor(stateDirAbs, release.manualId), 'current.json');
  writeFileAtomic(file, JSON.stringify({ version: 1, releaseId: release.id, documentPath: release.documentPath, documentHash: release.documentHash, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

/** 当前发布记录；没有发布过返回 null。 */
function readCurrentRelease(stateDirAbs, manualId) {
  const pointer = readCurrentPointer(stateDirAbs, manualId);
  return pointer ? readRelease(stateDirAbs, manualId, pointer.releaseId) : null;
}

function listReleases(stateDirAbs, manualId) {
  const dir = releasesDirFor(stateDirAbs, manualId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'current.json').map((name) => name.slice(0, -5));
}

module.exports = { ReleaseError, manualIdFor, releasesDirFor, releaseFileFor, writeRelease, readRelease, readCurrentPointer, readCurrentRelease, setCurrent, listReleases };
