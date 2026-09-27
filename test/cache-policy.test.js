'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { captureKey, imageKey, manualKey } = require('../src/cache/keys');
const { createCacheStore } = require('../src/cache/store');
const { resolveMode, freshnessPolicy } = require('../src/cache/policy');
const { lookup, offlineMissError, MISS_REASONS } = require('../src/cache/lookup');
const { createCaptureStore } = require('../src/evidence/store');
const { loadConfig } = require('../src/config/load');
const { TINY_PNG } = require('./server');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-cache-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const T0 = Date.parse('2026-09-27T08:00:00.000Z');
const MIN = 60 * 1000;

const fixtureCapture = {
  projectId: 'a3f1c2d4-0000-4000-8000-000000000001', environment: 'local', deployedBuild: 'b1', dataRevision: 'fixture-1',
  scenarioId: 'member', scenarioRevision: 'sha256:s', checkpoint: 'entry', viewport: { width: 800, height: 600 }, dpr: 1,
  browser: 'chromium', captureMode: 'viewport', readinessPolicy: 'default',
};
const liveCapture = { ...fixtureCapture, deployedBuild: undefined, dataRevision: undefined };

function commitCapture(root, observedAt = new Date(T0).toISOString(), privacyStatus = 'clean') {
  const stateDirAbs = path.join(root, '.manual');
  const captures = createCaptureStore({ projectRoot: root, stateDirAbs });
  const handle = captures.begin();
  fs.mkdirSync(handle.stagingDir, { recursive: true });
  fs.writeFileSync(handle.file('raw.png'), TINY_PNG);
  return captures.commit(handle, {
    record: { observedAt, validations: [{ scope: 'page-identity', outcome: 'passed' }], privacy: { status: privacyStatus } },
    artifacts: [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw', prefix: `raw-${Math.random().toString(16).slice(2)}` }],
  });
}

function setup(root, { now = () => T0 } = {}) {
  const stateDirAbs = path.join(root, '.manual');
  const store = createCacheStore({ stateDirAbs, now });
  const find = (keyInfo, options = {}) => lookup({ store, keyInfo, projectRoot: root, stateDirAbs, mode: resolveMode(options.flags), now, ...options });
  const putCapture = (keyInfo, record, extra = {}) => store.put({
    kind: 'capture', key: keyInfo.key, input: keyInfo.input, uncertainty: keyInfo.uncertainty, subject: 'capture:member:entry',
    outputRefs: [{ kind: 'capture', ref: record.id }], observedAt: record.observedAt, validationScopes: ['page-identity'],
    privacy: { status: record.privacy.status, revision: 'priv-1' }, ...extra,
  });
  return { stateDirAbs, store, find, putCapture };
}

(async () => {
  process.stdout.write('\ncache policy\n');

  await test('命中返回原 observedAt 与来源，不写新的观察时间；标 onlineChecked=false', async (root) => {
    let clock = T0;
    const { store, find, putCapture, stateDirAbs } = setup(root, { now: () => clock });
    const record = commitCapture(root);
    const keyInfo = captureKey(fixtureCapture);
    putCapture(keyInfo, record);
    const entryFile = fs.readdirSync(path.join(stateDirAbs, 'cache/capture/entries'))[0];
    const before = fs.readFileSync(path.join(stateDirAbs, 'cache/capture/entries', entryFile), 'utf8');
    clock = T0 + 60 * MIN;
    const hit = find(keyInfo);
    assert.strictEqual(hit.hit, true);
    assert.strictEqual(hit.observedAt, record.observedAt);
    assert.strictEqual(hit.reusedFrom, keyInfo.key);
    assert.strictEqual(hit.inputHash, keyInfo.key);
    assert.strictEqual(hit.onlineChecked, false);
    assert.strictEqual(hit.freshness, 'content');
    assert.strictEqual(fs.readFileSync(path.join(stateDirAbs, 'cache/capture/entries', entryFile), 'utf8'), before);
    assert.strictEqual(store.get('capture', keyInfo.key).observedAt, record.observedAt);
  });

  await test('TTL 边界（注入时钟）：live 软 TTL 15 分钟；fixture 按内容版本无 TTL；项目配置可覆盖', async (root) => {
    let clock = T0;
    const { find, putCapture } = setup(root, { now: () => clock });
    const record = commitCapture(root);
    const live = captureKey(liveCapture);
    const fixture = captureKey(fixtureCapture);
    putCapture(live, record);
    putCapture(fixture, record);
    clock = T0 + 15 * MIN;
    assert.strictEqual(find(live).hit, true);
    clock = T0 + 15 * MIN + 1;
    const expired = find(live);
    assert.deepStrictEqual([expired.hit, expired.reason, expired.ttlMs], [false, 'expired', 15 * MIN]);
    assert.strictEqual(find(fixture).hit, true);
    assert.strictEqual(find(live, { cachePolicy: { captureTtlMs: 30 * MIN } }).hit, true);
    assert.deepStrictEqual(freshnessPolicy('identity', {}), { ttlMs: 5 * MIN, basis: 'soft-ttl' });
    assert.deepStrictEqual(find(live, { cachePolicy: { captureTtlMs: 30 * MIN } }).uncertainty.sort(), ['dataRevision', 'deployedBuild']);
  });

  await test('--offline：过期历史证据可用但标 stale；没有证据报 cache-miss-offline；三种开关互斥', async (root) => {
    let clock = T0 + 60 * MIN;
    const { find, putCapture } = setup(root, { now: () => clock });
    const live = captureKey(liveCapture);
    const offline = { offline: true };
    const none = find(live, { flags: offline });
    assert.strictEqual(none.hit, false);
    assert.strictEqual(offlineMissError(none).code, 'cache-miss-offline');
    putCapture(live, commitCapture(root));
    const stale = find(live, { flags: offline });
    assert.deepStrictEqual([stale.hit, stale.stale, stale.onlineChecked], [true, true, false]);
    assert.strictEqual(resolveMode(offline).browserAllowed, false);
    assert.strictEqual(resolveMode(offline).write, false);
    assert.throws(() => resolveMode({ offline: true, refresh: true }), (e) => e.code === 'invalid-arguments');
    assert.throws(() => resolveMode({ refresh: true, noCache: true }), (e) => e.code === 'invalid-arguments');
  });

  await test('--refresh 跳过复用但照常写入且可复用认证；--no-cache 不读不写；两者都不删除历史 Capture', async (root) => {
    const { find, putCapture, stateDirAbs } = setup(root);
    const record = commitCapture(root);
    const keyInfo = captureKey(fixtureCapture);
    putCapture(keyInfo, record);
    const refresh = find(keyInfo, { flags: { refresh: true } });
    assert.deepStrictEqual([refresh.hit, refresh.bypassed], [false, 'refresh']);
    assert.deepStrictEqual([resolveMode({ refresh: true }).write, resolveMode({ refresh: true }).reuseAuth], [true, true]);
    const noCache = find(keyInfo, { flags: { noCache: true } });
    assert.deepStrictEqual([noCache.hit, noCache.bypassed], [false, 'no-cache']);
    assert.deepStrictEqual([resolveMode({ noCache: true }).read, resolveMode({ noCache: true }).write], [false, false]);
    assert.ok(createCaptureStore({ projectRoot: root, stateDirAbs }).read(record.id));
    assert.strictEqual(find(keyInfo).hit, true);
  });

  await test('产物被替换 → hash-mismatch；产物缺失 → artifact-missing；缺少所需验证范围 → validation-insufficient', async (root) => {
    const { find, putCapture } = setup(root);
    const record = commitCapture(root);
    const keyInfo = captureKey(fixtureCapture);
    putCapture(keyInfo, record);
    assert.strictEqual(find(keyInfo, { requiredScopes: ['page-identity', 'scenario-state'] }).reason, 'validation-insufficient');
    const raw = path.join(root, record.artifacts[0].path);
    fs.writeFileSync(raw, Buffer.from('replaced-image'));
    assert.strictEqual(find(keyInfo).reason, 'hash-mismatch');
    fs.rmSync(raw);
    assert.strictEqual(find(keyInfo).reason, 'artifact-missing');
  });

  await test('输入变化给出 changedFields：DPR 变化需要重采集；公开发布时 privacy 未检测不能命中', async (root) => {
    const { find, putCapture } = setup(root);
    const keyInfo = captureKey(fixtureCapture);
    putCapture(keyInfo, commitCapture(root));
    const dpr2 = captureKey({ ...fixtureCapture, dpr: 2 });
    const changed = find(dpr2, { subject: 'capture:member:entry' });
    assert.deepStrictEqual([changed.reason, changed.changedFields], ['input-changed', ['dpr']]);
    assert.strictEqual(find(dpr2).reason, 'not-found');

    const unsafe = captureKey({ ...fixtureCapture, checkpoint: 'other' });
    putCapture(unsafe, commitCapture(root, new Date(T0).toISOString(), 'not-run'));
    assert.strictEqual(find(unsafe, { privacy: { audience: 'public' } }).reason, 'validation-insufficient');
    assert.strictEqual(find(unsafe, { privacy: { audience: 'internal' } }).hit, true);
  });

  await test('隐私规则变化：Capture（raw）仍命中，只有派生图 miss；模板变化：只有文档 miss，不需要浏览器', async (root) => {
    const { store, find, putCapture } = setup(root);
    const record = commitCapture(root);
    const capture = captureKey(fixtureCapture);
    putCapture(capture, record);
    const image1 = imageKey({ rawHash: record.artifacts[0].sha256, geometryHash: 'g', privacyRevision: 'priv-1', annotationTheme: 'default', rendererVersion: 'sharp-svg-1' });
    store.put({ kind: 'image', key: image1.key, input: image1.input, subject: 'image:member:entry', outputRefs: [{ kind: 'capture', ref: record.id }], observedAt: record.observedAt });
    const manual1 = manualKey({ factsHash: 'f', artifactHashes: [record.artifacts[0].sha256], language: 'zh-CN', templateVersion: 'render-1', generatorVersion: '0.1.0' });
    store.put({ kind: 'manual', key: manual1.key, input: manual1.input, subject: 'manual:task:edit', outputRefs: [{ kind: 'value', sha256: 'abc' }], observedAt: record.observedAt });

    const image2 = imageKey({ ...image1.input, privacyRevision: 'priv-2' });
    assert.strictEqual(find(capture).hit, true, 'raw 仍可复用 → 只需重派生');
    assert.deepStrictEqual(find(image2, { subject: 'image:member:entry' }).changedFields, ['privacyRevision']);

    const manual2 = manualKey({ ...manual1.input, templateVersion: 'render-2' });
    assert.strictEqual(find(capture).hit, true, '模板变化不需要重新截图');
    assert.deepStrictEqual(find(manual2, { subject: 'manual:task:edit' }).changedFields, ['templateVersion']);
  });

  await test('环境未知不复用；损坏 entry 当作不存在并删除；clear() 不删除 canonical Capture', async (root) => {
    const { store, find, putCapture, stateDirAbs } = setup(root);
    const record = commitCapture(root);
    const unknownEnv = captureKey({ ...fixtureCapture, environment: undefined });
    putCapture(unknownEnv, record);
    assert.strictEqual(find(unknownEnv).reason, 'environment-unknown');

    const keyInfo = captureKey(fixtureCapture);
    putCapture(keyInfo, record);
    const entryPath = path.join(stateDirAbs, 'cache/capture/entries', `${keyInfo.key.slice(7)}.json`);
    fs.writeFileSync(entryPath, '{"broken":');
    assert.strictEqual(find(keyInfo).reason, 'not-found');
    assert.ok(!fs.existsSync(entryPath));
    putCapture(keyInfo, record);
    store.clear();
    assert.ok(!fs.existsSync(path.join(stateDirAbs, 'cache/capture')));
    assert.ok(createCaptureStore({ projectRoot: root, stateDirAbs }).read(record.id));
    assert.ok(fs.existsSync(path.join(root, record.artifacts[0].path)));
    assert.ok(MISS_REASONS.includes('environment-unknown'));
  });

  await test('并发写入：两个进程同时写不同 entry，全部可读、无半截文件', async (root) => {
    const stateDirAbs = path.join(root, '.manual');
    const script = (prefix) => `
      const { createCacheStore } = require(${JSON.stringify(path.resolve(__dirname, '../src/cache/store'))});
      const store = createCacheStore({ stateDirAbs: ${JSON.stringify(stateDirAbs)} });
      for (let i = 0; i < 40; i++) {
        store.put({ kind: 'manual', key: 'sha256:' + '${prefix}'.repeat(8) + String(i).padStart(56, '0'), subject: 'shared', input: { i }, outputRefs: [{ kind: 'value', sha256: 'x' }], observedAt: new Date().toISOString() });
      }
    `;
    await Promise.all(['a', 'b'].map((p) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script(p)], { stdio: 'inherit' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
    })));
    const store = createCacheStore({ stateDirAbs });
    for (const p of ['a', 'b']) {
      for (let i = 0; i < 40; i++) assert.ok(store.get('manual', `sha256:${p.repeat(8)}${String(i).padStart(56, '0')}`));
    }
    assert.ok(store.latestForSubject('manual', 'shared'));
  });

  await test('配置：runtime.budget / cache 缺省取 C07 / C09 默认值，可覆盖，非法值拒绝', async (root) => {
    const { spawnSync } = require('child_process');
    const init = spawnSync(process.execPath, [path.join(__dirname, '../bin/manual.js'), 'init', '--base-url', 'http://localhost:3000', '--project-root', root, '--yes'], { encoding: 'utf8' });
    assert.strictEqual(init.status, 0, init.stderr + init.stdout);
    let loaded = loadConfig(root);
    assert.strictEqual(loaded.config.runtime.budget.maxActions, 200);
    assert.strictEqual(loaded.config.cache.captureTtlMs, 15 * MIN);
    const configFile = path.join(root, '.manual/config.yaml');
    const original = fs.readFileSync(configFile, 'utf8');
    fs.writeFileSync(configFile, `${original}\nruntime:\n  budget:\n    maxActions: 50\ncache:\n  captureTtlMs: 60000\n`);
    loaded = loadConfig(root);
    assert.deepStrictEqual([loaded.config.runtime.budget.maxActions, loaded.config.runtime.budget.navigationMs, loaded.config.cache.captureTtlMs], [50, 30000, 60000]);
    fs.writeFileSync(configFile, `${original}\ncache:\n  captureTtlMs: -1\n`);
    loaded = loadConfig(root);
    assert.strictEqual(loaded.ok, false);
    assert.match(loaded.errors[0], /cache\.captureTtlMs/);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
