'use strict';

/*
 * 实体 schema（契约 C01 / C03 / C04）。
 *
 * 每个 validateX 返回 { ok, errors: [{ path, code, message }], warnings }，一次收集全部错误。
 * 用普通函数实现，不引入 schema 框架：规则里有跨字段引用（步骤 → 页面状态 → 断言），
 * 用函数写比声明式 schema 更直接。
 *
 * 版本策略：
 *   - 每种实体独立 schemaVersion；缺省视为 1（旧文件没有这个字段）。
 *   - 高于本工具支持的版本 → schema-too-new，拒绝读取，更不能写回。
 *   - 旧版本经 normalizeLegacy 转成内存兼容模型，不自动写回磁盘（写回是迁移的职责）。
 *   - 未知字段给 warning 并原样保留，不静默丢弃用户写的内容。
 */

const { isSafeId, isUuid, isAssertionRef } = require('./ids');

const SCHEMA_VERSIONS = { config: 2, page: 2, userTask: 2, scenario: 1, capture: 1, release: 1 };

const ACTION_TYPES = ['click', 'fill', 'select', 'check', 'uncheck', 'inspect'];
const ASSERTION_TYPES = ['url', 'visible', 'hidden', 'editable'];
const TARGET_KEYS = ['role', 'name', 'label', 'text', 'testId', 'selector', 'exact'];
const RISKS = ['read', 'local', 'write', 'destructive'];
const REPLAYS = ['safe', 'requires-input', 'unsafe'];
const CAPTURE_TIMINGS = ['before', 'after'];
const CAPTURE_MODES = ['viewport', 'fullPage'];
const PAGE_LIFECYCLES = ['active', 'missing', 'excluded', 'retired'];
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected'];
const VALIDATION_OUTCOMES = ['passed', 'failed', 'inconclusive', 'not_run'];
const VALIDATION_SCOPES = ['artifact-integrity', 'auth-identity', 'page-identity', 'scenario-state', 'interaction', 'completion-claim', 'publication'];
const SHA256_RE = /^(sha256:)?[0-9a-f]{64}$/;

const KNOWN_FIELDS = {
  page: ['schemaVersion', 'id', 'revision', 'lifecycle', 'title', 'purpose', 'route', 'dynamic', 'params', 'routeBindings',
    'entry', 'source', 'dependencies', 'includeInManual', 'detectedActions', 'states', 'identityAssertions', 'confidence',
    'browser', 'status', 'analysis', 'latestCaptureId'],
  userTask: ['schemaVersion', 'id', 'revision', 'title', 'goal', 'entryPage', 'priority', 'preconditions', 'risk', 'status',
    'approval', 'environment', 'fixtures', 'steps', 'branches', 'relatedTasks', 'completion', 'evidence', 'evidenceManifest',
    'capturePlan', 'captureIds', 'lastCapture', 'stale', 'lastVerification', 'params', 'authProfile',
    'source', 'discovery', 'generatedAt', 'updatedAt', 'notes', 'history'],
};

// ---------------------------------------------------------------- 基础工具

function collector() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error(path, code, message) { errors.push({ path, code, message }); },
    warn(path, code, message) { warnings.push({ path, code, message }); },
    result(extra = {}) { return { ok: errors.length === 0, errors, warnings, ...extra }; },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** 项目根相对路径：非空、非绝对、无盘符、无 .. 段。 */
function isProjectRelativePath(value) {
  if (!nonEmpty(value)) return false;
  const posix = value.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || /^[a-z][a-z0-9+.-]*:\/\//i.test(posix)) return false;
  return !posix.split('/').some((segment) => segment === '..');
}

function schemaVersionOf(kind, value) {
  if (!isObject(value)) return null;
  const raw = kind === 'config' ? value.version : value.schemaVersion;
  return raw === undefined || raw === null ? 1 : raw;
}

/** 版本检查；返回 { ok, version } 或 { ok:false, code: schema-too-new | invalid-schema-version }。 */
function checkSchemaVersion(kind, value) {
  const max = SCHEMA_VERSIONS[kind];
  if (!max) throw new Error(`未知实体类型: ${kind}`);
  const version = schemaVersionOf(kind, value);
  const field = kind === 'config' ? 'version' : 'schemaVersion';
  if (!Number.isInteger(version) || version < 1) {
    return { ok: false, code: 'invalid-schema-version', path: field, message: `${field} 需要是正整数，收到: ${version}` };
  }
  if (version > max) {
    return { ok: false, code: 'schema-too-new', path: field, message: `${kind} 版本 ${version} 高于当前工具支持的 ${max}，请升级 manual 工具。` };
  }
  return { ok: true, version };
}

