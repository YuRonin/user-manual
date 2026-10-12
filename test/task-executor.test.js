'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { createCaptureStore } = require('../src/evidence/store');
const { rederiveCaptures } = require('../src/evidence/rederive');
// 截图必须是真实 PNG：发布图由离线图像管线从 raw 字节派生。
const { TINY_PNG } = require('./server');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

class FakeProvider {
  constructor({ failAssertion = false } = {}) { this.calls = []; this.failAssertion = failAssertion; }
  async open(url) { this.calls.push(['open', url]); return { status: 200, finalUrl: url }; }
  async waitUntilReady() { this.calls.push(['ready']); return { steps: {}, warnings: [] }; }
  async performAction(action) { this.calls.push(['action', action.type]); return { target: action.target, rect: { x: 1, y: 2, width: 3, height: 4 } }; }
  async assertCondition(assertion) { this.calls.push(['assert', assertion.type]); if (this.failAssertion) throw new Error('not visible'); return { ok: true }; }
  async screenshot({ path: file }) { this.calls.push(['shot', file]); fs.mkdirSync(path.dirname(file), { recursive: true }); await sharp({ create: { width: 200, height: 200, channels: 3, background: '#ffffff' } }).png().toFile(file); return { path: file, bytes: fs.statSync(file).size, meta: { viewport: { width: 100, height: 100 }, deviceScaleFactor: 2 } }; }
  async collectSensitiveElements() { return []; }
  // Demo 替身：没有 data-redact 区域，门禁通过
  async applyDemo() { return {}; }
  async auditDemo() { return { replaced: {}, images: {}, unconfigured: [], imageUnconfigured: [], unreplaceable: [], reverted: 0, leaks: [], contacts: [], hidden: 0, surfaces: { iframe: 0, canvas: 0 } }; }
  async close() { this.calls.push(['close']); }
}

