'use strict';

const fs = require('fs');
const path = require('path');

const { revisionOf } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readIndexes(stateDirAbs) {
  const forwardFile = path.join(stateDirAbs, 'index', 'forward.json');
  const reverseFile = path.join(stateDirAbs, 'index', 'reverse.json');
  if (!fs.existsSync(forwardFile) || !fs.existsSync(reverseFile)) {
    return { ok: false, warning: '.manual/index 索引不存在，将回退页面模型。' };
  }
  try {
    const forward = JSON.parse(fs.readFileSync(forwardFile, 'utf8'));
    const reverse = JSON.parse(fs.readFileSync(reverseFile, 'utf8'));
    if (!isPlainObject(forward) || !isPlainObject(reverse)) {
      return { ok: false, warning: '.manual/index 索引格式无效，将回退页面模型。' };
    }
    // 能解析不等于可用：索引必须由当前已提交模型派生（revision 与文件 hash 都对得上）
    const status = require('../store/project').indexStatus(stateDirAbs);
    if (!status.ok) {
      return { ok: false, stale: true, warning: `.manual/index 索引与当前提交不一致（${status.reason}），将回退页面模型。` };
    }
    return { ok: true, forward, reverse, revision: status.revision };
  } catch (error) {
    return {
      ok: false,
      warning: `.manual/index 索引解析失败，将回退页面模型: ${error.message}`,
    };
  }
}

function findForwardPage(forward, { id, route }) {
  if (!isPlainObject(forward)) return null;
  if (route && isPlainObject(forward[route])) return forward[route];
  for (const info of Object.values(forward)) {
    if (isPlainObject(info) && info.id === id) return info;
  }
  return null;
}

/*
 * 源码图快照（P3-01）：graph.json 只保存最近一次扫描；每次扫描同时按内容寻址保存一份不可变快照，
 * release 记录其 graphRevision，之后 update 能取回"发布时的依赖图"做旧新 union 查询。
 * revision 不含 generatedAt：源码没变时重复扫描得到同一个快照。
 */
function graphsDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'index', 'graphs');
}

function graphRevisionOf(graph) {
  const { generatedAt: _ignored, ...content } = graph || {};
  return revisionOf(content);
}

function graphSnapshotFileFor(stateDirAbs, graphRevision) {
  const hex = String(graphRevision || '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`invalid-graph-revision: ${graphRevision}`);
  return path.join(graphsDirFor(stateDirAbs), `${hex}.json`);
}

/** 写入不可变图快照；已存在则不重写。返回 graphRevision。 */
function writeGraphSnapshot(stateDirAbs, graph) {
  const graphRevision = graphRevisionOf(graph);
  const file = graphSnapshotFileFor(stateDirAbs, graphRevision);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(graph, null, 2) + '\n');
  }
  return graphRevision;
}

/** 读取图快照并校验内容与 revision 一致；缺失返回 null，被篡改抛错。 */
function readGraphSnapshot(stateDirAbs, graphRevision) {
  let file;
  try { file = graphSnapshotFileFor(stateDirAbs, graphRevision); } catch (_) { return null; }
  if (!fs.existsSync(file)) return null;
  const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (graphRevisionOf(graph) !== graphRevision) {
    const error = new Error(`图快照 ${path.basename(file)} 内容与 revision 不一致。`);
    error.code = 'graph-snapshot-corrupt';
    throw error;
  }
  return graph;
}

/** 最近一次 inspect 的源码图（graph.json）；不存在返回 null。 */
function readCurrentGraph(stateDirAbs) {
  const file = path.join(stateDirAbs, 'index', 'graph.json');
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; } catch (_) { return null; }
}

module.exports = {
  readIndexes,
  findForwardPage,
  graphsDirFor,
  graphRevisionOf,
  graphSnapshotFileFor,
  writeGraphSnapshot,
  readGraphSnapshot,
  readCurrentGraph,
};