function warnUnknown(c, kind, value, base = '') {
  const known = new Set(KNOWN_FIELDS[kind] || []);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) c.warn(`${base}${key}`, 'unknown-field', `未知字段 ${key} 已保留，但本版本工具不使用它。`);
  }
}

// ---------------------------------------------------------------- 共享片段

function validateTarget(c, target, path) {
  if (!isObject(target)) { c.error(path, 'invalid-target', '需要是语义定位对象。'); return; }
  for (const key of Object.keys(target)) {
    if (!TARGET_KEYS.includes(key)) c.error(`${path}.${key}`, 'invalid-target', `不支持的定位字段 ${key}。`);
  }
  const usable = (nonEmpty(target.role) && nonEmpty(target.name))
    || nonEmpty(target.label) || nonEmpty(target.text) || nonEmpty(target.testId) || nonEmpty(target.selector);
  if (!usable) c.error(path, 'invalid-target', '至少需要一种有效定位：role+name、label、text、testId 或 selector。');
  if (nonEmpty(target.role) && !nonEmpty(target.name) && !usable) c.error(`${path}.name`, 'invalid-target', 'role 定位需要同时给出 name。');
}

function validateAction(c, action, path) {
  if (!isObject(action)) { c.error(path, 'invalid-action', 'action 需要是对象。'); return; }
  if (!ACTION_TYPES.includes(action.type)) {
    c.error(`${path}.type`, 'invalid-action', `action.type 需要是 ${ACTION_TYPES.join(' / ')} 之一，收到: ${action.type}`);
    return;
  }
  if (action.type === 'inspect') {
    if (action.target !== undefined) validateTarget(c, action.target, `${path}.target`);
  } else {
    validateTarget(c, action.target, `${path}.target`);
  }
  if (action.type === 'fill' || action.type === 'select') {
    const hasValue = typeof action.value === 'string' || typeof action.value === 'number'
      || (Array.isArray(action.value) && action.value.every((v) => typeof v === 'string'));
    if (!hasValue && !nonEmpty(action.valueRef)) c.error(path, 'invalid-action', `${action.type} 需要 value 或 valueRef。`);
  }
  if (action.valueRef !== undefined && !nonEmpty(action.valueRef)) c.error(`${path}.valueRef`, 'invalid-action', 'valueRef 需要是非空字符串。');
}

function validateAssertion(c, assertion, path) {
  if (!isObject(assertion)) { c.error(path, 'invalid-assertion', '断言需要是对象。'); return; }
  if (assertion.id !== undefined && !isSafeId(assertion.id)) c.error(`${path}.id`, 'invalid-id', `断言 id 只能使用小写字母、数字和连字符: ${assertion.id}`);
  if (!ASSERTION_TYPES.includes(assertion.type)) {
    c.error(`${path}.type`, 'invalid-assertion', `断言类型需要是 ${ASSERTION_TYPES.join(' / ')} 之一，收到: ${assertion.type}`);
    return;
  }
  if (assertion.type === 'url') {
    if (!nonEmpty(assertion.value)) c.error(`${path}.value`, 'invalid-assertion', 'url 断言需要非空 value。');
  } else {
    validateTarget(c, assertion.target, `${path}.target`);
  }
}

function validateAssertions(c, list, path) {
  if (!Array.isArray(list)) { c.error(path, 'invalid-assertion', '需要是断言数组。'); return; }
  const ids = new Set();
  list.forEach((assertion, index) => {
    validateAssertion(c, assertion, `${path}[${index}]`);
    if (isObject(assertion) && assertion.id !== undefined) {
      if (ids.has(assertion.id)) c.error(`${path}[${index}].id`, 'duplicate-id', `断言 id 重复: ${assertion.id}`);
      ids.add(assertion.id);
    }
  });
}

