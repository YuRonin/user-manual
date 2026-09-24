'use strict';

/*
 * 导航 / 页面身份 / 前后状态验证。
 * 纯函数部分直接断言；任务执行顺序用假 provider 计数；错页夹具用真浏览器跑 capture。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { validateNavigation, assertWithin } = require('../src/evidence/validate-page');
const { REASON } = require('../src/browser/errors');
const { executeCapturePlan } = require('../src/tasks/executor');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  }
}

function reasonOf(fn) {
  try { fn(); } catch (error) { return error.reason || error.code; }
  return null;
}

const BASE = 'http://app.test';
const normal = { url: `${BASE}/chat`, hasPasswordField: false, bodyTextLength: 500, elementCount: 40 };

// ---------------------------------------------------------------- 假 provider：记录调用顺序

class FakeProvider {
  constructor({ status = 200, observation = null, failBefore = false } = {}) {
    this.calls = [];
    this.status = status;
    this.observation = observation;
    this.failBefore = failBefore;
  }
  async open(url) { this.calls.push('open'); return { status: this.status, finalUrl: url }; }
  async waitUntilReady() { this.calls.push('ready'); return { steps: {}, warnings: [] }; }
  async currentObservation() { return this.observation; }
  async assertCondition(assertion) {
    this.calls.push(`assert:${assertion.target?.name || assertion.type}`);
    if (this.failBefore && assertion.target?.name === '个人中心') throw Object.assign(new Error('不可见'), { code: 'target-not-visible' });
    return { ok: true };
  }
  async performAction(action) { this.calls.push(`action:${action.type}`); return { target: action.target, rect: { x: 1, y: 1, width: 10, height: 10 } }; }
  async screenshot({ path: file }) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'png');
    return { path: file, bytes: 3, meta: { viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 } };
  }
  async close() { this.calls.push('close'); }
}

function plan(afterAssertions) {
  const heading = { type: 'visible', target: { role: 'heading', name: '个人中心' } };
  return {
    taskId: 't', entry: { page: 'profile', route: '/profile', state: 'default', assertions: [heading] },
    steps: [{
      id: 'open', page: 'profile', stateBefore: 'default',
      beforeState: { id: 'default', assertions: [heading] },
      action: { type: 'click', target: { role: 'button', name: '编辑资料' } },
      execution: 'auto', willExecute: true,
      expectedState: { id: 'editor', assertions: afterAssertions },
    }],
  };
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function main() {
  process.stdout.write('\npage validation\n');

  // ------------------------------------------------------------ 纯规则
  await test('正常 200：记录 http-status / final-url / page-state 三项验证', () => {
    const result = validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: { status: 200, finalUrl: `${BASE}/chat` }, observation: normal });
    assert.deepStrictEqual(result.validations.map((v) => v.check), ['http-status', 'final-url', 'page-state']);
    assert.ok(result.validations.every((v) => v.outcome === 'passed'));
  });

  await test('HTTP 500 即使页面有正常按钮也失败', () => {
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: { status: 500, finalUrl: `${BASE}/chat` }, observation: normal })), REASON.HTTP_ERROR);
  });

  await test('SPA 延迟跳登录：以等待后的 URL 为准判定需要登录', () => {
    const observation = { ...normal, url: `${BASE}/login` };
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: { status: 200, finalUrl: `${BASE}/chat` }, observation })), REASON.LOGIN_REQUIRED);
  });

  await test('软 404、仍在加载、错误提示在普通场景中失败，在显式声明的场景中通过', () => {
    const open = { status: 200, finalUrl: `${BASE}/chat` };
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: { ...normal, notFoundHint: true } })), REASON.SOFT_NOT_FOUND);
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: { ...normal, busy: true } })), REASON.READINESS_TIMEOUT);
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: { ...normal, errorAlert: true } })), REASON.UNEXPECTED_STATE);
    validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: { ...normal, busy: true }, expected: { state: 'loading' } });
    validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: { ...normal, errorAlert: true }, expected: { state: 'error' } });
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: normal, expected: { state: 'loading' } })), REASON.UNEXPECTED_STATE);
  });

  await test('跳转：跨 origin 停止；声明了允许列表时未知路径停止，否则记录实际地址', () => {
    const cross = { ...normal, url: 'http://evil.test/' };
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: { status: 200, finalUrl: cross.url }, observation: cross })), REASON.UNEXPECTED_REDIRECT);
    const moved = { ...normal, url: `${BASE}/workspace` };
    const open = { status: 200, finalUrl: moved.url };
    assert.strictEqual(reasonOf(() => validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: moved, expected: { allowRedirects: ['/home'] } })), REASON.UNEXPECTED_REDIRECT);
    const allowed = validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: moved, expected: { allowRedirects: ['/workspace'] } });
    assert.strictEqual(allowed.actualRoute, '/workspace');
    const recorded = validateNavigation({ requestedUrl: `${BASE}/chat`, openResult: open, observation: moved });
    assert.strictEqual(recorded.redirected, true);
    assert.strictEqual(recorded.warnings.length, 1);
  });

  await test('正文很长的账号设置页即使有密码框也不判为登录页', () => {
    const observation = { ...normal, url: `${BASE}/settings`, hasPasswordField: true, bodyTextLength: 1200, elementCount: 60 };
    validateNavigation({ requestedUrl: `${BASE}/settings`, openResult: { status: 200, finalUrl: `${BASE}/settings` }, observation });
  });

  await test('有界自动等待：稍后出现的目标通过，始终不出现的按定位分类失败', async () => {
    let attempts = 0;
    const eventually = { async assertCondition() { attempts++; if (attempts < 3) throw Object.assign(new Error('x'), { code: 'target-not-visible' }); return { ok: true }; } };
    await assertWithin(eventually, { type: 'visible' }, { timeoutMs: 2000, intervalMs: 10 });
    assert.strictEqual(attempts, 3);
    const ambiguous = { async assertCondition() { throw Object.assign(new Error('2 个'), { code: 'target-ambiguous' }); } };
    await assert.rejects(() => assertWithin(ambiguous, { type: 'visible' }, { timeoutMs: 50, intervalMs: 10 }), (e) => e.code === 'target-ambiguous');
  });

  // ------------------------------------------------------------ 任务执行顺序
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-page-validation-'));
  const options = { baseUrl: BASE, stateDir: path.join(root, '.manual'), assertionTimeoutMs: 50 };
  try {
    await test('任务入口 HTTP 500：失败且不执行任何动作', async () => {
      const provider = new FakeProvider({ status: 500, observation: { ...normal, url: `${BASE}/profile` } });
      await assert.rejects(() => executeCapturePlan(plan([{ type: 'visible', target: { role: 'dialog', name: '编辑资料' } }]), provider, options), (e) => e.code === 'http-error');
      assert.ok(!provider.calls.some((call) => call.startsWith('action:')));
    });

    await test('stateBefore 断言失败：动作调用次数为 0，错误带 before 阶段的 validation', async () => {
      const provider = new FakeProvider({ observation: { ...normal, url: `${BASE}/profile` }, failBefore: true });
      const entryless = plan([{ type: 'visible', target: { role: 'dialog', name: '编辑资料' } }]);
      entryless.entry.assertions = [];
      await assert.rejects(() => executeCapturePlan(entryless, provider, options), (e) => e.code === 'target-not-visible' && e.validation.phase === 'before');
      assert.strictEqual(provider.calls.filter((call) => call.startsWith('action:')).length, 0);
    });

    await test('执行顺序：入口身份 → before → 动作 → after；只有 URL 的 after 状态记为 observed', async () => {
      let provider = new FakeProvider({ observation: { ...normal, url: `${BASE}/profile` } });
      let result = await executeCapturePlan(plan([{ type: 'visible', target: { role: 'dialog', name: '编辑资料' } }]), provider, options);
      assert.deepStrictEqual(provider.calls.filter((c) => c !== 'ready' && c !== 'close'), [
        'open', 'assert:个人中心', 'assert:个人中心', 'action:click', 'assert:编辑资料',
      ]);
      assert.strictEqual(result.steps[0].status, 'verified');
      assert.strictEqual(result.entryIdentity, 'verified');
      assert.deepStrictEqual(result.steps[0].validations.map((v) => v.phase), ['before', 'after']);

      provider = new FakeProvider({ observation: { ...normal, url: `${BASE}/profile` } });
      result = await executeCapturePlan(plan([{ type: 'url', value: '/profile' }]), provider, options);
      assert.strictEqual(result.steps[0].status, 'observed', '只有 URL 断言不能称为 verified');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  await test('截图计划拒绝没有断言的状态，并展开 beforeState', () => {
    const { buildCapturePlan } = require('../src/tasks/capture-plan');
    const page = { id: 'p', route: '/p', states: { default: { assertions: [{ type: 'visible', target: { role: 'heading', name: 'P' } }] }, empty: { description: '空', assertions: [] } } };
    const task = { id: 't', title: 'T', entryPage: 'p', risk: 'read', status: 'approved', steps: [{ id: 's', page: 'p', stateBefore: 'default', stateAfter: 'empty', action: { type: 'click', target: { role: 'button', name: 'x' } } }] };
    let built = buildCapturePlan(task, [page]);
    assert.strictEqual(built.ok, false);
    assert.match(built.errors.join('\n'), /没有任何断言/);
    task.steps[0].stateAfter = 'default';
    built = buildCapturePlan(task, [page]);
    assert.strictEqual(built.ok, true, built.errors?.join('\n'));
    assert.strictEqual(built.plan.steps[0].beforeState.assertions[0].target.name, 'P');
    assert.strictEqual(built.plan.entry.assertions[0].target.name, 'P');
  });

  // ------------------------------------------------------------ 真浏览器错页夹具
  const server = await startServer();
  const project = fx.captureFixture();
  try {
    let r = await runCli(['init', '--project-root', project, '--base-url', server.baseUrl]);
    assert.strictEqual(r.status, 0, r.stderr);
    r = await runCli(['inspect', '--project-root', project]);
    assert.strictEqual(r.status, 0, r.stderr);
    const raw = path.join(project, '.manual', 'artifacts', 'raw', 'pages', 'chat.png');
    const captureUrl = (route, extra = []) => runCli(['capture', 'chat', '--project-root', project, '--url', `${server.baseUrl}${route}`, '--timeout', '3000', '--json', ...extra]);

    for (const [route, reasons, label] of [
      ['/error500-with-button', ['http-error'], 'HTTP 500 但有正常按钮'],
      ['/soft-404', ['soft-not-found'], '200 软 404'],
      ['/spa-redirect', ['login-required', 'auth-missing'], 'SPA 延迟跳登录'],
      ['/loading-forever', ['readiness-timeout'], 'Loading 永不结束'],
      ['/error-state', ['unexpected-page-state'], '页面显示错误提示'],
      ['/cross-origin', ['unexpected-redirect'], '跳到其他 origin'],
    ]) {
      await test(`真浏览器：${label} → ${reasons.join('/')}，不产出截图`, async () => {
        if (fs.existsSync(raw)) fs.rmSync(raw);
        const result = await captureUrl(route);
        assert.strictEqual(result.status, 1, result.stdout + result.stderr);
        assert.ok(reasons.includes(JSON.parse(result.stdout).reason), result.stdout);
        assert.ok(!fs.existsSync(raw), '失败时不能产出截图');
      });
    }

    await test('真浏览器：--wait-for 等不到即 readiness-timeout', async () => {
      const result = await captureUrl('/chat', ['--wait-for', '#never-appears']);
      assert.strictEqual(result.status, 1);
      assert.strictEqual(JSON.parse(result.stdout).reason, 'readiness-timeout');
      assert.ok(!fs.existsSync(raw));
    });

    await test('真浏览器：页面身份断言不符时失败，相符时记录 identity=verified', async () => {
      const pageFile = path.join(project, '.manual', 'pages', 'chat.yaml');
      const page = yaml.load(fs.readFileSync(pageFile, 'utf8'));
      page.states = { default: { description: '工作台', assertions: [{ type: 'visible', target: { role: 'heading', name: '别的页面' } }] } };
      fs.writeFileSync(pageFile, yaml.dump(page));
      let result = await runCli(['capture', 'chat', '--project-root', project, '--json']);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.strictEqual(JSON.parse(result.stdout).reason, 'page-identity-failed');

      page.states.default.assertions[0].target.name = '工作台';
      fs.writeFileSync(pageFile, yaml.dump(page));
      result = await runCli(['capture', 'chat', '--project-root', project, '--json']);
      assert.strictEqual(result.status, 0, result.stdout + result.stderr);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.identity, 'verified');
      assert.ok(out.validations.some((v) => v.scope === 'page-identity' && v.assertionId === 'default#0'));
      assert.strictEqual(yaml.load(fs.readFileSync(pageFile, 'utf8')).browser.identity, 'verified');
    });
  } finally {
    await server.close();
    fx.cleanup(project);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
