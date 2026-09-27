'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRunStore, ensureStateGitignore } = require('../src/runtime/store');
const { createCaptureStore } = require('../src/evidence/store');
const { sha256Hex } = require('../src/util/hash');
const { lockFileFor } = require('../src/store/lock');
const { TINY_PNG } = require('./server');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-run-store-'));
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const stateOf = (root) => path.join(root, '.manual');
const storeOf = (root, options = {}) => createRunStore({ projectRoot: root, stateDirAbs: stateOf(root), ...options });

function plan() {
  return {
    command: 'generate',
    target: 'page:dashboard',
    tasks: [
      { id: 'capture-dashboard', kind: 'capture', inputHash: 'sha256:a', dependsOn: [] },
      { id: 'draft-dashboard', kind: 'draft', inputHash: 'sha256:b', dependsOn: ['capture-dashboard'] },
    ],
  };
}

function writeOutput(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return { kind: 'file', ref: rel, sha256: sha256Hex(Buffer.from(content)) };
}

function childRead(root, runId) {
  const script = `
    const { createRunStore } = require(${JSON.stringify(path.resolve(__dirname, '../src/runtime/store'))});
    const store = createRunStore({ projectRoot: ${JSON.stringify(root)}, stateDirAbs: ${JSON.stringify(stateOf(root))} });
    process.stdout.write(JSON.stringify(store.read(${JSON.stringify(runId)})));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

process.stdout.write('\nrun store\n');

test('创建：plan 与任务先落盘，run.json 最后发布；新进程只读文件即可还原进度', (root) => {
  const store = storeOf(root);
  const created = store.create({ command: 'generate', target: 'page:dashboard', plan: plan(), modelRevision: 'sha256:m' });
  const runId = created.run.id;
  assert.strictEqual(created.run.status, 'pending');
  assert.deepStrictEqual(created.tasks.map((t) => [t.id, t.status, t.attempt]), [['capture-dashboard', 'pending', 0], ['draft-dashboard', 'pending', 0]]);

  const { lease } = store.open(runId);
  store.transition(runId, 'capture-dashboard', 'running', { lease });
  const ref = writeOutput(root, '.manual/runs/out.txt', 'done');
  store.transition(runId, 'capture-dashboard', 'succeeded', { lease, outputRefs: [ref] });
  lease.release();

  const fresh = childRead(root, runId);
  assert.strictEqual(fresh.run.status, 'pending');
  assert.deepStrictEqual(fresh.tasks.map((t) => t.status), ['succeeded', 'pending']);
  assert.deepStrictEqual(fresh.tasks[0].outputRefs, [ref]);

  // run.json 缺失（创建中途死亡）→ 视为未创建。
  fs.rmSync(path.join(store.runDirFor(runId), 'run.json'));
  assert.strictEqual(store.read(runId), null);
});

test('计划不可变：非法计划拒绝创建；plan.json 被改动后读取报 plan-tampered', (root) => {
  const store = storeOf(root);
  const bad = plan();
  bad.tasks.push({ id: 'capture-dashboard', kind: 'capture', inputHash: 'x' });
  assert.throws(() => store.create({ command: 'generate', plan: bad }), (e) => e.code === 'invalid-plan' && /重复/.test(e.message));
  const unknown = plan();
  unknown.tasks[1].dependsOn = ['nope'];
  assert.throws(() => store.create({ command: 'generate', plan: unknown }), (e) => e.code === 'invalid-plan' && /未知任务/.test(e.message));
  const kind = plan();
  kind.tasks[0].kind = 'deploy';
  assert.throws(() => store.create({ command: 'generate', plan: kind }), (e) => e.code === 'invalid-plan');
  assert.deepStrictEqual(store.list(), []);

  const { run } = store.create({ command: 'generate', plan: plan() });
  const planFile = path.join(store.runDirFor(run.id), 'plan.json');
  const edited = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  edited.tasks[0].inputHash = 'sha256:changed';
  fs.writeFileSync(planFile, JSON.stringify(edited));
  assert.throws(() => store.read(run.id), (e) => e.code === 'plan-tampered');
});

test('状态机：非法转换拒绝；succeeded 必须有通过校验的 outputRefs', (root) => {
  const store = storeOf(root);
  const { run } = store.create({ command: 'generate', plan: plan() });
  const { lease } = store.open(run.id);
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [] }), (e) => e.code === 'invalid-transition');
  store.transition(run.id, 'capture-dashboard', 'running', { lease });
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [] }), (e) => e.code === 'invalid-output');
  const ref = writeOutput(root, 'docs/out.md', 'v1');
  fs.writeFileSync(path.join(root, 'docs/out.md'), 'tampered');
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [ref] }), (e) => e.code === 'invalid-output' && e.problems[0].code === 'hash-mismatch');
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [{ kind: 'capture', ref: '00000000-0000-4000-8000-000000000000' }] }),
    (e) => e.problems[0].code === 'artifact-missing');
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [{ kind: 'file', ref: '../escape', sha256: 'x' }] }), (e) => e.code === 'invalid-output');
  const good = writeOutput(root, 'docs/out.md', 'v2');
  store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [good] });
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'running', { lease }), (e) => e.code === 'invalid-transition');
  assert.strictEqual(store.read(run.id).tasks[0].status, 'succeeded');
});

test('Capture 输出引用：记录完整且图片 hash 一致才接受', (root) => {
  const captures = createCaptureStore({ projectRoot: root, stateDirAbs: stateOf(root) });
  const handle = captures.begin();
  const png = TINY_PNG;
  fs.mkdirSync(handle.stagingDir, { recursive: true });
  fs.writeFileSync(handle.file('raw.png'), png);
  const record = captures.commit(handle, {
    record: { schemaVersion: 1, id: handle.captureId, observedAt: new Date().toISOString(), validations: [], privacy: { status: 'clean' } },
    artifacts: [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw', prefix: 'raw' }],
  });
  const store = storeOf(root);
  const { run } = store.create({ command: 'capture', plan: plan() });
  const { lease } = store.open(run.id);
  store.transition(run.id, 'capture-dashboard', 'running', { lease });
  fs.writeFileSync(path.join(root, record.artifacts[0].path), Buffer.from('replaced'));
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [{ kind: 'capture', ref: record.id }] }), (e) => e.code === 'invalid-output');
  fs.writeFileSync(path.join(root, record.artifacts[0].path), png);
  store.transition(run.id, 'capture-dashboard', 'succeeded', { lease, outputRefs: [{ kind: 'capture', ref: record.id }] });
});

test('重试：失败保留错误摘要，新 attempt 独立记录；超过上限返回 retry-exhausted', (root) => {
  const store = storeOf(root);
  const p = plan();
  p.tasks[0].retry = { maxAttempts: 2 };
  const { run } = store.create({ command: 'generate', plan: p });
  const { lease } = store.open(run.id);
  store.transition(run.id, 'capture-dashboard', 'running', { lease });
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'failed', { lease }), (e) => e.code === 'invalid-transition');
  store.transition(run.id, 'capture-dashboard', 'failed', { lease, error: { code: 'timeout', phase: 'capture', message: '超时', policy: 'retry', retryable: true, requiresInput: false } });
  assert.strictEqual(store.read(run.id).run.status, 'failed');
  store.transition(run.id, 'capture-dashboard', 'pending', { lease });
  const second = store.transition(run.id, 'capture-dashboard', 'running', { lease });
  assert.strictEqual(second.attempt, 2);
  assert.strictEqual(second.attempts[0].error.code, 'timeout');
  assert.strictEqual(second.attempts[1].status, 'running');
  store.transition(run.id, 'capture-dashboard', 'failed', { lease, error: { code: 'http-error', message: '502' } });
  store.transition(run.id, 'capture-dashboard', 'pending', { lease });
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'running', { lease }), (e) => e.code === 'retry-exhausted');
  const task = store.read(run.id).tasks[0];
  assert.deepStrictEqual(task.attempts.map((a) => [a.n, a.status, a.error.code]), [[1, 'failed', 'timeout'], [2, 'failed', 'http-error']]);
});

test('租约：执行进程死亡后新进程 open() 把 running 转为 interrupted；租约有效时拒绝第二个执行者', (root) => {
  const store = storeOf(root);
  const { run } = store.create({ command: 'generate', plan: plan() });
  const script = `
    const { createRunStore } = require(${JSON.stringify(path.resolve(__dirname, '../src/runtime/store'))});
    const store = createRunStore({ projectRoot: ${JSON.stringify(root)}, stateDirAbs: ${JSON.stringify(stateOf(root))} });
    const { lease } = store.open(${JSON.stringify(run.id)});
    store.transition(${JSON.stringify(run.id)}, 'capture-dashboard', 'running', { lease });
    process.exit(137);
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 137, r.stderr);

  // 只读视图不改文件，但把租约失效的 running 显示为 interrupted。
  const view = store.read(run.id);
  assert.strictEqual(view.tasks[0].status, 'running');
  assert.strictEqual(view.tasks[0].effectiveStatus, 'interrupted');
  assert.strictEqual(view.lease.live, false);

  const opened = store.open(run.id);
  assert.deepStrictEqual(opened.interrupted, ['capture-dashboard']);
  assert.strictEqual(opened.state.tasks[0].status, 'interrupted');
  assert.strictEqual(opened.state.tasks[0].attempts[0].status, 'interrupted');
  assert.strictEqual(store.read(run.id).lease.live, true);
  assert.throws(() => store.open(run.id), (e) => e.code === 'run-busy');

  // 恢复：可安全重放 → pending → 新 attempt。
  store.transition(run.id, 'capture-dashboard', 'pending', { lease: opened.lease });
  assert.strictEqual(store.transition(run.id, 'capture-dashboard', 'running', { lease: opened.lease }).attempt, 2);
  opened.lease.release();
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'failed', { lease: opened.lease, error: { code: 'x' } }), (e) => e.code === 'lease-lost');
  assert.throws(() => store.transition(run.id, 'capture-dashboard', 'failed', { error: { code: 'x' } }), (e) => e.code === 'lease-required');
  assert.ok(!fs.existsSync(lockFileFor(stateOf(root), `run-${run.id}`)));
});

