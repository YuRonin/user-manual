'use strict';

const fs = require('fs');
const path = require('path');

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

module.exports = {
  readIndexes,
  findForwardPage,
};
