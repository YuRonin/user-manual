'use strict';

/*
 * Demo Capture 端到端（真实 Chromium + 本地测试站，不改被采集项目）：
 *   页面采集：演示值替换（无马赛克）、Fixture 数据即演示数据、原始值残留、非模式化私人文本、
 *             重渲染改回、WebSocket、图片类敏感区域、浏览器信标、加载即写、正常 UI 蒙层、可复现、项目源码不变
 *   任务采集：误标为只读的删除动作被中止（服务端写计数为 0）；Fixture 完整模拟写操作后步骤正常完成
 * 门禁失败时不产出截图，也不留下原图 / 派生图。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const sharp = require('sharp');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { sha256Hex } = require('../src/util/hash');
const { createProvider } = require('../src/browser');
const { executeCapturePlan } = require('../src/tasks/executor');
const { DEFAULT_THEME } = require('../src/config/annotation');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

/** 项目内除 .manual / docs 之外的全部文件：Skill 不能改被采集项目的源码与配置。 */
function sourceSnapshot(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (rel === '.manual' || rel === 'docs') continue;
      if (entry.isDirectory()) walk(full); else out[rel] = sha256Hex(fs.readFileSync(full));
    }
  };
  walk(root);
  return out;
}

function pngFiles(project) {
  const out = [];
  for (const dir of ['.manual/artifacts', 'docs']) {
    const full = path.join(project, dir);
    if (fs.existsSync(full)) out.push(...fs.readdirSync(full, { recursive: true }).filter((f) => /\.png$/.test(f)));
  }
  return out;
}

async function pixels(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { info, at: (x, y) => { const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; } };
}

