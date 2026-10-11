'use strict';

/*
 * B5 Scenario 状态（真实 Chromium + 本地测试站）：
 *   B5-01 setup 打开 Modal / Dropdown / Tab / Hover 后在浮层内部完成标注；同一定义重放得到同一结论
 *   B5-03 Fixture 延迟响应稳定复现 Loading 状态
 *   B5-04 角色断言不满足 → auth-identity-mismatch（不改用其他身份）
 *   B5-05 截图之后状态不再成立 → scenario-state-lost，不出发布图
 *   B5-06a 声明的合法跳转（/password-reset → /login?view=reset）不当作登录墙；未声明仍报需要登录
 *   B5-06b 一次性前置数据被消费 → precondition-consumed
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { loadConfig } = require('../src/config/load');
const { capturePage } = require('../src/evidence/capture-page');
const { withRevision } = require('../src/scenarios/model');
const { validateScenario } = require('../src/model/schema');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function cli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

/** 一个显式 Scenario 变体（页面 chat），检查点断言与标注按用例给出。 */
function scenarioOf({ assertions = [], annotations = [], ...extra }) {
  const def = withRevision({
    schemaVersion: 1, id: 'chat-variant', userTaskId: null, environment: 'local', authProfile: 'anonymous',
    data: { mode: 'live' }, entry: { pageId: 'chat', routeBindingId: 'main', params: {} },
    expected: { httpStatuses: [200], redirects: [], state: 'normal' }, setup: [],
    checkpoints: [{ id: 'default', afterStepId: null, pageId: 'chat', assertions, capture: { mode: 'viewport', annotations } }],
    ...extra,
  });
  const checked = validateScenario(def);
  assert.ok(checked.ok, JSON.stringify(checked.errors));
  return def;
}

