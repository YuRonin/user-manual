'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { toErrorResult, toLegacyProjection, errorSummary, sanitizeMessage } = require('../src/runtime/errors');
const { CaptureError, REASON } = require('../src/browser/errors');
const { executeCapturePlan, TaskExecutionError } = require('../src/tasks/executor');
const { LockError } = require('../src/store/lock');
const { ProjectStoreError } = require('../src/store/project');
const { PublicationError } = require('../src/publication/publisher');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

class ThrowingProvider {
  constructor(error) { this.error = error; }
  async open(url) { return { status: 200, finalUrl: url }; }
  async waitUntilReady() { return { steps: {}, warnings: [] }; }
  async currentObservation() { return { url: 'http://localhost:3000/profile', hasPasswordField: false, bodyTextLength: 500, elementCount: 40 }; }
  async performAction() { throw this.error; }
  async assertCondition() {}
  async screenshot({ path: file }) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'x'); }
  async close() {}
}

function readPlan() {
  return {
    taskId: 'edit-profile',
    entry: { page: 'profile', route: '/profile', assertions: [] },
    steps: [{ id: 'open', page: 'profile', action: { type: 'click', target: { role: 'button', name: '编辑' } }, willExecute: true, execution: 'auto', risk: 'read', expectedState: { id: 'default', assertions: [] }, beforeState: { assertions: [] } }],
  };
}

