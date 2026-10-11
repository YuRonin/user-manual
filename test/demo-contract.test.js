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
    assert.deepEqual(loaded.config.capture.demo, { text: {}, images: {}, selectors: {}, surfaces: [], network: { allow: [], block: [], websockets: [] } });
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
  assert.equal(c('GET', '/api/sessions'), 'pass', '静态资源 / 文档请求');
  assert.equal(c('GET', '/api/sessions', { resourceType: 'fetch' }), 'unverified', '没有 Fixture 的数据读取：放行但记录');
  assert.equal(c('GET', '/stream', { resourceType: 'eventsource' }), 'unverified');
  assert.equal(c('OPTIONS', '/api/sessions', { resourceType: 'fetch' }), 'pass', '预检请求不承载数据');
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
  assert.deepEqual(passed.sources, { public: true, fixture: 0, api_mock: 1, dom_replace: 1 });
  assert.deepEqual(passed.kinds, ['public', 'api_mock', 'dom_replace']);

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

test('数据读取：登记的只读接口放行；GraphQL 按 operationName 精确登记', () => {
  const network = demo.resolveDemoConfig({ demo: { network: {
    allow: [{ method: 'GET', path: '/api/announcements' }, { method: 'POST', path: '/graphql', operationName: 'ListCourses' }],
  } } }).demo.network;
  const at = (p) => new URL(p, 'http://app.test');
  assert.equal(demo.classifyRequest({ method: 'GET', url: at('/api/announcements'), resourceType: 'fetch', network }), 'allow');
  assert.equal(demo.classifyRequest({ method: 'POST', url: at('/graphql'), resourceType: 'fetch', network, operationName: 'ListCourses' }), 'allow');
  assert.equal(demo.classifyRequest({ method: 'POST', url: at('/graphql'), resourceType: 'fetch', network, operationName: 'DeleteCourse' }), 'block', '同一路径的其它操作仍按写请求阻断');
  assert.equal(demo.operationNameOf(at('/graphql'), JSON.stringify({ operationName: 'ListCourses', variables: { secret: 'x' } })), 'ListCourses');
  assert.equal(demo.operationNameOf(at('/graphql?operationName=Q1'), null), 'Q1');
  assert.equal(demo.operationNameOf(at('/graphql'), 'not json'), null);
  assert.equal(demo.resolveDemoConfig({ demo: { network: { allow: [{ path: '/graphql', operationName: '' }] } } }).ok, false);
});

test('未覆盖的数据读取：页面有敏感区域 → needs_fixture（demo-unmocked-read）；没有敏感区域只记录', () => {
  const uncovered = [{ method: 'GET', path: '/api/profile', kind: 'same-origin' }, { method: 'GET', path: 'https://cdn.example.com/me', kind: 'cross-origin' }];
  const withRegions = demo.decide({ audit: { replaced: { 'account-name': 1 }, realValues: 1 }, guard: { uncovered } });
  assert.equal(withRegions.status, 'needs_fixture');
  const reason = withRegions.reasons.find((r) => r.code === 'demo-unmocked-read');
  assert.match(reason.detail, /GET \/api\/profile/);
  assert.match(reason.detail, /cross-origin/);
  assert.match(reason.hint, /capture\.demo\.network\.allow/);
  const publicPage = demo.decide({ audit: {}, guard: { uncovered } });
  assert.equal(publicPage.status, 'passed', '没有声明敏感区域的公开页面不因读取接口而阻断');
  assert.equal(publicPage.network.uncovered, 2);
  assert.equal(publicPage.realDataInBrowser, true, '真实数据进入过浏览器必须如实记录');
  assert.equal(demo.decide({ audit: { replaced: { a: 1 } }, guard: { mocked: ['GET /x'] } }).realDataInBrowser, false);
});

test('无法审计的区域：有敏感区域时 iframe / canvas / shadow → needs_fixture；登记 surfaces 后通过', () => {
  const audit = { replaced: { a: 1 }, surfaces: { iframe: 1, canvas: 0, shadow: 2 } };
  const r = demo.decide({ audit, guard: {} });
  assert.equal(r.status, 'needs_fixture');
  assert.equal(r.reasons[0].code, 'demo-surface-unaudited');
  assert.equal(r.reasons[0].detail, 'iframe × 1, shadow × 2');
  const config = demo.resolveDemoConfig({ demo: { surfaces: ['iframe', 'shadow'] } }).demo;
  assert.equal(demo.decide({ audit, guard: {}, demo: config }).status, 'passed');
  assert.equal(demo.resolveDemoConfig({ demo: { surfaces: ['video'] } }).ok, false);
  assert.equal(demo.decide({ audit: { surfaces: { canvas: 3 } }, guard: {} }).status, 'passed', '公开页面的图表不阻断');
});

