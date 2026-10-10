'use strict';

/*
 * 受控 Fixture（P3-05）。只有两类，都必须事先登记在 .manual/fixtures/<id>.yaml：
 *
 *   kind: mock   BrowserContext 请求拦截返回静态响应；不碰后端。
 *                由此得到的 Capture 标 provenance.mode = simulated：只证明"界面如何呈现这种数据"，
 *                不能证明真实后端保存成功，完成声明因此不能是 verified。
 *   kind: hook   专用测试环境的登记 setup / cleanup 模块（.manual/fixtures/ 下的 Node 模块，导出 setup / cleanup）；
 *                数据写在按 Run 划分的命名空间里，setup / cleanup 是独立的 RuntimeTask，中断后可幂等清理。
 *
 * 不执行来自模型或命令行的任意 shell / JS：模块路径只能位于 .manual/fixtures/ 内且在定义里登记。
 * Secret 只以引用出现（env:NAME），运行时解析后传给 hook，不写入任何记录。
 *
 * 定义示例：
 *   schemaVersion: 1
 *   id: dashboard-empty
 *   version: 1
 *   kind: mock
 *   environments: [local]
 *   dataset: demo/empty-week            # 数据集引用（只含演示值）
 *   sideEffectClass: none
 *   mock:
 *     routes:
 *       - { path: /api/stats, method: GET, status: 200, json: { users: 0 } }
 *       - { path: /api/report, status: 500, bodyFile: data/error.html, contentType: text/html }
 *       - { path: /api/orders, method: GET, query: { page: '2' }, json: { items: [] } }   # query：这些参数必须完全相等
 *   demo:                               # 可选：本 Fixture 的演示值，覆盖 / 补充 config 的 capture.demo
 *     text: { account-name: 演示教师 }
 *   # 或 kind: hook
 *   hook: { module: hooks/seed-orders.js, secrets: { token: env:FIXTURE_API_TOKEN } }
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { isSafeId } = require('../model/ids');
const { revisionOf, sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { RuntimeError } = require('../runtime/errors');

const KINDS = ['mock', 'hook'];
const SIDE_EFFECTS = ['none', 'isolated-test-data'];
const SECRET_REF = /^env:[A-Z_][A-Z0-9_]*$/;

function fixturesDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'fixtures');
}

function inside(root, file) {
  const rel = path.relative(root, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 校验 Fixture 定义；返回错误列表。 */
function validateFixture(def, dir) {
  const errors = [];
  if (!def || typeof def !== 'object') return ['Fixture 需要是对象。'];
  if (def.schemaVersion !== 1) errors.push('schemaVersion 需要是 1。');
  if (!isSafeId(def.id)) errors.push(`id 非法: ${def.id}`);
  if (!Number.isInteger(def.version) || def.version < 1) errors.push('version 需要是正整数。');
  if (!KINDS.includes(def.kind)) errors.push(`kind 需要是 ${KINDS.join(' / ')}。`);
  if (!Array.isArray(def.environments) || def.environments.length === 0) errors.push('environments 需要是非空数组（允许使用的环境）。');
  if (!SIDE_EFFECTS.includes(def.sideEffectClass)) errors.push(`sideEffectClass 需要是 ${SIDE_EFFECTS.join(' / ')}。`);
  if (def.kind === 'mock') {
    if (def.sideEffectClass !== 'none') errors.push('mock 类 Fixture 的 sideEffectClass 必须是 none。');
    const routes = def.mock?.routes;
    if (!Array.isArray(routes) || routes.length === 0) errors.push('mock.routes 需要是非空数组。');
    else routes.forEach((route, i) => {
      if (typeof route?.path !== 'string' || !route.path.startsWith('/')) errors.push(`mock.routes[${i}].path 需要是以 / 开头的路径（可含 *）。`);
      if (route?.status !== undefined && !(Number.isInteger(route.status) && route.status >= 100 && route.status < 600)) errors.push(`mock.routes[${i}].status 非法。`);
      if (route?.bodyFile !== undefined && (typeof route.bodyFile !== 'string' || !inside(dir, path.resolve(dir, route.bodyFile)))) errors.push(`mock.routes[${i}].bodyFile 必须位于 .manual/fixtures/ 内。`);
      if (route?.query !== undefined && (!route.query || typeof route.query !== 'object' || Array.isArray(route.query) || Object.values(route.query).some((v) => typeof v !== 'string' && typeof v !== 'number'))) errors.push(`mock.routes[${i}].query 需要是 { 参数名: 值 } 对象。`);
    });
  }
  if (def.demo !== undefined) {
    const { resolveDemoConfig } = require('../privacy/demo');
    const checked = resolveDemoConfig({ demo: { text: def.demo?.text, images: def.demo?.images } });
    if (!checked.ok) errors.push(...checked.errors.map((e) => e.replace('capture.demo', 'demo')));
    if (def.demo?.network !== undefined) errors.push('demo.network 只能在 config.yaml 的 capture.demo.network 中声明（网络放行属于项目级安全策略）。');
  }
  if (def.kind === 'hook') {
    const mod = def.hook?.module;
    if (typeof mod !== 'string' || !inside(dir, path.resolve(dir, mod)) || !/\.c?js$/.test(mod)) errors.push('hook.module 必须是 .manual/fixtures/ 内登记的 .js 模块。');
    for (const [name, ref] of Object.entries(def.hook?.secrets || {})) {
      if (!SECRET_REF.test(String(ref))) errors.push(`hook.secrets.${name} 只能是引用（env:NAME），不能写明文。`);
    }
  }
  return errors;
}

