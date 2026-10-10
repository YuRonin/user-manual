'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { loadConfig } = require('../src/config/load');
const { createProjectStore } = require('../src/store/project');
const { createCacheStore } = require('../src/cache/store');
const { resolveMode } = require('../src/cache/policy');
const { collectPlanningInputs, plan } = require('../src/runtime/planner');
const { createRunStore } = require('../src/runtime/store');
const { runRun } = require('../src/runtime/runner');
const { HANDLERS } = require('../src/runtime/handlers');
const { submitModelResponse } = require('../src/runtime/model-response');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `manual ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };

function project(baseUrl) {
  const root = fx.captureFixture();
  fx.writeFile(root, 'app/task-profile/page.tsx', 'export default function Profile() { return "个人中心" }\n');
  cli(root, ['init', '--base-url', baseUrl, '--audience', 'public']);
  fx.useDemoValues(root);
  cli(root, ['inspect']);
  cli(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [
    { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。', detectedActions: ['点击「新对话」创建会话'], features: [{ id: 'new-chat', label: '新对话', priority: 'optional' }] },
  ] })]);
  const file = path.join(root, '.manual', 'pages', 'task-profile.yaml');
  const page = yaml.load(fs.readFileSync(file, 'utf8'));
  page.states = { default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] } };
  // 页面上的按钮都要有明确决定，公开手册才能发布（B2）
  page.features = [{ id: 'edit-profile', label: '编辑资料', priority: 'optional' }, { id: 'benefits', label: '学校权益', priority: 'optional' }];
  fs.writeFileSync(file, yaml.dump(page));
  return root;
}

function context(root) {
  const { config } = loadConfig(root);
  const stateDirAbs = path.join(root, config.artifacts.stateDir);
  return { config, stateDirAbs };
}

async function start(root, target, copy = { mode: 'model' }) {
  const { config, stateDirAbs } = context(root);
  const base = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).load();
  const mode = resolveMode({});
  const cacheStore = createCacheStore({ stateDirAbs });
  const snapshot = collectPlanningInputs({ projectRoot: root, config, base, targets: [target], mode, cacheStore });
  const planned = plan(snapshot, { command: 'generate', copy });
  assert.deepStrictEqual(planned.errors, []);
  const runStore = createRunStore({ projectRoot: root, stateDirAbs });
  const { run } = runStore.create({ command: 'generate', target, plan: planned.plan });
  const execute = () => runRun({ runStore, runId: run.id, handlers: HANDLERS, context: { projectRoot: root, config, stateDirAbs, mode, cacheStore } });
  return { runId: run.id, runStore, execute, config };
}

function requests(runStore, runId) {
  const dir = path.join(runStore.runDirFor(runId), 'model');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.request.json')).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')));
}

function submitInChild(root, runId, requestId, response) {
  const script = `
    const { loadConfig } = require(${JSON.stringify(path.resolve(__dirname, '../src/config/load'))});
    const { submitModelResponse } = require(${JSON.stringify(path.resolve(__dirname, '../src/runtime/model-response'))});
    const root = ${JSON.stringify(root)};
    try {
      const out = submitModelResponse({ projectRoot: root, config: loadConfig(root).config, runId: ${JSON.stringify(runId)}, requestId: ${JSON.stringify(requestId)}, response: ${JSON.stringify(response)} });
      process.stdout.write(JSON.stringify(out));
    } catch (e) { process.stdout.write(JSON.stringify({ ok: false, code: e.code, message: e.message })); }
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