async function runWith(error) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-runtime-errors-'));
  try {
    await executeCapturePlan(readPlan(), new ThrowingProvider(error), { baseUrl: 'http://localhost:3000', stateDir: dir, projectRoot: dir });
    assert.fail('应当失败');
  } catch (err) {
    return err;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  process.stdout.write('\nruntime errors\n');

  await test('CaptureError：保留 reason 为 code，认证失效需要输入并带修复提示', async () => {
    const result = toErrorResult(new CaptureError(REASON.AUTH_EXPIRED, '登录已失效'), { phase: 'capture', scope: { pageId: 'profile', scenarioId: 'member' } });
    assert.strictEqual(result.code, 'auth-expired');
    assert.strictEqual(result.policy, 'waiting_input');
    assert.strictEqual(result.requiresInput, true);
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.phase, 'capture');
    assert.deepStrictEqual(result.scope, { pageId: 'profile', scenarioId: 'member' });
    assert.match(result.hint, /auth login/);
  });

  await test('标注排版失败保留 annotation-layout-failed（不归为导航失败），确定性失败不重试', async () => {
    assert.ok(Object.values(REASON).includes('annotation-layout-failed'), 'capture-page 只保留 REASON 里的 code，其余改写为 navigation-failed');
    const result = toErrorResult(new CaptureError(REASON.ANNOTATION_LAYOUT_FAILED, '排版失败'), { phase: 'capture' });
    assert.strictEqual(result.code, 'annotation-layout-failed');
    assert.strictEqual(result.policy, 'fail');
    assert.strictEqual(result.retryable, false);
    assert.match(result.hint, /不是导航问题/);
  });

  await test('C08 策略：瞬时故障重试，404 / provider 缺失失败，5xx 可重试而 4xx 不可', async () => {
    assert.strictEqual(toErrorResult(new CaptureError(REASON.TIMEOUT, 't')).policy, 'retry');
    assert.strictEqual(toErrorResult(new CaptureError(REASON.HTTP_NOT_FOUND, 'n')).policy, 'fail');
    assert.strictEqual(toErrorResult(new CaptureError(REASON.PROVIDER_UNAVAILABLE, 'p')).policy, 'fail');
    assert.strictEqual(toErrorResult(new CaptureError(REASON.HTTP_ERROR, 'e', { status: 502 })).retryable, true);
    assert.strictEqual(toErrorResult(new CaptureError(REASON.HTTP_ERROR, 'e', { status: 403 })).retryable, false);
    assert.strictEqual(toErrorResult(Object.assign(new Error('x'), { code: 'target-ambiguous' })).policy, 'fail');
    assert.strictEqual(toErrorResult(Object.assign(new Error('x'), { code: 'hash-mismatch' })).policy, 'fail');
    assert.strictEqual(toErrorResult(Object.assign(new Error('x'), { code: 'outcome-unknown' })).policy, 'outcome_unknown');
    assert.strictEqual(toErrorResult(new Error('没有分类')).code, 'internal-error');
    assert.strictEqual(toErrorResult(new Error('没有分类')).policy, 'fail');
  });

  await test('存储类错误：锁等待超时可重试，远端锁 / 并发定义修改 / 发布冲突需要输入', async () => {
    assert.strictEqual(toErrorResult(new LockError('lock-timeout', 'x')).policy, 'retry');
    assert.strictEqual(toErrorResult(new LockError('lock-held-remote', 'x')).requiresInput, true);
    assert.strictEqual(toErrorResult(new ProjectStoreError('model-conflict', 'x')).requiresInput, true);
    assert.strictEqual(toErrorResult(new PublicationError('publication-conflict', 'x')).policy, 'waiting_input');
  });

  await test('任务执行错误保留原始 code，不再塌缩为 state-assertion-failed', async () => {
    const ambiguous = await runWith(Object.assign(new Error('匹配到 2 个'), { code: 'target-ambiguous' }));
    assert.ok(ambiguous instanceof TaskExecutionError);
    assert.strictEqual(ambiguous.code, 'target-ambiguous');
    assert.strictEqual(ambiguous.step, 'open');

    const timeout = new Error('locator.click: Timeout 30000ms exceeded.');
    timeout.name = 'TimeoutError';
    const timedOut = await runWith(timeout);
    assert.strictEqual(timedOut.code, 'timeout');
    const mapped = toErrorResult(timedOut, { phase: 'capture' });
    assert.strictEqual(mapped.policy, 'retry');
    assert.strictEqual(mapped.scope.userTaskId, 'edit-profile');
    assert.strictEqual(mapped.scope.stepId, 'open');

    const crashed = await runWith(new CaptureError(REASON.NAVIGATION_FAILED, 'nav'));
    assert.strictEqual(crashed.code, 'navigation-failed');

    const plain = await runWith(new Error('未知故障'));
    assert.strictEqual(plain.code, 'step-failed');
  });

  await test('message 去敏：URL 查询参数、凭据、邮箱、手机号不出现；过长截断', async () => {
    const text = sanitizeMessage('GET https://app.test/api/users?token=abc#x 失败 Authorization: Bearer eyJhbGciOi.x.y cookie=sid=123; user@example.com 13912345678 api_key="k-1"');
    assert.ok(!/abc|eyJhbGciOi|sid=123|user@example|13912345678|k-1/.test(text), text);
    assert.match(text, /https:\/\/app\.test\/api\/users/);
    assert.ok(sanitizeMessage('x'.repeat(2000)).length <= 501);
    const result = toErrorResult(Object.assign(new Error('password=hunter2 失败'), { code: 'timeout' }));
    assert.ok(!/hunter2/.test(result.message));
  });

  await test('兼容投影与持久化摘要', async () => {
    const result = toErrorResult(new CaptureError(REASON.HTTP_NOT_FOUND, '404'), { phase: 'capture' });
    const legacy = toLegacyProjection(result);
    assert.deepStrictEqual(legacy.errors, ['http-not-found: 404']);
    assert.strictEqual(legacy.reason, 'http-not-found');
    assert.deepStrictEqual(Object.keys(errorSummary(result)).sort(), ['code', 'message', 'phase', 'policy', 'requiresInput', 'retryable']);
  });

  await test('沙箱拦截网络归类为 network-access-denied，不重试且带提示', async () => {
    const { classifyNavigationError } = require('../src/browser/errors');
    const err = classifyNavigationError(new Error('page.goto: net::ERR_NETWORK_ACCESS_DENIED at https://app.test/chat'), 'https://app.test/chat');
    assert.strictEqual(err.reason, REASON.NETWORK_ACCESS_DENIED);
    const result = toErrorResult(err, { phase: 'capture' });
    assert.strictEqual(result.code, 'network-access-denied');
    assert.strictEqual(result.retryable, false);
    assert.strictEqual(result.policy, 'fail');
    assert.ok(result.hint.includes('network_access'));
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
