'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const yaml = require('js-yaml');
const fx = require('./fixtures');
const { startServer } = require('./server');
const { loadConfig } = require('../src/config/load');
const { draftPage, preparePageFinal, publishPageFinal } = require('../src/generate/page-usecase');
const { capturePage } = require('../src/evidence/capture-page');
const { withRevision } = require('../src/scenarios/model');
const { readScenario } = require('../src/scenarios/store');
const { validatePage } = require('../src/model/schema');

function cli(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/manual.js'), ...args, '--project-root', root, '--json']);
    let output = '';
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('close', (status) => resolve({ status, output }));
  });
}

(async () => {
  const server = await startServer();
  const root = fx.captureFixture();
  let passed = 0;
  let failed = 0;
  async function test(name, fn) {
    try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
    catch (error) { failed++; process.stdout.write(`  ✗ ${name}\n${error.stack}\n`); }
  }
  try {
    for (const args of [['init', '--base-url', server.baseUrl, '--audience', 'internal'], ['inspect']]) {
      const r = await cli(root, args);
      assert.strictEqual(r.status, 0, r.output);
    }
    const state = path.join(root, '.manual');
    const input = path.join(root, 'describe.json');
    fs.writeFileSync(input, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '在这里查看会话。', variants: [{ scenarioId: 'chat-other', title: '其他状态' }] }] }));
    const described = await cli(root, ['describe', '--input', input]);
    assert.strictEqual(described.status, 0, described.output);
    const { config } = loadConfig(root);
    const def = withRevision({ schemaVersion: 1, id: 'chat-other', userTaskId: null, environment: 'local', authProfile: 'anonymous',
      data: { mode: 'live' }, entry: { pageId: 'chat', params: {} }, expected: { httpStatuses: [200], state: 'normal' }, setup: [],
      checkpoints: [{ id: 'default', pageId: 'chat', afterStepId: null, assertions: [], capture: { mode: 'viewport', annotations: [] } }] });
    const file = path.join(state, 'scenarios/chat-other.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, yaml.dump(def));
    await capturePage({ projectRoot: root, config, pageId: 'chat', options: {} });
    let variant;
    await test('R1 未采集声明的变体时拒绝草稿；不能悄悄省略', async () => {
      assert.throws(() => draftPage({ projectRoot: root, config, pageId: 'chat' }), (e) => e.code === 'capture-record-missing');
    });
    await test('R1 变体通过门禁进入独立章节，Capture / Scenario 引用进入发布记录', async () => {
      variant = await capturePage({ projectRoot: root, config, pageId: 'chat', options: { scenario: readScenario(state, 'chat-other').scenario } });
      const draft = draftPage({ projectRoot: root, config, pageId: 'chat' });
      assert.match(draft.markdown, /manual:block id=variant.chat-other/);
      assert.ok(draft.pack.artifacts.some((a) => a.captureId === variant.record.id && a.scenarioId === 'chat-other'));
      const prepared = preparePageFinal({ projectRoot: root, config, pageId: 'chat' });
      const published = publishPageFinal({ projectRoot: root, config, prepared });
      const release = require('../src/publication/release-store').readCurrentRelease(state, 'page-chat');
      assert.ok(published);
      const section = release.sections.find((s) => s.id === 'variant.chat-other');
      assert.deepStrictEqual(section.captureRefs, [variant.record.id]);
      assert.deepStrictEqual(section.scenarioRefs, ['chat-other']);
      const verified = await cli(root, ['verify', 'page:chat']);
      assert.strictEqual(verified.status, 0, verified.output);
      const live = await cli(root, ['verify', 'page:chat', '--live']);
      assert.strictEqual(live.status, 0, live.output);
      assert.ok(JSON.parse(live.output).reports[0].variants.some((v) => v.target === 'page:chat@chat-other'));
    });
    await test('R1 变体定义变化后拒绝旧草稿与旧截图', async () => {
      const changed = { ...def, expected: { ...def.expected, redirects: ['/other'] } };
      fs.writeFileSync(file, yaml.dump(changed));
      assert.throws(() => preparePageFinal({ projectRoot: root, config, pageId: 'chat' }), (e) => e.code === 'draft-stale');
      assert.throws(() => draftPage({ projectRoot: root, config, pageId: 'chat' }), (e) => e.code === 'evidence-stale');
      fs.writeFileSync(file, yaml.dump(def));
    });
    await test('R1 variants schema 拒绝重复与非法引用；不声明仍兼容', async () => {
      assert.ok(validatePage({ id: 'chat', route: '/chat' }).ok);
      assert.ok(!validatePage({ id: 'chat', route: '/chat', variants: [{ scenarioId: '../escape', title: '状态' }] }).ok);
      assert.ok(!validatePage({ id: 'chat', route: '/chat', variants: [{ scenarioId: 'other', title: '状态' }, { scenarioId: 'other', title: '状态' }] }).ok);
    });
    await test('R1 Runtime generate 自动规划变体采集依赖；不能在变体采集前生成正文', async () => {
      const generated = await cli(root, ['generate', 'page:chat', '--copy-default', '--refresh']);
      assert.strictEqual(generated.status, 0, generated.output);
      const release = require('../src/publication/release-store').readCurrentRelease(state, 'page-chat');
      assert.ok(release.sections.find((s) => s.id === 'variant.chat-other').captureRefs.length);
      assert.strictEqual((await cli(root, ['verify', 'page:chat'])).status, 0);
    });
  } finally { await server.close(); fx.cleanup(root); }
  process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
