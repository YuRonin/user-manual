'use strict';

/*
 * 模型快照与 current 指针（契约 C02）。
 *
 *   .manual/snapshots/<hex>.json   一次提交的完整模型（页面、任务、项目元信息），写入后不再修改
 *   .manual/current.json           { revision, modelRevision, parent, updatedAt, materialized }
 *
 * 两种 revision：
 *   revision       整个模型内容（含观察投影）的 hash，用作快照文件名；
 *   modelRevision  只含定义与决策（页面定义、分析状态、任务定义与审批）的 hash，用于 CAS：
 *                  截图、采集结果这类观察不改变它，所以 capture 不会与 describe 互相冲突。
 */

const fs = require('fs');
const path = require('path');

const { revision, pickDefinitionFields } = require('../model/revision');
const { writeFileAtomic } = require('../util/atomic-write');

const SNAPSHOT_SCHEMA_VERSION = 1;

class SnapshotError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SnapshotError';
    this.code = code;
  }
}

/** 统一成纯 JSON（YAML 里的时间戳会被解析成 Date）。 */
function toJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function metaForRevision(meta = {}) {
  const { generatedAt, ...rest } = meta || {};
  return rest;
}

function byId(list) {
  return Object.fromEntries([...(list || [])].sort((a, b) => String(a.id).localeCompare(String(b.id))).map((item) => [item.id, item]));
}

/** 定义与决策部分的 revision。 */
function modelRevisionOf(model) {
  const pages = {};
  for (const page of model.pages || []) {
    pages[page.id] = {
      definition: pickDefinitionFields('page', page),
      lifecycle: page.lifecycle || 'active',
      sourceAnalysis: page.status?.sourceAnalysis ?? null,
      sourceRevision: page.analysis?.sourceRevision ?? null,
    };
  }
  const tasks = {};
  for (const task of model.tasks || []) {
    tasks[task.id] = { definition: pickDefinitionFields('userTask', task), approval: task.approval ?? null };
  }
  return revision(toJson({ meta: metaForRevision(model.meta), pages, tasks }));
}

/** 完整内容的 revision（快照名）。 */
function contentRevisionOf(model) {
  return revision(toJson({ meta: metaForRevision(model.meta), pages: byId(model.pages), tasks: byId(model.tasks) }));
}

function hexOf(rev) {
  return String(rev).replace(/^sha256:/, '');
}

function snapshotFileFor(stateDirAbs, rev) {
  return path.join(stateDirAbs, 'snapshots', `${hexOf(rev)}.json`);
}

function pointerFileFor(stateDirAbs) {
  return path.join(stateDirAbs, 'current.json');
}

/** 写不可变快照；已存在时校验内容一致（相同 revision 不同内容说明被篡改）。 */
function writeSnapshot(stateDirAbs, model, { parent = null } = {}) {
  const rev = contentRevisionOf(model);
  const file = snapshotFileFor(stateDirAbs, rev);
  if (fs.existsSync(file)) {
    const existing = readSnapshot(stateDirAbs, rev);
    if (contentRevisionOf(existing.model) !== rev) throw new SnapshotError('snapshot-corrupt', `快照 ${hexOf(rev)} 内容与名称不符。`);
    return { revision: rev, modelRevision: existing.modelRevision, file, reused: true };
  }
  const modelRevision = modelRevisionOf(model);
  const body = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, revision: rev, modelRevision, parent, createdAt: new Date().toISOString(), model: toJson(model) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(body, null, 2) + '\n');
  return { revision: rev, modelRevision, file, reused: false };
}

function readSnapshot(stateDirAbs, rev) {
  const file = snapshotFileFor(stateDirAbs, rev);
  if (!fs.existsSync(file)) throw new SnapshotError('snapshot-missing', `current 指向的快照不存在: ${hexOf(rev)}`);
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (body.schemaVersion > SNAPSHOT_SCHEMA_VERSION) throw new SnapshotError('schema-too-new', `快照版本 ${body.schemaVersion} 高于本工具支持的 ${SNAPSHOT_SCHEMA_VERSION}。`);
  if (contentRevisionOf(body.model) !== body.revision) throw new SnapshotError('snapshot-corrupt', `快照 ${hexOf(rev)} 内容与名称不符。`);
  return body;
}

function readPointer(stateDirAbs) {
  const file = pointerFileFor(stateDirAbs);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writePointer(stateDirAbs, pointer) {
  writeFileAtomic(pointerFileFor(stateDirAbs), JSON.stringify({ version: 1, ...pointer }, null, 2) + '\n');
}

module.exports = {
  SnapshotError, toJson, modelRevisionOf, contentRevisionOf, writeSnapshot, readSnapshot, readPointer, writePointer,
  snapshotFileFor, pointerFileFor,
};