(async () => {
  process.stdout.write('\nmodel handoff\n');
  const server = await startServer();
  const root = project(server.baseUrl);
  try {
    let chat;
    let request;
    await test('文案请求：只含允许读取的文件与 hash、文案块默认值、输出 schema 与限制；resume 复用同一请求', async () => {
      chat = await start(root, 'page:chat');
      const summary = await chat.execute();
      assert.strictEqual(summary.status, 'waiting_input');
      assert.deepStrictEqual(summary.waiting.map((w) => [w.id, w.code]), [['rewrite', 'model-input-required']]);
      [request] = requests(chat.runStore, chat.runId);
      assert.strictEqual(request.kind, 'rewrite');
      assert.strictEqual(request.runId, chat.runId);
      assert.match(request.inputHash, /^sha256:/);
      assert.deepStrictEqual(request.output.allowedBlocks, Object.keys(request.facts.copyBlocks));
      assert.ok(request.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
      assert.ok(request.files.some((f) => f.path.endsWith('chat.facts.json')));
      assert.ok(!/cookie|storageState|password/i.test(JSON.stringify(request)));
      assert.ok(request.limits.maxBlockChars > 0);
      assert.match(summary.waiting[0].message, /resume .* --request/);
      await chat.execute();
      assert.strictEqual(requests(chat.runStore, chat.runId).length, 1, 'resume 不产生新请求');
    });

    const good = () => ({ requestId: request.requestId, inputHash: request.inputHash, output: { copy: { [request.output.allowedBlocks[0]]: '在这里和 AI 助手对话，所有会话都会保存在左侧列表。' } } });

    await test('拒绝：错 requestId / 旧 inputHash / 未授权文案块 / 改写受保护 UI 名称 / 跨 Run 请求；拒绝时任务仍在等待', async () => {
      const { config } = context(root);
      const submit = (response, requestId = request.requestId, runId = chat.runId) => () => submitModelResponse({ projectRoot: root, config, runId, requestId, response });
      assert.throws(submit({ ...good(), requestId: '00000000-0000-4000-8000-000000000000' }), (e) => e.code === 'invalid-model-response');
      assert.throws(submit({ ...good(), inputHash: 'sha256:old' }), (e) => e.code === 'invalid-model-response' && /inputHash/.test(e.message));
      assert.throws(submit({ ...good(), output: { copy: { 'step.fake': 'x' } } }), (e) => e.code === 'invalid-model-response' && e.unauthorized.includes('step.fake'));
      const block = request.output.allowedBlocks[0];
      assert.throws(submit({ ...good(), output: { copy: { [block]: '点击「删除账号」即可注销。' } } }), (e) => e.code === 'invalid-model-response' && /受保护/.test(e.message));
      const other = await start(root, 'page:chat');
      await other.execute();
      assert.throws(submit(good(), request.requestId, other.runId), (e) => e.code === 'invalid-model-response' && /跨 Run/.test(e.message));
      assert.strictEqual(chat.runStore.read(chat.runId).tasks.find((t) => t.id === 'rewrite').status, 'waiting_input');
    });

    await test('另一个进程提交正确响应后任务完成；重复提交幂等；已接受后不能用另一份覆盖；继续执行只用这份文案发布', async () => {
      const first = submitInChild(root, chat.runId, request.requestId, good());
      assert.deepStrictEqual([first.ok, first.idempotent], [true, false]);
      const again = submitInChild(root, chat.runId, request.requestId, good());
      assert.deepStrictEqual([again.ok, again.idempotent], [true, true]);
      const different = submitInChild(root, chat.runId, request.requestId, { ...good(), output: { copy: { [request.output.allowedBlocks[0]]: '另一段文案。' } } });
      assert.strictEqual(different.code, 'invalid-model-response');
      const summary = await chat.execute();
      assert.strictEqual(summary.status, 'succeeded', JSON.stringify(summary));
      assert.match(fs.readFileSync(path.join(root, 'docs', 'manual', 'chat.md'), 'utf8'), /所有会话都会保存在左侧列表/);
    });

    await test('等待期间事实变化：提交时 CAS 发现请求依据的文件已变，返回 run-input-changed 且不推进任务', async () => {
      const stale = await start(root, 'page:chat');
      await stale.execute();
      const [req] = requests(stale.runStore, stale.runId);
      const factsFile = path.join(root, req.files.find((f) => f.path.endsWith('.facts.json')).path);
      fs.appendFileSync(factsFile, '\n');
      const out = submitInChild(root, stale.runId, req.requestId, { requestId: req.requestId, inputHash: req.inputHash, output: { copy: { [req.output.allowedBlocks[0]]: '新文案。' } } });
      assert.strictEqual(out.code, 'run-input-changed');
      assert.strictEqual(stale.runStore.read(stale.runId).tasks.find((t) => t.id === 'rewrite').status, 'waiting_input');
    });

    await test('语义分析请求：附源码文件 hash；只能填写标题 / 用途 / 可见操作；结果标 origin=model，不算验证', async () => {
      const run = await start(root, 'page:task-profile', { mode: 'default' });
      const summary = await run.execute();
      assert.deepStrictEqual(summary.waiting.map((w) => w.id), ['analyze']);
      assert.ok(summary.succeeded.includes('capture'), '采集不被语义分析阻塞');
      const [req] = requests(run.runStore, run.runId);
      assert.strictEqual(req.kind, 'analyze');
      assert.ok(req.files.some((f) => f.path === 'app/task-profile/page.tsx'));
      const bad = submitInChild(root, run.runId, req.requestId, { requestId: req.requestId, inputHash: req.inputHash, output: { title: '个人中心', purpose: '管理资料。', lifecycle: 'retired' } });
      assert.strictEqual(bad.code, 'invalid-model-response');
      const ok = submitInChild(root, run.runId, req.requestId, { requestId: req.requestId, inputHash: req.inputHash, output: { title: '个人中心', purpose: '查看与修改个人资料。' } });
      assert.strictEqual(ok.ok, true);
      const page = yaml.load(fs.readFileSync(path.join(root, '.manual', 'pages', 'task-profile.yaml'), 'utf8'));
      assert.strictEqual(page.title, '个人中心');
      assert.strictEqual(page.lifecycle || 'active', 'active');
      assert.strictEqual(page.analysis.semantic.origin, 'model');
      assert.ok(page.analysis.semantic.evidenceRefs.some((r) => r.path === 'app/task-profile/page.tsx'));
      const done = await run.execute();
      assert.strictEqual(done.status, 'succeeded', JSON.stringify(done));
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
