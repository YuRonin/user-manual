'use strict';

/*
 * 路由发现的 L3 / L4 输入（docs/MULTI_FRAMEWORK_PLAN.md §6.3、§6.4）。
 *
 *   L3 AI 候选   .manual/routes.candidates.yaml  由 `manual inspect --routes-input <json>` 校验后写入（派生文件）
 *   L4 人工覆盖  .manual/routes.override.yaml    由人维护
 *
 * 两者都只是**扫描的输入**：在适配器给出记录之后合并进发现结果，不直接写页面 YAML
 * （页面的 route / entry 是扫描拥有的字段，每次 inspect 重写）。优先级 L4 > L3 > L1/L2。
 *
 * AI 候选绑定它所依据的源码文件 hash：源码变了，候选自动过期，对应记录重新回到 unresolved，
 * 不会让一份过时的推断继续冒充事实。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { DISPOSITION, finalizeDiscovery } = require('./adapters/records');
const { routeParams, pageFromRecord } = require('./adapters/route-table');
const { hashFile } = require('./fingerprint');
const { writeText } = require('../util/fsx');

const CANDIDATES_FILE = 'routes.candidates.yaml';
const OVERRIDE_FILE = 'routes.override.yaml';
const ROUTE_PATTERN = /^\/(?:[\w\-.~%!$&'()+,;=@]+|:[A-Za-z_$][\w$]*[?*]?)?(?:\/(?:[\w\-.~%!$&'()+,;=@]+|:[A-Za-z_$][\w$]*[?*]?))*$/;

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function readYaml(file) {
  if (!fs.existsSync(file)) return { exists: false, doc: null };
  try {
    return { exists: true, doc: yaml.load(fs.readFileSync(file, 'utf8')) || {} };
  } catch (error) {
    return { exists: true, error: `${path.basename(file)} 解析失败：${error.message}` };
  }
}

/** 项目内的相对文件路径，且文件存在。 */
function checkFile(projectRoot, rel, where, errors) {
  const value = toPosix(rel || '');
  if (!value || value.startsWith('/') || value.split('/').includes('..') || /^[A-Za-z]:/.test(value)) {
    errors.push(`${where}: 文件路径必须是项目根相对路径（${rel}）`);
    return null;
  }
  if (!fs.existsSync(path.join(projectRoot, value))) {
    errors.push(`${where}: 文件不存在（${value}）`);
    return null;
  }
  return value;
}

/**
 * 校验一条路由输入（候选或覆盖）。
 * @returns {{ item } | null}  不合法时把原因写进 errors
 */
function normalizeItem(projectRoot, raw, where, errors, { requireReason = true } = {}) {
  if (!raw || typeof raw !== 'object') { errors.push(`${where}: 必须是对象`); return null; }
  if (requireReason && (typeof raw.reason !== 'string' || !raw.reason.trim())) errors.push(`${where}: 缺少 reason（为什么需要人工 / AI 补充）`);
  if (raw.exclude) {
    if (typeof raw.exclude !== 'string') { errors.push(`${where}: exclude 必须是 recordId 字符串`); return null; }
    return { exclude: raw.exclude, reason: raw.reason || null };
  }
  const before = errors.length;
  if (typeof raw.route !== 'string' || !ROUTE_PATTERN.test(raw.route)) errors.push(`${where}: route 不是合法的路由模式（${raw.route}），示例 /reports/:id`);
  const entry = checkFile(projectRoot, raw.entry, `${where}.entry`, errors);
  const layout = [];
  for (const [i, file] of (Array.isArray(raw.layout) ? raw.layout : []).entries()) {
    const checked = checkFile(projectRoot, file, `${where}.layout[${i}]`, errors);
    if (checked) layout.push(checked);
  }
  if (raw.recordId !== undefined && typeof raw.recordId !== 'string') errors.push(`${where}: recordId 必须是字符串`);
  if (errors.length > before) return null;
  return {
    ...(raw.recordId ? { recordId: raw.recordId } : {}),
    route: routeParams(raw.route).route,
    entry,
    layout,
    reason: raw.reason || null,
  };
}

