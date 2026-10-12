'use strict';

/*
 * Demo Capture：唯一的截图数据模式（capture.mode: demo）。
 *
 * 截图里出现的数据只能来自以下来源，每张截图都记录实际用到的来源：
 *   public       导航、按钮、公开文案等没有被声明为敏感的内容，原样呈现
 *   api_mock     Fixture（.manual/fixtures/<id>.yaml，kind: mock）拦截接口返回的虚构数据
 *   fixture      hook Fixture 在隔离测试环境中准备的演示数据
 *   dom_replace  敏感区域截图前替换为 capture.demo.text 配置的虚构值。敏感区域有两种声明方式：
 *                capture.demo.selectors（Skill 侧按 CSS 或角色 / 名称声明，被采集项目无需任何改动，推荐）
 *                或页面自带的 data-redact="<键>" 属性（项目愿意加标记时可用，二者等价）
 * 证明不了的一律不出发布图：
 *   needs_fixture  缺少演示数据（未配置的 data-redact 键、未声明的手机号/邮箱、未登记的 WebSocket）
 *   blocked        已发现风险（原始值仍在页面其他位置可见、替换被页面重渲染覆盖、写请求被拦截）
 *
 * 浏览器侧网络守卫（在打开页面之前安装）对每个请求给出一个判定：
 *   mock      命中 Fixture 路由，返回静态响应，不碰后端
 *   pass      只读的静态资源请求（文档、脚本、样式、图片、字体等，且不在 network.block 中）
 *   unverified 只读的数据请求（fetch / xhr / EventSource）既没有 Fixture 也没有登记在 network.allow：
 *             照常放行，但逐条记录；页面声明了敏感区域时门禁据此给出 needs_fixture（真实数据可能进入画面）
 *   allow     network.allow 中登记的请求：已审阅的只读数据接口，或已确认无副作用的非只读请求
 *             （如查询类 POST、令牌刷新；GraphQL 可按 operationName 精确登记）
 *   authorized 任务写步骤已获授权（write-policy），且发往授权的站点
 *   suppress  浏览器信标（sendBeacon / ping）：直接回 204，不计入门禁
 *   block     其余非只读请求与 network.block 命中的请求：中止，门禁记为 write-blocked
 *
 * 本模块只做判定，不接触浏览器；日志只记方法、路径与原因码，不记查询串、请求体、页面文本。
 */

