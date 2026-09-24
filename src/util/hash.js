'use strict';

/* 确定性序列化与 hash（契约 C01）。定义字段的挑选见 src/model/revision.js。 */

const crypto = require('crypto');
const fs = require('fs');

function invalid(message, path) {
  const error = new TypeError(`invalid-json-value: ${message}${path ? `（位置 ${path}）` : ''}`);
  error.code = 'invalid-json-value';
  error.path = path || '$';
  return error;
}

function assertJsonValue(value, path = '$', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('不接受 NaN/Infinity', path);
    return;
  }
  if (typeof value !== 'object') throw invalid(`不接受 ${typeof value}`, path);
  if (seen.has(value)) throw invalid('不接受循环引用', path);
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    throw invalid(`不接受 ${value.constructor?.name || '非普通'} 对象`, path);
  }
  seen.add(value);
  if (Array.isArray(value)) value.forEach((item, i) => assertJsonValue(item, `${path}[${i}]`, seen));
  else for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`, seen);
  seen.delete(value);
}

function canonical(value) {
  assertJsonValue(value);
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(walk).join(',') + ']';
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + walk(v[k])).join(',') + '}';
  };
  return walk(value);
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function fileSha256(file) {
  return sha256Hex(fs.readFileSync(file));
}

function revisionOf(value) {
  return `sha256:${sha256Hex(canonical(value))}`;
}

module.exports = { canonical, assertJsonValue, sha256Hex, fileSha256, revisionOf };
