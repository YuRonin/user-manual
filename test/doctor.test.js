'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const cache = require('../src/auth/cache');
const { collectChecks, versionAtLeast } = require('../src/commands/doctor');
const { resolvePlaywright } = require('../src/browser/playwright');
const { COMMANDS } = require('../src/cli/commands');
const aliases = require('../src/compat/aliases');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-doctor-'));
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

// 测试进程不继承调用者的 Playwright 覆盖，也不读取真实用户认证缓存。
function cleanEnv(cacheRoot, extra = {}) {
  const env = { ...process.env, MANUAL_AUTH_CACHE_DIR: cacheRoot, ...extra };
  if (!('MANUAL_PLAYWRIGHT_PATH' in extra)) delete env.MANUAL_PLAYWRIGHT_PATH;
  if (!('MANUAL_PLAYWRIGHT_LEGACY_SEARCH' in extra)) delete env.MANUAL_PLAYWRIGHT_LEGACY_SEARCH;
  return env;
}

function run(root, cacheRoot, args, extraEnv) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root], {
    encoding: 'utf8',
    env: cleanEnv(cacheRoot, extraEnv),
  });
}

function byId(report, id) {
  return report.checks.find((item) => item.id === id);
}

async function main() {
  process.stdout.write('\ndoctor\n');

  await test('未初始化目录：依赖与浏览器通过，配置标记 skip，且不写任何文件', (root, cacheRoot) => {
    const result = run(root, cacheRoot, ['doctor', '--json']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.ok, true);
    assert.strictEqual(byId(report, 'playwright').source, 'dependency');
    assert.strictEqual(byId(report, 'chromium').status, 'ok');
    assert.strictEqual(byId(report, 'config').status, 'skip');
    assert.strictEqual(byId(report, 'dependency:sharp').status, 'ok');
    assert.strictEqual(byId(report, 'dependency:markdown-it').status, 'ok');
    assert.deepStrictEqual(fs.readdirSync(root), [], 'doctor 必须只读');
  });

  await test('已初始化项目：报告配置、输出可写与缺失的认证档案', (root, cacheRoot) => {
    assert.strictEqual(run(root, cacheRoot, ['init', '--base-url', 'http://localhost:3000']).status, 0);
    const before = fs.readdirSync(path.join(root, '.manual')).sort();
    const result = run(root, cacheRoot, ['doctor', '--json']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(byId(report, 'config').status, 'ok');
    assert.strictEqual(byId(report, 'output:state').status, 'ok');
    assert.strictEqual(byId(report, 'output:docs').status, 'ok');
    assert.strictEqual(byId(report, 'auth').storageStatus, 'missing');
    assert.match(byId(report, 'auth').hint, /manual auth login/);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, '.manual')).sort(), before);
    assert.strictEqual(fs.existsSync(cacheRoot), false, 'doctor 不得创建认证缓存目录');
  });

  await test('认证缓存只输出元数据，不泄露 cookie/localStorage 值', (root, cacheRoot) => {
    assert.strictEqual(run(root, cacheRoot, ['init', '--base-url', 'http://localhost:3000']).status, 0);
    const config = yaml.load(fs.readFileSync(path.join(root, '.manual', 'config.yaml'), 'utf8'));
    cache.writeState({ root: cacheRoot, cacheKey: config.auth.cacheKey, profile: config.auth.activeProfile }, {
      origin: 'http://localhost:3000',
      storageState: {
        cookies: [{ name: 'sid', value: 'SECRET-COOKIE-VALUE', domain: 'localhost', path: '/' }],
        origins: [{ origin: 'http://localhost:3000', localStorage: [{ name: 'token', value: 'SECRET-LS-TOKEN' }] }],
      },
    });
    const result = run(root, cacheRoot, ['doctor', '--json']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-COOKIE-VALUE|SECRET-LS-TOKEN/);
    assert.strictEqual(byId(JSON.parse(result.stdout), 'auth').storageStatus, 'stored');
    const text = run(root, cacheRoot, ['doctor']);
    assert.doesNotMatch(text.stdout + text.stderr, /SECRET-COOKIE-VALUE|SECRET-LS-TOKEN/);
  });

  await test('损坏的配置与认证缓存分类为 fail 并给修复建议', (root, cacheRoot) => {
    assert.strictEqual(run(root, cacheRoot, ['init', '--base-url', 'http://localhost:3000']).status, 0);
    const config = yaml.load(fs.readFileSync(path.join(root, '.manual', 'config.yaml'), 'utf8'));
    const file = cache.cacheFileFor({ root: cacheRoot, cacheKey: config.auth.cacheKey, profile: config.auth.activeProfile });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    let result = run(root, cacheRoot, ['doctor', '--json']);
    assert.strictEqual(result.status, 1);
    let report = JSON.parse(result.stdout);
    assert.strictEqual(byId(report, 'auth').storageStatus, 'corrupt');

    fs.writeFileSync(path.join(root, '.manual', 'config.yaml'), 'version: 1\nproject: {}\n');
    result = run(root, cacheRoot, ['doctor', '--json']);
    assert.strictEqual(result.status, 1);
    report = JSON.parse(result.stdout);
    assert.strictEqual(byId(report, 'config').status, 'fail');
    assert.ok(byId(report, 'config').errors.length > 0);
  });

  await test('MANUAL_PLAYWRIGHT_PATH 无效时失败，不静默回退到其他副本', (root, cacheRoot) => {
    const result = run(root, cacheRoot, ['doctor', '--json'], { MANUAL_PLAYWRIGHT_PATH: path.join(root, 'missing-playwright') });
    assert.strictEqual(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(byId(report, 'playwright').status, 'fail');
    assert.match(byId(report, 'playwright').hint, /npm ci|MANUAL_PLAYWRIGHT_PATH/);
    assert.strictEqual(byId(report, 'chromium').status, 'skip');
  });

  await test('Playwright 解析顺序：env 覆盖 → 自身依赖 → 仅显式开关才搜个人目录', () => {
    const calls = [];
    const fake = (available) => {
      const impl = (request) => ({ loaded: request });
      impl.resolve = (request) => {
        calls.push(request);
        if (available.includes(request)) return request;
        throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' });
      };
      return impl;
    };
    const envPath = path.resolve('/tmp/pw-override');
    let hit = resolvePlaywright({ env: { MANUAL_PLAYWRIGHT_PATH: envPath }, requireImpl: fake([envPath, 'playwright']) });
    assert.strictEqual(hit.source, 'env');
    hit = resolvePlaywright({ env: {}, requireImpl: fake(['playwright']) });
    assert.strictEqual(hit.source, 'dependency');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-doctor-home-'));
    try {
      const legacy = path.join(home, 'gstack', 'node_modules', 'playwright');
      fs.mkdirSync(legacy, { recursive: true });
      assert.throws(() => resolvePlaywright({ env: {}, requireImpl: fake([legacy]), home }), /找不到 playwright/);
      hit = resolvePlaywright({ env: { MANUAL_PLAYWRIGHT_LEGACY_SEARCH: '1' }, requireImpl: fake([legacy]), home });
      assert.strictEqual(hit.source, 'legacy');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  await test('Node 版本低于 engines 时 fail；依赖可注入缺失', (root) => {
    assert.strictEqual(versionAtLeast('20.9.0', '20.9.0'), true);
    assert.strictEqual(versionAtLeast('20.8.9', '20.9.0'), false);
    assert.strictEqual(versionAtLeast('22.1.0', '20.9.0'), true);
    const missing = (request) => { throw new Error(request); };
    missing.resolve = () => { throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); };
    const report = collectChecks({
      projectRoot: root,
      env: {},
      nodeVersion: '18.19.0',
      requireImpl: missing,
      resolvePlaywrightImpl: () => { throw new Error('找不到 playwright 包。'); },
    });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(byId(report, 'node').status, 'fail');
    assert.strictEqual(byId(report, 'dependency:playwright').status, 'fail');
    assert.match(byId(report, 'dependency:playwright').hint, /npm ci/);
  });

  await test('命令注册表是 CLI 与 compat 别名的唯一来源（含 auth、doctor）', (root, cacheRoot) => {
    const names = COMMANDS.map((command) => command.name);
    assert.deepStrictEqual(aliases.COMMANDS, names);
    assert.ok(names.includes('auth') && names.includes('doctor'));
    const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    for (const name of names) assert.match(help.stdout, new RegExp(`\\b${name}\\b`));
    for (const command of COMMANDS) {
      const result = run(root, cacheRoot, [command.name, '--help']);
      assert.strictEqual(result.status, 0, `${command.name} --help: ${result.stderr}`);
    }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main();
