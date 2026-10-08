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
const { authRecoveryTarget, run: runAuth } = require('../src/commands/auth');
const { waitingHint } = require('../src/cli/run-report');

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
    const status = JSON.parse(result.stdout);
    assert.strictEqual(status.status, 'stored', '可读文件只是 stored，不等于线上已登录');
    assert.strictEqual(status.storageStatus, 'stored');
    assert.strictEqual(status.validationStatus, 'unvalidated');
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
    assert.strictEqual(result.status, 2, '不支持的子命令是参数错误（C08）');
    assert.match(result.stderr, /login|status|clear/);
  });

  await test('登录续跑只匹配等待当前认证档案的 Run', async (root, cacheRoot) => {
    init(root, cacheRoot);
    const state = {
      plan: { tasks: [{ id: 'capture-chat', input: { authProfile: 'teacher' } }] },
      tasks: [{ id: 'capture-chat', effectiveStatus: 'waiting_input', error: { code: 'auth-expired' } }],
    };
    assert.strictEqual(authRecoveryTarget(state, 'teacher', 'default')?.id, 'capture-chat');
    assert.strictEqual(authRecoveryTarget(state, 'default', 'default'), undefined);
    assert.match(waitingHint('run-1', { id: 'capture-chat', code: 'auth-expired' }, state.plan), /auth login --profile teacher --resume run-1/);
    const missing = run(root, cacheRoot, ['auth', 'login', '--resume', '00000000-0000-4000-8000-000000000000', '--json']);
    assert.notStrictEqual(missing.status, 0);
    assert.strictEqual(JSON.parse(missing.stdout).reason, 'run-not-found');
    assert.strictEqual(fs.existsSync(cacheRoot), false, '无效 Run 不打开登录窗口或写认证状态');
  });

  await test('登录保存私有状态并关闭窗口后自动继续原 Run', async (root, cacheRoot) => {
    const config = init(root, cacheRoot);
    const runId = '00000000-0000-4000-8000-000000000001';
    const priorCacheRoot = process.env.MANUAL_AUTH_CACHE_DIR;
    const priorWrite = process.stdout.write;
    const chunks = [];
    const events = [];
    process.env.MANUAL_AUTH_CACHE_DIR = cacheRoot;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    try {
      const exit = await runAuth(['login', '--resume', runId, '--project-root', root, '--json'], {
        openProject: () => ({ runStore: { read: () => ({
          plan: { tasks: [{ id: 'auth-check', input: { authProfile: 'default' } }] },
          tasks: [{ id: 'auth-check', effectiveStatus: 'waiting_input', error: { code: 'auth-expired' } }],
        }) } }),
        changedInputs: () => ({ changed: [] }),
        probeRedirect: async () => null,
        createProvider: () => ({ close: async () => { events.push('closed'); } }),
        establishSession: async () => ({ storageState: { cookies: [{ name: 'sid', value: 'secret-cookie' }], origins: [] },
          finalUrl: 'https://app.example.com/chat?session=secret-session', validationStatus: 'validated', identityRevision: 'id', validatedAt: new Date().toISOString() }),
        resumeRun: async ({ runId: id }) => {
          assert.strictEqual(id, runId);
          assert.deepStrictEqual(events, ['closed']);
          assert.ok(cache.readState({ root: cacheRoot, cacheKey: config.auth.cacheKey, profile: 'default' }));
          events.push('resumed');
          return { runId, plan: { tasks: [] }, summary: { status: 'succeeded', succeeded: [], pending: [], waiting: [], failed: [], interrupted: [] } };
        },
      });
      assert.strictEqual(exit, 0);
      assert.deepStrictEqual(events, ['closed', 'resumed']);
      const printed = chunks.join('');
      assert.strictEqual(JSON.parse(printed).status, 'succeeded');
      assert.ok(!printed.includes('secret-cookie'));
      assert.ok(!printed.includes('secret-session'));
    } finally {
      process.stdout.write = priorWrite;
      if (priorCacheRoot === undefined) delete process.env.MANUAL_AUTH_CACHE_DIR;
      else process.env.MANUAL_AUTH_CACHE_DIR = priorCacheRoot;
    }
  });

  await test('档案不匹配或输入变化时不打开登录窗口', async (root, cacheRoot) => {
    init(root, cacheRoot);
    const runId = '00000000-0000-4000-8000-000000000002';
    const priorCacheRoot = process.env.MANUAL_AUTH_CACHE_DIR;
    const priorWrite = process.stdout.write;
    const chunks = [];
    let opened = false;
    process.env.MANUAL_AUTH_CACHE_DIR = cacheRoot;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    const state = { plan: { tasks: [{ id: 'auth-check', input: { authProfile: 'teacher' } }] },
      tasks: [{ id: 'auth-check', effectiveStatus: 'waiting_input', error: { code: 'auth-expired' } }] };
    const services = { openProject: () => ({ runStore: { read: () => state } }),
      changedInputs: () => ({ changed: ['auth-check'] }), createProvider: () => { opened = true; throw new Error('should not open'); } };
    try {
      let exit = await runAuth(['login', '--resume', runId, '--project-root', root, '--json'], services);
      assert.notStrictEqual(exit, 0);
      assert.strictEqual(JSON.parse(chunks.pop()).reason, 'auth-resume-unavailable');
      exit = await runAuth(['login', '--profile', 'teacher', '--resume', runId, '--project-root', root, '--json'], services);
      assert.notStrictEqual(exit, 0);
      assert.strictEqual(JSON.parse(chunks.pop()).reason, 'run-input-changed');
      assert.strictEqual(opened, false);
      assert.strictEqual(fs.existsSync(cacheRoot), false);
    } finally {
      process.stdout.write = priorWrite;
      if (priorCacheRoot === undefined) delete process.env.MANUAL_AUTH_CACHE_DIR;
      else process.env.MANUAL_AUTH_CACHE_DIR = priorCacheRoot;
    }
  });

  await test('登录 JSON 不暴露完整会话 URL，窗口关闭时不保存状态', async (root, cacheRoot) => {
    const config = init(root, cacheRoot);
    const priorCacheRoot = process.env.MANUAL_AUTH_CACHE_DIR;
    const priorWrite = process.stdout.write;
    const chunks = [];
    let closed = 0;
    process.env.MANUAL_AUTH_CACHE_DIR = cacheRoot;
    process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
    const services = { probeRedirect: async () => null, createProvider: () => ({ close: async () => { closed++; } }),
      establishSession: async () => ({ storageState: { cookies: [], origins: [] }, finalUrl: 'https://app.example.com/chat?session=private-id', validationStatus: 'validated' }) };
    try {
      let exit = await runAuth(['login', '--project-root', root, '--json'], services);
      assert.strictEqual(exit, 0);
      const result = JSON.parse(chunks.pop());
      assert.strictEqual(result.finalUrl, undefined);
      assert.ok(!JSON.stringify(result).includes('private-id'));
      const ref = { root: cacheRoot, cacheKey: config.auth.cacheKey, profile: 'default' };
      const beforeFailure = cache.readState(ref);
      services.establishSession = async () => { throw Object.assign(new Error('登录窗口已关闭'), { code: 'auth-window-closed' }); };
      exit = await runAuth(['login', '--project-root', root, '--json'], services);
      assert.notStrictEqual(exit, 0);
      assert.strictEqual(JSON.parse(chunks.pop()).reason, 'auth-window-closed');
      assert.strictEqual(closed, 2);
      assert.deepStrictEqual(cache.readState(ref), beforeFailure);
    } finally {
      process.stdout.write = priorWrite;
      if (priorCacheRoot === undefined) delete process.env.MANUAL_AUTH_CACHE_DIR;
      else process.env.MANUAL_AUTH_CACHE_DIR = priorCacheRoot;
    }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
