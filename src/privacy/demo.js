'use strict';

/*
 * Demo Capture：唯一的截图数据模式（capture.mode: demo）。
 *
 * 截图里出现的数据只能来自以下来源，每张截图都记录实际用到的来源：
 *   public       导航、按钮、公开文案等没有被声明为敏感的内容，原样呈现
 *   api_mock     Fixture（.manual/fixtures/<id>.yaml，kind: mock）拦截接口返回的虚构数据
 *   dom_replace  页面用 data-redact="<键>" 声明的敏感区域，截图前替换为 capture.demo.text 配置的虚构值
 * 证明不了的一律不出发布图：
 *   needs_fixture  缺少演示数据（未配置的 data-redact 键、未声明的手机号/邮箱、未登记的 WebSocket）
 *   blocked        已发现风险（原始值仍在页面其他位置可见、替换被页面重渲染覆盖、写请求被拦截）
 *
 * 浏览器侧网络守卫（在打开页面之前安装）对每个请求给出一个判定：
 *   mock      命中 Fixture 路由，返回静态响应，不碰后端
 *   pass      只读请求（GET / HEAD / OPTIONS，且不在 network.block 中）
 *   allow     network.allow 中登记的、已确认无副作用的非只读请求（如查询类 POST、令牌刷新）
 *   authorized 任务写步骤已获授权（write-policy），且发往授权的站点
 *   suppress  浏览器信标（sendBeacon / ping）：直接回 204，不计入门禁
 *   block     其余非只读请求与 network.block 命中的请求：中止，门禁记为 write-blocked
 *
 * 本模块只做判定，不接触浏览器；日志只记方法、路径与原因码，不记查询串、请求体、页面文本。
 */

const MODES = ['demo'];
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const IMAGE_STYLES = ['initials', 'blank'];
// * 对应没有写键名的 data-redact
const KEY = /^(\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,63})$/;

/** 门禁原因码 → 结论与修复建议。 */
const REASONS = {
  'demo-text-unconfigured': { status: 'needs_fixture', hint: '在 config.yaml 的 capture.demo.text 中为这些 data-redact 键配置虚构演示值（没有写键名的 data-redact 用 * 配置）。' },
  'demo-image-unconfigured': { status: 'needs_fixture', hint: '在 capture.demo.images 中为这些图片类 data-redact 键选择 initials 或 blank。' },
  'demo-surface-unreplaceable': { status: 'needs_fixture', hint: '该 data-redact 区域是 Canvas / 视频 / 嵌入框等无法替换的内容；用 Fixture 返回虚构数据，或把它拆到不截图的步骤。' },
  'undeclared-sensitive-text': { status: 'needs_fixture', hint: '页面上出现了未声明为 data-redact 的手机号 / 邮箱：用 Fixture 返回虚构数据，或改用 example.com 等保留域名的演示值。' },
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
    return { method: rule.method ? rule.method.toUpperCase() : null, path: rule.path, origin: rule.origin || null };
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
    network: projectDemo.network || { allow: [], block: [], websockets: [] },
  };
}

function ruleMatches(rule, { method, url }) {
  if (rule.method && rule.method !== method) return false;
  if (rule.origin && !globToRegex(rule.origin).test(url.origin)) return false;
  return globToRegex(rule.path).test(url.pathname);
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
 */
function classifyRequest({ method, url, resourceType = '', mocked = false, network = {}, writeOrigin = null }) {
  const m = String(method || 'GET').toUpperCase();
  if (mocked) return 'mock';
  if ((network.block || []).some((rule) => ruleMatches(rule, { method: m, url }))) return 'block';
  if (READ_METHODS.has(m)) return 'pass';
  if ((network.allow || []).some((rule) => ruleMatches(rule, { method: m, url }))) return 'allow';
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

/**
 * 截图门禁结论。
 * @param {object} audit  浏览器侧审计：{ replaced: {key: n}, unconfigured: [key], images: {key: n}, imageUnconfigured: [key],
 *                        unreplaceable: [key], leaks: [{ surface }], reverted: n, contacts: [match] }
 * @param {object} guard  网络守卫：{ mocked: [], blocked: [{ method, path }], suppressed: n, allowed: n, websockets: [{ path, allowed }] }
 * @param {object} [demo] 合并后的 demo 配置（用于识别演示值中的联系方式）
 * @returns {{ status, reasons: [{ code, status, detail, hint }], sources }}
 */
function decide({ audit = {}, guard = {}, demo = {} }) {
  const reasons = [];
  const add = (code, detail) => reasons.push({ code, status: REASONS[code].status, detail, hint: REASONS[code].hint });
  const unique = (list) => [...new Set(list)].sort();

  if (audit.unconfigured?.length) add('demo-text-unconfigured', unique(audit.unconfigured).join(', '));
  if (audit.imageUnconfigured?.length) add('demo-image-unconfigured', unique(audit.imageUnconfigured).join(', '));
  if (audit.unreplaceable?.length) add('demo-surface-unreplaceable', unique(audit.unreplaceable).join(', '));
  const demoValues = Object.values(demo.text || {}).flat().map(String);
  const contacts = (audit.contacts || []).filter((match) => !isDemoContact(match, demoValues));
  // 只报数量与类别，不把命中的手机号 / 邮箱本身写进记录
  if (contacts.length) add('undeclared-sensitive-text', `${contacts.length} 处（${unique(contacts.map((c) => (c.includes('@') ? 'email' : 'phone'))).join(', ')}）`);
  const sockets = (guard.websockets || []).filter((ws) => !ws.allowed);
  if (sockets.length) add('websocket-unverified', unique(sockets.map((ws) => ws.path)).join(', '));
  if (audit.leaks?.length) add('original-value-leaked', `${audit.leaks.length} 处（${unique(audit.leaks.map((l) => l.surface)).join(', ')}）`);
  if (audit.reverted > 0) add('demo-replacement-reverted', `${audit.reverted} 个区域`);
  if (guard.blocked?.length) add('write-blocked', unique(guard.blocked.map((b) => `${b.method} ${b.path}`)).join(', '));

  const status = reasons.some((r) => r.status === 'blocked') ? 'blocked' : reasons.length ? 'needs_fixture' : 'passed';
  const replaced = Object.values(audit.replaced || {}).reduce((sum, n) => sum + n, 0) + Object.values(audit.images || {}).reduce((sum, n) => sum + n, 0);
  return {
    status,
    reasons,
    sources: {
      public: true,
      api_mock: (guard.mocked || []).length,
      dom_replace: replaced,
    },
    // 写入安全计数（只有数量）：passed 的截图 blocked 必为 0
    network: {
      mocked: (guard.mocked || []).length,
      allowed: guard.allowed || 0,
      authorized: guard.authorized || 0,
      suppressed: guard.suppressed || 0,
      blocked: (guard.blocked || []).length,
      websockets: (guard.websockets || []).length,
    },
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
  MODES, REASONS, IMAGE_STYLES, READ_METHODS,
  resolveDemoConfig, mergeDemo, classifyRequest, websocketAllowed, ruleMatches, globToRegex,
  demoValueFor, leakCheckable, isDemoContact, decide, demoGateError, fixtureStrings,
};
