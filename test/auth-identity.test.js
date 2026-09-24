'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const cache = require('../src/auth/cache');
const { prepareAuth, refreshAuth } = require('../src/auth/runtime');
const { verifyIdentity, identityRevision } = require('../src/auth/identity');
const { establishSession } = require('../src/auth/session');
const { checkAuthPermissions } = require('../src/commands/doctor');
const fx = require('./fixtures');
const { startServer } = require('./server');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
let skipped = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-auth-identity-'));
  try {
    if (await fn(root) === 'skip') { skipped++; process.stdout.write(`  - ${name}（跳过）\n`); return; }
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function config(overrides = {}) {
  return {
    project: { name: 'x', baseUrl: 'http://app.test' },
    auth: { enabled: true, cacheKey: 'app', activeProfile: 'member', loginUrl: '/login', verifyPath: '/me', identityAssertions: [], capabilities: ['cookies', 'localStorage'], ...overrides },
  };
}

const STORAGE = (value) => ({ cookies: [{ name: 'sid', value, domain: 'app.test', path: '/' }], origins: [] });

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

(async () => {
  process.stdout.write('\nauth identity\n');

  await test('auth.enabled=false 与 anonymous：即使缓存损坏也不读取、不注入', (root) => {
    const ref = { root, cacheKey: 'app', profile: 'member' };
    fs.mkdirSync(path.dirname(cache.cacheFileFor(ref)), { recursive: true });
    fs.writeFileSync(cache.cacheFileFor(ref), '{broken');
    const disabled = prepareAuth(config({ enabled: false }), { root });
    assert.strictEqual(disabled.status, 'disabled');
    assert.strictEqual(disabled.storageState, null);
    const anonymous = prepareAuth(config(), { root, profile: 'anonymous' });
    assert.strictEqual(anonymous.status, 'disabled');
    assert.throws(() => prepareAuth(config(), { root }), /认证缓存/);
  });

  await test('disabled 状态下 refreshAuth 不写缓存', async (root) => {
    let exported = false;
    const result = await refreshAuth({ async exportStorageState() { exported = true; return STORAGE('x'); } }, prepareAuth(config({ enabled: false }), { root }));
    assert.strictEqual(result.updated, false);
    assert.strictEqual(exported, false);
    assert.deepStrictEqual(fs.readdirSync(root), []);
  });

  await test('stored 与 validated 分离：可读文件只是 stored，身份断言通过才记 validatedAt', (root) => {
    const ref = { root, cacheKey: 'app', profile: 'member' };
    const unvalidated = cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('a') });
    assert.strictEqual(cache.publicMetadata(unvalidated, 'f').validationStatus, 'unvalidated');
    assert.strictEqual(prepareAuth(config(), { root }).status, 'stored');
    const validated = cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('b'), validatedAt: '2026-09-24T00:00:00.000Z', identityRevision: 'sha256:x' });
    const meta = cache.publicMetadata(validated, 'f');
    assert.strictEqual(meta.validationStatus, 'validated');
    assert.strictEqual(meta.lastValidatedAt, '2026-09-24T00:00:00.000Z');
    assert.ok(!JSON.stringify(meta).includes('"b"'), '元数据不含 cookie 值');
  });

  await test('登录验证：身份断言通过才 validated；失败报 auth-verification-failed；未配置为 unvalidated', async () => {
    const assertions = [{ type: 'visible', target: { role: 'heading', name: '个人中心' } }];
    const ok = { async assertCondition() { return { ok: true }; } };
    const result = await verifyIdentity(ok, { config: config({ identityAssertions: assertions }), profile: 'member', verifyUrl: null });
    assert.strictEqual(result.validationStatus, 'validated');
    assert.strictEqual(result.identityRevision, identityRevision(config({ identityAssertions: assertions }), 'member'));
    assert.ok(!result.identityRevision.includes('个人中心'), 'identityRevision 是 hash，不含明文');
    const bad = { async assertCondition() { throw Object.assign(new Error('不可见'), { code: 'target-not-visible' }); } };
    await assert.rejects(() => verifyIdentity(bad, { config: config({ identityAssertions: assertions }), profile: 'member', timeoutMs: 20 }), (e) => e.code === 'auth-verification-failed');
    assert.strictEqual((await verifyIdentity(ok, { config: config(), profile: 'member' })).validationStatus, 'unvalidated');
  });

  await test('登录编排：离开登录页后先执行身份断言再导出状态', async () => {
    const events = [];
    const provider = {
      async open(url) { events.push(['open', url]); },
      async waitForAuthentication() { events.push(['wait']); return { finalUrl: 'http://app.test/me' }; },
      async assertCondition() { events.push(['assert']); return { ok: true }; },
      async exportStorageState(opts) { events.push(['export', !!opts?.indexedDB]); return { cookies: [], origins: [] }; },
    };
    const result = await establishSession({ provider, loginUrl: 'http://app.test/login', config: config({ identityAssertions: [{ type: 'visible', target: { role: 'heading', name: '我' } }] }), profile: 'member', capabilities: ['cookies', 'indexedDB'] });
    assert.deepStrictEqual(events.map((e) => e[0]), ['open', 'wait', 'assert', 'export']);
    assert.strictEqual(events[3][1], true, '声明 indexedDB 时一并导出');
    assert.strictEqual(result.validationStatus, 'validated');
  });

  await test('刷新 CAS：旧 Context 的快照不能覆盖其他进程写入的新快照', async (root) => {
    const ref = { root, cacheKey: 'app', profile: 'member' };
    cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('v1') });
    const stale = prepareAuth(config(), { root });
    assert.strictEqual(stale.generation, 1);
    cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('v2-newer') }, { expectedGeneration: 1 });
    const result = await refreshAuth({ async exportStorageState() { return STORAGE('v1-refreshed-late'); } }, stale);
    assert.strictEqual(result.updated, false);
    assert.match(result.warning, /其他进程/);
    const current = cache.readState(ref);
    assert.strictEqual(current.storageState.cookies[0].value, 'v2-newer');
    assert.strictEqual(current.generation, 2);
    const fresh = prepareAuth(config(), { root });
    assert.strictEqual((await refreshAuth({ async exportStorageState() { return STORAGE('v3'); } }, fresh)).updated, true);
    assert.strictEqual(cache.readState(ref).generation, 3);
  });

  await test('刷新前再次确认身份：当前页已回到登录页时不刷新', async (root) => {
    const ref = { root, cacheKey: 'app', profile: 'member' };
    cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('v1') });
    const result = await refreshAuth({
      async currentObservation() { return { url: 'http://app.test/login' }; },
      async exportStorageState() { return STORAGE('anonymous-session'); },
    }, prepareAuth(config(), { root }));
    assert.strictEqual(result.updated, false);
    assert.strictEqual(cache.readState(ref).storageState.cookies[0].value, 'v1');
  });

  await test('profile 锁：活跃锁使写入报 auth-locked，残留的过期锁被清理', (root) => {
    const ref = { root, cacheKey: 'app', profile: 'member' };
    const file = cache.cacheFileFor(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, '');
    assert.throws(() => cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('x') }), (e) => e.code === 'auth-locked');
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(`${file}.lock`, old, old);
    cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('x') });
    assert.ok(!fs.existsSync(`${file}.lock`));
  });

  await test('旧版缓存文件（无 generation）按第 0 代、未验证读取', (root) => {
    const ref = { root, cacheKey: 'app', profile: 'member' };
    const file = cache.cacheFileFor(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, cacheKey: 'app', profile: 'member', origin: 'http://app.test', updatedAt: 'x', storageState: STORAGE('old') }));
    const state = cache.readState(ref);
    assert.strictEqual(state.generation, 0);
    assert.strictEqual(state.validatedAt, null);
  });

  await test('能力声明：sessionStorage 报 capability-unavailable', (root) => {
    assert.throws(() => prepareAuth(config({ capabilities: ['cookies', 'sessionStorage'] }), { root }), (e) => e.code === 'capability-unavailable');
    assert.deepStrictEqual(prepareAuth(config({ capabilities: ['cookies', 'indexedDB'] }), { root }).capabilities, ['cookies', 'indexedDB']);
  });

  await test('权限：POSIX 目录 0700 / 文件 0600；Windows 报告 ACL 继承状态与共享目录风险', (root) => {
    const ref = { root: path.join(root, 'auth'), cacheKey: 'app', profile: 'member' };
    cache.writeState(ref, { origin: 'http://app.test', storageState: STORAGE('x') });
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(path.dirname(cache.cacheFileFor(ref))).mode & 0o777, 0o700);
      assert.strictEqual(fs.statSync(cache.cacheFileFor(ref)).mode & 0o777, 0o600);
      assert.strictEqual(checkAuthPermissions(ref.root).status, 'ok');
      return undefined;
    }
    assert.strictEqual(checkAuthPermissions(ref.root).acl, 'inherited-unverified');
    const shared = checkAuthPermissions(ref.root, { platform: 'win32', env: { LOCALAPPDATA: 'Z:\\nobody' }, home: 'Z:\\nobody-home' });
    assert.strictEqual(shared.status, 'warn');
    assert.match(shared.hint, /icacls|LOCALAPPDATA/);
    return undefined;
  });

  // ------------------------------------------------------------ 真浏览器：匿名采集不带凭据
  const server = await startServer();
  const project = fx.captureFixture();
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-auth-anon-'));
  try {
    await test('真浏览器：auth.enabled=false 时即使有有效缓存也不注入，受保护页判为需要登录且缓存不变', async () => {
      const env = { MANUAL_AUTH_CACHE_DIR: cacheRoot };
      let r = await runCli(['init', '--project-root', project, '--base-url', server.baseUrl], env);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual((await runCli(['inspect', '--project-root', project], env)).status, 0);
      const configFile = path.join(project, '.manual', 'config.yaml');
      const cfg = yaml.load(fs.readFileSync(configFile, 'utf8'));
      const ref = { root: cacheRoot, cacheKey: cfg.auth.cacheKey, profile: cfg.auth.activeProfile };
      cache.writeState(ref, { origin: new URL(server.baseUrl).origin, storageState: { cookies: [{ name: 'manual_sid', value: 'cookie-secret', domain: '127.0.0.1', path: '/' }], origins: [] } });

      r = await runCli(['capture', 'protected', '--project-root', project, '--json'], env);
      assert.strictEqual(r.status, 0, '启用认证时缓存可用于受保护页面: ' + r.stdout);
      const before = fs.readFileSync(cache.cacheFileFor(ref));

      cfg.auth.enabled = false;
      fs.writeFileSync(configFile, yaml.dump(cfg));
      r = await runCli(['capture', 'protected', '--project-root', project, '--json'], env);
      assert.strictEqual(r.status, 1, r.stdout);
      assert.strictEqual(JSON.parse(r.stdout).reason, 'login-required');
      assert.ok(fs.readFileSync(cache.cacheFileFor(ref)).equals(before), '匿名采集不能刷新认证缓存');
      r = await runCli(['auth', 'status', '--project-root', project, '--json'], env);
      assert.strictEqual(JSON.parse(r.stdout).storageStatus, 'disabled');
      assert.ok(!r.stdout.includes('cookie-secret'));
    });
  } finally {
    await server.close();
    fx.cleanup(project);
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
  if (failures.length) process.exitCode = 1;
})();
