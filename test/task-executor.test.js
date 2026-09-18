'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
  async screenshot({ path: file }) { this.calls.push(['shot', file]); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { path: file, bytes: 3, meta: { viewport: { width: 100, height: 100 }, deviceScaleFactor: 2 } }; }
  async collectSensitiveElements() { return []; }
  async renderEvidence({ sanitizedPath, annotatedPath }) { fs.mkdirSync(path.dirname(sanitizedPath), { recursive: true }); fs.mkdirSync(path.dirname(annotatedPath), { recursive: true }); fs.writeFileSync(sanitizedPath, 'safe'); fs.writeFileSync(annotatedPath, 'marked'); return { sanitizedPath, annotatedPath }; }
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
      assert.deepStrictEqual(provider.calls.filter((call) => call[0] === 'action').map((call) => call[1]), ['click']);
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