test('选择器声明：校验键名与选择器；无法解析的选择器 → needs_fixture；Fixture 可补充选择器', () => {
  const ok = demo.resolveDemoConfig({ demo: { selectors: { 'account-name': '.user .name' }, text: { 'account-name': '演示教师' } } });
  assert.equal(ok.ok, true, (ok.errors || []).join('\n'));
  assert.deepEqual(ok.demo.selectors, { 'account-name': '.user .name' });
  const bad = demo.resolveDemoConfig({ demo: { selectors: { '*': '.x', name: '' } } });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join('\n'), /键名非法: \*/);
  assert.match(bad.errors.join('\n'), /name 需要是非空的 CSS 选择器/);
  const r = demo.decide({ audit: { invalidSelectors: ['name'] }, guard: {} });
  assert.equal(r.reasons[0].code, 'demo-selector-invalid');
  const merged = demo.mergeDemo(ok.demo, { selectors: { 'session-title': 'li.t' } });
  assert.deepEqual(merged.selectors, { 'account-name': '.user .name', 'session-title': 'li.t' });
});

test('数据来源记录：Fixture 路由命中与未命中、hook Fixture、被阻断时的 blocked 类别', () => {
  const guard = { mocked: ['GET /api/a'], routes: [{ rule: 'GET /api/a', hits: 1 }, { rule: '* /api/old', hits: 0 }] };
  const r = demo.decide({ audit: {}, guard, demo: { dataMode: 'fixture' } });
  assert.deepEqual(r.mock, { routes: [{ rule: 'GET /api/a', hits: 1 }, { rule: '* /api/old', hits: 0 }], unhit: ['* /api/old'] });
  assert.equal(r.sources.fixture, 1);
  assert.deepEqual(r.kinds, ['public', 'fixture', 'api_mock']);
  assert.deepEqual(demo.decide({ guard: { blocked: [{ method: 'POST', path: '/x' }] } }).kinds, ['public', 'blocked']);
});