/** 人工覆盖：解析失败或条目不合法都是错误（人写的文件，应当修正后再扫描）。 */
function readOverrides(projectRoot, stateDirAbs) {
  const file = path.join(stateDirAbs, OVERRIDE_FILE);
  const read = readYaml(file);
  if (!read.exists) return { items: [], errors: [] };
  if (read.error) return { items: [], errors: [read.error] };
  const errors = [];
  const items = [];
  const list = Array.isArray(read.doc.routes) ? read.doc.routes : [];
  if (!Array.isArray(read.doc.routes)) errors.push(`${OVERRIDE_FILE}: 缺少 routes 列表`);
  list.forEach((raw, i) => {
    const item = normalizeItem(projectRoot, raw, `${OVERRIDE_FILE} routes[${i}]`, errors);
    if (item) items.push({ ...item, source: 'L4' });
  });
  return { items, errors };
}

/** AI 候选：依据文件的 hash 变了就过期（忽略并给出诊断），不报错。 */
function readCandidates(projectRoot, stateDirAbs) {
  const file = path.join(stateDirAbs, CANDIDATES_FILE);
  const read = readYaml(file);
  if (!read.exists) return { items: [], stale: [], errors: [] };
  if (read.error) return { items: [], stale: [], errors: [read.error] };
  const items = [];
  const stale = [];
  for (const raw of Array.isArray(read.doc.routes) ? read.doc.routes : []) {
    const changed = Object.entries(raw.evidence || {}).filter(([rel, hash]) => hashFile(projectRoot, rel) !== hash).map(([rel]) => rel);
    const errors = [];
    const item = normalizeItem(projectRoot, raw, CANDIDATES_FILE, errors);
    if (changed.length || !item) {
      stale.push({ route: raw.route, recordId: raw.recordId || null, changed, errors });
      continue;
    }
    items.push({ ...item, source: 'L3' });
  }
  return { items, stale, errors: [] };
}

/**
 * 校验 `--routes-input` 提交的候选，并与已有候选合并写入 routes.candidates.yaml。
 * 候选只能补充当前发现结果里的 unresolved 记录，或新增未被发现的路由；不能改写已确定的页面。
 * @returns {{ ok, errors, written?, accepted? }}
 */
function submitCandidates({ projectRoot, stateDirAbs, discovery, input }) {
  const errors = [];
  const routes = Array.isArray(input?.routes) ? input.routes : null;
  if (!routes || routes.length === 0) return { ok: false, errors: ['输入必须是 { "routes": [ { "route", "entry", "reason", "recordId?", "layout?", "evidence?" } ] }'] };
  const unresolved = new Map(discovery.records.filter((r) => r.disposition === DISPOSITION.UNRESOLVED).map((r) => [r.recordId, r]));
  const discoveredRoutes = new Set(discovery.pages.map((p) => p.route));
  const accepted = [];
  routes.forEach((raw, i) => {
    const where = `routes[${i}]`;
    if (raw?.exclude) { errors.push(`${where}: AI 候选不能排除路由；需要排除时请人工写进 ${OVERRIDE_FILE}`); return; }
    const item = normalizeItem(projectRoot, raw, where, errors);
    if (!item) return;
    if (item.recordId && !unresolved.has(item.recordId)) {
      errors.push(`${where}: recordId ${item.recordId} 不是当前未解析的路由记录（可用：${[...unresolved.keys()].slice(0, 5).join('、') || '无'}）`);
      return;
    }
    if (!item.recordId && discoveredRoutes.has(item.route)) {
      errors.push(`${where}: 路由 ${item.route} 已由静态扫描确定，候选不能改写它；确需修正请人工写进 ${OVERRIDE_FILE}`);
      return;
    }
    // 候选依据的源码：显式 evidence + 入口 + 布局 + 未解析记录所在的定义文件
    const evidenceFiles = new Set([item.entry, ...item.layout]);
    if (item.recordId) evidenceFiles.add(unresolved.get(item.recordId).location?.file);
    for (const [j, file] of (Array.isArray(raw.evidence) ? raw.evidence : []).entries()) {
      const checked = checkFile(projectRoot, file, `${where}.evidence[${j}]`, errors);
      if (checked) evidenceFiles.add(checked);
    }
    const evidence = Object.fromEntries([...evidenceFiles].filter(Boolean).sort().map((rel) => [rel, hashFile(projectRoot, rel)]));
    accepted.push({ ...item, evidence });
  });
  if (errors.length) return { ok: false, errors };

  const file = path.join(stateDirAbs, CANDIDATES_FILE);
  const existing = readYaml(file);
  const keyOf = (item) => item.recordId || `route:${item.route}`;
  const merged = new Map((existing.doc && Array.isArray(existing.doc.routes) ? existing.doc.routes : []).map((item) => [keyOf(item), item]));
  for (const item of accepted) merged.set(keyOf(item), item);
  const header = [
    '# .manual/routes.candidates.yaml',
    '#',
    '# 由 `manual inspect --routes-input` 写入的 AI 路由候选（L3），作为扫描输入合并进路由发现结果。',
    '# evidence 记录候选依据的源码 hash：源码变化后候选自动过期，需要重新提交。不要手工编辑；',
    '# 需要人工修正时写 routes.override.yaml（L4，优先级更高）。',
    '',
  ].join('\n');
  writeText(file, header + yaml.dump({ version: 1, routes: [...merged.values()] }, { lineWidth: 120, noRefs: true }));
  return { ok: true, errors: [], written: file, accepted };
}