test('事件日志：损坏末行被跳过；删除日志不影响恢复；白名单与去敏', (root) => {
  const store = storeOf(root);
  const { run } = store.create({ command: 'generate', plan: plan() });
  const { lease } = store.open(run.id);
  store.transition(run.id, 'capture-dashboard', 'running', { lease, reason: 'open https://app.test/p?token=tok-secret-zq user@example.com 13800138000 password=hunter2' });
  const eventsFile = path.join(store.runDirFor(run.id), 'events.jsonl');
  const text = fs.readFileSync(eventsFile, 'utf8');
  assert.ok(!/tok-secret-zq|hunter2|user@example|13800138000/.test(text), text);
  assert.match(text, /https:\/\/app\.test\/p/);

  fs.appendFileSync(eventsFile, '{"type":"task-trans');
  const read = store.events(run.id);
  assert.strictEqual(read.truncated, true);
  assert.strictEqual(read.skipped, 1);
  assert.ok(read.events.length >= 2);
  assert.ok(read.events.every((e) => !('cookies' in e)));

  fs.rmSync(eventsFile);
  assert.strictEqual(store.read(run.id).tasks[0].status, 'running');
  lease.release();
});

test('.manual/.gitignore：创建 Run 补齐 runs/ drafts/，保留用户行，重复执行幂等', (root) => {
  const gitignore = path.join(stateOf(root), '.gitignore');
  fs.mkdirSync(stateOf(root), { recursive: true });
  fs.writeFileSync(gitignore, 'session/\nmy-own/\n');
  storeOf(root).create({ command: 'generate', plan: plan() });
  const text = fs.readFileSync(gitignore, 'utf8');
  assert.match(text, /^my-own\/$/m);
  assert.match(text, /^runs\/$/m);
  assert.match(text, /^drafts\/$/m);
  assert.strictEqual((text.match(/^session\/$/gm) || []).length, 1);
  assert.strictEqual(ensureStateGitignore(stateOf(root)), false);
  assert.strictEqual(fs.readFileSync(gitignore, 'utf8'), text);
});

test('预算消耗累计并持久化', (root) => {
  const store = storeOf(root);
  const { run } = store.create({ command: 'generate', plan: plan(), budget: { maxActions: 10 } });
  assert.strictEqual(store.read(run.id).run.budget.maxActions, 10);
  assert.strictEqual(store.read(run.id).run.budget.navigationMs, 30000);
  const { lease } = store.open(run.id);
  store.consume(run.id, lease, { activeMs: 500, actions: 2 });
  store.consume(run.id, lease, { activeMs: 250, actions: 1 });
  assert.deepStrictEqual(store.read(run.id).run.consumed, { activeMs: 750, actions: 3 });
  lease.release();
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
