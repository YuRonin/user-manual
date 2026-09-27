'use strict';

/*
 * 故障矩阵：每类错误都有确定的任务状态、错误码与下一步（退出码）。
 * 用假 handler 抛出与真实模块相同的错误对象，经 runner 的统一映射后检查结果。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunStore } = require('../src/runtime/store');
const { runRun } = require('../src/runtime/runner');
const { CaptureError, REASON } = require('../src/browser/errors');
const { RuntimeError } = require('../src/runtime/errors');
const { LockError } = require('../src/store/lock');
const { exitCodeForRun, EXIT } = require('../src/cli/output');
const { waitingHint } = require('../src/cli/run-report');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-matrix-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const value = (v) => ({ outputs: [{ kind: 'value', sha256: String(v).padEnd(8, '0') }] });
const node = (id, kind, dependsOn = [], replay = 'safe') => ({ id, kind, dependsOn, inputHash: `sha256:${id}`, retry: { maxAttempts: 3, backoffMs: [0, 0], replay } });

async function runWith(root, kind, error, { replay = 'safe', signal = null } = {}) {
  const runStore = createRunStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
  const tasks = kind === 'rewrite'
    ? [node('capture', 'capture'), node('rewrite', 'rewrite', ['capture'], replay), node('publish', 'publish', ['rewrite'])]
    : [node('target', kind, [], replay), node('publish', 'publish', ['target'])];
  const { run } = runStore.create({ command: 'generate', plan: { tasks } });
  const calls = { capture: 0, target: 0 };
  const failing = () => { calls.target += 1; if (typeof error === 'function') return error(); throw error; };
  const handlers = {
    capture: kind === 'rewrite' ? () => { calls.capture += 1; return value('c'); } : failing,
    rewrite: failing, analyze: failing, validate: failing, draft: failing, 'derive-image': failing,
    publish: () => value('p'),
  };
  const summary = await runRun({ runStore, runId: run.id, handlers, signal, sleep: async () => {}, sessionFactory: () => ({ close: async () => {} }) });
  const task = runStore.read(run.id).tasks.find((t) => t.id === (kind === 'rewrite' ? 'rewrite' : 'target'));
  return { summary, task, calls };
}

const CASES = [
  // [名称, kind, 错误, 期望状态, 期望 code, 期望尝试次数, 期望退出码]
  ['浏览器启动失败', 'capture', new CaptureError(REASON.BROWSER_LAUNCH_FAILED, '启动失败'), 'failed', 'browser-launch-failed', 3, EXIT.FAILED],
  ['登录失效', 'capture', new CaptureError(REASON.AUTH_EXPIRED, '登录已失效'), 'waiting_input', 'auth-expired', 1, EXIT.WAITING],
  ['目标不存在（0 个）', 'capture', Object.assign(new Error('不可见'), { code: 'target-not-visible' }), 'failed', 'target-not-visible', 1, EXIT.FAILED],
  ['目标匹配多个', 'capture', Object.assign(new Error('2 个'), { code: 'target-ambiguous' }), 'failed', 'target-ambiguous', 1, EXIT.FAILED],
  ['意外跳转', 'capture', new CaptureError(REASON.UNEXPECTED_REDIRECT, '跳到别处'), 'failed', 'unexpected-redirect', 1, EXIT.FAILED],
  ['HTTP 404', 'capture', new CaptureError(REASON.HTTP_NOT_FOUND, '404'), 'failed', 'http-not-found', 1, EXIT.FAILED],
  ['HTTP 500（瞬时）', 'capture', new CaptureError(REASON.HTTP_ERROR, '500', { status: 500 }), 'failed', 'http-error', 3, EXIT.FAILED],
  ['只读导航超时', 'capture', new CaptureError(REASON.TIMEOUT, '超时'), 'failed', 'timeout', 3, EXIT.FAILED],
  ['截图期间页面不稳定', 'capture', Object.assign(new Error('几何变化'), { code: 'geometry-unstable' }), 'failed', 'geometry-unstable', 3, EXIT.FAILED],
  ['隐私规则冲突', 'capture', new CaptureError(REASON.PRIVACY_UNCERTAIN, '冲突'), 'failed', 'privacy-uncertain', 1, EXIT.FAILED],
  ['磁盘已满', 'draft', Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), 'failed', 'ENOSPC', 1, EXIT.FAILED],
  ['项目锁等待超时（瞬时）', 'draft', new LockError('lock-timeout', '等待锁超时'), 'failed', 'lock-timeout', 3, EXIT.FAILED],
  ['发布冲突（人工修改）', 'validate', Object.assign(new Error('文档被改过'), { code: 'publication-conflict' }), 'waiting_input', 'publication-conflict', 1, EXIT.CONFLICT],
  ['输入在规划后变化', 'capture', new RuntimeError('run-input-changed', '输入变了'), 'waiting_input', 'run-input-changed', 1, EXIT.CONFLICT],
];

(async () => {
  process.stdout.write('\nruntime failure matrix\n');

  for (const [name, kind, error, status, code, attempts, exit] of CASES) {
    await test(`${name} → ${status} / ${code} / 退出 ${exit}`, async (root) => {
      const { summary, task } = await runWith(root, kind, error);
      assert.strictEqual(task.status, status);
      assert.strictEqual(task.error.code, code);
      assert.strictEqual(task.attempts.length, attempts, `尝试次数 ${task.attempts.length}`);
      assert.deepStrictEqual(summary.succeeded, [], '失败任务之后的发布不会执行');
      assert.strictEqual(exitCodeForRun(summary), exit);
      if (status === 'waiting_input') assert.match(waitingHint(summary.runId, summary.waiting[0]), /manual/);
      assert.ok(!/ENOSPC: no space left on device \//.test(JSON.stringify(task.error)), '错误信息经去敏');
    });
  }

  await test('模型响应格式错误 → 只重试模型任务 3 次，采集只执行一次', async (root) => {
    const { task, calls, summary } = await runWith(root, 'rewrite', new RuntimeError('invalid-model-response', '格式错误'));
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.attempts.length, 3);
    assert.strictEqual(calls.capture, 1);
    assert.strictEqual(exitCodeForRun(summary), EXIT.FAILED);
  });

  await test('用户取消 → interrupted，后续不执行，退出 1', async (root) => {
    const controller = new AbortController();
    const { task, summary } = await runWith(root, 'capture', () => { controller.abort(); return value('x'); }, { signal: controller.signal });
    assert.strictEqual(task.status, 'interrupted');
    assert.strictEqual(task.error.code, 'cancelled');
    assert.deepStrictEqual(summary.pending, ['publish']);
    assert.strictEqual(exitCodeForRun(summary), EXIT.FAILED);
  });

  await test('不能安全重放的任务被中断 → 恢复时 outcome-unknown 等待核查，绝不自动重放', async (root) => {
    const runStore = createRunStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const { run } = runStore.create({ command: 'generate', plan: { tasks: [node('write', 'publish', [], 'unsafe')] } });
    const { lease } = runStore.open(run.id);
    runStore.transition(run.id, 'write', 'running', { lease });
    lease.release(); // 模拟执行进程消失，租约不再有效
    let calls = 0;
    const summary = await runRun({ runStore, runId: run.id, handlers: { publish: () => { calls += 1; return value('w'); } }, sleep: async () => {}, sessionFactory: () => ({ close: async () => {} }) });
    assert.strictEqual(calls, 0, '不重放');
    assert.deepStrictEqual(summary.waiting.map((w) => [w.id, w.code]), [['write', 'outcome-unknown']]);
    assert.strictEqual(exitCodeForRun(summary), EXIT.WAITING);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
