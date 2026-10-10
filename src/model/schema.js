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

const SCHEMA_VERSIONS = { config: 2, page: 2, userTask: 2, scenario: 1, capture: 1, release: 1, run: 1 };

const ACTION_TYPES = ['click', 'hover', 'fill', 'select', 'check', 'uncheck', 'inspect'];
const ASSERTION_TYPES = ['url', 'visible', 'hidden', 'editable'];
const TARGET_KEYS = ['role', 'name', 'label', 'text', 'testId', 'selector', 'exact', 'within', 'alternatives'];
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
    'entry', 'source', 'dependencies', 'includeInManual', 'detectedActions', 'features', 'guide', 'states', 'identityAssertions', 'confidence',
    'browser', 'status', 'analysis', 'latestCaptureId'],
  userTask: ['schemaVersion', 'id', 'revision', 'title', 'goal', 'entryPage', 'priority', 'preconditions', 'readerPreconditions', 'risk', 'status',
    'approval', 'environment', 'fixtures', 'writeAuthorization', 'steps', 'branches', 'relatedTasks', 'completion', 'evidence', 'evidenceManifest',
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
  if (target.within !== undefined) validateTarget(c, target.within, `${path}.within`);
  if (target.alternatives !== undefined) {
    if (!Array.isArray(target.alternatives) || target.alternatives.length > 5) c.error(path, 'invalid-target', 'alternatives 需要至多五个定位。');
    else target.alternatives.forEach((t, i) => validateTarget(c, t, `${path}.alternatives[${i}]`));
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

/*
 * 步骤标题（可选）：帮助中心目录显示的短名称，渲染成 <!-- step-title: … --> 注释。
 * 注释里不能出现 -- 与尖括号；「」、句末标点和自带编号会和目录的「N. 标题」格式冲突。
 */
const STEP_TITLE_MAX = 16;
const STEP_TITLE_FORBIDDEN_RE = /--|[<>\r\n「」]/;
const STEP_TITLE_TRAILING_RE = /[。．.！!？?；;，,：:、]$/;
const STEP_TITLE_NUMBERED_RE = /^(?:第\s*\d+\s*步|\d+\s*[.、)）])/;

function validateStepTitle(c, title, path) {
  if (title === undefined || title === null) return;
  if (!nonEmpty(title)) { c.error(path, 'invalid-step-title', 'title 需要是非空字符串。'); return; }
  const text = title.trim();
  if ([...text].length > STEP_TITLE_MAX) c.error(path, 'invalid-step-title', `title 不超过 ${STEP_TITLE_MAX} 个字: ${text}`);
  if (STEP_TITLE_FORBIDDEN_RE.test(text)) c.error(path, 'invalid-step-title', `title 不能包含换行、「」、尖括号或 --: ${text}`);
  if (STEP_TITLE_TRAILING_RE.test(text)) c.error(path, 'invalid-step-title', `title 结尾不加标点: ${text}`);
  if (STEP_TITLE_NUMBERED_RE.test(text)) c.error(path, 'invalid-step-title', `title 不写编号，目录会自动加序号: ${text}`);
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
  if (capture.readerCaption !== undefined && !nonEmpty(capture.readerCaption)) {
    c.error(`${path}.readerCaption`, 'invalid-capture', 'readerCaption 需要非空文字。');
  }
  if (capture.readerVisible !== undefined && typeof capture.readerVisible !== 'boolean') {
    c.error(`${path}.readerVisible`, 'invalid-capture', 'readerVisible 需要布尔值。');
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
  if (page.guide !== undefined) {
    if (!Array.isArray(page.guide)) c.error('guide', 'invalid-guide', 'guide 需要是数组。');
    else {
      const ids = new Set();
      page.guide.forEach((item, i) => {
        const at = `guide[${i}]`;
        if (!isObject(item)) { c.error(at, 'invalid-guide', '需要对象'); return; }
        if (!isSafeId(item.id) || ids.has(item.id)) c.error(at, 'invalid-guide', '需要唯一安全 id');
        ids.add(item.id);
        for (const field of ['title', 'instruction']) if (!nonEmpty(item[field])) c.error(at, 'invalid-guide', `${field} 必填`);
        if (item.target) validateTarget(c, item.target, `${at}.target`);
        if (item.taskId && !isSafeId(item.taskId)) c.error(at, 'invalid-guide', 'taskId 非法');
      });
    }
  }
  if (page.features !== undefined) {
    if (!Array.isArray(page.features)) c.error('features', 'invalid-features', 'features must be an array');
    else {
      const ids = new Set();
      page.features.forEach((item, i) => {
        const at = `features[${i}]`;
        if (!isObject(item)) { c.error(at, 'invalid-feature', 'feature must be an object'); return; }
        if (!nonEmpty(item.feature_id) || ids.has(item.feature_id)) c.error(`${at}.feature_id`, 'invalid-feature', 'feature_id must be unique');
        ids.add(item.feature_id);
        if (!nonEmpty(item.label)) c.error(`${at}.label`, 'invalid-feature', 'label is required');
        if (!['required', 'optional', 'skip', 'undecided'].includes(item.priority)) c.error(`${at}.priority`, 'invalid-feature', 'priority must be required, optional, skip, or undecided');
        if (item.target) validateTarget(c, item.target, `${at}.target`);
        if (item.task_ids !== undefined && (!Array.isArray(item.task_ids) || item.task_ids.some((id) => !nonEmpty(id)))) c.error(`${at}.task_ids`, 'invalid-feature', 'task_ids must be an array of ids');
      });
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
  if (task.readerPreconditions !== undefined && (!Array.isArray(task.readerPreconditions) || task.readerPreconditions.some((item) => !nonEmpty(item)))) {
    c.error('readerPreconditions', 'invalid-preconditions', 'readerPreconditions 需要非空文字数组。');
  }
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
      validateStepTitle(c, step.title, `${where}.title`);
      const pageId = step.pageId ?? step.page;
      if (!nonEmpty(pageId)) c.error(`${where}.page`, 'required', '步骤需要所属页面。');
      validateAction(c, step.action, `${where}.action`);
      if (step.risk !== undefined && !RISKS.includes(step.risk)) c.error(`${where}.risk`, 'invalid-risk', `risk 需要是 ${RISKS.join(' / ')} 之一。`);
      if (step.replay !== undefined && !REPLAYS.includes(step.replay)) c.error(`${where}.replay`, 'invalid-replay', `replay 需要是 ${REPLAYS.join(' / ')} 之一。`);
      validateCaptureSpec(c, step.capture, `${where}.capture`);
      if (step.assertionTimeoutMs !== undefined && (!Number.isInteger(step.assertionTimeoutMs) || step.assertionTimeoutMs < 1 || step.assertionTimeoutMs > 120000)) c.error(where, 'invalid-timeout', 'assertionTimeoutMs 需要是 1..120000 的整数。');
      if (step.requires !== undefined) validateAssertions(c, step.requires, `${where}.requires`);
      if (step.pageAfter !== undefined && !isSafeId(step.pageAfter)) c.error(where, 'invalid-action', 'pageAfter 需要页面 id');
      if (pagesById && step.pageAfter) {
        const afterPage = pagesById.get(step.pageAfter);
        if (!afterPage) c.error(where, 'missing-reference', `目的页面不存在: ${step.pageAfter}`);
        else referencedPages.add(afterPage);
      }
      if (pagesById && nonEmpty(pageId)) {
        const page = pagesById.get(pageId);
        if (!page) c.error(`${where}.page`, 'missing-reference', `步骤引用不存在的页面: ${pageId}`);
        else {
          referencedPages.add(page);
          const states = { default: true, ...(isObject(page.states) ? page.states : {}) };
          for (const key of ['stateBefore', 'stateAfter']) {
            if (step[key] !== undefined && !(key === 'stateAfter' && step.pageAfter ? { default: true, ...pagesById.get(step.pageAfter)?.states } : states)[step[key]]) c.error(`${where}.${key}`, 'missing-reference', `页面 ${pageId} 没有状态 ${step[key]}`);
          }
        }
      }
    });
  }

  if (task.writeAuthorization !== undefined) {
    const g = task.writeAuthorization;
    if (!isObject(g)) c.error('writeAuthorization', 'invalid-authorization', 'writeAuthorization 需要是对象。');
    else {
      if (!nonEmpty(task.environment)) c.error('environment', 'required', '授权写操作需要登记测试环境。');
      if (!nonEmpty(g.decisionRef)) c.error('writeAuthorization.decisionRef', 'required', '需要用户授权依据。');
      try { if (new URL(g.origin).origin !== g.origin || !/^https?:/.test(g.origin)) throw new Error(); } catch { c.error('writeAuthorization.origin', 'invalid-origin', '需要完整 HTTP(S) origin。'); }
      if (!Number.isFinite(Date.parse(g.expiresAt))) c.error('writeAuthorization.expiresAt', 'invalid-expiry', '需要有效到期时间。');
      if (!Array.isArray(g.steps) || !g.steps.length || g.steps.some(id => !stepIds.has(id))) c.error('writeAuthorization.steps', 'missing-reference', '需要有效的步骤 id 列表。');
    }
  }
  const claims = task.completionClaims ?? task.completion?.claims;
  if (task.completion?.readerChecks !== undefined) {
    const checks = task.completion.readerChecks;
    if (!Array.isArray(checks) || checks.some(item => !nonEmpty(item))) {
      c.error('completion.readerChecks', 'invalid-reader-checks', 'readerChecks 需要是非空字符串数组。');
    }
  }
  if (task.completion?.goalChecks !== undefined) {
    const items = task.completion.goalChecks;
    const claimIds = new Set((Array.isArray(claims) ? claims : []).map(item => item?.id));
    const readerChecks = new Set(Array.isArray(task.completion.readerChecks) ? task.completion.readerChecks : []);
    if (!Array.isArray(items) || items.length === 0) c.error('completion.goalChecks', 'invalid-goal-checks', 'goalChecks 需要是非空数组。');
    else {
      const seen = new Set();
      items.forEach((item, index) => {
        const where = `completion.goalChecks[${index}]`;
        if (!isObject(item) || !isSafeId(item.id) || seen.has(item.id)) c.error(`${where}.id`, 'invalid-goal-checks', '需要唯一的小写连字符 id。');
        else seen.add(item.id);
        if (!nonEmpty(item?.text)) c.error(`${where}.text`, 'invalid-goal-checks', '需要说明对应的任务目标。');
        const claimRefs = item?.claimIds || [];
        const readerRefs = item?.readerChecks || [];
        if (!Array.isArray(claimRefs) || !Array.isArray(readerRefs) || (!claimRefs.length && !readerRefs.length)) c.error(where, 'invalid-goal-checks', '需要 claimIds 或 readerChecks。');
        else {
          if (claimRefs.some(id => !claimIds.has(id))) c.error(`${where}.claimIds`, 'missing-reference', '引用了不存在的完成声明。');
          if (readerRefs.some(value => !readerChecks.has(value))) c.error(`${where}.readerChecks`, 'missing-reference', '必须引用现有读者核对项的原文。');
        }
      });
    }
  }
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
  // 入口路径与查询参数：数据从路径后缀（/s/<id>）或查询串（?id=）读取的页面用它打开具体内容
  if (isObject(scenario.entry) && scenario.entry.path !== undefined) {
    const p = scenario.entry.path;
    const ok = typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
      && !/[?#\\\s]/.test(p) && !p.split('/').some((segment) => segment === '..' || segment === '.');
    if (!ok) c.error('entry.path', 'invalid-path', 'entry.path 需要是以 / 开头的站内路径，不含 ?、#、反斜杠、空白和 . / .. 段；查询参数写在 entry.query。');
    if (ok && isObject(scenario.entry.params) && Object.keys(scenario.entry.params).length) c.error('entry.path', 'invalid-path', 'entry.path 与 entry.params 不能同时使用。');
  }
  if (isObject(scenario.entry) && scenario.entry.query !== undefined) {
    if (!isObject(scenario.entry.query)) c.error('entry.query', 'invalid-query', 'entry.query 需要是对象。');
    else for (const [key, value] of Object.entries(scenario.entry.query)) {
      if (!nonEmpty(key) || typeof value !== 'string') c.error(`entry.query.${key}`, 'invalid-query', '查询参数名需要非空，值需要是字符串。');
    }
  }
  // 数据来源（P3-05）：live，或引用已登记的 Fixture；预期页面状态用于 Empty / Loading / Error Scenario
  if (scenario.data !== undefined && scenario.data !== null) {
    if (!isObject(scenario.data) || !['live', 'fixture'].includes(scenario.data.mode)) c.error('data.mode', 'invalid-data', 'data.mode 需要是 live 或 fixture。');
    else if (scenario.data.mode === 'fixture' && !isSafeId(scenario.data.fixture)) c.error('data.fixture', 'required', 'data.mode=fixture 时需要 data.fixture（已登记的 Fixture id）。');
  }
  if (scenario.expected?.state !== undefined && !['normal', 'loading', 'error', 'empty'].includes(scenario.expected.state)) {
    c.error('expected.state', 'invalid-state', `expected.state 需要是 normal / loading / error / empty，收到: ${scenario.expected.state}`);
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
  // 源码基线（P3-01）：旧发布记录没有该字段，按"无基线"处理（update 回退全量重建）
  if (release.sourceBaseline !== undefined && release.sourceBaseline !== null) {
    const b = release.sourceBaseline;
    if (!isObject(b)) c.error('sourceBaseline', 'invalid-type', 'sourceBaseline 需要是对象。');
    else {
      if (b.graphRevision !== null && b.graphRevision !== undefined && !SHA256_RE.test(String(b.graphRevision))) c.error('sourceBaseline.graphRevision', 'invalid-hash', 'graphRevision 需要是 sha256。');
      if (b.gitCommit !== null && b.gitCommit !== undefined && !/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(String(b.gitCommit))) c.error('sourceBaseline.gitCommit', 'invalid-commit', 'gitCommit 需要是完整提交 id。');
    }
  }
  // 人工编辑保护（P3-06）：纯生成正文 blob 与章节；旧记录没有这些字段
  if (release.generatedBlob !== undefined && (typeof release.generatedBlob !== 'string' || !SHA256_RE.test(release.generatedBlob))) c.error('generatedBlob', 'invalid-hash', 'generatedBlob 需要是 sha256。');
  if (release.sections !== undefined && (!Array.isArray(release.sections) || release.sections.some((s) => !isObject(s) || !nonEmpty(s.id)))) c.error('sections', 'invalid-sections', 'sections 需要是带 id 的章节数组。');
  return c.result({ version: version.version });
}

function validateRun(run) {
  const c = collector();
  if (!isObject(run)) { c.error('$', 'invalid-type', 'Run 需要是对象。'); return c.result(); }
  const version = checkSchemaVersion('run', run);
  if (!version.ok) { c.error(version.path, version.code, version.message); return c.result(); }
  // 延迟加载，避免 model ↔ runtime 之间的加载顺序耦合。
  const { RUN_STATUSES } = require('../runtime/model');
  if (!isUuid(run.id)) c.error('id', 'invalid-id', 'Run id 需要是 UUID。');
  if (!nonEmpty(run.command)) c.error('command', 'required', 'command 必填。');
  if (typeof run.planHash !== 'string' || !SHA256_RE.test(run.planHash)) c.error('planHash', 'invalid-hash', 'planHash 需要是 sha256。');
  if (!RUN_STATUSES.includes(run.status)) c.error('status', 'invalid-status', `未知 Run 状态: ${run.status}`);
  if (!Array.isArray(run.taskOrder) || run.taskOrder.some((id) => !isSafeId(id))) c.error('taskOrder', 'invalid-id', 'taskOrder 需要是任务 id 数组。');
  if (run.predecessor !== null && run.predecessor !== undefined && !isUuid(run.predecessor)) c.error('predecessor', 'invalid-id', 'predecessor 需要是 Run id。');
  if (!isObject(run.budget)) c.error('budget', 'required', 'budget 必填。');
  if (!isObject(run.consumed)) c.error('consumed', 'required', 'consumed 必填。');
  for (const field of ['createdAt', 'updatedAt']) {
    if (!nonEmpty(run[field]) || Number.isNaN(Date.parse(run[field]))) c.error(field, 'required', `${field} 需要是 ISO 时间。`);
  }
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
  validateStepTitle: (title, path = 'title') => { const c = collector(); validateStepTitle(c, title, path); return c.result(); },
  STEP_TITLE_MAX,
  validatePage,
  validateUserTask,
  validateScenario,
  validateCapture,
  validateRelease,
  validateRun,
};
