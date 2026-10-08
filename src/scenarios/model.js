'use strict';

/*
 * Scenario：一次可重复执行的观察条件（契约 C03）。
 *
 * 它把"谁（authProfile）在什么环境、用什么参数打开哪个页面、期望看到什么"显式化。
 * 本阶段不做组合穷举：页面的默认 Scenario 取 default 状态，任务的默认 Scenario 按步骤
 * 的 stateAfter 生成检查点。用户可以在 .manual/scenarios/<id>.yaml 写显式 Scenario 覆盖默认值。
 */

const { revision } = require('../model/revision');

const SCENARIO_SCHEMA_VERSION = 1;

/** 当前配置下的身份：认证关闭时必须显式为 anonymous，不能默默带上已有 Profile。 */
function authProfileFor(config) {
  if (!config?.auth || config.auth.enabled === false) return 'anonymous';
  return config.auth.activeProfile || 'default';
}

/**
 * 把 `/docs/:slug*`、`/a/:id` 这类模板换成具体路径。
 * - 普通参数：整体 encodeURIComponent（值里的 / 变成 %2F，不会意外多出一段）。
 * - catch-all（:x* / 可选 :x?）：string[]，逐段编码后用 / 连接；字符串按 / 拆段兼容 CLI 输入。
 * @returns {{ ok: true, route } | { ok: false, missing: string[], invalid: string[] }}
 */
function resolveRouteTemplate(template, params = {}) {
  const missing = [];
  const invalid = [];
  const segments = String(template).split('/').map((segment) => {
    if (!segment.startsWith(':')) return segment;
    const catchAll = /[*?]$/.test(segment);
    const optional = segment.endsWith('?');
    const name = segment.slice(1).replace(/[*?]$/, '');
    const value = params[name];
    const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    if (empty) {
      if (optional) return null;
      missing.push(name);
      return segment;
    }
    if (catchAll) {
      const parts = Array.isArray(value) ? value : String(value).split('/').filter(Boolean);
      if (parts.some((part) => typeof part !== 'string' || part === '')) { invalid.push(name); return segment; }
      return parts.map(encodeURIComponent).join('/');
    }
    if (typeof value !== 'string' && typeof value !== 'number') { invalid.push(name); return segment; }
    return encodeURIComponent(String(value));
  }).filter((segment) => segment !== null);
  if (missing.length || invalid.length) return { ok: false, missing, invalid };
  const route = segments.join('/');
  return { ok: true, route: route === '' ? '/' : route };
}

/**
 * Scenario 入口要打开的具体位置：路由模板 + 参数，或显式 `entry.path`；再拼上 `entry.query`。
 * 用于数据从路径后缀或查询参数读取的页面（如 `/s/<shareId>`、`/activities/detail?id=`），
 * 这类页面的路由模板本身是静态的，只靠模板打不开有效内容。
 * - `entry.path` 必须落在页面路由的静态前缀之内（等于前缀，或以「前缀/」开头），不能借它打开别的页面。
 * - `extraParams`（命令行 `--params`）覆盖 Scenario 中的同名参数。
 * - query 只进入本次打开的地址；证据记录按 origin + pathname 保存，不记录查询串。
 * @returns {{ ok: true, route: string, search: string } | { ok: false, missing: string[], invalid: string[] }}
 */
function resolveEntryLocation(template, entry = {}, extraParams = {}) {
  let route;
  if (entry?.path !== undefined) {
    const prefix = staticRoutePrefix(template);
    const inside = entry.path === prefix || entry.path.startsWith(prefix === '/' ? '/' : `${prefix}/`);
    if (!inside) return { ok: false, missing: [], invalid: [`entry.path（需要以 ${prefix} 开头）`] };
    route = entry.path;
  } else {
    const resolved = resolveRouteTemplate(template, { ...(entry?.params || {}), ...extraParams });
    if (!resolved.ok) return resolved;
    route = resolved.route;
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(entry?.query || {})) query.append(key, String(value));
  const search = query.toString();
  return { ok: true, route, search: search ? `?${search}` : '' };
}

/** 路由模板在第一个动态段之前的部分：`/a/:code` → `/a`，`/docs` → `/docs`，`/` → `/`。 */
function staticRoutePrefix(template) {
  const segments = [];
  for (const segment of String(template).split('/')) {
    if (segment.startsWith(':')) break;
    segments.push(segment);
  }
  const prefix = segments.join('/').replace(/\/+$/, '');
  return prefix === '' ? '/' : prefix;
}

function withRevision(scenario) {
  const { revision: _ignored, ...definition } = scenario;
  return { ...scenario, revision: revision(JSON.parse(JSON.stringify(definition))) };
}

/** 页面的默认 Scenario：打开页面、default 状态的断言作为检查点。 */
function derivePageScenario(page, config, { params = {} } = {}) {
  const assertions = page.states?.default?.assertions || [{ type: 'url', value: page.route }];
  return withRevision({
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: `page-${page.id}`,
    userTaskId: null,
    environment: 'local',
    authProfile: authProfileFor(config),
    data: { mode: 'live', revision: null },
    entry: { pageId: page.id, routeBindingId: 'main', params },
    expected: { httpStatuses: [200], redirects: [], state: 'normal' },
    setup: [],
    checkpoints: [{ id: 'default', afterStepId: null, pageId: page.id, assertions, capture: { mode: 'viewport', annotations: [] } }],
  });
}

/** 任务的默认 Scenario：入口页面 + 每个步骤的 stateAfter 作为检查点。 */
function deriveTaskScenario(task, pages, config, { params = task.params || {} } = {}) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const checkpoints = (task.steps || []).map((step) => {
    const pageId = step.pageId ?? step.page;
    const stateId = step.stateAfter || step.stateBefore || 'default';
    const page = pagesById.get(pageId);
    const assertions = page?.states?.[stateId]?.assertions
      || (stateId === 'default' && page ? [{ type: 'url', value: page.route }] : []);
    return {
      id: step.id,
      afterStepId: step.id,
      pageId: pageId ?? null,
      state: stateId,
      assertions,
      capture: {
        mode: step.capture?.mode || 'viewport',
        ...(step.capture?.timing ? { timing: step.capture.timing } : {}),
        annotations: step.capture?.annotations || [],
      },
    };
  });
  return withRevision({
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    id: `${task.id}-default`,
    userTaskId: task.id,
    environment: task.environment || 'local',
    authProfile: task.authProfile || authProfileFor(config),
    data: { mode: 'live', revision: null },
    entry: { pageId: task.entryPage, routeBindingId: 'main', params },
    expected: { httpStatuses: [200], redirects: [], state: 'normal' },
    setup: [],
    checkpoints,
  });
}

module.exports = { SCENARIO_SCHEMA_VERSION, authProfileFor, resolveRouteTemplate, resolveEntryLocation, derivePageScenario, deriveTaskScenario, withRevision };
