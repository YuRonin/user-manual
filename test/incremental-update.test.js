'use strict';

/*
 * P3-02：增量更新端到端（真实浏览器 + CLI 子进程）。
 *   - 改共享组件只更新关联页面；未关联文档 bytes / mtime 不变
 *   - 源码变化后页面分析需要复核（waiting_input），复核后再次 update 完成
 *   - 人工修改在 update 中保留；受影响目标失败时保留上一版并报告 stale，其它目标照常发布
 *   - update 写出的文档不会触发下一轮 update
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const releases = require('../src/publication/release-store');

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
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };
const snapshot = (file) => ({ bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs });

(async () => {
  process.stdout.write('\nincremental update\n');
  if (!fx.hasGit()) { process.stdout.write('  - 跳过：没有 git\n\n0 passed, 0 failed\n'); return; }
  const server = await startServer();
  const root = fx.captureFixture();
  const env = { MANUAL_AUTH_CACHE_DIR: path.join(root, '.auth-cache') };
  const state = path.join(root, '.manual');
  const doc = (id) => path.join(root, 'docs', 'manual', `${id}.md`);
  const describe = (ids) => expectExit(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), {
    pages: ids.map((id) => ({ id, title: { home: '首页', chat: '工作台', login: '登录' }[id], purpose: `${id} 页面。` })),
  })], 0, env);
  try {
    await step('准备：首页独占组件，chat / login 共用组件；三页已发布', async () => {
      fx.writeFile(root, 'components/Home.tsx', 'export default function Home() { return null }\n');
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return null }\n');
      fx.writeFile(root, 'app/page.tsx', "import Home from '../components/Home'\nexport default function Page() { return <Home /> }\n");
      fx.writeFile(root, 'app/chat/page.tsx', "import Shared from '../../components/Shared'\nexport default function Page() { return <Shared /> }\n");
      fx.writeFile(root, 'app/login/page.tsx', "import Shared from '../../components/Shared'\nexport default function Page() { return <Shared /> }\n");
      await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
      await expectExit(root, ['inspect'], 0, env);
      await describe(['home', 'chat', 'login']);
      fx.gitInit(root);
      for (const id of ['home', 'chat', 'login']) await expectExit(root, ['generate', `page:${id}`, '--copy-default'], 0, env);
      for (const id of ['home', 'chat', 'login']) assert.ok(releases.readCurrentRelease(state, `page-${id}`).sourceBaseline.gitCommit);
    });

    await step('无变化：update 零写入、不创建 Run', async () => {
      const runs = fs.readdirSync(path.join(state, 'runs')).length;
      const before = snapshot(doc('home'));
      const out = await expectExit(root, ['update'], 0, env);
      assert.strictEqual(out.status, 'no-change');
      assert.strictEqual(fs.readdirSync(path.join(state, 'runs')).length, runs);
      assert.deepStrictEqual(snapshot(doc('home')), before);
    });

    let home;
    let changedAt;
    await step('改共享组件：计划只含 chat / login；执行后需要复核页面分析（waiting_input）', async () => {
      home = snapshot(doc('home'));
      changedAt = Date.now();
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return <nav>新导航</nav> }\n');
      fx.gitCommit(root, 'shared v2');
      const plan = await expectExit(root, ['update', '--plan'], 0, env);
      assert.deepStrictEqual(plan.targets.map((t) => t.target), ['page:chat', 'page:login']);
      const out = await expectExit(root, ['update', '--copy-default'], 3, env);
      assert.ok(out.waiting.every((w) => w.code === 'model-input-required'), JSON.stringify(out.waiting));
      assert.deepStrictEqual(out.targets.map((t) => [t.target, t.result]), [['page:chat', 'stale'], ['page:login', 'stale']]);
      assert.deepStrictEqual(snapshot(doc('home')), home, '未关联文档不变');
    });

    await step('复核后再次 update：只重新生成 chat / login，首页 bytes / mtime 不变', async () => {
      await describe(['chat', 'login']);
      const chatBefore = releases.readCurrentRelease(state, 'page-chat').id;
      const out = await expectExit(root, ['update', '--copy-default'], 0, env);
      assert.deepStrictEqual(out.targets.map((t) => [t.target, t.result]), [['page:chat', 'updated'], ['page:login', 'updated']]);
      // 上一次 update 等待复核时已按新源码采集过：可以复用那次采集，但绝不复用源码变化之前的截图
      assert.ok(out.cache.every((c) => !c.hit || Date.parse(c.observedAt) >= changedAt), JSON.stringify(out.cache));
      assert.notStrictEqual(releases.readCurrentRelease(state, 'page-chat').id, chatBefore);
      assert.deepStrictEqual(snapshot(doc('home')), home);
    });

    await step('update 写出的文档不触发下一轮：再次 update 无变化', async () => {
      const out = await expectExit(root, ['update'], 0, env);
      assert.strictEqual(out.status, 'no-change');
    });

    await step('人工修改保留；一个目标失败时保留上一版并报告 stale，另一个照常发布', async () => {
      fs.appendFileSync(doc('chat'), '\n> 团队说明：工作台只对成员开放。\n');
      const loginBefore = snapshot(doc('login'));
      // login 的身份断言改成页面上不存在的标题：采集失败
      const loginFile = path.join(state, 'pages', 'login.yaml');
      const page = yaml.load(fs.readFileSync(loginFile, 'utf8'));
      page.states = { default: { assertions: [{ id: 'nope', type: 'visible', target: { role: 'heading', name: '不存在的标题' } }] } };
      fs.writeFileSync(loginFile, yaml.dump(page));
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return <nav>第三版</nav> }\n');
      fx.gitCommit(root, 'shared v3');
      // 先刷新指纹并复核受影响页面的分析，让本轮 update 不停在分析复核上
      await expectExit(root, ['inspect'], 0, env);
      await describe(['chat', 'login']);
      const r = await cli(root, ['update', '--copy-default'], env);
      assert.notStrictEqual(r.status, 0, r.stdout);
      const byTarget = Object.fromEntries(r.json.targets.map((t) => [t.target, t]));
      assert.strictEqual(byTarget['page:chat'].result, 'updated', r.stdout);
      assert.strictEqual(byTarget['page:login'].result, 'stale');
      assert.strictEqual(byTarget['page:login'].kept, 'previous-release');
      assert.match(fs.readFileSync(doc('chat'), 'utf8'), /团队说明：工作台只对成员开放。/, '人工说明被保留');
      assert.deepStrictEqual(snapshot(doc('login')), loginBefore, '失败目标的旧文档不变');
      assert.deepStrictEqual(snapshot(doc('home')), home);
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }
})().catch(() => {}).finally(() => {
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
});