function validateCaptureSpec(c, capture, path) {
  if (capture === undefined || capture === null) return;
  if (!isObject(capture)) { c.error(path, 'invalid-capture', 'capture 需要是对象。'); return; }
  if (capture.timing !== undefined && !CAPTURE_TIMINGS.includes(capture.timing)) {
    c.error(`${path}.timing`, 'invalid-capture', `capture.timing 需要是 ${CAPTURE_TIMINGS.join(' / ')} 之一。`);
  }
  if (capture.mode !== undefined && !CAPTURE_MODES.includes(capture.mode)) {
    c.error(`${path}.mode`, 'invalid-capture', `capture.mode 需要是 ${CAPTURE_MODES.join(' / ')} 之一。`);
  }
  if (capture.annotations !== undefined) {
    if (!Array.isArray(capture.annotations)) { c.error(`${path}.annotations`, 'invalid-capture', 'annotations 需要是数组。'); return; }
    capture.annotations.forEach((annotation, index) => {
      const where = `${path}.annotations[${index}]`;
      if (!isObject(annotation)) { c.error(where, 'invalid-capture', '标注需要是对象。'); return; }
      if (annotation.rect !== undefined) {
        const r = annotation.rect;
        if (!isObject(r) || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(r[k]))) c.error(`${where}.rect`, 'invalid-capture', 'rect 需要 x/y/width/height 数字。');
      } else if (annotation.target !== 'action.target') {
        validateTarget(c, annotation.target, `${where}.target`);
      }
    });
  }
}

/** 页面状态 id → 断言 id 集合（显式 id 与执行器生成的 <page>:<state>#<index>）。 */
function assertionIdsOfPage(page) {
  const ids = new Set();
  const states = isObject(page?.states) ? page.states : {};
  for (const [stateId, state] of Object.entries(states)) {
    (Array.isArray(state?.assertions) ? state.assertions : []).forEach((assertion, index) => {
      if (assertion?.id) ids.add(assertion.id);
      ids.add(`${page.id}:${stateId}#${index}`);
    });
  }
  for (const assertion of Array.isArray(page?.identityAssertions) ? page.identityAssertions : []) {
    if (assertion?.id) ids.add(assertion.id);
  }
  return ids;
}

// ---------------------------------------------------------------- Page

function validatePage(page) {
  const c = collector();
  if (!isObject(page)) { c.error('$', 'invalid-type', '页面需要是对象。'); return c.result(); }
  const version = checkSchemaVersion('page', page);
  if (!version.ok) { c.error(version.path, version.code, version.message); return c.result(); }
  warnUnknown(c, 'page', page);

  if (!isSafeId(page.id)) c.error('id', 'invalid-id', `页面 id 只能使用小写字母、数字和连字符: ${page.id}`);
  if (!nonEmpty(page.route) || !page.route.startsWith('/')) c.error('route', 'invalid-route', 'route 需要以 / 开头。');
  if (page.entry !== undefined && page.entry !== null && !isProjectRelativePath(page.entry)) c.error('entry', 'invalid-path', `entry 需要是项目根相对路径: ${page.entry}`);
  if (page.source !== undefined) {
    if (!Array.isArray(page.source)) c.error('source', 'invalid-path', 'source 需要是路径数组。');
    else page.source.forEach((item, i) => { if (!isProjectRelativePath(item)) c.error(`source[${i}]`, 'invalid-path', `需要是项目根相对路径: ${item}`); });
  }
  if (page.lifecycle !== undefined && !PAGE_LIFECYCLES.includes(page.lifecycle)) {
    c.error('lifecycle', 'invalid-lifecycle', `lifecycle 需要是 ${PAGE_LIFECYCLES.join(' / ')} 之一。`);
  }
  if (page.routeBindings !== undefined) {
    if (!Array.isArray(page.routeBindings)) c.error('routeBindings', 'invalid-route', 'routeBindings 需要是数组。');
    else {
      const ids = new Set();
      page.routeBindings.forEach((binding, i) => {
        const where = `routeBindings[${i}]`;
        if (!isObject(binding)) { c.error(where, 'invalid-route', '需要是对象。'); return; }
        if (!isSafeId(binding.id)) c.error(`${where}.id`, 'invalid-id', `binding id 非法: ${binding.id}`);
        else if (ids.has(binding.id)) c.error(`${where}.id`, 'duplicate-id', `binding id 重复: ${binding.id}`);
        else ids.add(binding.id);
        if (!nonEmpty(binding.template) || !binding.template.startsWith('/')) c.error(`${where}.template`, 'invalid-route', 'template 需要以 / 开头。');
        for (const [j, file] of (binding.entryFiles || []).entries()) {
          if (!isProjectRelativePath(file)) c.error(`${where}.entryFiles[${j}]`, 'invalid-path', `需要是项目根相对路径: ${file}`);
        }
      });
    }
  }
  if (page.states !== undefined) {
    if (!isObject(page.states)) c.error('states', 'invalid-state', 'states 需要是对象。');
    else {
      for (const [stateId, state] of Object.entries(page.states)) {
        const where = `states.${stateId}`;
        if (!isSafeId(stateId)) c.error(where, 'invalid-id', `状态 id 只能使用小写字母、数字和连字符: ${stateId}`);
        if (!isObject(state)) { c.error(where, 'invalid-state', '状态需要是对象。'); continue; }
        validateAssertions(c, state.assertions || [], `${where}.assertions`);
      }
    }
  }
  if (page.identityAssertions !== undefined) validateAssertions(c, page.identityAssertions, 'identityAssertions');
  return c.result({ version: version.version });
}

