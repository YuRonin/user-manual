'use strict';

const assert = require('assert');

const { captureKey, imageKey, manualKey, sourceKey, changedFields, UNKNOWN } = require('../src/cache/keys');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const captureFields = {
  projectId: 'a3f1c2d4-0000-4000-8000-000000000001',
  environment: 'staging',
  deployedBuild: 'build-42',
  dataRevision: 'fixture-7',
  scenarioId: 'member-default',
  scenarioRevision: 'sha256:s1',
  checkpoint: 'open:after',
  sourceHash: 'sha256:src',
  identityRevision: 'sha256:member',
  viewport: { width: 1440, height: 900 },
  dpr: 2,
  locale: 'zh-CN',
  timezone: 'Asia/Shanghai',
  browser: 'chromium-1243',
  platform: 'darwin',
  captureMode: 'viewport',
  readinessPolicy: 'sha256:ready',
};

process.stdout.write('\ncache keys\n');

test('相同输入得到相同 key；白名单外字段（Cookie 值等）不进入 key 与输入摘要', () => {
  const a = captureKey(captureFields);
  const b = captureKey({ ...captureFields, cookie: 'sid=secret', storageState: { cookies: [{ value: 'secret' }] } });
  assert.strictEqual(a.key, b.key);
  assert.ok(!JSON.stringify(b.input).includes('secret'));
  assert.match(a.key, /^sha256:[0-9a-f]{64}$/);
  assert.deepStrictEqual(a.uncertainty, []);
});

test('角色、租户数据、DPR、语言、时区、浏览器、Scenario、checkpoint、视口、模式任一变化都改变 captureKey', () => {
  const base = captureKey(captureFields).key;
  const variants = {
    identityRevision: 'sha256:admin',
    dataRevision: 'tenant-b',
    dpr: 1,
    locale: 'en-US',
    timezone: 'UTC',
    browser: 'chromium-1250',
    scenarioRevision: 'sha256:s2',
    scenarioId: 'admin-default',
    checkpoint: 'open:before',
    viewport: { width: 390, height: 844 },
    captureMode: 'fullPage',
    sourceHash: 'sha256:src2',
    deployedBuild: 'build-43',
    environment: 'production',
    readinessPolicy: 'sha256:ready2',
  };
  for (const [field, value] of Object.entries(variants)) {
    const changed = captureKey({ ...captureFields, [field]: value });
    assert.notStrictEqual(changed.key, base, `${field} 变化应改变 key`);
    assert.deepStrictEqual(changedFields(captureKey(captureFields).input, changed.input), [field]);
  }
});

test('部署 build / 数据 revision / 环境未知时记为 unknown 并报告不确定性，空字符串不算已知', () => {
  const live = captureKey({ ...captureFields, deployedBuild: undefined, dataRevision: '', environment: null });
  assert.strictEqual(live.input.deployedBuild, UNKNOWN);
  assert.strictEqual(live.input.dataRevision, UNKNOWN);
  assert.deepStrictEqual(live.uncertainty.sort(), ['dataRevision', 'deployedBuild', 'environment']);
  assert.notStrictEqual(live.key, captureKey(captureFields).key);
});

test('必填字段缺失拒绝生成 key', () => {
  assert.throws(() => captureKey({ ...captureFields, scenarioRevision: undefined }), (e) => e.code === 'invalid-cache-input' && e.missing.includes('scenarioRevision'));
  assert.throws(() => imageKey({ rawHash: 'r' }), (e) => e.code === 'invalid-cache-input');
});

test('imageKey 随隐私规则 / 主题 / 渲染器变化；manualKey 随模板变化，产物顺序无关；四类 key 互不相同', () => {
  const image = { rawHash: 'r', geometryHash: 'g', privacyRevision: 'p1', annotationTheme: 't', rendererVersion: 'sharp-svg-1' };
  assert.deepStrictEqual(changedFields(imageKey(image).input, imageKey({ ...image, privacyRevision: 'p2' }).input), ['privacyRevision']);
  assert.notStrictEqual(imageKey(image).key, imageKey({ ...image, rendererVersion: 'sharp-svg-2' }).key);
  const manual = { factsHash: 'f', artifactHashes: ['b', 'a'], language: 'zh-CN', templateVersion: 'render-1', generatorVersion: '0.1.0' };
  assert.strictEqual(manualKey(manual).key, manualKey({ ...manual, artifactHashes: ['a', 'b'] }).key);
  assert.notStrictEqual(manualKey(manual).key, manualKey({ ...manual, templateVersion: 'render-2' }).key);
  const source = sourceKey({ fileHashes: { 'a.js': 'h' }, resolverVersion: 'regex-import-graph-2', dependencies: ['b', 'a'] });
  assert.strictEqual(source.key, sourceKey({ fileHashes: { 'a.js': 'h' }, resolverVersion: 'regex-import-graph-2', dependencies: ['a', 'b'] }).key);
  const keys = new Set([captureKey(captureFields).key, imageKey(image).key, manualKey(manual).key, source.key]);
  assert.strictEqual(keys.size, 4);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
