'use strict';

/*
 * P3-03：在线验证（真实浏览器 + CLI 子进程）。
 *   - artifacts 与 live 范围分开；每次验证写新的不可变报告，不新增 Capture
 *   - live 每次真实导航：Git 无变化、按钮改名 / 权限收回 / 页面 404 都能发现并分类
 *   - 写步骤不执行：报告覆盖比例与停止边界，未执行的声明是 not_run
 *   - 服务不可达是 inconclusive，不冒充产品回归
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { classify } = require('../src/verify/report');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

async function expectExit(root, args, exit, env) {
  const r = await cli(root, args, env);
  assert.strictEqual(r.status, exit, `manual ${args.join(' ')} 应以 ${exit} 退出\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };
const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);

/** 与 Gate 2 相同的任务：打开编辑面板（可验证），保存（写操作，不执行）。 */
async function prepare(root, server, env) {
  const yaml = require('js-yaml');
  fx.writeFile(root, 'app/task-profile/page.tsx');
  await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
  fx.useDemoValues(root);
  await expectExit(root, ['inspect'], 0, env);
  await expectExit(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [
    { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' },
    { id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' },
  ] })], 0, env);
  const file = path.join(root, '.manual', 'pages', 'task-profile.yaml');
  const page = yaml.load(fs.readFileSync(file, 'utf8'));
  page.states = {
    default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
    editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
  };
  fs.writeFileSync(file, yaml.dump(page));
  await expectExit(root, ['discover-tasks', 'task-profile', '--input', writeJson(path.join(root, 'tasks.json'), { tasks: [{
    id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'task-profile', preconditions: ['已登录'], risk: 'read',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'task-profile', stateBefore: 'default', stateAfter: 'editor',
        action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after' } },
      { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion: { description: '编辑面板打开', claims: [
      { id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] },
      { id: 'saved', text: '资料已保存。', assertionRefs: ['save-toast'] },
    ] },
    branches: [], relatedTasks: [],
  }] })], 0, env);
  await expectExit(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })], 0, env);
  await expectExit(root, ['generate', 'task:edit-profile', '--copy-default'], 0, env);
  await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
  if (fx.hasGit()) fx.gitInit(root);
}