const MODES = ['demo'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// 承载业务数据的请求类型：静态资源之外，这些请求的响应可能把真实数据带进画面
const DATA_TYPES = new Set(['fetch', 'xhr', 'eventsource']);
const SURFACES = ['iframe', 'canvas', 'shadow'];
const IMAGE_STYLES = ['initials', 'blank'];
// * 对应没有写键名的 data-redact
const KEY = /^(\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/;

/** 门禁原因码 → 结论与修复建议。 */
const REASONS = {
  'demo-text-unconfigured': { status: 'needs_fixture', hint: '在 config.yaml 的 capture.demo.text 中为这些 data-redact 键配置虚构演示值（没有写键名的 data-redact 用 * 配置）。' },
  'demo-image-unconfigured': { status: 'needs_fixture', hint: '在 capture.demo.images 中为这些图片类 data-redact 键选择 initials 或 blank。' },
  'demo-surface-unreplaceable': { status: 'needs_fixture', hint: '该 data-redact 区域是 Canvas / 视频 / 嵌入框等无法替换的内容；用 Fixture 返回虚构数据，或把它拆到不截图的步骤。' },
  'undeclared-sensitive-text': { status: 'needs_fixture', hint: '页面上出现了未声明为 data-redact 的手机号 / 邮箱：用 Fixture 返回虚构数据，或改用 example.com 等保留域名的演示值。' },
  'demo-selector-missing': { status: 'needs_fixture', hint: '角色 / 可访问名称目标没有命中；核对页面状态和配置，或使用 Fixture。' },
  'demo-selector-invalid': { status: 'needs_fixture', hint: 'capture.demo.selectors 中的选择器在页面里无法解析；改成合法的 CSS 或 { role, name }。' },
  'demo-unmocked-read': { status: 'needs_fixture', hint: '页面声明了敏感区域，但这些数据接口既没有 Fixture 也没有登记：真实数据可能出现在画面的其他位置。用 Fixture（kind: mock）返回虚构数据；确认接口只返回公开数据或其内容全部落在已声明区域时，登记到 capture.demo.network.allow。' },
  'demo-surface-unaudited': { status: 'needs_fixture', hint: '页面声明了敏感区域，同时含有无法审计内容的区域（跨域 iframe / canvas / shadow DOM）；确认其中没有真实数据后登记到 capture.demo.surfaces，或用 Fixture 替代。' },
  'websocket-unverified': { status: 'needs_fixture', hint: '页面建立了 WebSocket，其中的数据无法被拦截证明；确认只读后登记到 capture.demo.network.websockets，或用 Fixture 替代。' },
  'original-value-leaked': { status: 'blocked', hint: '已替换的真实值仍出现在页面其他位置（文本、输入框、title / alt / aria 属性或页面标题）；给那处也加 data-redact，或用 Fixture 提供数据。' },
  'demo-replacement-reverted': { status: 'blocked', hint: '截图时页面重渲染把演示值改回了真实值；等待数据加载完成（--wait-for），或用 Fixture 提供稳定数据。' },
  'write-blocked': { status: 'blocked', hint: '页面发出了未授权的写请求，已在浏览器内中止；若确认该请求无副作用，登记到 capture.demo.network.allow，否则用 Fixture 完整模拟。' },
};

function globToRegex(pattern) {
  return new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

function validateRules(list, field, errors) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) { errors.push(`${field} 需要是数组。`); return []; }
  return list.map((rule, i) => {
    if (!rule || typeof rule !== 'object' || typeof rule.path !== 'string' || !rule.path.startsWith('/')) {
      errors.push(`${field}[${i}] 需要是 { method?, path, origin? }，path 以 / 开头（可含 *）。`);
      return null;
    }
    if (rule.method !== undefined && (typeof rule.method !== 'string' || !/^[A-Za-z]+$/.test(rule.method))) errors.push(`${field}[${i}].method 非法。`);
    if (rule.origin !== undefined && typeof rule.origin !== 'string') errors.push(`${field}[${i}].origin 需要是字符串（可含 *）。`);
    if (rule.operationName !== undefined && (typeof rule.operationName !== 'string' || !rule.operationName.trim())) errors.push(`${field}[${i}].operationName 需要是非空字符串（GraphQL 操作名）。`);
    return { method: rule.method ? rule.method.toUpperCase() : null, path: rule.path, origin: rule.origin || null, operationName: rule.operationName || null };
  }).filter(Boolean);
}

/** demo.text 的值：字符串（可含 {n}，按出现顺序从 1 编号）或非空字符串数组（按出现顺序循环取值）。 */
function validateText(text, field, errors) {
  if (text === undefined) return {};
  if (!text || typeof text !== 'object' || Array.isArray(text)) { errors.push(`${field} 需要是 { data-redact 键: 演示值 } 对象。`); return {}; }
  const out = {};
  for (const [key, value] of Object.entries(text)) {
    if (!KEY.test(key)) { errors.push(`${field} 的键名非法: ${key}`); continue; }
    const values = Array.isArray(value) ? value : [value];
    if (!values.length || values.some((v) => (typeof v !== 'string' && typeof v !== 'number') || String(v).trim() === '')) {
      errors.push(`${field}.${key} 需要是非空字符串或非空字符串数组。`);
      continue;
    }
    out[key] = values.map(String);
  }
  return out;
}

/** demo.selectors：{ 键: CSS 或 { role, name } }。命中的元素与 data-redact="<键>" 等价，演示值仍从 demo.text / demo.images 取。 */
function validateSelectors(selectors, field, errors) {
  if (selectors === undefined) return {};
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) { errors.push(`${field} 需要是 { 键: CSS 选择器 } 对象。`); return {}; }
  const out = {};
  for (const [key, selector] of Object.entries(selectors)) {
    if (!KEY.test(key) || key === '*') errors.push(`${field} 的键名非法: ${key}`);
    else if (typeof selector === 'string' && selector.trim()) out[key] = selector.trim();
    else if (selector && typeof selector === 'object' && !Array.isArray(selector) &&
      Object.keys(selector).every((k) => ['role', 'name'].includes(k)) &&
      typeof selector.role === 'string' && /^[a-z]+$/.test(selector.role) &&
      typeof selector.name === 'string' && selector.name.trim()) out[key] = { role: selector.role, name: selector.name };
    else errors.push(`${field}.${key} 需要是非空 CSS 或 { role, name }。`);
  }
  return out;
}

function validateSurfaces(surfaces, field, errors) {
  if (surfaces === undefined) return [];
  if (!Array.isArray(surfaces) || surfaces.some((s) => !SURFACES.includes(s))) { errors.push(`${field} 需要是数组，取值 ${SURFACES.join(' / ')}。`); return []; }
  return [...new Set(surfaces)];
}