/** 读取已登记的 Fixture；不存在 / 不合法抛 RuntimeError。 */
function readFixture(stateDirAbs, id) {
  const dir = fixturesDirFor(stateDirAbs);
  if (!isSafeId(id)) throw new RuntimeError('fixture-invalid', `Fixture id 非法: ${id}`);
  const file = path.join(dir, `${id}.yaml`);
  if (!fs.existsSync(file)) throw new RuntimeError('fixture-missing', `Fixture ${id} 没有登记（缺少 .manual/fixtures/${id}.yaml）。`);
  let def;
  try { def = yaml.load(fs.readFileSync(file, 'utf8')); } catch (error) { throw new RuntimeError('fixture-invalid', `${id}.yaml: ${error.message}`); }
  const errors = validateFixture(def, dir);
  if (errors.length) throw new RuntimeError('fixture-invalid', `Fixture ${id} 不合法：${errors.join(' ')}`, { errors });
  if (def.id !== id) throw new RuntimeError('fixture-invalid', `${id}.yaml 的 id 是 ${def.id}。`);
  return { ...def, dir };
}

/** Fixture revision：定义（secret 只有引用）+ 引用的数据文件 / 模块内容。任何变化都让相关 Capture 失效。 */
function fixtureRevision(fixture) {
  const files = {};
  const add = (rel) => { const full = path.resolve(fixture.dir, rel); files[rel] = fs.existsSync(full) ? sha256Hex(fs.readFileSync(full)) : 'missing'; };
  for (const route of fixture.mock?.routes || []) if (route.bodyFile) add(route.bodyFile);
  if (fixture.hook?.module) add(fixture.hook.module);
  const { dir: _dir, ...definition } = fixture;
  return revisionOf({ definition, files });
}

/** Scenario 的数据描述 → 缓存 key 使用的数据 revision；live 与 fixture 永不相同。 */
function dataRevisionFor(stateDirAbs, scenario) {
  if (scenario?.data?.mode !== 'fixture') return scenario?.data?.revision ?? undefined;
  const fixture = readFixture(stateDirAbs, scenario.data.fixture);
  return `fixture:${fixture.id}:${fixtureRevision(fixture)}`;
}