(async () => {
  process.stdout.write('\nscenario states\n');
  const server = await startServer();
  const root = fx.captureFixture();
  try {
    let r = await cli(['init', '--project-root', root, '--base-url', server.baseUrl, '--profile', 'custom', '--viewport', '1000x700', '--dpr', '1', '--audience', 'internal']);
    assert.strictEqual(r.status, 0, r.stderr);
    r = await cli(['inspect', '--project-root', root]);
    assert.strictEqual(r.status, 0, r.stderr);
    // 变体检查点的标注只能引用页面上声明过的功能
    const pageFile = path.join(root, '.manual', 'pages', 'chat.yaml');
    const yaml = require('js-yaml');
    const page = yaml.load(fs.readFileSync(pageFile, 'utf8'));
    page.features = ['Tab', 'Dropdown', 'Modal', 'Hover'].map((name) => ({ id: `inside-${name.toLowerCase()}`, label: `${name} 内的控件`, priority: 'optional', description: `${name} 状态里的控件。` }));
    fs.writeFileSync(pageFile, yaml.dump(page));
    const { config } = loadConfig(root);
    const capture = (scenario, pathname) => capturePage({ projectRoot: root, config, pageId: 'chat', options: { scenario, url: `${server.baseUrl}${pathname}` } });
    const drawn = (result) => (result.record.annotationProof?.rendered || []).filter((item) => item.drawn && item.visible).map((item) => item.label);

    const STATES = [
      ['Tab', { type: 'click', target: { role: 'tab', name: '账单' }, expect: [{ type: 'visible', target: { role: 'tabpanel', name: '账单' } }] }, { role: 'button', name: '下载账单' }],
      ['Dropdown', { type: 'click', target: { role: 'button', name: '更多' }, expect: [{ type: 'visible', target: { role: 'menu', name: '更多操作' } }] }, { role: 'menuitem', name: '导出名单' }],
      ['Modal', { type: 'click', target: { role: 'button', name: '新建班级' }, expect: [{ type: 'visible', target: { role: 'dialog', name: '新建班级' } }] }, { label: '班级名称' }],
      ['Hover', { type: 'hover', target: { text: '帮助' }, expect: [{ type: 'visible', target: { text: '查看帮助文档' } }] }, { text: '查看帮助文档' }],
    ];
    for (const [name, action, inside] of STATES) {
      await test(`B5-01 ${name}：setup 进入状态，在浮层 / 面板内部完成标注；重放得到同一结论`, async () => {
        const def = scenarioOf({ setup: [action], assertions: action.expect, annotations: [{ feature_id: `inside-${name.toLowerCase()}`, label: '1', target: inside }] });
        const first = await capture(def, '/scenario-ui');
        assert.deepStrictEqual(drawn(first), ['1'], JSON.stringify(first.record.annotationProof?.rendered));
        assert.ok(first.navigation.validations.some((v) => v.scope === 'scenario-state'), '记录了 setup 后的状态确认');
        const second = await capture(def, '/scenario-ui');
        assert.deepStrictEqual(drawn(second), drawn(first));
      });
    }

    await test('B5-01 setup 目标不存在：scenario-setup-failed（确定性失败，不出图）', async () => {
      const def = scenarioOf({ setup: [{ type: 'click', target: { role: 'button', name: '不存在的按钮' } }] });
      await assert.rejects(capture(def, '/scenario-ui'), (e) => (e.reason || e.code) === 'scenario-setup-failed');
    });

    await test('B5-05 截图之后浮层已自动关闭：scenario-state-lost，不出发布图', async () => {
      const def = scenarioOf({ setup: [{ type: 'click', target: { role: 'button', name: '通知' } }], assertions: [{ type: 'visible', target: { text: '有 3 条新通知' } }] });
      await assert.rejects(capture(def, '/scenario-ui'), (e) => (e.reason || e.code) === 'scenario-state-lost', '状态没有保持到截图之后');
    });

    await test('B5-06a 声明的合法跳转：/password-reset → /login?view=reset 正常采集；未声明仍报需要登录', async () => {
      const declared = scenarioOf({ expected: { httpStatuses: [200], redirects: [{ path: '/login', query: { view: 'reset' } }], state: 'normal' } });
      const ok = await capture(declared, '/password-reset');
      assert.match(ok.navigation.finalUrl, /\/login\?view=reset$/);
      const wrongQuery = scenarioOf({ expected: { httpStatuses: [200], redirects: [{ path: '/login', query: { view: 'signup' } }], state: 'normal' } });
      await assert.rejects(capture(wrongQuery, '/password-reset'), (e) => /login-required|auth-/.test(e.reason || e.code), '查询参数不符：仍是登录墙');
    });

    await test('B5-06b 一次性前置数据被消费：precondition-consumed，不去截状态不对的页面', async () => {
      const def = scenarioOf({ preconditions: [{ id: 'pending-draft', assertions: [{ type: 'visible', target: { text: '待补充：七年级期中分析' } }] }] });
      await capture(def, '/drafts');
      server.set({ draftPending: false });
      await assert.rejects(capture(def, '/drafts'), (e) => (e.reason || e.code) === 'precondition-consumed');
      server.reset();
    });

    await test('B5-04 角色断言不满足：auth-identity-mismatch，不改用其他身份', async () => {
      const def = scenarioOf({ expected: { httpStatuses: [200], redirects: [], state: 'normal', roleAssertions: [{ type: 'visible', target: { role: 'link', name: '系统设置' } }] } });
      await assert.rejects(capture(def, '/member-home'), (e) => (e.reason || e.code) === 'auth-identity-mismatch');
      const member = scenarioOf({ expected: { httpStatuses: [200], redirects: [], state: 'normal', roleAssertions: [{ type: 'visible', target: { role: 'link', name: '我的课程' } }] } });
      await capture(member, '/member-home');
    });

    await test('B5-03 Loading：Fixture 延迟响应，expected.state: loading 稳定截到加载中', async () => {
      const state = path.join(root, '.manual');
      fs.mkdirSync(path.join(state, 'fixtures'), { recursive: true });
      fs.writeFileSync(path.join(state, 'fixtures', 'slow-report.yaml'), [
        'schemaVersion: 1', 'id: slow-report', 'version: 1', 'kind: mock', 'environments: [local]', 'sideEffectClass: none',
        'mock:', '  routes:', '    - { path: /api/demo/report, method: GET, json: { title: 十月报表 }, delayMs: 20000 }',
      ].join('\n'));
      const fixtureConfig = { ...config, fixtures: { environments: { local: { origins: ['http://127.0.0.1:*'] } } } };
      const def = scenarioOf({ data: { mode: 'fixture', fixture: 'slow-report' }, expected: { httpStatuses: [200], redirects: [], state: 'loading' },
        assertions: [{ type: 'visible', target: { text: '加载中…' } }] });
      const result = await capturePage({ projectRoot: root, config: fixtureConfig, pageId: 'chat', options: { scenario: def, url: `${server.baseUrl}/loading-report`, timeout: 4000 } });
      assert.ok(result.navigation.validations.some((v) => v.check === 'page-state' && v.actual === 'loading'), JSON.stringify(result.navigation.validations));
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
