'use strict';

/* 确定性序列化与 hash（契约 C01 的最小实现，P1-01 扩展为完整 schema 校验）。 */

const crypto = require('crypto');
const fs = require('fs');

function assertJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON 不接受 NaN/Infinity。');
    return;
  }
  if (typeof value !== 'object') throw new TypeError(`canonical JSON 不接受 ${typeof value}。`);
  if (seen.has(value)) throw new TypeError('canonical JSON 不接受循环引用。');
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) assertJsonValue(item, seen);
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

module.exports = { canonical, sha256Hex, fileSha256, revisionOf };
