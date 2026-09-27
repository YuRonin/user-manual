'use strict';

/*
 * 四类缓存 key（契约 C09）。
 *
 *   sourceKey   = H(文件字节 hash + 依赖集合 + resolver 版本 + 框架配置)
 *   captureKey  = H(项目 + 环境 + 部署 build + Scenario revision + checkpoint + sourceHash + 身份 revision
 *                   + 数据 revision + viewport/DPR/locale/timezone + 浏览器/平台 + 截图模式 + 就绪策略)
 *   imageKey    = H(rawHash + geometryHash + 隐私规则 revision + 标注主题 + 渲染器版本)
 *   manualKey   = H(factsHash + 产物 hash + 语言 + 模板/文风版本 + 生成器版本)
 *
 * 每类 key 只取白名单字段：多传的字段（例如 Cookie 值）被丢弃，不会进入 key 或缓存索引。
 * 必填字段缺失直接拒绝；允许"不知道"的字段（部署 build、数据 revision 等）缺失时记为 'unknown'
 * 并写进 uncertainty，不能用空字符串假装确定。
 */

const { revisionOf } = require('../util/hash');
const { RuntimeError } = require('../runtime/errors');

const UNKNOWN = 'unknown';

const SPECS = {
  source: {
    required: ['fileHashes', 'resolverVersion'],
    optional: ['dependencies', 'frameworkConfig'],
    uncertain: [],
  },
  capture: {
    required: ['projectId', 'scenarioId', 'scenarioRevision', 'checkpoint', 'viewport', 'dpr', 'browser', 'captureMode', 'readinessPolicy'],
    optional: ['sourceHash', 'locale', 'timezone', 'platform', 'identityRevision'],
    // 缺失时不阻止生成 key，但必须显式记录不确定性（C09）。
    uncertain: ['environment', 'deployedBuild', 'dataRevision'],
  },
  image: {
    required: ['rawHash', 'geometryHash', 'privacyRevision', 'annotationTheme', 'rendererVersion'],
    optional: [],
    uncertain: [],
  },
  manual: {
    required: ['factsHash', 'artifactHashes', 'language', 'templateVersion', 'generatorVersion'],
    optional: ['styleVersion'],
    uncertain: [],
  },
};

const KINDS = Object.keys(SPECS);

function present(value) {
  return value !== undefined && value !== null && value !== '';
}

/**
 * @param {'source'|'capture'|'image'|'manual'} kind
 * @param {object} fields
 * @returns {{ kind, key, input, uncertainty: string[] }}
 */
function buildKey(kind, fields = {}) {
  const spec = SPECS[kind];
  if (!spec) throw new RuntimeError('invalid-cache-input', `未知缓存类型: ${kind}`);
  const missing = spec.required.filter((field) => !present(fields[field]));
  if (missing.length > 0) {
    throw new RuntimeError('invalid-cache-input', `${kind} 缓存 key 缺少必填字段: ${missing.join(', ')}`, { missing });
  }
  const input = {};
  for (const field of [...spec.required, ...spec.optional]) {
    if (present(fields[field])) input[field] = fields[field];
  }
  const uncertainty = [];
  for (const field of spec.uncertain) {
    if (present(fields[field]) && fields[field] !== UNKNOWN) input[field] = fields[field];
    else { input[field] = UNKNOWN; uncertainty.push(field); }
  }
  if (kind === 'source' && Array.isArray(input.dependencies)) input.dependencies = [...input.dependencies].sort();
  if (kind === 'manual' && Array.isArray(input.artifactHashes)) input.artifactHashes = [...input.artifactHashes].sort();
  return { kind, key: revisionOf({ kind, ...input }), input, uncertainty };
}

const sourceKey = (fields) => buildKey('source', fields);
const captureKey = (fields) => buildKey('capture', fields);
const imageKey = (fields) => buildKey('image', fields);
const manualKey = (fields) => buildKey('manual', fields);

/** 两份 key 输入之间变化的字段（用于 miss 解释）。 */
function changedFields(before = {}, after = {}) {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter((field) => revisionOf({ v: before[field] ?? null }) !== revisionOf({ v: after[field] ?? null })).sort();
}

module.exports = { KINDS, SPECS, UNKNOWN, buildKey, sourceKey, captureKey, imageKey, manualKey, changedFields };