test('Fixture 响应结构：shape 校验字段、列表元素与唯一 id；JSON 无法解析被拒绝；跨域路由需要合法 origin', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-demo-shape-'));
  try {
    const state = path.join(root, '.manual');
    const dir = fixtures.fixturesDirFor(state);
    fs.mkdirSync(dir, { recursive: true });
    const base = { schemaVersion: 1, id: 'list-demo', version: 1, kind: 'mock', environments: ['local'], sideEffectClass: 'none' };
    const write = (routes) => fs.writeFileSync(path.join(dir, 'list-demo.yaml'), yaml.dump({ ...base, mock: { routes } }));
    const shape = { required: ['items', 'total'], items: { field: 'items', required: ['id', 'title'] } };
    write([{ path: '/api/list', json: { items: [{ id: 1, title: '示例' }, { id: 2, title: '示例 2' }], total: 2 }, shape }]);
    assert.equal(fixtures.readFixture(state, 'list-demo').id, 'list-demo');
    write([{ path: '/api/list', json: { items: [{ id: 1 }, { id: 1, title: 'x' }] }, shape }]);
    assert.throws(() => fixtures.readFixture(state, 'list-demo'), (e) => /缺少字段: total/.test(e.message) && /items\[0\] 缺少字段: title/.test(e.message) && /id 重复: 1/.test(e.message));
    write([{ path: '/api/list', body: '{bad', contentType: 'application/json' }]);
    assert.throws(() => fixtures.readFixture(state, 'list-demo'), /JSON 响应体无法解析/);
    write([{ path: '/v1/me', origin: 'https://api.example.com/v1', json: {} }]);
    assert.throws(() => fixtures.readFixture(state, 'list-demo'), /origin 需要是 http\(s\):\/\/主机/);
    write([{ path: '/v1/me', origin: 'https://*.example.com', json: { name: '演示教师' } }]);
    const routes = fixtures.mockRoutes(fixtures.readFixture(state, 'list-demo'));
    assert.ok(routes[0].origin.test('https://api.example.com'));
    assert.ok(!routes[0].origin.test('https://example.org'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('门禁失败记录：只存原因码；之后的重新采集被阻断才算 recapture-blocked；采集成功即清除', () => {
  const log = require('../src/evidence/demo-gate-log');
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-demo-gate-'));
  try {
    const key = log.subjectKey(['page', 'chat', 'page-chat']);
    assert.equal(key, 'page--chat--page-chat');
    assert.equal(log.recordGateFailure(state, key, new Error('普通错误')), null, '不是 Demo 门禁错误不记录');
    const error = demo.demoGateError(demo.decide({ audit: { replaced: { a: 1 } }, guard: { uncovered: [{ method: 'GET', path: '/api/me', kind: 'same-origin' }] } }));
    const entry = log.recordGateFailure(state, key, error);
    assert.deepEqual({ status: entry.status, reasons: entry.reasons }, { status: 'needs_fixture', reasons: ['demo-unmocked-read'] });
    assert.doesNotMatch(fs.readFileSync(path.join(state, 'evidence', 'demo-gate', `${key}.json`), 'utf8'), /\/api\/me/, '不写 detail');
    assert.equal(log.recaptureBlocked(state, key, '2000-01-01T00:00:00.000Z').reasons[0], 'demo-unmocked-read');
    assert.equal(log.recaptureBlocked(state, key, '2999-01-01T00:00:00.000Z'), null, '失败早于手册引用的截图：不提示');
    log.clearGateFailure(state, key);
    assert.equal(log.readGateFailure(state, key), null);
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test('generate 质量提示：旧证据 demo-evidence-legacy、重新采集被阻断 demo-recapture-blocked，可由 quality.blockOn 升级为阻断', () => {
  const { packWarnings, qualityGate, validateQualityConfig } = require('../src/generate/quality-summary');
  const pack = { kind: 'page', artifacts: [
    { id: 'img-1', privacy: { status: 'passed' } },
    { id: 'img-2', privacy: { status: 'passed', demo: { status: 'passed' } }, demoRecapture: { reasons: ['demo-unmocked-read'] } },
    { id: 'img-3', privacy: { status: 'passed', demo: { status: 'passed' } } },
  ] };
  const warnings = packWarnings(pack);
  assert.ok(warnings.includes('demo-evidence-legacy:img-1'));
  assert.ok(warnings.some((w) => w.startsWith('demo-recapture-blocked:img-2（demo-unmocked-read）')));
  assert.equal(warnings.filter((w) => /img-3/.test(w)).length, 0);
  assert.deepEqual(qualityGate(pack, {}), []);
  const errors = [];
  validateQualityConfig({ blockOn: ['demo-recapture-blocked'] }, errors);
  assert.deepEqual(errors, []);
  assert.equal(qualityGate(pack, { quality: { blockOn: ['demo-recapture-blocked'] } })[0].code, 'quality-blocked');
});

test('verify 的 Demo 指标：遮罩面积、Fixture 命中、未覆盖读取、真实数据进入浏览器、门禁失败分布', () => {
  const { summarizeDemoSafety } = require('../src/verify/demo-safety');
  const shot = (extra) => ({ quality: { maskedAreaUpperBound: 0 }, privacy: { demo: { status: 'passed', network: { uncovered: 0 }, mock: { routes: [], unhit: [] }, ...extra } } });
  const records = [
    shot({ mock: { routes: [{ rule: 'GET /a', hits: 2 }, { rule: 'GET /b', hits: 0 }], unhit: ['GET /b'] } }),
    shot({ realDataInBrowser: true, network: { uncovered: 1 } }),
    { quality: { maskedAreaUpperBound: 0.3 }, privacy: { status: 'passed' } },
  ];
  const failures = [{ status: 'needs_fixture', reasons: ['demo-unmocked-read'] }, { status: 'blocked', reasons: ['original-value-leaked', 'demo-unmocked-read'] }];
  const { metrics } = summarizeDemoSafety(records, { gateFailures: failures });
  assert.deepEqual(metrics.maskedArea, { mean: 0.1, max: 0.3, heavilyRedacted: 1 });
  assert.deepEqual(metrics.mock, { rules: 2, hits: 2, unhit: ['GET /b'] });
  assert.equal(metrics.uncoveredReads, 1);
  assert.equal(metrics.realDataInBrowser, 1);
  assert.deepEqual(metrics.gateFailures, { total: 2, blocked: 1, needsFixture: 1, reasons: { 'demo-unmocked-read': 2, 'original-value-leaked': 1 } });
});
