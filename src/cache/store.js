'use strict';

/*
 * 缓存索引：<stateDir>/cache/<kind>/
 *   entries/<keyHex>.json    key → 不可变产物引用、输入摘要、observedAt、验证范围
 *   subjects/<hash>.json     逻辑对象（例如某 Scenario 的某 checkpoint）→ 最近一次写入的 key，
 *                            用于 miss 时解释"哪些输入变了"
 *
 * - 每条 entry 一个文件、原子替换：并发写入不会互相覆盖出半截 JSON。
 * - 只保存引用（Capture id、文件路径 + sha256），不复制图片，不保存凭据。
 * - 缓存可丢弃：损坏的 entry 读取时当作不存在并删除，canonical Capture / 发布记录不受影响。
 * - remove / clear 只删索引，从不删除历史 Capture 与产物。
 */

const fs = require('fs');
const path = require('path');

const { writeFileAtomic } = require('../util/atomic-write');
const { sha256Hex } = require('../util/hash');
const { KINDS } = require('./keys');
const { RuntimeError } = require('../runtime/errors');

const CACHE_ENTRY_VERSION = 1;

function hexOf(key) {
  return String(key).replace(/^sha256:/, '');
}

function createCacheStore({ stateDirAbs, now = () => Date.now() }) {
  const root = path.join(stateDirAbs, 'cache');
  const dirOf = (kind) => {
    if (!KINDS.includes(kind)) throw new RuntimeError('invalid-cache-input', `未知缓存类型: ${kind}`);
    return path.join(root, kind);
  };
  const entryFile = (kind, key) => path.join(dirOf(kind), 'entries', `${hexOf(key)}.json`);
  const subjectFile = (kind, subject) => path.join(dirOf(kind), 'subjects', `${sha256Hex(String(subject))}.json`);

  function readJsonOrDiscard(file) {
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      fs.rmSync(file, { force: true });
      return null;
    }
  }

  function get(kind, key) {
    const entry = readJsonOrDiscard(entryFile(kind, key));
    if (!entry || entry.key !== key || entry.kind !== kind) return null;
    return entry;
  }

  function latestForSubject(kind, subject) {
    const pointer = readJsonOrDiscard(subjectFile(kind, subject));
    if (!pointer?.key) return null;
    return get(kind, pointer.key);
  }

  /**
   * 写入一条 entry。observedAt 是产物实际观察时间（来自 Capture 记录），不是写缓存的时间。
   * @param {{ kind, key, input, subject?, outputRefs, observedAt, validationScopes?, privacy?, uncertainty?, meta? }} entry
   */
  function put(entry) {
    if (!Array.isArray(entry.outputRefs) || entry.outputRefs.length === 0) {
      throw new RuntimeError('invalid-cache-input', '缓存 entry 需要至少一个不可变 outputRef。');
    }
    if (!entry.observedAt || Number.isNaN(Date.parse(entry.observedAt))) {
      throw new RuntimeError('invalid-cache-input', '缓存 entry 需要 observedAt。');
    }
    const record = {
      version: CACHE_ENTRY_VERSION,
      kind: entry.kind,
      key: entry.key,
      subject: entry.subject || null,
      input: entry.input || {},
      outputRefs: entry.outputRefs.map((ref) => ({ ...ref })),
      observedAt: entry.observedAt,
      validationScopes: entry.validationScopes || [],
      privacy: entry.privacy || null,
      // 采集类 entry：发布图与标注覆盖是否通过（failed / unknown 不能作为成功复用）
      annotation: entry.annotation || null,
      uncertainty: entry.uncertainty || [],
      // 不参与 key 的附加说明（例如产生这批发布图时的隐私规则 / 主题 / 渲染器），用于判断是否需要重新派生。
      meta: entry.meta || null,
      recordedAt: new Date(now()).toISOString(),
    };
    const file = entryFile(entry.kind, entry.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(record, null, 2) + '\n');
    if (record.subject) {
      const pointer = subjectFile(entry.kind, record.subject);
      fs.mkdirSync(path.dirname(pointer), { recursive: true });
      writeFileAtomic(pointer, JSON.stringify({ subject: record.subject, key: record.key }) + '\n');
    }
    return record;
  }

  function remove(kind, key) {
    fs.rmSync(entryFile(kind, key), { force: true });
  }

  /** 丢弃整个缓存索引（可重建）；不触碰 Capture、产物和发布记录。 */
  function clear(kind = null) {
    for (const k of kind ? [kind] : KINDS) fs.rmSync(dirOf(k), { recursive: true, force: true });
  }

  return { get, put, remove, clear, latestForSubject, root };
}

module.exports = { createCacheStore, CACHE_ENTRY_VERSION };