// ---------------------------------------------------------------- UserTask

/**
 * @param {object} task
 * @param {{ pages?: object[] }} [context]  提供页面时校验步骤引用的页面、状态和 claim 引用的断言。
 */
function validateUserTask(task, context = {}) {
  const c = collector();
  if (!isObject(task)) { c.error('$', 'invalid-type', '任务需要是对象。'); return c.result(); }
  const version = checkSchemaVersion('userTask', task);
  if (!version.ok) { c.error(version.path, version.code, version.message); return c.result(); }
  warnUnknown(c, 'userTask', task);

  if (!isSafeId(task.id)) c.error('id', 'invalid-id', `任务 id 只能使用小写字母、数字和连字符: ${task.id}`);
  for (const field of ['title', 'goal', 'entryPage']) {
    if (!nonEmpty(task[field])) c.error(field, 'required', `${field} 需要是非空字符串。`);
  }
  if (task.risk !== undefined && !RISKS.includes(task.risk)) c.error('risk', 'invalid-risk', `risk 需要是 ${RISKS.join(' / ')} 之一。`);
  if (task.approval !== undefined && task.approval !== null) {
    if (!isObject(task.approval) || !APPROVAL_STATUSES.includes(task.approval.status)) {
      c.error('approval.status', 'invalid-approval', `approval.status 需要是 ${APPROVAL_STATUSES.join(' / ')} 之一。`);
    }
  }

  const pagesById = Array.isArray(context.pages) ? new Map(context.pages.map((p) => [p.id, p])) : null;
  if (pagesById && nonEmpty(task.entryPage) && !pagesById.has(task.entryPage)) {
    c.error('entryPage', 'missing-reference', `入口页面不存在: ${task.entryPage}`);
  }

  const stepIds = new Set();
  const referencedPages = new Set();
  if (!Array.isArray(task.steps) || task.steps.length === 0) {
    c.error('steps', 'required', 'steps 至少需要一个步骤。');
  } else {
    task.steps.forEach((step, index) => {
      const where = `steps[${index}]`;
      if (!isObject(step)) { c.error(where, 'invalid-step', '步骤需要是对象。'); return; }
      if (!isSafeId(step.id)) c.error(`${where}.id`, 'invalid-id', `stepId 只能使用小写字母、数字和连字符: ${step.id}`);
      else if (stepIds.has(step.id)) c.error(`${where}.id`, 'duplicate-id', `stepId 重复: ${step.id}`);
      else stepIds.add(step.id);
      if (!nonEmpty(step.instruction)) c.error(`${where}.instruction`, 'required', 'instruction 需要是非空字符串。');
      const pageId = step.pageId ?? step.page;
      if (!nonEmpty(pageId)) c.error(`${where}.page`, 'required', '步骤需要所属页面。');
      validateAction(c, step.action, `${where}.action`);
      if (step.risk !== undefined && !RISKS.includes(step.risk)) c.error(`${where}.risk`, 'invalid-risk', `risk 需要是 ${RISKS.join(' / ')} 之一。`);
      if (step.replay !== undefined && !REPLAYS.includes(step.replay)) c.error(`${where}.replay`, 'invalid-replay', `replay 需要是 ${REPLAYS.join(' / ')} 之一。`);
      validateCaptureSpec(c, step.capture, `${where}.capture`);
      if (pagesById && nonEmpty(pageId)) {
        const page = pagesById.get(pageId);
        if (!page) c.error(`${where}.page`, 'missing-reference', `步骤引用不存在的页面: ${pageId}`);
        else {
          referencedPages.add(page);
          const states = { default: true, ...(isObject(page.states) ? page.states : {}) };
          for (const key of ['stateBefore', 'stateAfter']) {
            if (step[key] !== undefined && !states[step[key]]) c.error(`${where}.${key}`, 'missing-reference', `页面 ${pageId} 没有状态 ${step[key]}`);
          }
        }
      }
    });
  }

  const claims = task.completionClaims ?? task.completion?.claims;
  const claimsPath = task.completionClaims !== undefined ? 'completionClaims' : 'completion.claims';
  if (claims !== undefined) {
    if (!Array.isArray(claims)) c.error(claimsPath, 'invalid-claim', '需要是数组。');
    else {
      const knownAssertions = new Set();
      for (const page of referencedPages) for (const id of assertionIdsOfPage(page)) knownAssertions.add(id);
      const seen = new Set();
      claims.forEach((claim, index) => {
        const where = `${claimsPath}[${index}]`;
        if (!isObject(claim)) { c.error(where, 'invalid-claim', '需要是对象。'); return; }
        if (!isSafeId(claim.id)) c.error(`${where}.id`, 'invalid-id', `claim id 只能使用小写字母、数字和连字符: ${claim.id}`);
        else if (seen.has(claim.id)) c.error(`${where}.id`, 'duplicate-id', `claim id 重复: ${claim.id}`);
        else seen.add(claim.id);
        if (!nonEmpty(claim.text)) c.error(`${where}.text`, 'required', 'text 需要是非空字符串。');
        if (!Array.isArray(claim.assertionRefs) || claim.assertionRefs.length === 0) {
          c.error(`${where}.assertionRefs`, 'invalid-claim', '需要是非空的断言 id 数组。');
        } else {
          claim.assertionRefs.forEach((ref, j) => {
            if (!isAssertionRef(ref)) c.error(`${where}.assertionRefs[${j}]`, 'invalid-id', `断言引用非法: ${ref}`);
            else if (pagesById && referencedPages.size > 0 && !knownAssertions.has(ref)) {
              c.error(`${where}.assertionRefs[${j}]`, 'missing-reference', `引用的断言不存在于步骤涉及的页面: ${ref}`);
            }
          });
        }
        if (claim.checkpoint !== undefined && !stepIds.has(claim.checkpoint)) {
          c.error(`${where}.checkpoint`, 'missing-reference', `checkpoint 需要是本任务的 stepId: ${claim.checkpoint}`);
        }
      });
    }
  }
  return c.result({ version: version.version });
}

