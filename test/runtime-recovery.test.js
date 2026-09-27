'use strict';

/*
 * 中断恢复：在六个检查点真实杀掉执行进程（exit 137），由全新进程 resume。
 * 断言：已提交的产物补记成功而不重做；只有 staging 的采集回收后重采；发布按 journal 继续；
 * 无重复 Capture / 重复发布；重复 resume 不再产生任何业务动作。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { resumeRun, runStatus } = require('../src/runtime/app');
const { submitModelResponse } = require('../src/runtime/model-response');
const { loadConfig } = require('../src/config/load');
const { listReleases } = require('../src/publication/release-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const APP = path.resolve(__dirname, '..', 'src', 'runtime', 'app.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function spawnAsync(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr, child }));
  });
}

async function cli(root, args) {
  const r = await spawnAsync([CLI, ...args, '--project-root', root, '--json']);
  assert.strictEqual(r.status, 0, `manual ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };

async function project(baseUrl) {
  const root = fx.captureFixture();
  fx.writeFile(root, 'app/task-profile/page.tsx');
  await cli(root, ['init', '--base-url', baseUrl, '--audience', 'public']);
  await cli(root, ['inspect']);
  await cli(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [{ id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' }] })]);
  const file = path.join(root, '.manual', 'pages', 'task-profile.yaml');
  const page = yaml.load(fs.readFileSync(file, 'utf8'));
  page.states = {
    default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
    editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
  };
  fs.writeFileSync(file, yaml.dump(page));
  await cli(root, ['discover-tasks', 'task-profile', '--input', writeJson(path.join(root, 'tasks.json'), { tasks: [{
    id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'task-profile', preconditions: ['已登录'], risk: 'read',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'task-profile', stateBefore: 'default', stateAfter: 'editor',
        action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
      { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
    branches: [], relatedTasks: [],
  }] })]);
  await cli(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })]);
  return root;
}

/** 在子进程里执行 generate，在指定检查点被强杀。返回留下的 runId。 */
async function crashAt(root, fault, copy = { mode: 'default' }) {
  const script = `
    const { startRun } = require(${JSON.stringify(APP)});
    startRun({ projectRoot: ${JSON.stringify(root)}, command: 'generate', targets: ['task:edit-profile'], copy: ${JSON.stringify(copy)} })
      .then(() => process.exit(0), (e) => { process.stderr.write(String(e.stack || e)); process.exit(1); });
  `;
  const r = await spawnAsync(['-e', script], { MANUAL_TEST_FAULTS: '1', MANUAL_TEST_FAULT: fault });
  assert.strictEqual(r.status, 137, `应在 ${fault} 被强杀\n${r.stderr}`);
  const runs = fs.readdirSync(path.join(root, '.manual', 'runs'));
  assert.strictEqual(runs.length, 1);
  return runs[0];
}

const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);
const captures = (root) => count(path.join(root, '.manual', 'evidence', 'captures'));
const staging = (root) => count(path.join(root, '.manual', 'evidence', 'staging'));
const releases = (root) => listReleases(path.join(root, '.manual'), 'task-edit-profile').length;
const recovery = (root, runId) => runStatus({ projectRoot: root, runId }).recovery.map((r) => [r.taskId, r.result]);