/**
 * 把 L3 / L4 输入合并进适配器的发现结果，重新判定去向、冲突与完整性。
 * 没有任何输入时原样返回（Next 等项目的结果逐字节不变）。
 */
function applyRouteInputs({ discovery, router, overrides, candidates }) {
  const inputs = [...overrides.items, ...candidates.items];
  const diagnostics = [...discovery.diagnostics];
  for (const s of candidates.stale) {
    diagnostics.push(`AI 路由候选已过期（${s.route}${s.recordId ? `，${s.recordId}` : ''}）：${s.changed.length ? `依据的源码已变化：${s.changed.join('、')}` : s.errors.join('；')}。需要重新提交。`);
  }
  if (inputs.length === 0) return diagnostics.length === discovery.diagnostics.length ? discovery : { ...discovery, diagnostics };

  const originalPages = new Map(discovery.pages.map((page) => [page.__recordId, page]));
  const records = discovery.records.map((record) => ({ ...record }));
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const toRecord = (item, recordId) => ({
    recordId, location: { file: item.entry }, rawPath: item.route, fullPath: item.route,
    disposition: DISPOSITION.PAGE, entry: item.entry, layoutChain: item.layout, isLayout: false,
    source: item.source, reason: undefined, props: null, meta: null,
  });

  // L4 先于 L3 处理；同一目标只取第一个（L4 胜出）
  const claimed = new Set();
  for (const item of [...overrides.items, ...candidates.items]) {
    if (item.exclude) {
      const target = byId.get(item.exclude);
      if (!target) { diagnostics.push(`${OVERRIDE_FILE}: exclude 的记录 ${item.exclude} 不存在`); continue; }
      Object.assign(target, { disposition: DISPOSITION.SKIPPED, reason: 'excluded', source: item.source });
      delete target.recordHash;
      claimed.add(item.exclude);
      continue;
    }
    const sameRoute = !item.recordId ? records.find((r) => r.disposition === DISPOSITION.PAGE && r.fullPath === item.route && r.source !== 'L3' && r.source !== 'L4') : null;
    const targetId = item.recordId || sameRoute?.recordId || `${item.source === 'L4' ? 'override' : 'candidate'}:${item.route}`;
    if (claimed.has(targetId)) continue;
    claimed.add(targetId);
    if (item.recordId && !byId.has(item.recordId)) {
      diagnostics.push(`${item.source === 'L4' ? OVERRIDE_FILE : CANDIDATES_FILE}: 记录 ${item.recordId} 已不存在（路由表可能改过），这一条未生效`);
      continue;
    }
    const replacement = toRecord(item, targetId);
    if (byId.has(targetId)) {
      const target = byId.get(targetId);
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, replacement);
      originalPages.delete(targetId);
    } else {
      records.push(replacement);
      byId.set(targetId, replacement);
    }
  }

  const generic = pageFromRecord(discovery.adapter, router);
  // 静态发现已经覆盖不到的项目（unsupported）：靠人工 / AI 补出来的路由不能宣称完整
  const detectStatus = discovery.detectStatus === 'unsupported' ? 'partial' : discovery.detectStatus;
  return finalizeDiscovery({
    adapter: discovery.adapter,
    records,
    routeSources: discovery.routeSources,
    diagnostics,
    detectStatus,
    toPage: (record) => originalPages.get(record.recordId) || generic(record),
    sortPages: true,
  });
}

module.exports = { CANDIDATES_FILE, OVERRIDE_FILE, readOverrides, readCandidates, submitCandidates, applyRouteInputs };