function validateImages(images, field, errors) {
  if (images === undefined) return {};
  if (!images || typeof images !== 'object' || Array.isArray(images)) { errors.push(`${field} 需要是 { data-redact 键: initials | blank } 对象。`); return {}; }
  const out = {};
  for (const [key, style] of Object.entries(images)) {
    if (!KEY.test(key)) errors.push(`${field} 的键名非法: ${key}`);
    else if (!IMAGE_STYLES.includes(style)) errors.push(`${field}.${key} 只能是 ${IMAGE_STYLES.join(' / ')}。`);
    else out[key] = style;
  }
  return out;
}

/**
 * capture.mode 与 capture.demo。缺省即 demo；其它取值没有对应实现，明确拒绝而不是静默回退。
 * @returns {{ ok: true, mode, demo } | { ok: false, errors }}
 */
function resolveDemoConfig(capture = {}) {
  const errors = [];
  const mode = capture?.mode === undefined ? 'demo' : capture.mode;
  if (!MODES.includes(mode)) {
    errors.push(`capture.mode 只支持 demo（统一演示截图模式），收到: ${mode}。删除这一行或改为 demo；需要保留真实数据的区域无需配置，需要虚构的区域在 capture.demo 中声明。`);
  }
  const raw = capture?.demo;
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) errors.push('capture.demo 需要是对象。');
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const network = source.network === undefined ? {} : source.network;
  if (!network || typeof network !== 'object' || Array.isArray(network)) errors.push('capture.demo.network 需要是对象。');
  const demo = {
    text: validateText(source.text, 'capture.demo.text', errors),
    images: validateImages(source.images, 'capture.demo.images', errors),
    selectors: validateSelectors(source.selectors, 'capture.demo.selectors', errors),
    surfaces: validateSurfaces(source.surfaces, 'capture.demo.surfaces', errors),
    network: {
      allow: validateRules(network?.allow, 'capture.demo.network.allow', errors),
      block: validateRules(network?.block, 'capture.demo.network.block', errors),
      websockets: validateRules(network?.websockets, 'capture.demo.network.websockets', errors),
    },
  };
  return errors.length ? { ok: false, errors } : { ok: true, mode, demo };
}

/** 项目级 demo 与 Fixture 级 demo 合并：Fixture 只能补充 / 覆盖演示值，网络放行仍只认项目级。 */
function mergeDemo(projectDemo = {}, fixtureDemo = null) {
  return {
    text: { ...(projectDemo.text || {}), ...(fixtureDemo?.text || {}) },
    images: { ...(projectDemo.images || {}), ...(fixtureDemo?.images || {}) },
    selectors: { ...(projectDemo.selectors || {}), ...(fixtureDemo?.selectors || {}) },
    surfaces: projectDemo.surfaces || [],
    network: projectDemo.network || { allow: [], block: [], websockets: [] },
  };
}

function ruleMatches(rule, { method, url, operationName = null }) {
  if (rule.method && rule.method !== method) return false;
  if (rule.origin && !globToRegex(rule.origin).test(url.origin)) return false;
  if (rule.operationName && rule.operationName !== operationName) return false;
  return globToRegex(rule.path).test(url.pathname);
}

/** GraphQL 操作名：查询串 operationName，或 JSON 请求体的 operationName（只取这一个字段，不保留请求体）。 */
function operationNameOf(url, postData) {
  const fromQuery = url.searchParams.get('operationName');
  if (fromQuery) return fromQuery;
  if (!postData) return null;
  try {
    const body = JSON.parse(postData);
    return typeof body?.operationName === 'string' ? body.operationName : null;
  } catch (_) { return null; }
}

/**
 * 单个请求的判定（见文件头）。
 * @param {object} p
 * @param {string} p.method
 * @param {URL} p.url
 * @param {string} [p.resourceType]
 * @param {boolean} [p.mocked]          已命中 Fixture 路由
 * @param {object} p.network            capture.demo.network
 * @param {string|null} [p.writeOrigin] 当前处于已授权写步骤时的授权站点
 * @param {string|null} [p.operationName] GraphQL 操作名（operationNameOf）
 */
function classifyRequest({ method, url, resourceType = '', mocked = false, network = {}, writeOrigin = null, operationName = null }) {
  const m = String(method || 'GET').toUpperCase();
  if (mocked) return 'mock';
  if ((network.block || []).some((rule) => ruleMatches(rule, { method: m, url, operationName }))) return 'block';
  const allowed = (network.allow || []).some((rule) => ruleMatches(rule, { method: m, url, operationName }));
  if (READ_METHODS.has(m)) {
    if (m === 'OPTIONS' || !DATA_TYPES.has(resourceType)) return 'pass';
    return allowed ? 'allow' : 'unverified';
  }
  if (allowed) return 'allow';
  if (writeOrigin && url.origin === writeOrigin) return 'authorized';
  if (resourceType === 'ping' || resourceType === 'beacon') return 'suppress';
  return 'block';
}

