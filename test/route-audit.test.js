'use strict';

/*
 * 浏览器路由审计（docs/MULTI_FRAMEWORK_PLAN.md 阶段 4）：真实 Chromium 打开测试站点，
 * 收集站内链接与 Vue 3 运行时路由表，与页面模型对照，只报告差异，不改页面模型。
 */

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const fx = require('./fixtures');
const { auditRoutes, patternRegex } = require('../src/verify/route-audit');
const { createBrowserSession } = require('../src/browser/session');
const { loadConfig } = require('../src/config/load');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

/** 每个页面：一个已知链接、一个未声明链接、一个外站链接；首页挂一个假的 Vue 3 应用实例。 */
function page(withVue) {
  const vue = withVue ? `<script>
document.body.__vue_app__ = { config: { globalProperties: { $router: { getRoutes: () => [
  { path: '/chat', components: { default: {} } },
  { path: '/artifact/:id(\\\\d+)', components: { default: {} } },
  { path: '/dyn-added', components: { default: {} } },
  { path: '/:pathMatch(.*)*', components: { default: {} } },
  { path: '/old', redirect: '/chat', components: {} },
] } } } };
</script>` : '';
  return `<!doctype html><html><body>
<a href="/chat">聊天</a> <a href="/artifact/42">作品</a> <a href="/docs/a/b">文档</a>
<a href="/secret-report/7">未登记的报表</a> <a href="https://example.com/x">外站</a>
${vue}</body></html>`;
}

function startServer({ withVue }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(withVue));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withAudit({ withVue }, fn) {
  const server = await startServer({ withVue });
  const root = fx.nextAppFixture();
  const session = createBrowserSession();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const init = spawnSync(process.execPath, [CLI, 'init', '--project-root', root, '--base-url', base], { encoding: 'utf8' });
    assert.strictEqual(init.status, 0, init.stderr);
    const inspect = spawnSync(process.execPath, [CLI, 'inspect', '--project-root', root], { encoding: 'utf8' });
    assert.strictEqual(inspect.status, 0, inspect.stderr);
    const { config } = loadConfig(root);
    await fn({ root, config, session });
  } finally {
    await session.close().catch(() => {});
    server.close();
    fx.cleanup(root);
  }
}

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function main() {
  process.stdout.write('\nroute audit\n');

  await test('路由模式匹配：参数段、可选段、剩余段', () => {
    assert.ok(patternRegex('/artifact/:id').test('/artifact/42'));
    assert.ok(!patternRegex('/artifact/:id').test('/artifact'));
    assert.ok(patternRegex('/blog/:slug?').test('/blog') && patternRegex('/blog/:slug?').test('/blog/x'));
    assert.ok(patternRegex('/docs/:slug*').test('/docs/a/b/c'));
    assert.ok(!patternRegex('/chat').test('/chat/x'));
  });

  await test('站内链接：已登记的路由不报，未登记的报为疑似遗漏；外站链接忽略；不改页面模型', async () => {
    await withAudit({ withVue: false }, async ({ root, config, session }) => {
      const pagesDir = path.join(root, '.manual/pages');
      const before = fs.readdirSync(pagesDir).map((f) => fs.readFileSync(path.join(pagesDir, f), 'utf8')).join('\n');
      const report = await auditRoutes({ projectRoot: root, config, session, authProfile: 'anonymous', maxPages: 3 });
      assert.deepStrictEqual(report.errors, []);
      assert.strictEqual(report.sources.vueRouter, false);
      assert.deepStrictEqual(report.unmatched.map((u) => [u.source, u.path]), [['link', '/secret-report/7']]);
      assert.ok(report.notes.some((n) => /onClick/.test(n)), '没有运行时路由表时要说明观察范围');
      const after = fs.readdirSync(pagesDir).map((f) => fs.readFileSync(path.join(pagesDir, f), 'utf8')).join('\n');
      assert.strictEqual(after, before);
    });
  });

  await test('Vue 3 运行时路由表：addRoute 动态添加的路由被报出；兜底与重定向不报；参数正则按模式比较', async () => {
    await withAudit({ withVue: true }, async ({ root, config, session }) => {
      const report = await auditRoutes({ projectRoot: root, config, session, authProfile: 'anonymous', maxPages: 1 });
      assert.strictEqual(report.sources.vueRouter, true);
      assert.deepStrictEqual(report.unmatched.map((u) => [u.source, u.path]), [['vue-router', '/dyn-added'], ['link', '/secret-report/7']].sort((a, b) => a[1].localeCompare(b[1])));
    });
  });

  await test('CLI：manual verify --routes 输出差异并以退出码 4 表示有疑似遗漏', async () => {
    await withAudit({ withVue: false }, async ({ root }) => {
      // 测试服务器在本进程里：CLI 必须异步启动，否则 spawnSync 会阻塞服务器响应
      const r = await runAsync([CLI, 'verify', '--routes', '--auth-profile', 'anonymous', '--max-pages', '3', '--json', '--project-root', root]);
      assert.strictEqual(r.status, 4, r.stderr + r.stdout);
      const body = JSON.parse(r.stdout);
      assert.strictEqual(body.scope, 'routes');
      assert.deepStrictEqual(body.report.unmatched.map((u) => u.path), ['/secret-report/7']);
    });
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`测试运行器出错: ${error.stack || error}\n`);
  process.exitCode = 1;
});
