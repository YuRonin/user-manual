'use strict';

/*
 * P3-07：干净安装冒烟测试。
 *
 * 把工具打包（npm pack）解到只含"工具包 + 业务 fixture"的临时目录，HOME 指向空目录，
 * 依赖只来自工具自己的 node_modules（CI 中由 npm ci 安装；本地复用仓库的 node_modules），
 * 然后执行 doctor → init → inspect → describe → generate → update --plan。
 * 证明安装后的工具不依赖仓库外的目录（例如个人工具目录 ~/gstack 中的 Playwright）。
 */

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const fx = require('./fixtures');
const { startServer } = require('./server');

const REPO = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

/** Playwright 浏览器缓存的默认位置（HOME 被替换后仍要找到已安装的 Chromium）。 */
function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

(async () => {
  process.stdout.write('\ninstall smoke\n');
  const work = fx.makeTempDir('manual-install-');
  const home = path.join(work, 'home');
  const tool = path.join(work, 'tool');
  fs.mkdirSync(home);
  const server = await startServer();
  const project = fx.captureFixture();
  const env = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
    MANUAL_AUTH_CACHE_DIR: path.join(home, '.manual-auth'),
    // 不让子进程借用本仓库或用户目录中的模块
    NODE_PATH: '',
  };
  // 异步子进程：测试服务器在本进程里，同步等待会让它无法响应
  const manual = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(tool, 'bin', 'manual.js'), ...args, '--project-root', project, '--json'], { env, cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const ok = async (args) => {
    const r = await manual(args);
    assert.strictEqual(r.status, 0, `manual ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    return JSON.parse(r.stdout || '{}');
  };
  try {
    await step('npm pack：包内不含项目状态、依赖与测试产物', () => {
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json', '--pack-destination', work], { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' });
      assert.strictEqual(r.status, 0, r.stderr);
      const [info] = JSON.parse(r.stdout);
      const paths = info.files.map((f) => f.path);
      assert.ok(paths.includes('bin/manual.js') && paths.includes('package.json') && paths.includes('SKILL.md'));
      assert.deepStrictEqual(paths.filter((p) => /^(\.manual|node_modules|test-results|\.auth)/.test(p)), []);
      fs.mkdirSync(tool);
      const untar = spawnSync('tar', ['-xzf', path.join(work, info.filename), '-C', tool, '--strip-components=1'], { encoding: 'utf8' });
      assert.strictEqual(untar.status, 0, untar.stderr);
      // 依赖：CI 中由 npm ci 安装；这里链接到仓库的 node_modules（等价于一次干净安装的结果）
      fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tool, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    });

    await step('doctor：依赖来自工具自己的 node_modules，不引用个人工具目录', async () => {
      const r = await manual(['doctor']);
      const out = JSON.parse(r.stdout);
      const text = JSON.stringify(out);
      assert.doesNotMatch(text, /gstack/i);
      const failed = out.checks.filter((c) => c.status === 'fail' && !/^config|^auth/.test(c.id));
      assert.deepStrictEqual(failed, [], JSON.stringify(failed));
      const playwright = out.checks.find((c) => c.id === 'dependency:playwright');
      assert.strictEqual(playwright.status, 'ok', JSON.stringify(playwright));
    });

    await step('业务 fixture：init → inspect → describe → generate → update --plan', async () => {
      await ok(['init', '--base-url', server.baseUrl, '--audience', 'public']);
      await ok(['inspect']);
      const file = path.join(work, 'describe.json');
      fs.writeFileSync(file, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' }] }));
      await ok(['describe', '--input', file]);
      const generated = await ok(['generate', 'page:chat', '--copy-default']);
      assert.strictEqual(generated.status, 'succeeded');
      assert.ok(fs.existsSync(path.join(project, 'docs', 'manual', 'chat.md')));
      const plan = await ok(['update', '--plan']);
      assert.deepStrictEqual(plan.targets, []);
      assert.ok(!fs.existsSync(path.join(home, '.manual')), '不在 HOME 下写项目状态');
    });
  } catch (_) {
    // 已记录
  } finally {
    await server.close();
    fx.cleanup(project);
    fx.cleanup(work);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