function websocketAllowed(url, network = {}) {
  return (network.websockets || []).some((rule) => ruleMatches(rule, { method: null, url }));
}

/**
 * Fixture 响应体里的全部字符串：页面上与之完全相同的 data-redact 内容来自 Fixture（虚构数据），
 * 不必再配置演示值（列表、分页、详情页因此保持前后一致）。只取 JSON 响应。
 */
function fixtureStrings(routes = []) {
  const out = new Set();
  const walk = (value) => {
    if (typeof value === 'string') { if (value.trim()) out.add(value.trim()); return; }
    if (typeof value === 'number') { out.add(String(value)); return; }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  for (const route of routes) {
    if (!/json/i.test(String(route.contentType || ''))) continue;
    try { walk(JSON.parse(Buffer.isBuffer(route.body) ? route.body.toString('utf8') : String(route.body))); } catch (_) { /* 非 JSON 响应体不参与 */ }
  }
  return [...out];
}

/** 第 index 个（0 起）同键元素的演示值。 */
function demoValueFor(values, index) {
  const list = Array.isArray(values) ? values : [values];
  return String(list[index % list.length]).replace(/\{n\}/g, String(index + 1));
}

/** 需要做"原始值是否残留"检查的值：太短或纯数字的短值误报太多（"12" 到处都是），不参与。 */
function leakCheckable(value) {
  const text = String(value || '').trim();
  if (text.length < 2) return false;
  if (/^[\d\s.,:+\-%¥$]+$/.test(text)) return text.replace(/\D/g, '').length >= 4;
  return true;
}

/** 演示值本身含手机号 / 邮箱时不算"未声明的敏感文本"；保留域名（RFC 2606）一律视为虚构。 */
function isDemoContact(match, demoValues) {
  if (/@(example\.(com|org|net)|[a-z0-9-]+\.(test|example|invalid))$/i.test(match)) return true;
  return demoValues.some((value) => value.includes(match));
}

/** 页面上声明了敏感区域（data-redact 或 capture.demo.selectors 命中的可见元素，无论是否已配置演示值）。 */
function declaresSensitive(audit = {}) {
  const count = (map) => Object.values(map || {}).reduce((sum, n) => sum + n, 0);
  return count(audit.replaced) + count(audit.images) + (audit.unconfigured || []).length + (audit.imageUnconfigured || []).length + (audit.unreplaceable || []).length + (audit.reverted || 0) > 0;
}

/**
 * 截图门禁结论。
 * @param {object} audit  浏览器侧审计：{ replaced: {key: n}, unconfigured: [key], images: {key: n}, imageUnconfigured: [key],
 *                        unreplaceable: [key], leaks: [{ surface }], reverted: n, contacts: [match], surfaces: {iframe, canvas, shadow},
 *                        invalidSelectors: [key], realValues: n }
 * @param {object} guard  网络守卫：{ mocked: [], blocked: [{ method, path }], suppressed: n, allowed: n, websockets: [{ path, allowed }],
 *                        uncovered: [{ method, path, kind }], routes: [{ rule, hits }] }
 * @param {object} [demo] 合并后的 demo 配置（用于识别演示值中的联系方式、已登记的无法审计区域、数据准备方式）
 * @returns {{ status, reasons: [{ code, status, detail, hint }], sources, kinds, network, mock, realDataInBrowser }}
 */
function decide({ audit = {}, guard = {}, demo = {} }) {
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, status: REASONS[code].status, detail, hint: REASONS[code].hint });
  const unique = (list) => [...new Set(list)].sort();
  const sensitive = declaresSensitive(audit);

  if (audit.missingSelectors?.length) add('demo-selector-missing', unique(audit.missingSelectors).join(', '));
  if (audit.invalidSelectors?.length) add('demo-selector-invalid', unique(audit.invalidSelectors).join(', '));
  if (audit.unconfigured?.length) add('demo-text-unconfigured', unique(audit.unconfigured).join(', '));
  if (audit.imageUnconfigured?.length) add('demo-image-unconfigured', unique(audit.imageUnconfigured).join(', '));
  if (audit.unreplaceable?.length) add('demo-surface-unreplaceable', unique(audit.unreplaceable).join(', '));
  const demoValues = Object.values(demo.text || {}).flat().map(String);
  const contacts = (audit.contacts || []).filter((match) => !isDemoContact(match, demoValues));
  // 只报数量与类别，不把命中的手机号 / 邮箱本身写进记录
  if (contacts.length) add('undeclared-sensitive-text', `${contacts.length} 处（${unique(contacts.map((c) => (c.includes('@') ? 'email' : 'phone'))).join(', ')}）`);
  const sockets = (guard.websockets || []).filter((ws) => !ws.allowed);
  if (sockets.length) add('websocket-unverified', unique(sockets.map((ws) => ws.path)).join(', '));
  // 没有 Fixture、也没有登记的数据接口：页面声明了敏感区域时，真实数据可能出现在声明区域之外
  const uncovered = guard.uncovered || [];
  if (sensitive && uncovered.length) add('demo-unmocked-read', unique(uncovered.map((r) => `${r.method} ${r.path}${r.kind === 'same-origin' ? '' : `（${r.kind}）`}`)).join(', '));
  const surfaceCounts = audit.surfaces || {};
  const unaudited = SURFACES.filter((kind) => Number(surfaceCounts[kind] || 0) > 0 && !(demo.surfaces || []).includes(kind));
  if (sensitive && unaudited.length) add('demo-surface-unaudited', unaudited.map((kind) => `${kind} × ${surfaceCounts[kind]}`).join(', '));
  if (audit.leaks?.length) add('original-value-leaked', `${audit.leaks.length} 处（${unique(audit.leaks.map((l) => l.surface)).join(', ')}）`);
  if (audit.reverted > 0) add('demo-replacement-reverted', `${audit.reverted} 个区域`);
  if (guard.blocked?.length) add('write-blocked', unique(guard.blocked.map((b) => `${b.method} ${b.path}`)).join(', '));

  const status = reasons.some((r) => r.status === 'blocked') ? 'blocked' : reasons.length ? 'needs_fixture' : 'passed';
  const replaced = Object.values(audit.replaced || {}).reduce((sum, n) => sum + n, 0) + Object.values(audit.images || {}).reduce((sum, n) => sum + n, 0);
  const sources = {
    public: true,
    fixture: demo.dataMode === 'fixture' ? 1 : 0,
    api_mock: (guard.mocked || []).length,
    dom_replace: replaced,
  };
  const routes = guard.routes || [];
  return {
    status,
    reasons,
    sources,
    // 本张截图实际用到的数据来源类别（public / fixture / api_mock / dom_replace；未通过时追加 blocked）
    kinds: [...Object.keys(sources).filter((k) => k === 'public' || sources[k] > 0), ...(status === 'passed' ? [] : ['blocked'])],
    // 真实数据曾经进入浏览器（被替换的原始值、未 Mock 的数据请求）：画面已证明安全，但不能宣称"没有读取真实数据"
    realDataInBrowser: Number(audit.realValues || 0) > 0 || uncovered.length > 0 || Number(guard.allowedReads || 0) > 0,
    // 写入安全计数（只有数量）：passed 的截图 blocked 必为 0
    network: {
      mocked: (guard.mocked || []).length,
      allowed: guard.allowed || 0,
      allowedReads: guard.allowedReads || 0,
      authorized: guard.authorized || 0,
      suppressed: guard.suppressed || 0,
      blocked: (guard.blocked || []).length,
      websockets: (guard.websockets || []).length,
      uncovered: uncovered.length,
    },
    // Fixture 路由命中记录：规则 ID（方法 + 路径）与命中次数；声明了却没命中的规则单列，便于发现 Fixture 已过期
    mock: { routes: routes.map(({ rule, hits }) => ({ rule, hits })), unhit: routes.filter((r) => !r.hits).map((r) => r.rule) },
  };
}

/** 抛给上层的门禁失败：带原因码，日志与报告只引用它。 */
function demoGateError(decision) {
  const summary = decision.reasons.map((r) => `${r.code}（${r.detail}）`).join('；');
  const error = new Error(`demo-${decision.status === 'blocked' ? 'blocked' : 'needs-fixture'}: 演示截图门禁未通过：${summary}。${decision.reasons.map((r) => r.hint).filter((h, i, a) => a.indexOf(h) === i).join(' ')}`);
  error.code = decision.status === 'blocked' ? 'demo-blocked' : 'demo-needs-fixture';
  error.demo = decision;
  return error;
}

module.exports = {
  MODES, REASONS, IMAGE_STYLES, READ_METHODS, DATA_TYPES, SURFACES,
  resolveDemoConfig, mergeDemo, classifyRequest, websocketAllowed, ruleMatches, globToRegex, operationNameOf,
  demoValueFor, leakCheckable, isDemoContact, decide, declaresSensitive, demoGateError, fixtureStrings,
};
