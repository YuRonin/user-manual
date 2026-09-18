'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const cache = require('../src/auth/cache');
const { establishSession } = require('../src/auth/session');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-auth-command-'));
  const cacheRoot = path.join(root, 'auth-cache');
  try {
    await fn(root, cacheRoot);
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(root, cacheRoot, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    encoding: 'utf8',
    env: { ...process.env, MANUAL_AUTH_CACHE_DIR: cacheRoot },
  });
}

function init(root, cacheRoot) {
  const result = run(root, cacheRoot, ['init', '--base-url', 'https://app.example.com']);
  assert.strictEqual(result.status, 0, result.stderr);
  return yaml.load(fs.readFileSync(path.join(root, '.manual', 'config.yaml'), 'utf8'));
}

async function main() {
  process.stdout.write('\nauth command\n');

  await test('session 编排验证登录后才导出状态', async () => {
    const events = [];
    const provider = {
      async open(url) { events.push(['open', url]); },
      async waitForAuthentication(options) { events.push(['wait', options]); return { finalUrl: options.verifyUrl }; },
      async exportStorageState() { events.push(['export']); return { cookies: [], origins: [] }; },
    };
    const result = await establishSession({
      provider,
      loginUrl: 'https://app.example.com/login',
      verifyUrl: 'https://app.example.com/user-center',
      timeout: 1234,
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.storageState, { cookies: [], origins: [] });
    assert.deepStrictEqual(events.map((item) => item[0]), ['open', 'wait', 'export']);
  });

  await test('status 在缓存缺失时返回 missing', async (root, cacheRoot) => {
    init(root, cacheRoot);
    const result = run(root, cacheRoot, ['auth', 'status', '--json']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).status, 'missing');
  });

  await test('status 不输出 cookie 与 localStorage 值', async (root, cacheRoot) => {
    const config = init(root, cacheRoot);
    const ref = { root: cacheRoot, cacheKey: config.auth.cacheKey, profile: 'default' };
    cache.writeState(ref, {
      origin: 'https://app.example.com',
      storageState: {
        cookies: [{ name: 'sid', value: 'cookie-secret' }],
        origins: [{ origin: 'https://app.example.com', localStorage: [{ name: 'token', value: 'local-secret' }] }],
      },
    });
    const result = run(root, cacheRoot, ['auth', 'status', '--json']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).status, 'ready');
    assert.ok(!result.stdout.includes('cookie-secret'));
    assert.ok(!result.stdout.includes('local-secret'));
  });

  await test('clear 只删除指定 profile 且可重复执行', async (root, cacheRoot) => {
    const config = init(root, cacheRoot);
    for (const profile of ['default', 'teacher']) {
      cache.writeState({ root: cacheRoot, cacheKey: config.auth.cacheKey, profile }, {
        origin: 'https://app.example.com', storageState: { cookies: [], origins: [] },
      });
    }
    let result = run(root, cacheRoot, ['auth', 'clear', '--profile', 'teacher', '--json']);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).cleared, true);
    result = run(root, cacheRoot, ['auth', 'clear', '--profile', 'teacher', '--json']);
    assert.strictEqual(JSON.parse(result.stdout).cleared, false);
    assert.ok(cache.readState({ root: cacheRoot, cacheKey: config.auth.cacheKey, profile: 'default' }));
  });

  await test('未知 auth 动作返回可读错误', async (root, cacheRoot) => {
    init(root, cacheRoot);
    const result = run(root, cacheRoot, ['auth', 'explode']);
    assert.strictEqual(result.status, 1);
    assert.match(result.stderr, /login|status|clear/);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
