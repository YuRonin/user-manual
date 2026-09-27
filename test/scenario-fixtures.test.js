'use strict';

/*
 * P3-05：受控 Fixture 与多角色 Scenario。
 * 单元：Fixture 定义校验、环境策略（生产 / 未登记 / origin / 租户）、数据 revision、命名空间。
 * 端到端（真实浏览器 + CLI）：
 *   - mock Fixture 的 Scenario 变体：simulated 标识、不替换页面默认截图、与 live 采集缓存互不命中
 *   - 生产 / 未登记环境：规划即拒绝，不启动浏览器、不执行 setup
 *   - hook Fixture：setup → capture → cleanup；采集失败也清理；清理失败报告 fixture-cleanup-required，resume 后幂等清理；
 *     secret 值不落盘
 *   - 多角色：成员与匿名 Scenario 使用独立 Context 与认证档案
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const cache = require('../src/auth/cache');
const fixtures = require('../src/scenarios/fixtures');
const { checkFixtureAllowed } = require('../src/scenarios/policy');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

async function expectExit(root, args, exit, env) {
  const r = await cli(root, args, env);
  assert.strictEqual(r.status, exit, `manual ${args.join(' ')} 应以 ${exit} 退出\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const writeYaml = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, yaml.dump(value)); };
const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);

function allFiles(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out.push(f); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

const CONFIG = { project: { baseUrl: 'http://127.0.0.1:4100' }, fixtures: { environments: { local: { origins: ['http://127.0.0.1:*'] }, test: { origins: ['https://test.example.com'], tenant: 'acme' } } } };
const MOCK = { schemaVersion: 1, id: 'm', version: 1, kind: 'mock', environments: ['local'], sideEffectClass: 'none', mock: { routes: [{ path: '/api/*', json: { ok: true } }] } };

(async () => {
  process.stdout.write('\nscenario fixtures\n');

  await step('Fixture 定义校验：明文 secret、模块越界、mock 带副作用都拒绝', () => {
    const dir = '/tmp/fixtures';
    assert.deepStrictEqual(fixtures.validateFixture(MOCK, dir), []);
    assert.ok(fixtures.validateFixture({ ...MOCK, sideEffectClass: 'isolated-test-data' }, dir).some((e) => /mock 类/.test(e)));
    const hook = { ...MOCK, kind: 'hook', sideEffectClass: 'isolated-test-data', mock: undefined, hook: { module: '../evil.js', secrets: { token: 'plain-secret' } } };
    const errors = fixtures.validateFixture(hook, dir);
    assert.ok(errors.some((e) => /hook.module/.test(e)));
    assert.ok(errors.some((e) => /只能是引用/.test(e)));
  });

  await step('环境策略：生产 / 未登记 / origin 不匹配 / 租户不符 / Fixture 不允许的环境 → fixture-policy-denied', () => {
    const allowed = checkFixtureAllowed({ fixture: MOCK, scenario: { environment: 'local' }, config: CONFIG });
    assert.strictEqual(allowed.environment, 'local');
    const denied = (scenario, config = CONFIG, fixture = MOCK) => assert.throws(() => checkFixtureAllowed({ fixture, scenario, config }), (e) => e.code === 'fixture-policy-denied');
    denied({ environment: 'production' }, { ...CONFIG, fixtures: { environments: { production: { origins: ['*'] } } } });
    denied({ environment: 'staging' });
    denied({ environment: 'local' }, { ...CONFIG, project: { baseUrl: 'https://app.example.com' } });
    denied({ environment: 'test' }, { ...CONFIG, project: { baseUrl: 'https://test.example.com' } }, { ...MOCK, environments: ['test'], tenant: 'other' });
    denied({ environment: 'test' }, { ...CONFIG, project: { baseUrl: 'https://test.example.com' } });
  });

  await step('数据 revision：fixture 与 live 不同，数据文件变化即变化；命名空间按 Run 确定', () => {
    const root = fx.makeTempDir('manual-fixture-unit-');
    try {
      const state = path.join(root, '.manual');
      writeYaml(path.join(state, 'fixtures', 'm.yaml'), { ...MOCK, mock: { routes: [{ path: '/dashboard', bodyFile: 'data/page.html', contentType: 'text/html' }] } });
      fs.mkdirSync(path.join(state, 'fixtures', 'data'), { recursive: true });
      fs.writeFileSync(path.join(state, 'fixtures', 'data', 'page.html'), '<h1>A</h1>');
      const scenario = { data: { mode: 'fixture', fixture: 'm' } };
      const a = fixtures.dataRevisionFor(state, scenario);
      assert.match(a, /^fixture:m:sha256:/);
      assert.notStrictEqual(a, fixtures.dataRevisionFor(state, { data: { mode: 'live', revision: null } }));
      fs.writeFileSync(path.join(state, 'fixtures', 'data', 'page.html'), '<h1>B</h1>');
      assert.notStrictEqual(fixtures.dataRevisionFor(state, scenario), a);
      assert.strictEqual(fixtures.namespaceFor('0f3c9a1e-1111-4222-8333-444455556666', 'seed'), fixtures.namespaceFor('0f3c9a1e-1111-4222-8333-444455556666', 'seed'));
      assert.notStrictEqual(fixtures.namespaceFor('0f3c9a1e-1111-4222-8333-444455556666', 'seed'), fixtures.namespaceFor('9f3c9a1e-1111-4222-8333-444455556666', 'seed'));
    } finally { fx.cleanup(root); }
  });

  // ---------------------------------------------------------------- 端到端
  const server = await startServer();
  const root = fx.captureFixture();
  const backend = fx.makeTempDir('manual-fixture-backend-');
  const SECRET = 'fixture-token-7c1e9b';
  const env = { MANUAL_AUTH_CACHE_DIR: path.join(root, '.auth-cache'), FIXTURE_TEST_DB: backend, FIXTURE_API_TOKEN: SECRET };
  const state = path.join(root, '.manual');
  const configFile = path.join(state, 'config.yaml');
  const editConfig = (fn) => { const c = yaml.load(fs.readFileSync(configFile, 'utf8')); fn(c); fs.writeFileSync(configFile, yaml.dump(c)); };
  const captures = () => count(path.join(state, 'evidence', 'captures'));
  const scenario = (id, body) => writeYaml(path.join(state, 'scenarios', `${id}.yaml`), { schemaVersion: 1, id, userTaskId: null, environment: 'local', authProfile: 'anonymous', data: { mode: 'live', revision: null }, expected: { httpStatuses: [200], redirects: [], state: 'normal' }, setup: [], checkpoints: [{ id: 'default', afterStepId: null, pageId: body.entry.pageId, assertions: body.assertions, capture: { mode: 'viewport', annotations: [] } }], ...body, assertions: undefined });
  try {
    await step('准备：登记本地测试环境、mock / hook Fixture 与 Scenario 变体', async () => {
      fx.writeFile(root, 'app/dashboard/page.tsx');
      await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
      await expectExit(root, ['inspect'], 0, env);
      editConfig((c) => { c.fixtures = { environments: { local: { origins: ['http://127.0.0.1:*'] } } }; });
      writeYaml(path.join(state, 'fixtures', 'dashboard-empty.yaml'), {
        schemaVersion: 1, id: 'dashboard-empty', version: 1, kind: 'mock', environments: ['local'], dataset: 'demo/empty-week', sideEffectClass: 'none',
        mock: { routes: [{ path: '/dashboard', contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h1>数据看板</h1><p role="status">暂无数据</p></body></html>' }] },
      });
      fs.mkdirSync(path.join(state, 'fixtures', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(state, 'fixtures', 'hooks', 'seed.js'), `
const fs = require('fs'); const path = require('path');
const file = (ns) => path.join(process.env.FIXTURE_TEST_DB, ns + '.json');
exports.setup = async ({ namespace, secrets }) => { fs.writeFileSync(file(namespace), JSON.stringify({ rows: 3, auth: secrets.token.length })); return { rows: 3 }; };
exports.cleanup = async ({ namespace }) => { if (process.env.FIXTURE_FAIL_CLEANUP === '1') throw new Error('测试后端暂时不可用'); fs.rmSync(file(namespace), { force: true }); };
`);
      writeYaml(path.join(state, 'fixtures', 'chat-seed.yaml'), {
        schemaVersion: 1, id: 'chat-seed', version: 1, kind: 'hook', environments: ['local'], dataset: 'demo/chat-3', sideEffectClass: 'isolated-test-data',
        hook: { module: 'hooks/seed.js', secrets: { token: 'env:FIXTURE_API_TOKEN' } },
      });
      scenario('dashboard-empty', { entry: { pageId: 'dashboard', routeBindingId: 'main', params: {} }, data: { mode: 'fixture', fixture: 'dashboard-empty' }, expected: { httpStatuses: [200], redirects: [], state: 'empty' }, assertions: [{ id: 'empty-heading', type: 'visible', target: { role: 'heading', name: '数据看板' } }, { id: 'empty-message', type: 'visible', target: { text: '暂无数据' } }] });
      scenario('chat-seeded', { entry: { pageId: 'chat', routeBindingId: 'main', params: {} }, data: { mode: 'fixture', fixture: 'chat-seed' }, assertions: [{ id: 'chat-heading', type: 'visible', target: { role: 'heading', name: '工作台' } }] });
    });

    let fixtureCapture;
    await step('mock Fixture：simulated 标识与 Fixture 引用；不替换页面默认截图；latest 独立', async () => {
      await expectExit(root, ['capture', 'dashboard', '--json'], 0, env);
      const pageBefore = yaml.load(fs.readFileSync(path.join(state, 'pages', 'dashboard.yaml'), 'utf8')).browser.latestCaptureId;
      const out = await expectExit(root, ['capture', 'scenario:dashboard-empty'], 0, env);
      assert.deepStrictEqual(out.succeeded, ['capture']);
      const latest = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'latest.json'), 'utf8')).refs;
      fixtureCapture = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'captures', `${latest['scenario:dashboard-empty']}.json`), 'utf8'));
      assert.strictEqual(fixtureCapture.provenance.mode, 'simulated');
      assert.strictEqual(fixtureCapture.scenarioId, 'dashboard-empty');
      assert.strictEqual(fixtureCapture.fixture.id, 'dashboard-empty');
      assert.strictEqual(latest['page:dashboard'], pageBefore);
      assert.strictEqual(yaml.load(fs.readFileSync(path.join(state, 'pages', 'dashboard.yaml'), 'utf8')).browser.latestCaptureId, pageBefore, '页面默认截图不变');
    });

    await step('缓存隔离：fixture 采集与 live 采集互不命中；fixture 内容变化使其失效', async () => {
      const live = await expectExit(root, ['generate', 'page:dashboard', '--copy-default', '--plan'], 0, env);
      assert.ok(live.summary.cache.every((c) => c.subject === 'page:dashboard'));
      const plan = await expectExit(root, ['capture', 'scenario:dashboard-empty', '--json'], 0, env);
      assert.ok(plan.cache.every((c) => c.subject === 'page:dashboard@dashboard-empty' && c.hit), JSON.stringify(plan.cache));
      const file = path.join(state, 'fixtures', 'dashboard-empty.yaml');
      const def = yaml.load(fs.readFileSync(file, 'utf8'));
      def.mock.routes[0].body = def.mock.routes[0].body.replace('<h1>数据看板</h1>', '<h1>数据看板</h1><p>（演示）</p>');
      fs.writeFileSync(file, yaml.dump(def));
      const again = await expectExit(root, ['capture', 'scenario:dashboard-empty'], 0, env);
      assert.ok(again.cache.every((c) => !c.hit && /input-changed.*dataRevision/.test(c.reason)), JSON.stringify(again.cache));
    });

    await step('生产 / 未登记环境：规划即拒绝，不启动浏览器、不执行 setup', async () => {
      const before = captures();
      for (const environment of ['production', 'staging']) {
        const file = path.join(state, 'scenarios', 'chat-seeded.yaml');
        const def = yaml.load(fs.readFileSync(file, 'utf8'));
        fs.writeFileSync(file, yaml.dump({ ...def, environment }));
        const r = await cli(root, ['capture', 'scenario:chat-seeded'], env);
        assert.strictEqual(r.status, 1, r.stdout);
        assert.match(r.stdout, /fixture-policy-denied/);
        fs.writeFileSync(file, yaml.dump({ ...def, environment: 'local' }));
      }
      assert.strictEqual(captures(), before);
      assert.deepStrictEqual(fs.readdirSync(backend), [], '没有写入测试数据');
    });

    await step('hook Fixture：setup → capture → cleanup；测试数据被清理；secret 值不落盘', async () => {
      const out = await expectExit(root, ['capture', 'scenario:chat-seeded'], 0, env);
      assert.deepStrictEqual(out.succeeded, ['fixture-setup', 'capture', 'fixture-cleanup']);
      assert.deepStrictEqual(fs.readdirSync(backend), [], '测试数据已清理');
      const stateFile = allFiles(path.join(state, 'runs', out.runId)).find((f) => f.endsWith(path.join('fixtures', 'chat-seed.json')));
      assert.strictEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status, 'cleaned');
      const leaked = allFiles(state).filter((f) => fs.readFileSync(f).includes(SECRET));
      assert.deepStrictEqual(leaked, [], 'secret 不出现在 .manual 中');
    });

    await step('采集失败也清理：Scenario 断言不成立 → capture 失败，cleanup 仍执行', async () => {
      const file = path.join(state, 'scenarios', 'chat-seeded.yaml');
      const def = yaml.load(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(file, yaml.dump({ ...def, checkpoints: [{ ...def.checkpoints[0], assertions: [{ id: 'nope', type: 'visible', target: { role: 'heading', name: '不存在' } }] }] }));
      const r = await cli(root, ['capture', 'scenario:chat-seeded'], env);
      assert.notStrictEqual(r.status, 0, r.stdout);
      assert.deepStrictEqual(r.json.succeeded, ['fixture-setup', 'fixture-cleanup']);
      assert.strictEqual(r.json.failed[0].id, 'capture');
      assert.deepStrictEqual(fs.readdirSync(backend), []);
      fs.writeFileSync(file, yaml.dump(def));
    });

    await step('清理失败：fixture-cleanup-required 明确报告、数据保留；resume 后幂等清理', async () => {
      // 改 Fixture 数据集使采集缓存失效，确保本轮会重新准备测试数据
      const defFile = path.join(state, 'fixtures', 'chat-seed.yaml');
      fs.writeFileSync(defFile, yaml.dump({ ...yaml.load(fs.readFileSync(defFile, 'utf8')), dataset: 'demo/chat-4' }));
      const r = await cli(root, ['capture', 'scenario:chat-seeded', '--refresh'].slice(0, 2), { ...env, FIXTURE_FAIL_CLEANUP: '1' });
      assert.strictEqual(r.status, 3, r.stdout);
      const waiting = r.json.waiting.find((w) => w.id === 'fixture-cleanup');
      assert.strictEqual(waiting.code, 'fixture-cleanup-required');
      assert.match(waiting.next, /resume/);
      assert.strictEqual(fs.readdirSync(backend).length, 1, '数据仍在，没有被吞掉');
      const resumed = await expectExit(root, ['resume', r.json.runId], 0, env);
      assert.ok(resumed.succeeded.includes('fixture-cleanup'));
      assert.deepStrictEqual(fs.readdirSync(backend), []);
      await expectExit(root, ['resume', r.json.runId], 0, env);
    });

    await step('多角色：成员与匿名 Scenario 各用独立 Context 与认证档案', async () => {
      const cfg = yaml.load(fs.readFileSync(configFile, 'utf8'));
      cache.writeState({ root: env.MANUAL_AUTH_CACHE_DIR, cacheKey: cfg.auth.cacheKey, profile: cfg.auth.activeProfile }, {
        origin: new URL(server.baseUrl).origin,
        storageState: { cookies: [{ name: 'manual_sid', value: 'cookie-secret', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
      });
      scenario('protected-member', { authProfile: cfg.auth.activeProfile, entry: { pageId: 'protected', routeBindingId: 'main', params: {} }, assertions: [{ id: 'protected-heading', type: 'visible', target: { role: 'heading', name: '受保护页面' } }] });
      scenario('protected-anonymous', { entry: { pageId: 'protected', routeBindingId: 'main', params: {} }, assertions: [{ id: 'protected-heading', type: 'visible', target: { role: 'heading', name: '受保护页面' } }] });
      await expectExit(root, ['capture', 'scenario:protected-member'], 0, env);
      const anonymous = await cli(root, ['capture', 'scenario:protected-anonymous'], env);
      assert.notStrictEqual(anonymous.status, 0, '匿名身份没有继承成员的 Cookie');
      assert.match(anonymous.stdout, /login-required|auth-missing/);
    });
  } finally {
    await server.close();
    fx.cleanup(root);
    fx.cleanup(backend);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
