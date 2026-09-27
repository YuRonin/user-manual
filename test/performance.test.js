'use strict';

/*
 * P3-07：性能验收——断言调用次数，耗时只报告（中位数 / p90），不设硬阈值。
 *
 *   cold             两个页面首次 generate：1 次 Browser 启动、每个 Scenario 1 个 Context / 1 次导航
 *   warm unchanged   再次 generate：不启动 Browser、不新增 Capture（重复 3 次取耗时分位数）
 *   template-only    只改文档语言：不启动 Browser
 *   shared change    改共享组件后 generate：只重新导航受影响的页面
 *
 * 设置 MANUAL_PERF_REPORT_DIR 时把报告写到该目录的 performance.json（CI 作为 artifact 上传）。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { startRun } = require('../src/runtime/app');
const { createBrowserSession } = require('../src/browser/session');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

(async () => {
  process.stdout.write('\nperformance\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const cacheDir = path.join(root, '.auth-cache');
  const previousCache = process.env.MANUAL_AUTH_CACHE_DIR;
  process.env.MANUAL_AUTH_CACHE_DIR = cacheDir;
  const state = path.join(root, '.manual');
  const captures = () => fs.readdirSync(path.join(state, 'evidence', 'captures')).length;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8', env: { ...process.env } });
    assert.strictEqual(r.status, 0, `${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  };
  const report = { environment: { node: process.version, platform: process.platform, arch: process.arch, playwright: require('playwright/package.json').version }, scenarios: {} };

  /** 在进程内执行一次 generate，返回会话调用计数与耗时。 */
  async function generate(targets) {
    let session = null;
    const started = process.hrtime.bigint();
    const result = await startRun({
      projectRoot: root, command: 'generate', targets, copy: { mode: 'default' },
      sessionFactory: () => { session = createBrowserSession(); return session; },
    });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.strictEqual(result.summary.status, 'succeeded', JSON.stringify(result.summary));
    const stats = session ? session.stats() : { launches: 0, contexts: 0, navigations: 0, screenshots: 0 };
    return { ms: Math.round(ms), launches: stats.launches, contexts: stats.contexts, navigations: stats.navigations, screenshots: stats.screenshots };
  }

  try {
    await step('准备：两个页面，chat 使用共享组件', async () => {
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return null }\n');
      fx.writeFile(root, 'app/chat/page.tsx', "import Shared from '../../components/Shared'\nexport default function Page() { return <Shared /> }\n");
      cli(['init', '--base-url', server.baseUrl, '--audience', 'public']);
      cli(['inspect']);
      const file = path.join(root, 'describe.json');
      fs.writeFileSync(file, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '对话。' }, { id: 'home', title: '首页', purpose: '入口。' }] }));
      cli(['describe', '--input', file]);
    });

    await step('cold：1 次 Browser 启动，每个页面 1 个 Context、1 次导航', async () => {
      const cold = await generate(['page:chat', 'page:home']);
      report.scenarios.cold = cold;
      assert.strictEqual(cold.launches, 1);
      assert.strictEqual(cold.contexts, 2);
      assert.strictEqual(cold.navigations, 2);
      assert.ok(cold.screenshots >= 2);
    });

    await step('warm unchanged：不启动 Browser、不新增 Capture（3 次取分位数）', async () => {
      const before = captures();
      const runs = [];
      for (let i = 0; i < 3; i++) runs.push(await generate(['page:chat', 'page:home']));
      assert.ok(runs.every((r) => r.launches === 0 && r.navigations === 0), JSON.stringify(runs));
      assert.strictEqual(captures(), before);
      report.scenarios.warm = { launches: 0, navigations: 0, medianMs: quantile(runs.map((r) => r.ms), 0.5), p90Ms: quantile(runs.map((r) => r.ms), 0.9), samples: runs.length };
    });

    await step('template-only：只改文档语言，不启动 Browser', async () => {
      const configFile = path.join(state, 'config.yaml');
      const config = yaml.load(fs.readFileSync(configFile, 'utf8'));
      config.docs.language = 'en-US';
      fs.writeFileSync(configFile, yaml.dump(config));
      const template = await generate(['page:chat', 'page:home']);
      report.scenarios.templateOnly = template;
      assert.strictEqual(template.launches, 0);
      assert.strictEqual(template.navigations, 0);
    });

    await step('shared change：只重新导航受影响的页面', async () => {
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return <nav /> }\n');
      cli(['inspect']);
      const file = path.join(root, 'describe.json');
      fs.writeFileSync(file, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '对话。' }] }));
      cli(['describe', '--input', file]);
      const shared = await generate(['page:chat', 'page:home']);
      report.scenarios.sharedChange = shared;
      assert.strictEqual(shared.launches, 1);
      assert.strictEqual(shared.navigations, 1, '只有 chat 重新采集');
    });

    process.stdout.write(`    ${JSON.stringify(report.scenarios)}\n`);
    if (process.env.MANUAL_PERF_REPORT_DIR) {
      fs.mkdirSync(process.env.MANUAL_PERF_REPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.MANUAL_PERF_REPORT_DIR, 'performance.json'), JSON.stringify(report, null, 2) + '\n');
    }
  } catch (_) {
    // 已记录
  } finally {
    if (previousCache === undefined) delete process.env.MANUAL_AUTH_CACHE_DIR; else process.env.MANUAL_AUTH_CACHE_DIR = previousCache;
    await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
