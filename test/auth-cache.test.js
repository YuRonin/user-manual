'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const cache = require('../src/auth/cache');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-auth-cache-'));
  try {
    fn(root);
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

process.stdout.write('\nauth cache\n');

test('缓存路径由 cacheKey 与 profile 隔离', (root) => {
  const file = cache.cacheFileFor({ root, cacheKey: 'neoagent-test', profile: 'teacher' });
  assert.strictEqual(file, path.join(root, 'neoagent-test', 'teacher.state.json'));
});

test('状态可原子写入并读回', (root) => {
  const ref = { root, cacheKey: 'neoagent-test', profile: 'teacher' };
  cache.writeState(ref, {
    origin: 'https://example.com',
    storageState: { cookies: [{ name: 'sid', value: 'secret' }], origins: [] },
  });
  const result = cache.readState(ref);
  assert.strictEqual(result.origin, 'https://example.com');
  assert.strictEqual(result.storageState.cookies[0].name, 'sid');
  assert.strictEqual(result.storageState.cookies[0].value, 'secret');
});

test('拒绝路径穿越名称', (root) => {
  assert.throws(
    () => cache.cacheFileFor({ root, cacheKey: '../escape', profile: 'default' }),
    (error) => error.code === 'auth-invalid-name'
  );
});

test('损坏缓存只报告分类，不包含文件内容', (root) => {
  const ref = { root, cacheKey: 'neoagent-test', profile: 'default' };
  const file = cache.cacheFileFor(ref);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"token":"do-not-leak"', 'utf8');
  assert.throws(
    () => cache.readState(ref),
    (error) => error.code === 'auth-corrupt' && !String(error.message).includes('do-not-leak')
  );
});

test('替换失败时保留上一份有效状态', (root) => {
  const ref = { root, cacheKey: 'neoagent-test', profile: 'default' };
  cache.writeState(ref, { origin: 'https://example.com', storageState: { cookies: [], origins: [] } });
  const original = fs.readFileSync(cache.cacheFileFor(ref), 'utf8');
  const failingFs = { ...fs, renameSync() { throw new Error('rename failed'); } };
  assert.throws(() => cache.writeState(ref, {
    origin: 'https://example.com',
    storageState: { cookies: [{ name: 'sid', value: 'new-secret' }], origins: [] },
  }, { fsImpl: failingFs }));
  assert.strictEqual(fs.readFileSync(cache.cacheFileFor(ref), 'utf8'), original);
});

test('清理只删除选中的 profile', (root) => {
  const common = { root, cacheKey: 'neoagent-test' };
  for (const profile of ['default', 'teacher']) {
    cache.writeState({ ...common, profile }, { origin: 'https://example.com', storageState: { cookies: [], origins: [] } });
  }
  assert.strictEqual(cache.clearState({ ...common, profile: 'teacher' }), true);
  assert.strictEqual(cache.readState({ ...common, profile: 'teacher' }), null);
  assert.ok(cache.readState({ ...common, profile: 'default' }));
});

test('公开元数据不包含 cookie 或 localStorage 值', (root) => {
  const ref = { root, cacheKey: 'neoagent-test', profile: 'default' };
  const state = cache.writeState(ref, {
    origin: 'https://example.com',
    storageState: {
      cookies: [{ name: 'sid', value: 'cookie-secret' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'local-secret' }] }],
    },
  });
  const text = JSON.stringify(cache.publicMetadata(state, cache.cacheFileFor(ref)));
  assert.ok(!text.includes('cookie-secret'));
  assert.ok(!text.includes('local-secret'));
  assert.match(text, /neoagent-test/);
});

const { prepareAuth, refreshAuth, withoutEphemeral } = require('../src/auth/runtime');
const polluted = (collapsed) => ({
  cookies: [{ name: 'sid', value: 'cookie-secret', domain: 'example.com', path: '/', expires: -1 }],
  origins: [{ origin: 'https://example.com', localStorage: [{ name: 'token', value: 'keep' }, { name: 'neo_sidebar_collapsed', value: collapsed }, { name: 'neo_ui_theme', value: 'dark' }] }],
});
const authConfig = (root) => ({ project: { baseUrl: 'https://example.com' }, auth: { enabled: true, cacheKey: 'neoagent-test', activeProfile: 'default', capabilities: ['cookies', 'localStorage'], ephemeralStorageKeys: ['neo_sidebar_collapsed', 'neo_ui_*'] }, _root: root });
const names = (state) => state.origins[0].localStorage.map((item) => item.name);

test('界面状态键（精确 / 前缀*）不随认证档案注入；凭据键保留', (root) => {
  cache.writeState({ root, cacheKey: 'neoagent-test', profile: 'default' }, { origin: 'https://example.com', storageState: polluted('true') });
  const auth = prepareAuth(authConfig(root), { root });
  assert.deepStrictEqual(names(auth.storageState), ['token'], '已被污染的旧档案注入时也要剔除 UI 状态');
  assert.deepStrictEqual(names(withoutEphemeral(polluted('true'), [])), ['token', 'neo_sidebar_collapsed', 'neo_ui_theme'], '未声明时不改动');
});

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-auth-cache-'));
  try {
    cache.writeState({ root, cacheKey: 'neoagent-test', profile: 'default' }, { origin: 'https://example.com', storageState: polluted('false') });
    const auth = prepareAuth(authConfig(root), { root });
    // 某次采集把侧栏收起：导出的状态带着 collapsed=true，写回档案时必须剔除
    const provider = { currentObservation: async () => ({ url: 'https://example.com/chat' }), exportStorageState: async () => polluted('true') };
    const first = await refreshAuth(provider, auth, { onlyIfChanged: true });
    assert.strictEqual(first.updated, false, '只有 UI 状态变化不算凭据变化');
    await refreshAuth(provider, auth);
    assert.deepStrictEqual(names(cache.readState({ root, cacheKey: 'neoagent-test', profile: 'default' }).storageState), ['token']);
    passed++;
    process.stdout.write('  ✓ 写回认证档案时剔除界面状态键；仅 UI 状态变化不触发写回\n');
  } catch (error) {
    failures.push({ name: 'refreshAuth ephemeral', error });
    process.stdout.write(`  ✗ refreshAuth ephemeral\n    ${error.stack || error}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