function plan() {
  return {
    taskId: 'edit-profile', taskTitle: '修改个人资料', entry: { route: '/user-center' },
    steps: [
      { id: 'open', instruction: '打开编辑器', page: 'user-center', stateBefore: 'default', action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, risk: 'read', execution: 'auto', willExecute: true, expectedState: { id: 'open', assertions: [{ type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] }, capture: { timing: 'after' } },
      { id: 'save', instruction: '保存', page: 'user-center', action: { type: 'click', target: { role: 'button', name: '保存修改' } }, risk: 'write', execution: 'stop-before-action', willExecute: false, expectedState: null, capture: null },
    ],
  };
}

(async () => {
  process.stdout.write('\ntask executor\n');
  await test('执行只读步骤、验证状态并停在写操作前', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-executor-'));
    try {
      const provider = new FakeProvider();
      const { executeCapturePlan } = require('../src/tasks/executor');
      const result = await executeCapturePlan(plan(), provider, { baseUrl: 'http://example.test', stateDir: path.join(root, '.manual'), projectRoot: root, annotatedDir: 'docs/manual/images/annotated', theme: { maxMarkersPerImage: 5, markerSize: 30, targetPadding: 5 } });
      assert.deepStrictEqual(provider.calls.filter((call) => call[0] === 'action').map((call) => call[1]), ['click', 'inspect']);
      assert.strictEqual(result.steps[0].status, 'verified');
      assert.strictEqual(result.steps[1].status, 'not-executed');
      assert.strictEqual(result.steps[1].reason, 'stop-before-action');
      assert.ok(fs.existsSync(result.steps[0].screenshots[0].raw));
      assert.ok(fs.existsSync(result.steps[0].screenshots[0].sanitized));
      assert.ok(fs.existsSync(path.join(root, result.steps[0].screenshots[0].annotated)));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('状态断言失败时生成诊断图并返回结构化错误', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-executor-'));
    try {
      const provider = new FakeProvider({ failAssertion: true });
      const { executeCapturePlan } = require('../src/tasks/executor');
      await assert.rejects(
        () => executeCapturePlan(plan(), provider, { baseUrl: 'http://example.test', stateDir: path.join(root, '.manual') }),
        (error) => error.code === 'state-assertion-failed' && error.step === 'open' && fs.existsSync(error.diagnostic)
      );
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('原图与坐标可复用，改标注主题时只重新派生而不重新采集', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-rederive-'));
    try {
      const provider = new FakeProvider();
      const stateDir = path.join(root, '.manual');
      const first = await require('../src/tasks/executor').executeCapturePlan(plan(), provider, { baseUrl: 'http://example.test', stateDir, projectRoot: root, annotatedDir: 'docs/manual/images/annotated', theme: require('../src/config/annotation').DEFAULT_THEME });
      const original = first.steps[0].screenshots[0];
      const store = createCaptureStore({ projectRoot: root, stateDirAbs: stateDir });
      const prior = store.read(original.captureId);
      assert.ok(prior.artifacts.some((item) => item.kind === 'annotations'));
      assert.strictEqual(prior.annotationCoverage.ok, true);
      const config = { artifacts: { stateDir: '.manual', annotatedDir: 'docs/manual/images/annotated' }, annotation: { activeTheme: 'changed', themes: { changed: { ...require('../src/config/annotation').DEFAULT_THEME, primary: '#0044aa' } } }, privacy: { audience: 'public', rules: { redact: [], preserve: [] } } };
      const replay = await rederiveCaptures({ projectRoot: root, config, captureIds: [original.captureId] });
      const next = replay.records[0].record;
      assert.strictEqual(provider.calls.filter((item) => item[0] === 'shot').length, 1);
      assert.strictEqual(next.provenance.derivedFrom, original.captureId);
      assert.strictEqual(next.annotationCoverage.ok, true);
      assert.strictEqual(next.artifacts.find((item) => item.kind === 'raw').sha256, prior.artifacts.find((item) => item.kind === 'raw').sha256);
      assert.notStrictEqual(next.artifacts.find((item) => item.kind === 'published').sha256, prior.artifacts.find((item) => item.kind === 'published').sha256);
      const withoutRaw = await rederiveCaptures({ projectRoot: root, config: { ...config, capture: { safety: { persistRaw: false } } }, captureIds: [original.captureId] });
      const stripped = withoutRaw.records[0].record;
      assert.strictEqual(stripped.rawRetained, false);
      assert.ok(!stripped.artifacts.some((a) => a.kind === 'raw'));
      assert.ok(fs.existsSync(original.raw), '不删除历史原图');
      await assert.rejects(rederiveCaptures({ projectRoot: root, config, captureIds: [stripped.id] }), (e) => e.code === 'rederive-unavailable');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('R6 核对已有会话：缺 raw 的历史步骤正常恢复，不重放动作', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-no-raw-reconcile-'));
    try {
      const { executeCapturePlan, reconcileCapturePlan } = require('../src/tasks/executor');
      const definition = plan(); definition.modelRevision = null; definition.scenario = { id: 'default' };
      const options = { baseUrl: 'http://example.test', stateDir: path.join(root, '.manual'), projectRoot: root, annotatedDir: 'docs/manual/images/annotated', theme: require('../src/config/annotation').DEFAULT_THEME, persistRaw: false };
      const provider = new FakeProvider();
      const originalShot = provider.screenshot.bind(provider);
      provider.screenshot = async (args) => { const shot = await originalShot(args); shot.meta.url = 'http://example.test/user-center'; return shot; };
      const first = await executeCapturePlan(definition, provider, options);
      const prior = first.steps[0].screenshots[0];
      assert.strictEqual(prior.raw, null);
      const last = definition.steps[1]; last.capture = { timing: 'after' }; last.expectedState = { id: 'saved', assertions: [{ type: 'visible', target: { text: '已保存' } }] };
      const checker = new FakeProvider();
      checker.currentObservation = async () => ({ url: 'http://example.test/user-center?session=1', bodyTextLength: 300, elementCount: 100 });
      const result = await reconcileCapturePlan(definition, checker, { ...options, sessionUrl: 'http://example.test/user-center?session=1', priorCaptureIds: [prior.captureId] });
      assert.strictEqual(result.steps[0].screenshots[0].raw, null);
      assert.strictEqual(result.steps[0].screenshots[0].captureId, prior.captureId);
      assert.ok(!checker.calls.some((call) => call[0] === 'action' && call[1] !== 'inspect'), '允许只读标注定位，不重放业务动作或写步骤');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  await test('任务成功后在关闭浏览器前刷新认证状态', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-executor-'));
    try {
      const provider = new FakeProvider();
      let refreshed = false;
      const { executeCapturePlan } = require('../src/tasks/executor');
      await executeCapturePlan(plan(), provider, {
        baseUrl: 'http://example.test',
        stateDir: path.join(root, '.manual'),
        projectRoot: root,
        annotatedDir: 'docs/manual/images/annotated',
        theme: { maxMarkersPerImage: 5, markerSize: 30, targetPadding: 5 },
        authRuntime: { async refresh(actual) { assert.strictEqual(actual, provider); refreshed = true; } },
      });
      assert.strictEqual(refreshed, true);
      assert.ok(provider.calls.findIndex((call) => call[0] === 'close') > provider.calls.findIndex((call) => call[0] === 'shot'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
