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

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
