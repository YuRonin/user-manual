'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { captureStable } = require('../src/evidence/capture-safe');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-stability-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** quiet 依次返回给定状态；记录截图次数。 */
function provider(states) {
  const p = { shots: 0, quiet: [...states] };
  p.waitForQuiet = async () => p.quiet.shift() || { dom: 'quiet', network: 'idle', pendingRequests: 0 };
  p.collectGeometry = async () => ({ dpr: 1, viewport: { width: 10, height: 10 }, scroll: { x: 0, y: 0 }, documentSize: null, mutationGeneration: 1 });
  p.screenshot = async ({ path: file }) => { p.shots++; return { path: file, bytes: 1, meta: { viewport: { width: 10, height: 10 } } }; };
  return p;
}
const streaming = { dom: 'max-wait', network: 'busy', pendingRequests: 1 };

(async () => {
  process.stdout.write('\ncapture stability\n');

  await test('回复仍在输出（DOM 未静止）时不截图，静止后再截', async (root) => {
    const p = provider([streaming, streaming]);
    const result = await captureStable(p, { rawPath: path.join(root, 'raw.png') });
    assert.strictEqual(p.shots, 1, '只在静止后截一次');
    assert.strictEqual(result.attempts, 3);
    assert.deepStrictEqual(result.warnings, []);
  });

  await test('始终不稳定：有界放弃并报告当前状态，不产出截图', async (root) => {
    const p = provider([streaming, streaming, streaming]);
    await assert.rejects(() => captureStable(p, { rawPath: path.join(root, 'raw.png') }), (error) => error.code === 'geometry-unstable' && /DOM 持续变化.*1 个数据请求未结束/.test(error.message));
    assert.strictEqual(p.shots, 0);
  });

  await test('DOM 静止但数据请求未结束（长轮询）：照常截图并留下提示', async (root) => {
    const p = provider([{ dom: 'quiet', network: 'busy', pendingRequests: 2 }]);
    const result = await captureStable(p, { rawPath: path.join(root, 'raw.png') });
    assert.strictEqual(p.shots, 1);
    assert.match(result.warnings[0], /^screenshot-network-busy: .*2 个数据请求/);
  });

  const { validateNavigation, validateWithReload } = require('../src/evidence/validate-page');
  const openResult = { status: 200, finalUrl: 'http://x.test/chat', redirected: false };
  const reloadingProvider = (states) => {
    const p = { reloads: 0, states: [...states] };
    p.reload = async () => { p.reloads++; };
    return p;
  };
  const settleFrom = (p) => async () => ({ ready: { warnings: [] }, observation: { url: 'http://x.test/chat', busy: p.states.shift() === 'loading', title: '工作台', textLength: 100 } });
  const validate = (observation) => validateNavigation({ requestedUrl: 'http://x.test/chat', openResult, observation, expected: {} });

  await test('入口长期加载中：刷新一次后恢复，并留下 page-reloaded 记录', async () => {
    const p = reloadingProvider(['loading', 'normal']);
    const result = await validateWithReload(p, { settle: settleFrom(p), validate, enabled: true, timeout: 1000 });
    assert.strictEqual(p.reloads, 1);
    assert.strictEqual(result.reloaded, true);
    assert.ok(result.navigation.warnings.some((w) => w.startsWith('page-reloaded')));
  });

  await test('刷新后仍加载中 / 关闭刷新：报告 readiness-timeout，最多刷新一次', async () => {
    const p = reloadingProvider(['loading', 'loading', 'loading']);
    await assert.rejects(() => validateWithReload(p, { settle: settleFrom(p), validate, enabled: true }), (e) => (e.reason || e.code) === 'readiness-timeout');
    assert.strictEqual(p.reloads, 1);
    const off = reloadingProvider(['loading']);
    await assert.rejects(() => validateWithReload(off, { settle: settleFrom(off), validate, enabled: false }), (e) => (e.reason || e.code) === 'readiness-timeout');
    assert.strictEqual(off.reloads, 0);
  });

  await test('等待预算可配置但有上限；assertionTimeoutMs 超限明确拒绝', () => {
    const { validateWaits, resolveWaits } = require('../src/config/waits');
    const errors = [];
    validateWaits({ readinessMs: 120000, stabilityMs: 8000 }, errors);
    assert.deepStrictEqual(errors, []);
    validateWaits({ readinessMs: 3600000, reloadOnStuckLoading: 'yes' }, errors);
    assert.strictEqual(errors.length, 2);
    assert.strictEqual(resolveWaits({}).readinessMs, 30000);
    const { validateTask } = require('../src/tasks/model');
    const task = (assertionTimeoutMs) => ({ id: 't', title: 't', goal: 'g', entryPage: 'p', risk: 'read', status: 'candidate', preconditions: [], completion: { description: 'd', verification: 'expected' },
      steps: [{ id: 's', instruction: '查看', page: 'p', action: { type: 'inspect' }, assertionTimeoutMs }] });
    assert.strictEqual(validateTask(task(360000)).ok, true, '生成类长等待（6 分钟）允许');
    const tooLong = validateTask(task(700000));
    assert.strictEqual(tooLong.ok, false);
    assert.ok(tooLong.errors.some((e) => /assertionTimeoutMs/.test(e)), tooLong.errors.join('；'));
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
