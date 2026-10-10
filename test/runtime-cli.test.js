'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

// 异步 spawn：测试服务器跑在本进程，spawnSync 会阻塞事件循环
function cli(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

async function expectExit(root, args, exit) {
  const r = await cli(root, [...args, '--json']);
  assert.strictEqual(r.status, exit, `manual ${args.join(' ')} 应以 ${exit} 退出\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };

async function setup(baseUrl) {
  const root = fx.captureFixture();
  fx.writeFile(root, 'app/task-profile/page.tsx');
  await expectExit(root, ['init', '--base-url', baseUrl, '--audience', 'public'], 0);
  fx.useDemoValues(root);
  await expectExit(root, ['inspect'], 0);
  await expectExit(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [
    { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' },
    { id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' },
  ] })], 0);
  const file = path.join(root, '.manual', 'pages', 'task-profile.yaml');
  const page = yaml.load(fs.readFileSync(file, 'utf8'));
  page.states = {
    default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
    editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
  };
  fs.writeFileSync(file, yaml.dump(page));
  const task = (id) => ({
    id, title: '修改个人资料', goal: '更新手机号', entryPage: 'task-profile', preconditions: ['已登录'], risk: 'read',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'task-profile', stateBefore: 'default', stateAfter: 'editor',
        action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
      { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
    branches: [], relatedTasks: [],
  });
  // 候选任务 chat 与页面 chat 同名，用来验证歧义目标。
  await expectExit(root, ['discover-tasks', 'task-profile', '--input', writeJson(path.join(root, 'tasks.json'), { tasks: [task('edit-profile'), task('chat')] })], 0);
  await expectExit(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })], 0);
  return root;
}

(async () => {
  process.stdout.write('\nruntime cli\n');
  const server = await startServer();
  const root = await setup(server.baseUrl);
  const runsDir = path.join(root, '.manual', 'runs');
  try {
    await test('generate --plan：只打印计划与风险边界，退出 0，不创建 Run', async () => {
      const out = await expectExit(root, ['generate', 'task:edit-profile', '--plan'], 0);
      assert.strictEqual(out.dryRun, true);
      assert.deepStrictEqual(out.tasks.map((t) => t.id), ['capture', 'draft', 'rewrite', 'validate', 'publish']);
      assert.strictEqual(out.summary.browserScenarios, 1);
      assert.deepStrictEqual(out.summary.riskBoundaries.map((b) => b.stepId), ['save']);
      assert.ok(!fs.existsSync(runsDir), '--plan 不创建 Run');
    });

    await test('参数错误与歧义目标退出 2；离线无证据退出 1 且不打开浏览器', async () => {
      const ambiguous = await expectExit(root, ['generate', 'chat'], 2);
      assert.strictEqual(ambiguous.code, 'ambiguous-target');
      assert.deepStrictEqual(ambiguous.candidates.sort(), ['page:chat', 'task:chat']);
      await expectExit(root, ['generate', 'task:edit-profile', '--nope'], 2);
      await expectExit(root, ['generate', 'task:edit-profile', '--offline', '--refresh'], 2);
      await expectExit(root, ['resume'], 2);
      await expectExit(root, ['run-submit', 'x'], 2);
      const offline = await expectExit(root, ['generate', 'task:edit-profile', '--offline', '--copy-default'], 1);
      assert.strictEqual(offline.code, 'cache-miss-offline');
    });

    await test('一条 generate 自动完成已授权的依赖（采集 → 草稿 → 校验 → 发布），退出 0；status 可读', async () => {
      const out = await expectExit(root, ['generate', 'task:edit-profile', '--copy-default'], 0);
      assert.strictEqual(out.status, 'succeeded');
      assert.deepStrictEqual(out.succeeded, ['capture', 'draft', 'validate', 'publish']);
      const taskDocument = path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md');
      assert.ok(fs.existsSync(taskDocument));
      assert.deepStrictEqual(out.documents, [{ subject: 'task:edit-profile', path: taskDocument }]);
      assert.ok(Array.isArray(out.warnings));
      const status = await expectExit(root, ['status', out.runId], 0);
      assert.strictEqual(status.run.status, 'succeeded');
      assert.deepStrictEqual(status.documents, out.documents);
      assert.deepStrictEqual(status.tasks.map((t) => [t.id, t.status]), [['capture', 'succeeded'], ['draft', 'succeeded'], ['validate', 'succeeded'], ['publish', 'succeeded']]);
      const list = await expectExit(root, ['status'], 0);
      assert.ok(list.runs.some((r) => r.id === out.runId));
      const again = await expectExit(root, ['generate', 'task:edit-profile', '--copy-default', '--plan'], 0);
      assert.strictEqual(again.tasks[0].reason, 'cache-hit');
      assert.strictEqual(again.summary.browserScenarios, 0);
    });

    let waitingRun;
    await test('等待模型文案退出 3，给出请求与下一步；resume --request --input 提交并继续', async () => {
      const out = await expectExit(root, ['generate', 'page:chat'], 3);
      waitingRun = out.runId;
      assert.strictEqual(out.status, 'waiting_input');
      assert.strictEqual(out.waiting[0].id, 'rewrite');
      assert.match(out.waiting[0].next, /manual resume .* --request <requestId> --input/);
      const status = await expectExit(root, ['status', waitingRun], 0);
      assert.strictEqual(status.tasks.find((t) => t.id === 'rewrite').error.code, 'model-input-required');
      const requestDir = path.join(runsDir, waitingRun, 'model');
      const request = JSON.parse(fs.readFileSync(path.join(requestDir, fs.readdirSync(requestDir).find((n) => n.endsWith('.request.json'))), 'utf8'));
      const response = writeJson(path.join(root, 'response.json'), { requestId: request.requestId, inputHash: 'sha256:wrong', output: { copy: { intro: '在这里和 AI 助手对话。' } } });
      const rejected = await expectExit(root, ['resume', waitingRun, '--request', request.requestId, '--input', response], 1);
      assert.strictEqual(rejected.code, 'invalid-model-response');
      assert.strictEqual((await expectExit(root, ['status', waitingRun], 0)).run.status, 'waiting_input', '校验失败不继续 Run');
      writeJson(response, { requestId: request.requestId, inputHash: request.inputHash, output: { copy: { intro: '在这里和 AI 助手对话。' } } });
      const resumed = await expectExit(root, ['resume', waitingRun, '--request', request.requestId, '--input', response], 0);
      assert.strictEqual(resumed.status, 'succeeded');
      assert.deepStrictEqual(resumed.documents, [{ subject: 'page:chat', path: path.join(root, 'docs', 'manual', 'chat.md') }]);
      assert.match(fs.readFileSync(path.join(root, 'docs', 'manual', 'chat.md'), 'utf8'), /在这里和 AI 助手对话。/);
    });

    await test('输入在等待期间变化：resume 退出 4 且原 Run 不变；--replan 创建记录 predecessor 的新 Run', async () => {
      const out = await expectExit(root, ['generate', 'task:edit-profile', '--copy-default', '--refresh', '--plan'], 0);
      assert.match(out.tasks[0].reason, /^cache-refresh/);
      const waiting = await expectExit(root, ['generate', 'task:edit-profile'], 3);
      const before = fs.readFileSync(path.join(runsDir, waiting.runId, 'tasks', 'rewrite.json'), 'utf8');
      // 修改任务的执行定义：采集输入变化
      const taskFile = path.join(root, '.manual', 'tasks', 'edit-profile.yaml');
      const task = yaml.load(fs.readFileSync(taskFile, 'utf8'));
      task.steps[0].capture = { timing: 'before' };
      fs.writeFileSync(taskFile, yaml.dump(task));
      const changed = await expectExit(root, ['resume', waiting.runId], 4);
      assert.strictEqual(changed.code, 'run-input-changed');
      assert.ok(changed.changed.length > 0);
      assert.strictEqual(fs.readFileSync(path.join(runsDir, waiting.runId, 'tasks', 'rewrite.json'), 'utf8'), before, '原 Run 不变');
      const replanned = await expectExit(root, ['resume', waiting.runId, '--replan'], 3);
      assert.strictEqual(replanned.predecessor, waiting.runId);
      assert.notStrictEqual(replanned.runId, waiting.runId);
      const status = await expectExit(root, ['status', replanned.runId], 0);
      assert.strictEqual(status.run.predecessor, waiting.runId);
    });

    await test('capture task:<id> 与 capture-task 走同一用例并登记缓存；帮助列出新命令', async () => {
      await expectExit(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions2.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })], 0);
      const captured = await expectExit(root, ['capture', 'task:edit-profile'], 0);
      assert.strictEqual(captured.status, 'captured');
      const plan = await expectExit(root, ['generate', 'task:edit-profile', '--copy-default', '--plan'], 0);
      assert.strictEqual(plan.tasks[0].reason, 'cache-hit');
      const help = await cli(root, ['--help']);
      for (const name of ['status', 'resume']) assert.match(help.stdout, new RegExp(`\\b${name}\\b`));
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