function globToRegex(pattern) {
  return new RegExp(`^${String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

/** mock 路由 → provider.installRoutes 使用的静态响应（响应体在此读入，不在浏览器内执行任何脚本）。 */
function mockRoutes(fixture) {
  return (fixture.mock?.routes || []).map((route) => {
    let body = '';
    let contentType = route.contentType || null;
    if (route.json !== undefined) { body = JSON.stringify(route.json); contentType = contentType || 'application/json'; }
    else if (route.bodyFile) body = fs.readFileSync(path.resolve(fixture.dir, route.bodyFile));
    else if (route.body !== undefined) body = String(route.body);
    const query = route.query ? Object.fromEntries(Object.entries(route.query).map(([k, v]) => [k, String(v)])) : null;
    return { path: route.path, matcher: globToRegex(route.path), method: route.method ? String(route.method).toUpperCase() : null, query, status: route.status || 200, contentType: contentType || 'text/plain; charset=utf-8', body };
  });
}

/** 按 Run 划分的测试数据命名空间：确定性，setup 中断后 cleanup 仍能找到同一批数据。 */
function namespaceFor(runId, fixtureId) {
  return `manual-${String(runId).replace(/-/g, '').slice(0, 12)}-${fixtureId}`;
}

function resolveSecrets(fixture, env = process.env) {
  const out = {};
  for (const [name, ref] of Object.entries(fixture.hook?.secrets || {})) {
    const key = String(ref).slice('env:'.length);
    if (env[key] === undefined) throw new RuntimeError('fixture-secret-missing', `Fixture ${fixture.id} 需要的 secret ${name}（${ref}）没有提供。`);
    out[name] = env[key];
  }
  return out;
}

function stateFileFor(stateDirAbs, runId, fixtureId) {
  return path.join(stateDirAbs, 'runs', runId, 'fixtures', `${fixtureId}.json`);
}

function readFixtureState(stateDirAbs, runId, fixtureId) {
  const file = stateFileFor(stateDirAbs, runId, fixtureId);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function writeFixtureState(stateDirAbs, runId, fixtureId, state) {
  const file = stateFileFor(stateDirAbs, runId, fixtureId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

/** 只保留可序列化的非敏感输出（hook 返回的 token 用于 cleanup；不含 secret）。 */
function publicToken(value, secrets) {
  const text = JSON.stringify(value ?? null);
  for (const secret of Object.values(secrets)) {
    if (secret && text.includes(String(secret))) throw new RuntimeError('fixture-secret-leak', 'hook 的返回值包含 secret，拒绝保存。');
  }
  return JSON.parse(text);
}

/**
 * 执行登记的 hook。
 * @param {'setup'|'cleanup'} phase
 */
async function runHook(fixture, phase, { namespace, baseUrl, token = null, env = process.env }) {
  const modulePath = path.resolve(fixture.dir, fixture.hook.module);
  const secrets = resolveSecrets(fixture, env);
  // 每次重新加载：模块内容参与 fixture revision，缓存的旧模块不能冒充新定义
  delete require.cache[require.resolve(modulePath)];
  const mod = require(modulePath);
  if (typeof mod[phase] !== 'function') throw new RuntimeError('fixture-invalid', `Fixture ${fixture.id} 的模块没有导出 ${phase}()。`);
  const result = await mod[phase]({ namespace, baseUrl, dataset: fixture.dataset || null, token, secrets });
  return publicToken(result, secrets);
}

module.exports = {
  KINDS, SIDE_EFFECTS, fixturesDirFor, validateFixture, readFixture, fixtureRevision, dataRevisionFor, mockRoutes,
  namespaceFor, resolveSecrets, stateFileFor, readFixtureState, writeFixtureState, runHook,
};

/**
 * 采集前的数据准备：live 直接返回；fixture 先过环境策略，再给出拦截路由（mock）或确认 setup 已完成（hook）。
 * @returns {{ mode: 'live'|'simulated'|'fixture', routes, fixture: { id, revision, kind, namespace? } | null }}
 */
function prepareScenarioData({ stateDirAbs, config, scenario, runId = null }) {
  if (scenario?.data?.mode !== 'fixture') return { mode: 'live', routes: [], fixture: null, demo: null };
  const { checkFixtureAllowed } = require('./policy');
  const fixture = readFixture(stateDirAbs, scenario.data.fixture);
  checkFixtureAllowed({ fixture, scenario, config });
  const ref = { id: fixture.id, version: fixture.version, revision: fixtureRevision(fixture), kind: fixture.kind, dataset: fixture.dataset || null };
  const demo = fixture.demo ? { text: fixture.demo.text || {}, images: fixture.demo.images || {} } : null;
  if (fixture.kind === 'mock') return { mode: 'simulated', routes: mockRoutes(fixture), fixture: ref, demo };
  const state = runId ? readFixtureState(stateDirAbs, runId, fixture.id) : null;
  if (!state || state.status !== 'active') {
    throw new RuntimeError('fixture-setup-required', `Scenario ${scenario.id} 使用 hook Fixture ${fixture.id}：需要在 Run 中先执行 fixture-setup（用 manual capture / generate 规划执行，而不是直接采集）。`);
  }
  return { mode: 'fixture', routes: [], fixture: { ...ref, namespace: state.namespace }, demo };
}

module.exports.prepareScenarioData = prepareScenarioData;
