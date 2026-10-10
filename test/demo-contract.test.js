'use strict';
/*
 * Demo Capture 契约（P1）：唯一模式 capture.mode: demo、capture.demo 配置校验、
 * Fixture 的 query 精确匹配与演示值、网络请求判定、门禁结论。不启动浏览器。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const yaml = require('js-yaml');

const demo = require('../src/privacy/demo');
const fixtures = require('../src/scenarios/fixtures');
const { loadConfig } = require('../src/config/load');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function initProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-demo-cfg-'));
  const r = require('child_process').spawnSync(process.execPath, [CLI, 'init', '--base-url', 'http://localhost:3000'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

test('init 生成的配置声明 capture.mode: demo，读回后带默认 demo 段', () => {
  const root = initProject();
  try {
    const text = fs.readFileSync(path.join(root, '.manual', 'config.yaml'), 'utf8');
    assert.match(text, /^  mode: demo$/m);
    const loaded = loadConfig(root);
    assert.equal(loaded.ok, true, (loaded.errors || []).join('\n'));
    assert.equal(loaded.config.capture.mode, 'demo');
    assert.deepEqual(loaded.config.capture.demo, { text: {}, images: {}, network: { allow: [], block: [], websockets: [] } });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('旧配置没有 capture.mode：按 demo 读取（兼容，不报错）', () => {
  const root = initProject();
  try {
    const file = path.join(root, '.manual', 'config.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^  mode: demo\n/m, ''));
    const loaded = loadConfig(root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.config.capture.mode, 'demo');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capture.mode 不是 demo：明确拒绝并给迁移说明，而不是静默回退', () => {
  const root = initProject();
  try {
    const file = path.join(root, '.manual', 'config.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^  mode: demo$/m, '  mode: real'));
    const loaded = loadConfig(root);
    assert.equal(loaded.ok, false);
    assert.match(loaded.errors.join('\n'), /capture\.mode 只支持 demo/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capture.demo 校验：键名、演示值、图片样式、网络规则', () => {
  const ok = demo.resolveDemoConfig({ demo: {
    text: { 'account-name': '演示教师', 'session-title': ['示例会话 A', '示例会话 B'], 'order-no': 'DEMO-{n}' },
    images: { 'account-avatar': 'initials' },
    network: { allow: [{ method: 'post', path: '/api/auth/refresh' }], block: [{ method: 'GET', path: '/api/logout' }] },
  } });
  assert.equal(ok.ok, true, (ok.errors || []).join('\n'));
  assert.deepEqual(ok.demo.text['session-title'], ['示例会话 A', '示例会话 B']);
  assert.equal(ok.demo.network.allow[0].method, 'POST');

  const bad = demo.resolveDemoConfig({ demo: { text: { 'bad key': 'x', empty: '' }, images: { a: 'mosaic' }, network: { allow: [{ path: 'api' }] } } });
  assert.equal(bad.ok, false);
  const errors = bad.errors.join('\n');
  assert.match(errors, /键名非法: bad key/);
  assert.match(errors, /empty 需要是非空字符串/);
  assert.match(errors, /images\.a 只能是 initials \/ blank/);
  assert.match(errors, /network\.allow\[0\]/);
});

test('演示值：数组按出现顺序循环，{n} 按序号展开', () => {
  assert.equal(demo.demoValueFor(['甲', '乙'], 0), '甲');
  assert.equal(demo.demoValueFor(['甲', '乙'], 3), '乙');
  assert.equal(demo.demoValueFor('示例会话 {n}', 4), '示例会话 5');
});

test('请求判定：只读放行、写请求默认阻断、登记放行、危险 GET、Mock、信标、已授权写步骤', () => {
  const network = demo.resolveDemoConfig({ demo: { network: {
    allow: [{ method: 'POST', path: '/api/search' }],
    block: [{ method: 'GET', path: '/api/logout' }],
  } } }).demo.network;
  const at = (p, origin = 'http://app.test') => new URL(p, origin);
  const c = (method, p, extra = {}) => demo.classifyRequest({ method, url: at(p), network, ...extra });
  assert.equal(c('GET', '/api/sessions'), 'pass');
  assert.equal(c('POST', '/api/sessions'), 'block');
  assert.equal(c('DELETE', '/api/sessions/1'), 'block');
  assert.equal(c('PATCH', '/api/profile'), 'block');
  assert.equal(c('POST', '/api/search'), 'allow');
  assert.equal(c('GET', '/api/logout'), 'block', 'GET 也可能有副作用：登记后阻断');
  assert.equal(c('DELETE', '/api/sessions/1', { mocked: true }), 'mock', 'Fixture 完整模拟的写请求不碰后端');
  assert.equal(c('POST', '/collect', { resourceType: 'ping' }), 'suppress');
  assert.equal(c('POST', '/api/sessions', { writeOrigin: 'http://app.test' }), 'authorized');
  assert.equal(c('POST', '/api/sessions', { writeOrigin: 'http://other.test' }), 'block', '授权只对登记站点有效');
});

test('门禁结论：passed / needs_fixture / blocked 与原因码', () => {
  const passed = demo.decide({ audit: { replaced: { 'account-name': 1 } }, guard: { mocked: ['GET /api/x'] } });
  assert.equal(passed.status, 'passed');
  assert.deepEqual(passed.sources, { public: true, api_mock: 1, dom_replace: 1 });

  const needs = demo.decide({ audit: { unconfigured: ['session-title', 'session-title'] }, guard: {} });
  assert.equal(needs.status, 'needs_fixture');
  assert.equal(needs.reasons[0].code, 'demo-text-unconfigured');
  assert.equal(needs.reasons[0].detail, 'session-title');

  const leaked = demo.decide({ audit: { unconfigured: ['x'], leaks: [{ surface: 'text' }, { surface: 'attribute' }] }, guard: {} });
  assert.equal(leaked.status, 'blocked', '任何 blocked 原因优先于 needs_fixture');
  assert.match(leaked.reasons.find((r) => r.code === 'original-value-leaked').detail, /2 处（attribute, text）/);

  const write = demo.decide({ audit: {}, guard: { blocked: [{ method: 'DELETE', path: '/api/sessions/1' }] } });
  assert.equal(write.status, 'blocked');
  assert.equal(write.reasons[0].code, 'write-blocked');

  const ws = demo.decide({ audit: {}, guard: { websockets: [{ path: '/ws', allowed: false }, { path: '/ok', allowed: true }] } });
  assert.equal(ws.status, 'needs_fixture');
  assert.equal(ws.reasons[0].detail, '/ws');
});

test('未声明的手机号 / 邮箱：演示值与保留域名不算；记录里不写命中的原文', () => {
  const config = { text: { 'account-phone': '13800000000' } };
  const r = demo.decide({ audit: { contacts: ['13800000000', 'demo@example.com', '13912345678'] }, guard: {}, demo: config });
  assert.equal(r.status, 'needs_fixture');
  const reason = r.reasons.find((x) => x.code === 'undeclared-sensitive-text');
  assert.equal(reason.detail, '1 处（phone）');
  assert.doesNotMatch(JSON.stringify(r), /13912345678/);
});

test('原始值残留检查：短值与短数字不参与，长文本与长号码参与（不依赖正则识别隐私）', () => {
  assert.equal(demo.leakCheckable('张'), false);
  assert.equal(demo.leakCheckable('120'), false);
  assert.equal(demo.leakCheckable('12,480'), true);
  assert.equal(demo.leakCheckable('王同学数学基础薄弱，需要家长配合'), true);
});

test('门禁错误：带原因码与修复建议，code 区分 blocked / needs-fixture', () => {
  const error = demo.demoGateError(demo.decide({ audit: { unconfigured: ['account-name'] } }));
  assert.equal(error.code, 'demo-needs-fixture');
  assert.match(error.message, /demo-text-unconfigured（account-name）/);
  assert.match(error.message, /capture\.demo\.text/);
  assert.equal(demo.demoGateError(demo.decide({ guard: { blocked: [{ method: 'POST', path: '/x' }] } })).code, 'demo-blocked');
});

test('Fixture：query 精确匹配进入路由；demo 演示值随数据准备返回；demo.network 被拒绝', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-demo-fx-'));
  try {
    const state = path.join(root, '.manual');
    const dir = fixtures.fixturesDirFor(state);
    fs.mkdirSync(dir, { recursive: true });
    const def = {
      schemaVersion: 1, id: 'orders-demo', version: 1, kind: 'mock', environments: ['local'], sideEffectClass: 'none',
      mock: { routes: [{ path: '/api/orders', method: 'GET', query: { page: 2 }, json: { items: [] } }] },
      demo: { text: { 'account-name': '演示教师' } },
    };
    fs.writeFileSync(path.join(dir, 'orders-demo.yaml'), yaml.dump(def));
    const config = { project: { baseUrl: 'http://127.0.0.1:3000' }, fixtures: { environments: { local: { origins: ['http://127.0.0.1:*'] } } } };
    const data = fixtures.prepareScenarioData({ stateDirAbs: state, config, scenario: { id: 's', environment: 'local', data: { mode: 'fixture', fixture: 'orders-demo' } } });
    assert.equal(data.mode, 'simulated');
    assert.deepEqual(data.routes[0].query, { page: '2' });
    assert.deepEqual(data.demo.text, { 'account-name': '演示教师' });

    fs.writeFileSync(path.join(dir, 'orders-demo.yaml'), yaml.dump({ ...def, demo: { network: { allow: [] } }, mock: { routes: [{ path: '/api/orders', query: ['x'] }] } }));
    assert.throws(() => fixtures.readFixture(state, 'orders-demo'), (e) => /query 需要是/.test(e.message) && /demo\.network 只能在 config\.yaml/.test(e.message));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mergeDemo：Fixture 演示值覆盖项目级；网络放行只认项目级', () => {
  const project = { text: { a: ['1'], b: ['2'] }, images: {}, network: { allow: [{ path: '/x' }], block: [], websockets: [] } };
  const merged = demo.mergeDemo(project, { text: { b: '覆盖' }, network: { allow: [{ path: '/evil' }] } });
  assert.deepEqual(merged.text, { a: ['1'], b: '覆盖' });
  assert.deepEqual(merged.network.allow, [{ path: '/x' }]);
});

test('verify 的 Demo 结果：demo_privacy 与 write_safety 分开汇总，旧证据记为 legacy', () => {
  const { summarizeDemoSafety } = require('../src/verify/demo-safety');
  const passed = { privacy: { demo: { status: 'passed', sources: { api_mock: 1, dom_replace: 3 }, network: { mocked: 1, allowed: 2, blocked: 0 }, surfaces: { iframe: 1, canvas: 0 } } } };
  const legacy = { privacy: { status: 'passed' } };
  const all = summarizeDemoSafety([passed, passed]);
  assert.equal(all.demo_privacy.status, 'passed');
  assert.deepEqual(all.demo_privacy.sources, { api_mock: 2, dom_replace: 6 });
  assert.equal(all.demo_privacy.unverifiedSurfaces, 2);
  assert.deepEqual({ status: all.write_safety.status, blocked: all.write_safety.blockedWrites, allowed: all.write_safety.allowed }, { status: 'passed', blocked: 0, allowed: 4 });
  const mixed = summarizeDemoSafety([passed, legacy]);
  assert.equal(mixed.demo_privacy.status, 'legacy');
  assert.equal(mixed.demo_privacy.legacy, 1);
  assert.equal(summarizeDemoSafety([legacy]).write_safety.status, 'unknown');
});

test('没写键名的 data-redact：用 * 配置演示值', () => {
  const r = demo.resolveDemoConfig({ demo: { text: { '*': '示例内容' } } });
  assert.equal(r.ok, true, (r.errors || []).join('\n'));
  assert.deepEqual(r.demo.text['*'], ['示例内容']);
  assert.equal(demo.resolveDemoConfig({ demo: { text: { '**': 'x' } } }).ok, false);
});

test('verify 判错：只有记录显示门禁失败或写请求被中止才失败，legacy 只提示', () => {
  const { summarizeDemoSafety, demoSafetyErrors } = require('../src/verify/demo-safety');
  const legacy = summarizeDemoSafety([{ privacy: { status: 'passed' } }]);
  assert.deepEqual(demoSafetyErrors(legacy), []);
  const failed = summarizeDemoSafety([{ privacy: { demo: { status: 'blocked' } } }]);
  assert.match(demoSafetyErrors(failed).join('\n'), /demo-privacy-failed: 1 张图/);
  const writes = summarizeDemoSafety([{ privacy: { demo: { status: 'passed', network: { blocked: 2 } } } }]);
  assert.match(demoSafetyErrors(writes).join('\n'), /write-safety-failed: 采集期间有 2 个写请求/);
});