// ---------------------------------------------------------------- Scenario

function validateScenario(scenario, context = {}) {
  const c = collector();
  if (!isObject(scenario)) { c.error('$', 'invalid-type', 'Scenario 需要是对象。'); return c.result(); }
  const version = checkSchemaVersion('scenario', scenario);
  if (!version.ok) { c.error(version.path, version.code, version.message); return c.result(); }

  if (!isSafeId(scenario.id)) c.error('id', 'invalid-id', `Scenario id 非法: ${scenario.id}`);
  if (scenario.userTaskId !== undefined && scenario.userTaskId !== null && !isSafeId(scenario.userTaskId)) c.error('userTaskId', 'invalid-id', `userTaskId 非法: ${scenario.userTaskId}`);
  if (!nonEmpty(scenario.environment)) c.error('environment', 'required', 'environment 需要是非空字符串。');
  // 匿名必须显式声明：缺省 authProfile 不能被理解成"随便用哪个已登录身份"。
  if (!nonEmpty(scenario.authProfile)) c.error('authProfile', 'required', 'authProfile 必填；匿名访问写 anonymous。');
  if (!isObject(scenario.entry) || !isSafeId(scenario.entry.pageId)) c.error('entry.pageId', 'required', 'entry.pageId 需要是页面 id。');
  else if (scenario.entry.params !== undefined) {
    if (!isObject(scenario.entry.params)) c.error('entry.params', 'invalid-params', 'params 需要是对象。');
    else for (const [key, value] of Object.entries(scenario.entry.params)) {
      const ok = typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
      if (!ok) c.error(`entry.params.${key}`, 'invalid-params', '参数值需要是字符串，catch-all 参数是字符串数组。');
    }
  }
  if (!Array.isArray(scenario.checkpoints)) c.error('checkpoints', 'required', 'checkpoints 需要是数组。');
  else {
    const ids = new Set();
    const stepIds = context.stepIds ? new Set(context.stepIds) : null;
    scenario.checkpoints.forEach((checkpoint, index) => {
      const where = `checkpoints[${index}]`;
      if (!isObject(checkpoint)) { c.error(where, 'invalid-checkpoint', '需要是对象。'); return; }
      if (!isSafeId(checkpoint.id)) c.error(`${where}.id`, 'invalid-id', `checkpoint id 非法: ${checkpoint.id}`);
      else if (ids.has(checkpoint.id)) c.error(`${where}.id`, 'duplicate-id', `checkpoint id 重复: ${checkpoint.id}`);
      else ids.add(checkpoint.id);
      if (checkpoint.afterStepId !== undefined && checkpoint.afterStepId !== null) {
        if (!isSafeId(checkpoint.afterStepId)) c.error(`${where}.afterStepId`, 'invalid-id', `afterStepId 非法: ${checkpoint.afterStepId}`);
        else if (stepIds && !stepIds.has(checkpoint.afterStepId)) c.error(`${where}.afterStepId`, 'missing-reference', `步骤不存在: ${checkpoint.afterStepId}`);
      }
      validateAssertions(c, checkpoint.assertions || [], `${where}.assertions`);
      validateCaptureSpec(c, checkpoint.capture, `${where}.capture`);
    });
  }
  return c.result({ version: version.version });
}

