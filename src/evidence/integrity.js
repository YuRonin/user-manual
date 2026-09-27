'use strict';

/*
 * Capture 完整性检查：记录里的每个产物都还在、字节数和 sha256 都对得上。
 *
 * 只读文件计算 hash，报告里只出现产物类型、项目相对路径和错误码，不读取或打印
 * 图片内容、URL 查询参数等敏感信息。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex } = require('../util/hash');
const { isProjectRelativePath } = require('../model/schema');

/**
 * @returns {{ ok: boolean, problems: Array<{ kind, path, code }> }}
 *   code = artifact-missing / size-mismatch / hash-mismatch / invalid-artifact-path
 */
function verifyCaptureRecord(projectRoot, record, { kinds = null } = {}) {
  const problems = [];
  for (const artifact of record?.artifacts || []) {
    if (kinds && !kinds.includes(artifact.kind)) continue;
    if (!isProjectRelativePath(artifact.path)) {
      problems.push({ kind: artifact.kind, path: artifact.path, code: 'invalid-artifact-path' });
      continue;
    }
    const file = path.join(projectRoot, artifact.path);
    if (!fs.existsSync(file)) {
      problems.push({ kind: artifact.kind, path: artifact.path, code: 'artifact-missing' });
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (Number.isInteger(artifact.bytes) && bytes.length !== artifact.bytes) {
      problems.push({ kind: artifact.kind, path: artifact.path, code: 'size-mismatch' });
      continue;
    }
    if (sha256Hex(bytes) !== String(artifact.sha256).replace(/^sha256:/, '')) {
      problems.push({ kind: artifact.kind, path: artifact.path, code: 'hash-mismatch' });
    }
  }
  return { ok: problems.length === 0, problems };
}

const CACHE_REQUIRED = ['id', 'observedAt', 'inputHash', 'modelRevision', 'spec', 'privacy', 'validations', 'artifacts'];

/** 记录缺少关键字段时不能成为 cache candidate（Phase 2 cache 只复用完整记录）。 */
function cacheCandidacy(record) {
  const missing = CACHE_REQUIRED.filter((field) => {
    const value = record?.[field];
    if (value === undefined || value === null) return true;
    if (Array.isArray(value)) return value.length === 0;
    return false;
  });
  if (record?.privacy && !record.privacy.status) missing.push('privacy.status');
  return { ok: missing.length === 0, missing };
}

/** 一条 validation 数组里某 scope 是否全部通过（至少一条）。一个 scope 通过不推导其他 scope。 */
function scopePassed(record, scope) {
  const items = (record?.validations || []).filter((v) => v.scope === scope);
  return items.length > 0 && items.every((v) => v.outcome === 'passed');
}

/** 给用户看的简短描述。 */
function describeProblems(problems) {
  return problems.map((p) => `${p.code}: ${p.kind} ${p.path}`);
}

/**
 * 校验 Run 输出 / 缓存 entry 中的不可变引用（Run Store 与缓存共用）：
 *   file / request  项目相对路径、文件存在、sha256 一致
 *   capture         Capture 记录存在且全部产物完整
 *   release         发布记录存在（ref = <manualId>/<releaseId>）
 *   value           纯值结果，只要求带 sha256
 * @returns {Array<{ code, ref?, path?, message? }>} 空数组表示全部通过
 */
function verifyOutputRefs(projectRoot, stateDirAbs, refs) {
  // 延迟加载：evidence/store 与发布记录模块在这里只是读取方。
  const { createCaptureStore } = require('./store');
  const { readRelease } = require('../publication/release-store');
  const { isUuid, isSafeId } = require('../model/ids');
  const problems = [];
  for (const ref of refs || []) {
    if (ref.kind === 'file' || ref.kind === 'request') {
      if (!isProjectRelativePath(ref.ref)) { problems.push({ code: 'invalid-output', ref: ref.ref, message: '需要是项目根相对路径。' }); continue; }
      const file = path.join(projectRoot, ref.ref);
      if (!fs.existsSync(file)) { problems.push({ code: 'artifact-missing', ref: ref.ref }); continue; }
      if (typeof ref.sha256 !== 'string') { problems.push({ code: 'invalid-output', ref: ref.ref, message: '文件引用需要 sha256。' }); continue; }
      if (sha256Hex(fs.readFileSync(file)) !== ref.sha256.replace(/^sha256:/, '')) problems.push({ code: 'hash-mismatch', ref: ref.ref });
    } else if (ref.kind === 'capture') {
      let record = null;
      try { record = createCaptureStore({ projectRoot, stateDirAbs }).read(ref.ref); } catch (_) { record = null; }
      if (!record) { problems.push({ code: 'artifact-missing', ref: ref.ref, message: 'Capture 记录不存在或无效。' }); continue; }
      for (const problem of verifyCaptureRecord(projectRoot, record).problems) problems.push({ code: problem.code, ref: ref.ref, path: problem.path });
    } else if (ref.kind === 'release') {
      const [manualId, releaseId] = String(ref.ref).split('/');
      if (!isSafeId(manualId) || !isUuid(releaseId) || !readRelease(stateDirAbs, manualId, releaseId)) problems.push({ code: 'artifact-missing', ref: ref.ref, message: '发布记录不存在。' });
    } else if (ref.kind === 'value') {
      if (typeof ref.sha256 !== 'string') problems.push({ code: 'invalid-output', message: 'value 引用需要 sha256。' });
    } else {
      problems.push({ code: 'invalid-output', ref: ref.ref, message: `未知引用类型: ${ref.kind}` });
    }
  }
  return problems;
}

module.exports = { verifyCaptureRecord, verifyOutputRefs, cacheCandidacy, scopePassed, describeProblems };
