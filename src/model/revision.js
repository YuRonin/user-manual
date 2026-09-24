'use strict';

/*
 * 定义 revision（契约 C01）：只对"定义"字段取内容 hash。
 *
 * 实体对象里混着观察（browser、lastCapture）、状态缓存（status、confidence）和派生值
 * （execution）。对整个对象 hash 会让一次截图就改变定义 revision，所以这里显式挑字段：
 * 新增定义字段时必须同时加进白名单，否则它不参与 revision——这是有意的，宁可漏报也
 * 不把观察值误当成定义变化。步骤数组保持顺序；对象键顺序不影响结果。
 */

const { revisionOf } = require('../util/hash');

const DEFINITION_FIELDS = {
  page: [
    'id', 'lifecycle', 'title', 'purpose', 'route', 'dynamic', 'params', 'routeBindings',
    'entry', 'source', 'includeInManual', 'detectedActions', 'states', 'identityAssertions',
  ],
  userTask: [
    'id', 'title', 'goal', 'entryPage', 'priority', 'preconditions', 'risk', 'environment',
    'fixtures', 'steps', 'branches', 'relatedTasks', 'completion',
  ],
  scenario: [
    'id', 'userTaskId', 'environment', 'authProfile', 'data', 'entry', 'expected', 'setup', 'checkpoints',
  ],
};

const STEP_FIELDS = [
  'id', 'instruction', 'page', 'pageId', 'stateBefore', 'stateAfter', 'action', 'risk', 'replay', 'capture', 'valueRef',
];

/** 规范化 JSON 值的 revision。undefined / NaN / 循环引用等抛 invalid-json-value。 */
function revision(value) {
  return revisionOf(value);
}

/** 对象中值为 undefined 的键视为缺省（YAML 往返后本来就不存在）；数组里的 undefined 仍然非法。 */
function dropUndefined(value) {
  if (Array.isArray(value)) return value.map(dropUndefined);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = dropUndefined(item);
  }
  return out;
}

function pick(source, fields) {
  const out = {};
  for (const field of fields) {
    if (source[field] !== undefined) out[field] = source[field];
  }
  return out;
}

function pickDefinitionFields(kind, entity) {
  const fields = DEFINITION_FIELDS[kind];
  if (!fields) throw new Error(`未知实体类型: ${kind}`);
  const picked = pick(entity || {}, fields);
  if (kind === 'userTask' && Array.isArray(picked.steps)) {
    picked.steps = picked.steps.map((step) => (step && typeof step === 'object' ? pick(step, STEP_FIELDS) : step));
  }
  return dropUndefined(picked);
}

function definitionRevision(kind, entity) {
  return revision(pickDefinitionFields(kind, entity));
}

module.exports = { DEFINITION_FIELDS, STEP_FIELDS, revision, pickDefinitionFields, definitionRevision };