(async () => {
  process.stdout.write('\nruntime recovery\n');
  const server = await startServer();
  const roots = [];
  const fresh = async () => { const root = await project(server.baseUrl); roots.push(root); return root; };
  try {
    await test('task-running：采集刚记 running 就被杀 → 新进程判定中断、从 Scenario 起点重采', async () => {
      const root = await fresh();
      const runId = await crashAt(root, 'task-running');
      assert.strictEqual(captures(root), 0);
      const result = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      assert.deepStrictEqual(recovery(root, runId), [['capture', 'replay']]);
      assert.strictEqual(captures(root), 1);
      assert.strictEqual(releases(root), 1);
    });

    await test('raw-captured：只有 staging 里的原图 → 回收残留 staging 后重采，不产生半条记录', async () => {
      const root = await fresh();
      const runId = await crashAt(root, 'raw-captured');
      assert.strictEqual(captures(root), 0);
      assert.strictEqual(staging(root), 1, '被杀的进程留下 staging');
      const result = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      assert.strictEqual(staging(root), 0, 'staging 被回收');
      assert.strictEqual(captures(root), 1);
    });

    await test('capture-committed：Capture 已提交但任务未记成功 → 补记成功，不重新采集', async () => {
      const root = await fresh();
      const runId = await crashAt(root, 'capture-committed');
      assert.strictEqual(captures(root), 1);
      const result = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      assert.deepStrictEqual(recovery(root, runId), [['capture', 'reconciled']]);
      assert.strictEqual(captures(root), 1, '没有重复采集');
      assert.strictEqual(releases(root), 1);
    });

    await test('rewrite-requested：请求已写出但未记等待 → 恢复后复用同一请求；提交响应后完成', async () => {
      const root = await fresh();
      const runId = await crashAt(root, 'rewrite-requested', { mode: 'model' });
      const modelDir = path.join(root, '.manual', 'runs', runId, 'model');
      assert.strictEqual(count(modelDir), 1);
      const waiting = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(waiting.summary.status, 'waiting_input');
      assert.strictEqual(count(modelDir), 1, '没有产生第二个请求');
      const request = JSON.parse(fs.readFileSync(path.join(modelDir, fs.readdirSync(modelDir)[0]), 'utf8'));
      submitModelResponse({ projectRoot: root, config: loadConfig(root).config, runId, requestId: request.requestId, response: { requestId: request.requestId, inputHash: request.inputHash, output: { copy: { intro: '修改后记得检查手机号。' } } } });
      const done = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(done.summary.status, 'succeeded', JSON.stringify(done.summary));
      assert.strictEqual(captures(root), 1);
    });

    await test('doc-renamed：文档已替换、发布记录未写 → 按本 Run 的 journal 继续，只有一条发布记录', async () => {
      const root = await fresh();
      const runId = await crashAt(root, 'doc-renamed');
      assert.ok(fs.existsSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md')));
      assert.strictEqual(releases(root), 0);
      const journalDir = path.join(root, '.manual', 'runs', runId, 'publication');
      assert.strictEqual(count(journalDir), 1, 'Run 内发布的 journal 位于 runs/<runId>/publication/');
      const result = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      assert.deepStrictEqual(recovery(root, runId), [['publish', 'reconciled']]);
      assert.strictEqual(releases(root), 1);
      assert.strictEqual(captures(root), 1);
    });

    await test('release-committed：发布记录已写、current 未更新 → 补完指针与任务状态，不重复发布；重复 resume 零动作', async () => {
      const root = await fresh();
      const runId = await crashAt(root, 'release-committed');
      assert.strictEqual(releases(root), 1);
      const result = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      assert.strictEqual(releases(root), 1, '没有第二条发布记录');
      const task = yaml.load(fs.readFileSync(path.join(root, '.manual', 'tasks', 'edit-profile.yaml'), 'utf8'));
      assert.strictEqual(task.status, 'generated');
      const docBefore = fs.readFileSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md'));
      const again = await resumeRun({ projectRoot: root, runId });
      assert.strictEqual(again.summary.status, 'succeeded');
      assert.strictEqual(releases(root), 1);
      assert.strictEqual(captures(root), 1);
      assert.ok(fs.readFileSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md')).equals(docBefore));
    });

    await test('SIGINT：CLI 中断当前任务并释放浏览器，状态记 interrupted；resume 继续完成', async () => {
      const root = await fresh();
      const child = spawn(process.execPath, [CLI, 'generate', 'task:edit-profile', '--copy-default', '--json', '--project-root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      const exited = new Promise((resolve) => child.on('close', (status) => resolve(status)));
      const tasksDir = () => {
        const runs = path.join(root, '.manual', 'runs');
        return fs.existsSync(runs) && fs.readdirSync(runs).length ? path.join(runs, fs.readdirSync(runs)[0], 'tasks') : null;
      };
      for (let i = 0; i < 200; i++) {
        const dir = tasksDir();
        if (dir && fs.existsSync(path.join(dir, 'capture.json')) && JSON.parse(fs.readFileSync(path.join(dir, 'capture.json'), 'utf8')).status === 'running') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      child.kill('SIGINT');
      const status = await exited;
      assert.strictEqual(status, 1, stdout);
      const out = JSON.parse(stdout);
      assert.deepStrictEqual(out.interrupted, ['capture']);
      const result = await resumeRun({ projectRoot: root, runId: out.runId });
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      assert.strictEqual(staging(root), 0);
    });
  } finally {
    await server.close();
    for (const root of roots) fx.cleanup(root);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
