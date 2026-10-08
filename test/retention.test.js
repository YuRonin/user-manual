'use strict';

/*
 * P3-08：保留策略与 gc（真实浏览器生成证据后，用"未来时间"模拟过期）。
 *   - dry-run 只读、列出对象 / 原因 / 大小；--apply 必须与审阅的计划一致
 *   - 发布记录、被引用的发布图与 Capture 记录不会被回收；活动 Run 不受影响
 *   - 原图可按天数回收，之后生成会重新采集（不伪造派生源），产物验证仍通过
 *   - 指向外部的链接只删链接；允许根之外的路径拒绝
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { loadConfig } = require('../src/config/load');
const { planRetention, applyRetention, safeTarget } = require('../src/store/retention');
const releases = require('../src/publication/release-store');
const { sha256Hex } = require('../src/util/hash');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const DAY = 24 * 60 * 60 * 1000;

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

function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else out[f] = `${sha256Hex(fs.readFileSync(f))}@${fs.statSync(f).mtimeMs}`;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

(async () => {
  process.stdout.write('\nretention\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const outside = fx.makeTempDir('manual-outside-');
  const env = { MANUAL_AUTH_CACHE_DIR: path.join(root, '.auth-cache') };
  const state = path.join(root, '.manual');
  const config = () => loadConfig(root).config;
  const future = Date.now() + 31 * DAY;
  let released;
  let waitingRun;
  try {
    await step('准备：发布 chat；再采集两次（旧采集不再被引用）；一个等待模型的 Run；残留 staging 与诊断图', async () => {
      await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
      await expectExit(root, ['inspect'], 0, env);
      const file = path.join(root, 'describe.json');
      fs.writeFileSync(file, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '对话。' }] }));
      await expectExit(root, ['describe', '--input', file], 0, env);
      await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      released = releases.readCurrentRelease(state, 'page-chat');
      await expectExit(root, ['capture', 'chat'], 0, env);
      await expectExit(root, ['capture', 'chat'], 0, env);
      // 等待模型分析的 Run：活动 Run 不能被回收
      const waiting = await expectExit(root, ['generate', 'page:login'], 3, env);
      waitingRun = waiting.runId;
      fs.mkdirSync(path.join(state, 'evidence', 'staging', 'orphan'), { recursive: true });
      fs.writeFileSync(path.join(state, 'evidence', 'staging', 'orphan', 'raw.png'), 'x');
      const diagnostics = path.join(root, config().artifacts.diagnosticsDir);
      fs.mkdirSync(diagnostics, { recursive: true });
      fs.writeFileSync(path.join(diagnostics, 'failed-step.png'), 'diag');
      fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
      try { fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(diagnostics, 'link.png')); } catch (_) { /* 平台不支持符号链接时跳过该项 */ }
    });

    await step('现在：没有过期对象；CLI dry-run 不写任何文件', async () => {
      assert.deepStrictEqual(planRetention({ projectRoot: root, config: config() }).items, []);
      const before = tree(state);
      const out = await expectExit(root, ['gc'], 0, env);
      assert.strictEqual(out.dryRun, true);
      assert.deepStrictEqual(tree(state), before);
    });

    await step('历史盘点逐项说明当前发布、当前快照与发布图，且只读；多次提交后只剩一份快照', async () => {
      const before = tree(state);
      const out = await expectExit(root, ['gc', '--inventory'], 0, env);
      assert.strictEqual(out.dryRun, true);
      assert.ok(out.items.some(item => item.kind === 'release' && item.reason === 'current-release'));
      assert.ok(out.items.some(item => item.kind === 'snapshot' && item.reason === 'current-model'));
      assert.ok(out.items.some(item => item.kind === 'published-image' && item.reason === 'referenced-image'));
      assert.strictEqual(out.currentSnapshotPresent, true);
      assert.strictEqual(out.items.filter(item => item.kind === 'snapshot').length, 1, 'inspect / describe / generate / capture 多次提交后只保留 current 快照');
      assert.deepStrictEqual(tree(state), before);
      const invalid = await expectExit(root, ['gc', '--inventory', '--apply'], 2, env);
      assert.strictEqual(invalid.code, 'invalid-arguments');
      assert.deepStrictEqual(tree(state), before);
    });

    await step('引用记录或当前模型损坏时 gc 拒绝规划与应用', async () => {
      const releaseFile = path.join(state, 'releases', 'page-chat', `${released.id}.json`);
      const pointer = JSON.parse(fs.readFileSync(path.join(state, 'current.json'), 'utf8'));
      const snapshotFile = path.join(state, 'snapshots', `${pointer.revision.replace(/^sha256:/, '')}.json`);
      for (const file of [releaseFile, snapshotFile]) {
        const original = fs.readFileSync(file);
        try {
          fs.writeFileSync(file, '{broken');
          const out = await expectExit(root, ['gc'], 1, env);
          assert.strictEqual(out.code, 'retention-reference-unavailable');
          const apply = await expectExit(root, ['gc', '--apply'], 1, env);
          assert.strictEqual(apply.code, 'retention-reference-unavailable');
          assert.ok(fs.existsSync(path.join(root, released.documentPath)));
        } finally { fs.writeFileSync(file, original); }
      }
    });

    await step('未提交的页面工作副本存在时 gc 不按旧快照清理', async () => {
      const pageFile = path.join(state, 'pages', 'chat.yaml');
      const original = fs.readFileSync(pageFile);
      try {
        fs.appendFileSync(pageFile, '\n# pending human edit\n');
        // 注释不改变模型；改动真实字段才能形成未提交的引用图分歧。
        const changed = fs.readFileSync(pageFile, 'utf8').replace('title: 工作台', 'title: 改动中的工作台');
        fs.writeFileSync(pageFile, changed);
        const out = await expectExit(root, ['gc'], 1, env);
        assert.strictEqual(out.code, 'retention-reference-unavailable');
        assert.match(out.errors[0], /working-model-uncommitted/);
      } finally { fs.writeFileSync(pageFile, original); }
    });

    let plan;
    await step('31 天后：列出 staging / 诊断 / 已结束 Run / 未引用 Capture / 原图；保留发布记录、发布图、活动 Run', () => {
      plan = planRetention({ projectRoot: root, config: config(), now: future });
      const kinds = plan.summary.byKind;
      assert.ok(kinds.staging === 1 && kinds.diagnostics >= 1 && kinds.run >= 1, JSON.stringify(kinds));
      assert.ok(kinds['capture-record'] >= 1, '中间那次采集不再被引用');
      assert.ok(kinds['capture-raw'] >= 2, '被引用的 Capture 也清原图');
      assert.ok(plan.items.every((i) => i.bytes >= 0 && i.reason && i.references === 0));
      const paths = plan.items.map((i) => i.path);
      assert.ok(!paths.some((p) => p.startsWith('.manual/releases/page-chat')), '发布记录永不回收');
      for (const artifact of released.artifacts) assert.ok(!paths.includes(artifact.path), '被发布引用的发布图保留');
      for (const id of released.captureIds) assert.ok(!paths.includes(`.manual/evidence/captures/${id}.json`), '被发布引用的 Capture 记录保留');
      assert.ok(!paths.some((p) => p.includes(waitingRun)), '等待中的 Run 保留');
      assert.ok(plan.roots.activeRuns.includes(waitingRun));
    });

    await step('--apply 计划不一致：拒绝并不删除任何文件', () => {
      const before = tree(state);
      assert.throws(() => applyRetention({ projectRoot: root, config: config(), expectedPlanHash: `sha256:${'0'.repeat(64)}`, now: future }), (e) => e.code === 'gc-plan-changed');
      assert.deepStrictEqual(tree(state), before);
    });

    await step('--apply：只删计划中的对象；外部文件不受影响；产物验证仍通过', async () => {
      const result = applyRetention({ projectRoot: root, config: config(), expectedPlanHash: plan.planHash, now: future });
      assert.strictEqual(result.removed.length, plan.items.length);
      assert.deepStrictEqual(result.skipped, []);
      for (const item of plan.items) assert.ok(!fs.existsSync(path.join(root, item.path)), item.path);
      assert.strictEqual(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', '链接目标在允许根之外，未被删除');
      assert.ok(fs.existsSync(path.join(state, 'runs', waitingRun, 'run.json')));
      await expectExit(root, ['verify', 'page:chat'], 0, env);
      // verify 刚写的报告在"31 天后"视角下已过期，这是预期的唯一新对象
      const again = planRetention({ projectRoot: root, config: config(), now: future }).items;
      assert.ok(again.length >= 1 && again.every((i) => i.kind === 'verification'), JSON.stringify(again));
    });

    await step('原图回收后：生成需要重新采集（不伪造派生源）', async () => {
      const out = await expectExit(root, ['generate', 'page:chat', '--copy-default', '--plan'], 0, env);
      assert.ok(/capture-required/.test(out.tasks.find((t) => t.kind === 'capture').reason), JSON.stringify(out.tasks));
    });

    await step('路径安全：允许根之外 / 越界的路径拒绝', () => {
      assert.strictEqual(safeTarget(root, config(), '../outside.txt').ok, false);
      assert.strictEqual(safeTarget(root, config(), 'app/chat/page.tsx').reason, 'outside-allowed-roots');
    });
  } catch (_) {
    // 已记录
  } finally {
    await server.close();
    fx.cleanup(root);
    fx.cleanup(outside);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