(async () => {
  process.stdout.write('\nlive verify\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const env = { MANUAL_AUTH_CACHE_DIR: path.join(root, '.auth-cache') };
  const state = path.join(root, '.manual');
  const captures = () => count(path.join(state, 'evidence', 'captures'));
  const reports = () => count(path.join(state, 'verifications'));
  let serverClosed = false;
  try {
    await step('准备：任务与页面手册已发布', () => prepare(root, server, env));

    await step('artifacts 与 live 范围分开：artifacts 不访问浏览器、onlineChecked=false', async () => {
      const artifacts = await expectExit(root, ['verify', 'task:edit-profile'], 0, env);
      assert.strictEqual(artifacts.scope, 'artifacts');
      assert.strictEqual(artifacts.onlineChecked, false);
      const all = await expectExit(root, ['verify', '--all'], 0, env);
      assert.deepStrictEqual(all.reports.map((r) => [r.target, r.result]).sort(), [['page:chat', 'passed'], ['task:edit-profile', 'passed']]);
    });

    await step('live 通过：真实回放、claim 逐条结果、写步骤不执行并报告覆盖与停止边界；不新增 Capture', async () => {
      const before = { captures: captures(), reports: reports() };
      const out = await expectExit(root, ['verify', 'task:edit-profile', '--live'], 0, env);
      const report = out.reports[0];
      assert.strictEqual(report.result, 'passed');
      assert.deepStrictEqual(report.claims.map((c) => [c.id, c.releaseStatus, c.liveStatus, c.outcome]), [
        ['editor-opened', 'verified', 'verified', 'passed'],
        ['saved', 'not_run', 'not_run', 'not_run'],
      ]);
      assert.deepStrictEqual(report.coverage.steps, { total: 2, executed: 1, notExecuted: 1 });
      assert.deepStrictEqual(report.coverage.stoppedAt, { stepId: 'save', reason: 'stop-before-action' });
      assert.strictEqual(report.sections.find((s) => s.id === 'step.save').outcome, 'not_run');
      assert.strictEqual(report.sections.find((s) => s.id === 'step.open-editor').outcome, 'passed');
      assert.strictEqual(captures(), before.captures, '在线验证不产生新的 Capture');
      assert.strictEqual(reports(), before.reports + 1);
      const saved = JSON.parse(fs.readFileSync(path.join(state, 'verifications', `${report.verificationId}.json`), 'utf8'));
      assert.strictEqual(saved.onlineChecked, true);
      assert.ok(saved.inputRevisions.scenarioRevision && saved.releaseId && saved.environment.origin);
    });

    await step('重复 live：每次真实导航、生成新报告，旧报告不变', async () => {
      const first = fs.readdirSync(path.join(state, 'verifications')).map((f) => [f, fs.readFileSync(path.join(state, 'verifications', f), 'utf8')]);
      const out = await expectExit(root, ['verify', 'page:chat', '--live'], 0, env);
      assert.ok(!first.some(([f]) => f === `${out.reports[0].verificationId}.json`));
      for (const [f, text] of first) assert.strictEqual(fs.readFileSync(path.join(state, 'verifications', f), 'utf8'), text);
    });

    await step('Git 无变化、按钮改名：live 失败（ui-changed，退出码 4），artifacts 仍通过', async () => {
      if (fx.hasGit()) assert.strictEqual(fx.git(root, ['status', '--porcelain', '--', 'app', 'components']), '', '源码无变化');
      server.set({ editLabel: '修改资料' });
      const out = await expectExit(root, ['verify', 'task:edit-profile', '--live'], 4, env);
      const report = out.reports[0];
      assert.strictEqual(report.result, 'failed');
      const failure = report.failures.find((f) => f.id === 'action:open-editor');
      assert.strictEqual(failure.category, 'ui-changed');
      assert.strictEqual(report.claims.find((c) => c.id === 'editor-opened').outcome, 'failed');
      await expectExit(root, ['verify', 'task:edit-profile'], 0, env);
      server.reset();
    });

    await step('Git 无变化、权限收回（接口不再提供编辑）：live 发现；恢复后通过', async () => {
      server.set({ canEdit: false });
      const out = await expectExit(root, ['verify', 'task:edit-profile', '--live'], 4, env);
      assert.ok(out.reports[0].failures.some((f) => f.stepId === 'open-editor'));
      server.reset();
      await expectExit(root, ['verify', 'task:edit-profile', '--live'], 0, env);
    });

    await step('页面下线（404）：page-not-found；--all 汇总为失败', async () => {
      server.set({ missing: ['/chat'] });
      const out = await expectExit(root, ['verify', '--all', '--live'], 4, env);
      const chat = out.reports.find((r) => r.target === 'page:chat');
      assert.strictEqual(chat.failures[0].category, 'page-not-found');
      assert.strictEqual(out.reports.find((r) => r.target === 'task:edit-profile').result, 'passed');
      server.reset();
    });

    await step('服务不可达：inconclusive（退出码 1），不冒充产品回归', async () => {
      await server.close();
      serverClosed = true;
      const out = await expectExit(root, ['verify', 'page:chat', '--live'], 1, env);
      assert.strictEqual(out.reports[0].result, 'inconclusive');
      assert.strictEqual(out.reports[0].failures[0].category, 'verification-inconclusive');
    });

    await step('分类表：网络 / 超时 inconclusive；登录需要输入；UI 与状态变化是 failed', async () => {
      assert.strictEqual(classify('server-unreachable').outcome, 'inconclusive');
      assert.strictEqual(classify('timeout').outcome, 'inconclusive');
      assert.strictEqual(classify('login-required').needsInput, true);
      assert.strictEqual(classify('target-not-visible').category, 'ui-changed');
      assert.strictEqual(classify('state-assertion-failed').outcome, 'failed');
      assert.strictEqual(classify('http-not-found').category, 'page-not-found');
    });
  } finally {
    if (!serverClosed) await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