(async () => {
  process.stdout.write('\ndemo capture\n');
  const server = await startServer();
  const projects = [];
  /** 初始化一个采集项目（页面 chat），把 capture.demo 写进配置。 */
  async function project(demo = {}, extra = {}) {
    const root = fx.captureFixture();
    projects.push(root);
    let r = await runCli(['init', '--project-root', root, '--base-url', server.baseUrl, '--profile', 'custom', '--viewport', '1000x700', '--dpr', '1']);
    assert.strictEqual(r.status, 0, r.stderr);
    r = await runCli(['inspect', '--project-root', root]);
    assert.strictEqual(r.status, 0, r.stderr);
    const file = path.join(root, '.manual', 'config.yaml');
    const config = yaml.load(fs.readFileSync(file, 'utf8'));
    config.capture.demo = demo;
    Object.assign(config, extra);
    fs.writeFileSync(file, yaml.dump(config));
    return root;
  }
  const capture = (root, page) => runCli(['capture', 'chat', '--project-root', root, '--url', `${server.baseUrl}${page}`, '--json']);
  const HISTORY_DEMO = { text: { 'account-name': '演示教师', 'account-phone': '138****0000', 'session-title': ['七年级数学：一元一次方程复习', '八年级物理：浮力实验设计'] } };

  try {
    await test('历史会话：data-redact 区域替换为演示值，发布图无马赛克，门禁记录数据来源', async () => {
      const root = await project(HISTORY_DEMO);
      const before = sourceSnapshot(root);
      const r = await capture(root, '/demo-history');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      const out = r.json;
      assert.strictEqual(out.published.privacy.status, 'passed');
      assert.strictEqual(out.published.privacy.coverage, 'demo-gate');
      assert.deepStrictEqual(out.published.privacy.demo.sources, { public: true, api_mock: 0, dom_replace: 4 });
      assert.deepStrictEqual(out.redactions, [], '演示数据区域不再打码');
      assert.deepStrictEqual(out.published.privacy.maskStyles, []);
      for (const secret of ['王小明', '13912345678', '李华']) assert.ok(!r.stdout.includes(secret), `输出含真实数据 ${secret}`);
      assert.deepStrictEqual(sourceSnapshot(root), before, '被采集项目的源码 / 配置不能被改动');
      assert.deepStrictEqual(server.writes, []);
    });

    await test('可复现：同一页面重复采集两次，发布图字节一致（演示值确定）', async () => {
      const root = await project(HISTORY_DEMO);
      const a = (await capture(root, '/demo-history')).json;
      const b = (await capture(root, '/demo-history')).json;
      assert.ok(a?.published && b?.published);
      assert.strictEqual(a.published.sha256, b.published.sha256);
    });

    await test('缺演示值：needs_fixture，列出缺少的 data-redact 键，不留任何截图', async () => {
      const root = await project({ text: { 'account-name': '演示教师' } });
      const r = await capture(root, '/demo-history');
      assert.notStrictEqual(r.status, 0);
      assert.strictEqual(r.json.reason, 'demo-needs-fixture');
      assert.match(r.json.message, /demo-text-unconfigured（account-phone, session-title）/);
      assert.ok(!/王小明|13912345678/.test(r.stdout));
      assert.deepStrictEqual(pngFiles(root), []);
    });

    await test('Fixture 数据即演示数据：接口被 Mock 后会话标题无需再配置演示值', async () => {
      const root = await project({ text: { 'account-name': '演示教师', 'account-phone': '138****0000' } },
        { fixtures: { environments: { local: { origins: ['http://127.0.0.1:*'] } } } });
      const state = path.join(root, '.manual');
      fs.mkdirSync(path.join(state, 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(state, 'fixtures', 'history-demo.yaml'), yaml.dump({
        schemaVersion: 1, id: 'history-demo', version: 1, kind: 'mock', environments: ['local'], sideEffectClass: 'none',
        mock: { routes: [{ path: '/api/demo/conversations', method: 'GET', json: { items: [{ title: '示例会话：分数加减法' }, { title: '示例会话：古诗默写' }] } }] },
      }));
      const page = yaml.load(fs.readFileSync(path.join(state, 'pages', 'chat.yaml'), 'utf8'));
      fs.mkdirSync(path.join(state, 'scenarios'), { recursive: true });
      fs.writeFileSync(path.join(state, 'scenarios', 'page-chat.yaml'), yaml.dump({
        schemaVersion: 1, id: 'page-chat', userTaskId: null, environment: 'local', authProfile: 'anonymous',
        data: { mode: 'fixture', fixture: 'history-demo' },
        entry: { pageId: 'chat', routeBindingId: 'main', params: {} },
        expected: { httpStatuses: [200], redirects: [], state: 'normal' }, setup: [],
        checkpoints: [{ id: 'default', afterStepId: null, pageId: 'chat', assertions: [{ type: 'url', value: page.route }], capture: { mode: 'viewport', annotations: [] } }],
      }));
      const r = await capture(root, '/demo-history');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      const record = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'captures', `${r.json.record?.id || r.json.captureId || JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'latest.json'), 'utf8')).refs['scenario:page-chat']}.json`), 'utf8'));
      assert.strictEqual(record.privacy.demo.status, 'passed');
      assert.strictEqual(record.privacy.demo.sources.api_mock, 1);
      assert.strictEqual(record.privacy.demo.sources.dom_replace, 4);
      assert.strictEqual(record.provenance.mode, 'simulated');
    });

    await test('漏网字段：声明区域已替换，但原始值仍出现在问候语里 → blocked', async () => {
      const root = await project({ text: { 'account-name': '演示教师' } });
      const r = await capture(root, '/demo-leak');
      assert.strictEqual(r.json.reason, 'demo-blocked');
      assert.match(r.json.message, /original-value-leaked（1 处（text））/);
      assert.ok(!r.stdout.includes('王小明'));
      assert.deepStrictEqual(pngFiles(root), []);
    });

    await test('隐私非模式化：不像手机号的学生备注，未声明 → needs_fixture；声明后残留在输入框 → blocked', async () => {
      let root = await project({});
      let r = await capture(root, '/demo-note');
      assert.strictEqual(r.json.reason, 'demo-needs-fixture');
      assert.match(r.json.message, /student-note/);
      root = await project({ text: { 'student-note': '该生课堂表现积极，建议加强计算练习' } });
      r = await capture(root, '/demo-note');
      assert.strictEqual(r.json.reason, 'demo-blocked');
      assert.match(r.json.message, /original-value-leaked（1 处（form-value））/);
      assert.ok(!r.stdout.includes('祖母'));
    });

    await test('SPA 重渲染把演示值改回真实值：有限重试后 blocked，不出图', async () => {
      const root = await project({ text: { 'account-name': '演示教师' } });
      const r = await capture(root, '/demo-revert');
      assert.strictEqual(r.json.reason, 'demo-blocked');
      assert.match(r.json.message, /demo-replacement-reverted/);
      assert.deepStrictEqual(pngFiles(root), []);
    });

    await test('WebSocket：未登记 → 连接被关闭且 needs_fixture；登记为只读后通过', async () => {
      let root = await project({});
      let r = await capture(root, '/demo-ws');
      assert.strictEqual(r.json.reason, 'demo-needs-fixture');
      assert.match(r.json.message, /websocket-unverified（\/ws）/);
      root = await project({ network: { websockets: [{ path: '/ws' }] } });
      r = await capture(root, '/demo-ws');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    });

    await test('图片类敏感区域（头像）：未配置 → needs_fixture；配置 initials 后替换为占位头像', async () => {
      let root = await project({});
      let r = await capture(root, '/demo-avatar');
      assert.match(r.json.message, /demo-image-unconfigured（account-avatar）/);
      root = await project({ images: { 'account-avatar': 'initials' } });
      r = await capture(root, '/demo-avatar');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.strictEqual(r.json.published.privacy.demo.sources.dom_replace, 1);
    });

    await test('写入保护：打开即写的页面默认中止写请求（服务端 0 次写）→ blocked；登记放行后通过', async () => {
      server.writes.length = 0;
      let root = await project({});
      let r = await capture(root, '/demo-autosave');
      assert.strictEqual(r.json.reason, 'demo-blocked');
      assert.match(r.json.message, /write-blocked（POST \/api\/demo\/autosave）/);
      assert.deepStrictEqual(server.writes, [], '被中止的写请求不能到达服务端');
      root = await project({ network: { allow: [{ method: 'POST', path: '/api/demo/autosave' }] } });
      r = await capture(root, '/demo-autosave');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.deepStrictEqual(server.writes, ['POST /api/demo/autosave'], '只有登记放行的请求到达服务端');
      server.writes.length = 0;
    });

    await test('浏览器信标（sendBeacon）：直接回 204，不计入门禁，不到达服务端', async () => {
      const root = await project({});
      const r = await capture(root, '/demo-beacon');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.deepStrictEqual(server.writes, []);
    });

    await test('正常 UI 蒙层保留：抽屉背景遮罩原样呈现，抽屉内敏感字段换成演示值，没有马赛克', async () => {
      const root = await project({ text: { 'order-no': 'DEMO-2024-0001', 'account-name': '演示教师' } });
      const r = await capture(root, '/demo-drawer');
      assert.strictEqual(r.status, 0, r.stdout + r.stderr);
      assert.deepStrictEqual(r.json.redactions, []);
      const raw = await pixels(path.join(root, r.json.screenshot));
      const pub = await pixels(path.join(root, r.json.published.artifactPath));
      // 蒙层区域（页面左侧）在发布图里与原图逐像素相同：没有被当作隐私遮罩
      for (const [x, y] of [[100, 300], [400, 500], [600, 100]]) assert.deepStrictEqual(pub.at(x, y), raw.at(x, y));
      const shade = raw.at(400, 500);
      assert.ok(shade[0] < 200 && shade[2] < 200, `蒙层应是半透明深色: ${shade}`);
      assert.ok(!r.stdout.includes('WX20240501883921'));
    });

    // ------------------------------------------------------------ 任务：动作触发的写请求
    const taskOptions = (root, extra = {}) => ({
      baseUrl: server.baseUrl, stateDir: path.join(root, '.manual'), projectRoot: root, annotatedDir: 'docs/manual/images/annotated',
      theme: DEFAULT_THEME, redactionRules: { audience: 'public', rules: { redact: [], preserve: [] } }, assertionTimeoutMs: 3000,
      demo: { text: HISTORY_DEMO.text, images: {}, network: { allow: [], block: [], websockets: [] } }, ...extra,
    });
    const deletePlan = () => ({
      taskId: 'delete-history', entry: { page: 'chat', route: '/demo-history', assertions: [] },
      steps: [{
        id: 'delete', instruction: '点击删除会话', page: 'chat', stateBefore: 'default', beforeState: { assertions: [] },
        action: { type: 'click', target: { role: 'button', name: '删除会话' } }, risk: 'read', willExecute: true, execution: 'auto',
        expectedState: { id: 'deleted', assertions: [{ type: 'visible', target: { text: '已删除' } }] }, capture: { timing: 'after' },
      }],
    });
    const provider = () => createProvider({ id: 'playwright-headless', providerConfig: { type: 'playwright', headless: true }, profile: { kind: 'desktop', viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 } });

    await test('写入保护（任务）：误标为只读的删除动作被中止 → demo-write-blocked，服务端 0 次写，不伪造成功', async () => {
      const root = fx.makeTempDir('manual-demo-task-');
      projects.push(root);
      server.writes.length = 0;
      const p = provider();
      try {
        await assert.rejects(executeCapturePlan(deletePlan(), p, taskOptions(root)), (error) => error.code === 'demo-write-blocked' || error.cause?.code === 'demo-write-blocked' || /demo-write-blocked|未授权的写请求/.test(error.message));
      } finally { await p.close(); }
      assert.deepStrictEqual(server.writes, []);
      const published = path.join(root, 'docs');
      assert.ok(!fs.existsSync(published), '失败的步骤不能产出发布图');
      assert.deepStrictEqual(pngFiles(root), [], 'Demo 门禁失败的画面也不能作为诊断图保存');
    });

    await test('失败现场图：画面里有未配置演示值的真实数据时不保存；全部可证明时才保存', async () => {
      const routes = [{ path: '/api/demo/conversations/1', matcher: /^\/api\/demo\/conversations\/1$/, method: 'DELETE', query: null, status: 200, contentType: 'application/json', body: '{"ok":true}' }];
      const failingPlan = () => { const plan = deletePlan(); plan.steps[0].expectedState.assertions = [{ type: 'visible', target: { text: '永远不会出现的状态' } }]; return plan; };
      for (const [text, saved] of [[{ 'account-name': '演示教师' }, false], [HISTORY_DEMO.text, true]]) {
        const root = fx.makeTempDir('manual-demo-diag-');
        projects.push(root);
        const p = provider();
        try {
          await assert.rejects(executeCapturePlan(failingPlan(), p, taskOptions(root, { routes, assertionTimeoutMs: 500, demo: { text, images: {}, network: { allow: [], block: [], websockets: [] } } })));
        } finally { await p.close(); }
        const diagnostics = pngFiles(root).filter((f) => /failure\.png$/.test(f));
        assert.strictEqual(diagnostics.length, saved ? 1 : 0, JSON.stringify(diagnostics));
      }
    });

    await test('完整模拟（任务）：Fixture 拦截删除请求，步骤完成、截图通过门禁，服务端 0 次写', async () => {
      const root = fx.makeTempDir('manual-demo-task-');
      projects.push(root);
      server.writes.length = 0;
      const routes = [{ path: '/api/demo/conversations/1', matcher: /^\/api\/demo\/conversations\/1$/, method: 'DELETE', query: null, status: 200, contentType: 'application/json', body: '{"ok":true}' }];
      const p = provider();
      let result;
      try { result = await executeCapturePlan(deletePlan(), p, taskOptions(root, { routes, provenanceMode: 'simulated' })); }
      finally { await p.close(); }
      const shot = result.steps[0].screenshots[0];
      assert.strictEqual(shot.privacy.status, 'passed');
      assert.strictEqual(shot.privacy.demo.sources.api_mock, 1);
      assert.ok(shot.annotated, '通过门禁的截图有发布图');
      assert.deepStrictEqual(server.writes, []);
    });
  } finally {
    await server.close();
    for (const root of projects) fx.cleanup(root);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
