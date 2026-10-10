'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { createRunStore } = require('../src/runtime/store');
const { runRun } = require('../src/runtime/runner');
const { HANDLERS } = require('../src/runtime/handlers');
const { collectPlanningInputs, plan } = require('../src/runtime/planner');
const { createCacheStore } = require('../src/cache/store');
const { resolveMode } = require('../src/cache/policy');
const { loadConfig } = require('../src/config/load');
const { createProjectStore } = require('../src/store/project');
const { RuntimeError } = require('../src/runtime/errors');
const { readCurrentRelease } = require('../src/publication/release-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-runner-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- 假 handler 与假 session

const value = (v) => ({ outputs: [{ kind: 'value', sha256: String(v).padEnd(8, '0') }] });
const node = (id, kind, dependsOn = [], replay = 'safe') => ({ id, kind, dependsOn, inputHash: `sha256:${id}`, retry: { maxAttempts: 3, backoffMs: [1000, 3000], replay } });

function fakeSession() {
  const s = { closes: 0, close: async () => { s.closes += 1; } };
  return s;
}

function setup(root, tasks, budget = {}) {
  const runStore = createRunStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
  const { run } = runStore.create({ command: 'generate', plan: { tasks }, budget });
  return { runStore, runId: run.id };
}

function fakeRun({ runStore, runId, handlers, ...rest }) {
  const sleeps = [];
  const sessions = [];
  const promise = runRun({
    runStore, runId, handlers, sleep: async (ms) => { sleeps.push(ms); },
    sessionFactory: () => { const s = fakeSession(); sessions.push(s); return s; }, ...rest,
  });
  return promise.then((summary) => ({ summary, sleeps, sessions }));
}

// ---------------------------------------------------------------- 真实项目

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `manual ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };

function realProject(baseUrl) {
  const root = fx.captureFixture();
  fx.writeFile(root, 'app/task-profile/page.tsx');
  cli(root, ['init', '--base-url', baseUrl, '--audience', 'public']);
  cli(root, ['inspect']);
  cli(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [
    { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' },
    { id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' },
  ] })]);
  const file = path.join(root, '.manual', 'pages', 'task-profile.yaml');
  const page = yaml.load(fs.readFileSync(file, 'utf8'));
  page.states = {
    default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
    editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
  };
  fs.writeFileSync(file, yaml.dump(page));
  cli(root, ['discover-tasks', 'task-profile', '--input', writeJson(path.join(root, 'tasks.json'), { tasks: [{
    id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'task-profile', preconditions: ['已登录'], risk: 'read',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'task-profile', stateBefore: 'default', stateAfter: 'editor',
        action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
      { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
    branches: [], relatedTasks: [],
  }] })]);
  cli(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })]);
  return root;
}

async function generate(root, target, { copy = { mode: 'default' }, flags = {} } = {}) {
  const { config } = loadConfig(root);
  const stateDirAbs = path.join(root, config.artifacts.stateDir);
  const base = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).load();
  const mode = resolveMode(flags);
  const cacheStore = createCacheStore({ stateDirAbs });
  const snapshot = collectPlanningInputs({ projectRoot: root, config, base, targets: [target], mode, cacheStore });
  const planned = plan(snapshot, { command: 'generate', copy });
  assert.deepStrictEqual(planned.errors, []);
  const runStore = createRunStore({ projectRoot: root, stateDirAbs });
  const { run } = runStore.create({ command: 'generate', target, plan: planned.plan, modelRevision: snapshot.modelRevision });
  const summary = await runRun({ runStore, runId: run.id, handlers: HANDLERS, context: { projectRoot: root, config, stateDirAbs, mode, cacheStore } });
  return { summary, plan: planned.plan, runStore, runId: run.id };
}

const captureCount = (root) => fs.readdirSync(path.join(root, '.manual', 'evidence', 'captures')).length;

(async () => {
  process.stdout.write('\nruntime runner\n');

  await test('按依赖顺序执行；每个任务先存 running 再执行，产物校验后才 succeeded', async (root) => {
    const { runStore, runId } = setup(root, [node('a', 'capture'), node('b', 'draft', ['a']), node('c', 'publish', ['b'])]);
    const order = [];
    const observed = [];
    const handler = (name) => (ctx, task) => {
      order.push(name);
      observed.push(runStore.read(runId).tasks.find((t) => t.id === task.id).status);
      return value(name);
    };
    const { summary } = await fakeRun({ runStore, runId, handlers: { capture: handler('a'), draft: handler('b'), publish: handler('c') } });
    assert.deepStrictEqual(order, ['a', 'b', 'c']);
    assert.deepStrictEqual(observed, ['running', 'running', 'running']);
    assert.strictEqual(summary.status, 'succeeded');
    assert.deepStrictEqual(summary.succeeded, ['a', 'b', 'c']);
  });

  await test('handler 的执行期提示随任务持久化并进入 Run 摘要（不再丢失）', async (root) => {
    const { runStore, runId } = setup(root, [node('capture', 'capture'), node('draft', 'draft', ['capture'])]);
    const { summary } = await fakeRun({ runStore, runId, handlers: {
      capture: async () => ({ ...value('c'), warnings: ['缓存在执行前失效（annotation-incomplete），重新采集。'] }),
      draft: async () => value('d'),
    } });
    assert.strictEqual(summary.status, 'succeeded');
    assert.deepStrictEqual(summary.warnings, ['capture：缓存在执行前失效（annotation-incomplete），重新采集。']);
    const state = runStore.read(runId);
    assert.deepStrictEqual(state.tasks.find((t) => t.id === 'capture').warnings, ['缓存在执行前失效（annotation-incomplete），重新采集。']);
    assert.deepStrictEqual(state.tasks.find((t) => t.id === 'draft').warnings, []);
  });

  await test('不可重试失败阻止依赖任务，互不依赖的目标照常推进；无效产物不记成功', async (root) => {
    const { runStore, runId } = setup(root, [node('a', 'capture'), node('b', 'draft', ['a']), node('x', 'analyze'), node('y', 'validate')]);
    const { summary } = await fakeRun({ runStore, runId, handlers: {
      capture: () => { throw Object.assign(new Error('404'), { reason: 'http-not-found' }); },
      draft: () => value('b'),
      analyze: () => value('x'),
      validate: () => ({ outputs: [{ kind: 'file', ref: 'missing.md', sha256: 'x' }] }),
    } });
    assert.deepStrictEqual(summary.failed.map((f) => [f.id, f.code]), [['a', 'http-not-found'], ['y', 'invalid-output']]);
    assert.deepStrictEqual(summary.pending, ['b']);
    assert.deepStrictEqual(summary.succeeded, ['x']);
    assert.strictEqual(summary.status, 'failed');
  });

  await test('瞬时故障有界重试并按退避表等待；不可安全重放的任务不重试', async (root) => {
    const { runStore, runId } = setup(root, [node('a', 'capture'), node('w', 'publish', [], 'requires-input')]);
    let calls = 0;
    const { summary, sleeps } = await fakeRun({ runStore, runId, handlers: {
      capture: () => { calls += 1; if (calls < 3) throw Object.assign(new Error('t'), { reason: 'timeout' }); return value('a'); },
      publish: () => { throw Object.assign(new Error('t'), { reason: 'timeout' }); },
    } });
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(sleeps, [1000, 3000]);
    const a = runStore.read(runId).tasks.find((t) => t.id === 'a');
    assert.deepStrictEqual(a.attempts.map((x) => x.status), ['failed', 'failed', 'succeeded']);
    assert.deepStrictEqual(summary.failed.map((f) => f.id), ['w']);
    assert.strictEqual(runStore.read(runId).tasks.find((t) => t.id === 'w').attempts.length, 1);
  });

  await test('模型步骤失败只重试模型任务，不重新采集；耗尽后 resume 也不会重跑采集', async (root) => {
    const { runStore, runId } = setup(root, [node('capture', 'capture'), node('rewrite', 'rewrite', ['capture'])]);
    let captures = 0;
    let rewrites = 0;
    const handlers = {
      capture: () => { captures += 1; return value('c'); },
      rewrite: () => { rewrites += 1; throw new RuntimeError('invalid-model-response', '格式错误'); },
    };
    const first = await fakeRun({ runStore, runId, handlers });
    assert.deepStrictEqual([captures, rewrites], [1, 3]);
    assert.strictEqual(first.summary.failed[0].code, 'invalid-model-response');
    await fakeRun({ runStore, runId, handlers });
    assert.deepStrictEqual([captures, rewrites], [1, 3]);
  });

  await test('等待输入：后续保持 pending，本次结束时关闭浏览器并释放租约；resume 重新检查且不消耗重试次数', async (root) => {
    const { runStore, runId } = setup(root, [node('capture', 'capture'), node('rewrite', 'rewrite', ['capture'], 'requires-input'), node('validate', 'validate', ['rewrite'])]);
    let answered = false;
    let captures = 0;
    const handlers = {
      capture: (ctx) => { captures += 1; ctx.session(); return value('c'); },
      rewrite: () => (answered ? value('r') : { waiting: { code: 'model-input-required', message: '需要文案' } }),
      validate: () => value('v'),
    };
    for (let i = 0; i < 4; i++) {
      const { summary, sessions } = await fakeRun({ runStore, runId, handlers });
      assert.strictEqual(summary.status, 'waiting_input');
      assert.deepStrictEqual(summary.waiting.map((w) => [w.id, w.code]), [['rewrite', 'model-input-required']]);
      assert.deepStrictEqual(summary.pending, ['validate']);
      if (i === 0) assert.strictEqual(sessions[0].closes, 1, '等待前关闭浏览器会话');
      assert.strictEqual(runStore.read(runId).lease.live, false, '租约已释放');
    }
    answered = true;
    const { summary } = await fakeRun({ runStore, runId, handlers });
    assert.strictEqual(summary.status, 'succeeded');
    assert.strictEqual(captures, 1);
  });

  await test('预算：动作次数用尽后停止；单任务超时记 budget-exceeded 并关闭浏览器会话', async (root) => {
    const tasks = [node('a', 'capture'), node('b', 'capture')];
    const { runStore, runId } = setup(root, tasks, { maxActions: 2 });
    const { summary } = await fakeRun({ runStore, runId, handlers: { capture: () => ({ ...value('a'), actions: 2 }) } });
    assert.deepStrictEqual(summary.failed.map((f) => [f.id, f.code]), [['b', 'budget-exceeded']]);
    assert.deepStrictEqual(runStore.read(runId).run.consumed.actions, 2);

    const other = setup(path.join(root, 'x'), [node('slow', 'capture')], { scenarioActiveMs: 50 });
    const { summary: slow, sessions } = await fakeRun({ ...other, handlers: { capture: (ctx) => { ctx.session(); return new Promise(() => {}); } } });
    assert.deepStrictEqual(slow.failed.map((f) => [f.id, f.code]), [['slow', 'budget-exceeded']]);
    assert.ok(sessions[0].closes >= 1);
  });

  await test('取消：当前任务记 interrupted 并停止调度；再次执行时可安全重放的任务继续完成', async (root) => {
    const { runStore, runId } = setup(root, [node('a', 'capture'), node('b', 'draft', ['a'])]);
    const controller = new AbortController();
    const first = await fakeRun({ runStore, runId, signal: controller.signal, handlers: {
      capture: () => new Promise((resolve) => setTimeout(() => { controller.abort(); resolve(value('a')); }, 10)),
      draft: () => value('b'),
    } });
    assert.deepStrictEqual(first.summary.interrupted, ['a']);
    assert.deepStrictEqual(first.summary.pending, ['b']);
    const second = await fakeRun({ runStore, runId, handlers: { capture: () => value('a'), draft: () => value('b') } });
    assert.strictEqual(second.summary.status, 'succeeded');
    const a = runStore.read(runId).tasks.find((t) => t.id === 'a');
    assert.deepStrictEqual(a.attempts.map((x) => x.status), ['interrupted', 'succeeded']);
  });

  await test('开始前输入校验不通过：不改动 Run，释放租约', async (root) => {
    const { runStore, runId } = setup(root, [node('a', 'capture')]);
    await assert.rejects(runRun({ runStore, runId, handlers: { capture: () => value('a') }, verifyInputs: () => { throw new RuntimeError('run-input-changed', '输入变了'); } }), (e) => e.code === 'run-input-changed');
    const state = runStore.read(runId);
    assert.strictEqual(state.tasks[0].status, 'pending');
    assert.strictEqual(state.lease.live, false);
  });

  // ---------------------------------------------------------------- 真实 handler：浏览器、缓存、发布

  const server = await startServer();
  const root = realProject(server.baseUrl);
  try {
    await test('真实 handler：任务首次 generate 完成采集 → 草稿 → 校验 → 发布；再次 generate 命中缓存不新截图', async () => {
      const first = await generate(root, 'task:edit-profile');
      assert.strictEqual(first.summary.status, 'succeeded', JSON.stringify(first.summary));
      assert.ok(fs.existsSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md')));
      assert.ok(readCurrentRelease(path.join(root, '.manual'), 'task-edit-profile'));
      const records = captureCount(root);
      const firstCapture = first.runStore.read(first.runId).tasks.find((t) => t.id === 'capture');

      const second = await generate(root, 'task:edit-profile');
      assert.strictEqual(second.plan.tasks.find((t) => t.id === 'capture').reason, 'cache-hit');
      assert.strictEqual(second.summary.status, 'succeeded', JSON.stringify(second.summary));
      assert.strictEqual(captureCount(root), records, '命中缓存不产生新的 Capture');
      const secondCapture = second.runStore.read(second.runId).tasks.find((t) => t.id === 'capture');
      assert.deepStrictEqual(secondCapture.outputRefs, firstCapture.outputRefs);
      const events = second.runStore.events(second.runId).events;
      assert.ok(events.some((e) => e.type === 'task-transition' && e.taskId === 'capture' && /^reused:/.test(e.message || '')));
    });

    await test('真实 handler：页面 generate 走同一 Runtime；等待模型文案时结束，提交文案文件后新 Run 完成', async () => {
      const waiting = await generate(root, 'page:chat', { copy: { mode: 'model' } });
      assert.strictEqual(waiting.summary.status, 'waiting_input');
      assert.deepStrictEqual(waiting.summary.waiting.map((w) => w.id), ['rewrite']);
      assert.ok(!fs.existsSync(path.join(root, 'docs', 'manual', 'chat.md')));
      const copyFile = writeJson(path.join(root, 'chat-copy.json'), { intro: '在这里和 AI 助手对话。' });
      const sha = require('../src/util/hash').sha256Hex(fs.readFileSync(copyFile));
      const done = await generate(root, 'page:chat', { copy: { mode: 'file', path: copyFile, sha256: sha } });
      assert.strictEqual(done.summary.status, 'succeeded', JSON.stringify(done.summary));
      assert.strictEqual(done.plan.tasks.find((t) => t.id === 'capture').reason, 'cache-hit');
      assert.match(fs.readFileSync(path.join(root, 'docs', 'manual', 'chat.md'), 'utf8'), /在这里和 AI 助手对话。/);
    });

    await test('真实 handler：隐私规则变化时只从已有原图重新派生发布图，不重新打开浏览器', async () => {
      const configFile = path.join(root, '.manual', 'config.yaml');
      const config = yaml.load(fs.readFileSync(configFile, 'utf8'));
      config.privacy.maskStyle = 'soft-solid';
      fs.writeFileSync(configFile, yaml.dump(config));
      const before = captureCount(root);
      const result = await generate(root, 'task:edit-profile');
      assert.deepStrictEqual(result.plan.tasks.map((t) => t.id), ['capture', 'derive-image', 'draft', 'validate', 'publish']);
      assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
      const derived = result.runStore.read(result.runId).tasks.find((t) => t.id === 'derive-image').outputRefs.filter((r) => r.kind === 'capture');
      const record = JSON.parse(fs.readFileSync(path.join(root, '.manual', 'evidence', 'captures', `${derived[0].ref}.json`), 'utf8'));
      assert.strictEqual(record.provenance.mode, 'rederived');
      assert.ok(record.provenance.derivedFrom);
      assert.strictEqual(captureCount(root), before + derived.length, '只新增重新派生的记录');
      const again = await generate(root, 'task:edit-profile');
      assert.ok(!again.plan.tasks.some((t) => t.kind === 'derive-image'), '重新派生后缓存记录了新的图像输入');
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