// ---------------------------------------------------------------- Capture / Release

function validateArtifactRefs(c, artifacts, path) {
  if (!Array.isArray(artifacts)) { c.error(path, 'required', 'artifacts 需要是数组。'); return; }
  artifacts.forEach((artifact, index) => {
    const where = `${path}[${index}]`;
    if (!isObject(artifact)) { c.error(where, 'invalid-artifact', '需要是对象。'); return; }
    if (!nonEmpty(artifact.kind)) c.error(`${where}.kind`, 'required', 'kind 必填。');
    if (!isProjectRelativePath(artifact.path)) c.error(`${where}.path`, 'invalid-path', `需要是项目根相对路径: ${artifact.path}`);
    if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) c.error(`${where}.sha256`, 'invalid-hash', 'sha256 需要是 64 位十六进制。');
    if (artifact.bytes !== undefined && !(Number.isInteger(artifact.bytes) && artifact.bytes >= 0)) c.error(`${where}.bytes`, 'invalid-artifact', 'bytes 需要是非负整数。');
  });
}

function validateCapture(capture) {
  const c = collector();
  if (!isObject(capture)) { c.error('$', 'invalid-type', 'Capture 需要是对象。'); return c.result(); }
  const version = checkSchemaVersion('capture', capture);
  if (!version.ok) { c.error(version.path, version.code, version.message); return c.result(); }
  if (!isUuid(capture.id)) c.error('id', 'invalid-id', 'Capture id 需要是 UUID。');
  if (!nonEmpty(capture.observedAt) || Number.isNaN(Date.parse(capture.observedAt))) c.error('observedAt', 'required', 'observedAt 需要是 ISO 时间。');
  if (!Array.isArray(capture.validations)) c.error('validations', 'required', 'validations 需要是数组。');
  else capture.validations.forEach((v, i) => {
    const where = `validations[${i}]`;
    if (!isObject(v)) { c.error(where, 'invalid-validation', '需要是对象。'); return; }
    if (!VALIDATION_SCOPES.includes(v.scope)) c.error(`${where}.scope`, 'invalid-validation', `未知 scope: ${v.scope}`);
    if (!VALIDATION_OUTCOMES.includes(v.outcome)) c.error(`${where}.outcome`, 'invalid-validation', `未知 outcome: ${v.outcome}`);
  });
  if (!isObject(capture.privacy) || !nonEmpty(capture.privacy.status)) c.error('privacy.status', 'required', 'privacy 摘要必填。');
  validateArtifactRefs(c, capture.artifacts, 'artifacts');
  if (capture.finalUrl !== undefined && capture.finalUrl !== null) {
    if (!isObject(capture.finalUrl) || !nonEmpty(capture.finalUrl.pathname)) c.error('finalUrl', 'invalid-url', 'finalUrl 需要 { origin, pathname }，不含查询参数。');
    else if (capture.finalUrl.search !== undefined) c.error('finalUrl.search', 'sensitive-field', 'Capture 不能记录完整查询参数。');
  }
  return c.result({ version: version.version });
}

function validateRelease(release) {
  const c = collector();
  if (!isObject(release)) { c.error('$', 'invalid-type', 'Release 需要是对象。'); return c.result(); }
  const version = checkSchemaVersion('release', release);
  if (!version.ok) { c.error(version.path, version.code, version.message); return c.result(); }
  if (!isUuid(release.id)) c.error('id', 'invalid-id', 'Release id 需要是 UUID。');
  if (!isSafeId(release.manualId)) c.error('manualId', 'invalid-id', `manualId 非法: ${release.manualId}`);
  if (!isProjectRelativePath(release.documentPath)) c.error('documentPath', 'invalid-path', `需要是项目根相对路径: ${release.documentPath}`);
  for (const field of ['documentHash', 'factsHash']) {
    if (typeof release[field] !== 'string' || !SHA256_RE.test(release[field])) c.error(field, 'invalid-hash', `${field} 需要是 sha256。`);
  }
  if (!Array.isArray(release.captureIds) || release.captureIds.some((id) => !isUuid(id))) c.error('captureIds', 'invalid-id', 'captureIds 需要是 UUID 数组。');
  if (!isObject(release.definitionRevisions)) c.error('definitionRevisions', 'required', 'definitionRevisions 必填。');
  if (!nonEmpty(release.createdAt) || Number.isNaN(Date.parse(release.createdAt))) c.error('createdAt', 'required', 'createdAt 需要是 ISO 时间。');
  if (release.artifacts !== undefined) validateArtifactRefs(c, release.artifacts, 'artifacts');
  return c.result({ version: version.version });
}

// ---------------------------------------------------------------- 旧版本只读兼容

/**
 * 把旧版本实体转成内存中的当前形状。只读：不改入参，不写磁盘。
 * @returns {{ ok: true, value, legacy: boolean, fromVersion } | { ok: false, code, message }}
 */
function normalizeLegacy(kind, value) {
  const version = checkSchemaVersion(kind, value);
  if (!version.ok) return { ok: false, code: version.code, message: version.message };
  const current = SCHEMA_VERSIONS[kind];
  if (version.version === current) return { ok: true, value, legacy: false, fromVersion: version.version };
  const copy = JSON.parse(JSON.stringify(value));
  if (kind === 'page') {
    copy.lifecycle = copy.lifecycle || 'active';
    if (!Array.isArray(copy.routeBindings) && nonEmpty(copy.route)) {
      copy.routeBindings = [{ id: 'main', template: copy.route, entryFiles: nonEmpty(copy.entry) ? [copy.entry] : [] }];
    }
  } else if (kind === 'userTask') {
    // 旧 status 只说明"曾经批准过"，不能证明当前执行范围；scopeHash 留空，执行前重新核对。
    if (!isObject(copy.approval)) {
      copy.approval = copy.status && copy.status !== 'candidate'
        ? { status: 'approved', scopeHash: null, provenance: 'legacy-status' }
        : { status: 'pending', scopeHash: null };
    }
    if (Array.isArray(copy.steps)) {
      copy.steps = copy.steps.map((step) => (isObject(step) && step.pageId === undefined && step.page !== undefined ? { ...step, pageId: step.page } : step));
    }
  }
  copy.schemaVersion = current;
  return { ok: true, value: copy, legacy: true, fromVersion: version.version };
}

module.exports = {
  SCHEMA_VERSIONS,
  ACTION_TYPES,
  ASSERTION_TYPES,
  RISKS,
  REPLAYS,
  CAPTURE_TIMINGS,
  PAGE_LIFECYCLES,
  APPROVAL_STATUSES,
  VALIDATION_OUTCOMES,
  VALIDATION_SCOPES,
  isProjectRelativePath,
  checkSchemaVersion,
  normalizeLegacy,
  assertionIdsOfPage,
  validateTarget: (target, path = 'target') => { const c = collector(); validateTarget(c, target, path); return c.result(); },
  validateAction: (action, path = 'action') => { const c = collector(); validateAction(c, action, path); return c.result(); },
  validateAssertion: (assertion, path = 'assertion') => { const c = collector(); validateAssertion(c, assertion, path); return c.result(); },
  validatePage,
  validateUserTask,
  validateScenario,
  validateCapture,
  validateRelease,
};
