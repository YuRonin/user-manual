'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { resolveRouteTemplate, derivePageScenario, deriveTaskScenario, authProfileFor } = require('../src/scenarios/model');
const { resolveScenario } = require('../src/scenarios/store');
const { validateScenario } = require('../src/model/schema');
const { reconcile } = require('../src/inspect/model');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const page = {
  id: 'user-center', route: '/user-center',
  states: {
    default: { assertions: [{ type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
    editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
  },
};
const task = {
  id: 'edit-profile', entryPage: 'user-center', risk: 'local',
  steps: [{ id: 'open-editor', page: 'user-center', stateBefore: 'default', stateAfter: 'editor', action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after' } }],
};
const config = { auth: { enabled: true, activeProfile: 'member' } };

process.stdout.write('\nscenario model\n');

test('路由模板：普通参数整体编码，catch-all 逐段编码，可选 catch-all 可缺省', () => {
  assert.deepStrictEqual(resolveRouteTemplate('/a/:id', { id: 'x/y z' }), { ok: true, route: '/a/x%2Fy%20z' });
  assert.deepStrictEqual(resolveRouteTemplate('/docs/:slug*', { slug: ['a', 'b c'] }), { ok: true, route: '/docs/a/b%20c' });
  assert.deepStrictEqual(resolveRouteTemplate('/docs/:slug*', { slug: 'a/b' }), { ok: true, route: '/docs/a/b' }, 'CLI 字符串按 / 拆段');
  assert.deepStrictEqual(resolveRouteTemplate('/shop/:path?', {}), { ok: true, route: '/shop' });
  assert.deepStrictEqual(resolveRouteTemplate('/:lang', {}), { ok: false, missing: ['lang'], invalid: [] });
  assert.deepStrictEqual(resolveRouteTemplate('/docs/:slug*', { slug: [1] }), { ok: false, missing: [], invalid: ['slug'] });
  assert.deepStrictEqual(resolveRouteTemplate('/', {}), { ok: true, route: '/' });
});

test('匿名必须显式：认证关闭时 authProfile = anonymous', () => {
  assert.strictEqual(authProfileFor({ auth: { enabled: false, activeProfile: 'member' } }), 'anonymous');
  assert.strictEqual(authProfileFor(config), 'member');
});

test('默认 Scenario 通过 schema，带 revision；只随定义变化', () => {
  const pageScenario = derivePageScenario(page, config);
  assert.deepStrictEqual(validateScenario(pageScenario).errors, []);
  assert.strictEqual(pageScenario.id, 'page-user-center');
  const taskScenario = deriveTaskScenario(task, [page], config);
  assert.deepStrictEqual(validateScenario(taskScenario, { stepIds: ['open-editor'] }).errors, []);
  assert.strictEqual(taskScenario.checkpoints[0].assertions[0].id, 'editor-visible');
  assert.strictEqual(taskScenario.authProfile, 'member');
  assert.strictEqual(deriveTaskScenario(task, [page], config).revision, taskScenario.revision);
  assert.notStrictEqual(deriveTaskScenario(task, [page], { auth: { enabled: false } }).revision, taskScenario.revision);
});

test('显式 Scenario 文件覆盖默认值；无效文件被拒绝', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-scenario-'));
  try {
    const derived = deriveTaskScenario(task, [page], config);
    assert.strictEqual(resolveScenario(dir, derived).explicit, false);
    fs.mkdirSync(path.join(dir, 'scenarios'));
    fs.writeFileSync(path.join(dir, 'scenarios', 'edit-profile-default.yaml'), [
      'id: edit-profile-default', 'userTaskId: edit-profile', 'environment: staging', 'authProfile: admin',
      'entry:', '  pageId: user-center', 'checkpoints: []', '',
    ].join('\n'));
    const explicit = resolveScenario(dir, derived);
    assert.strictEqual(explicit.ok, true, explicit.errors?.join('\n'));
    assert.strictEqual(explicit.explicit, true);
    assert.strictEqual(explicit.scenario.authProfile, 'admin');
    fs.writeFileSync(path.join(dir, 'scenarios', 'edit-profile-default.yaml'), 'id: edit-profile-default\nenvironment: x\n');
    const invalid = resolveScenario(dir, derived);
    assert.strictEqual(invalid.ok, false);
    assert.match(invalid.errors.join('\n'), /authProfile/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------ 页面身份与生命周期
const scanned = (route, entry) => ({ route, entry, dynamic: false, params: [], router: 'app' });
const existing = (id, route, entry, extra = {}) => ({ id, route, entry, source: [entry], title: id, status: { sourceAnalysis: 'completed' }, ...extra });

test('路由改名：入口文件唯一对应时保留页面 id', () => {
  const result = reconcile([scanned('/me', 'app/profile/page.tsx')], [existing('profile', '/profile', 'app/profile/page.tsx')], []);
  assert.deepStrictEqual(result.pages.map((p) => [p.id, p.route, p.lifecycle]), [['profile', '/me', 'active']]);
  assert.deepStrictEqual(result.renamed, [{ id: 'profile', from: '/profile', to: '/me', by: 'entry' }]);
  assert.deepStrictEqual(result.added, []);
  assert.strictEqual(result.pages[0].title, 'profile', '分析结果保留');
});

test('路由改名：显式 routeBindings 声明时合并；只是"看起来像"时不合并，只给候选', () => {
  const bound = reconcile(
    [scanned('/account/settings', 'app/account/settings/page.tsx')],
    [existing('settings', '/settings', 'app/settings/page.tsx', { routeBindings: [{ id: 'next', template: '/account/settings' }] })],
    [],
  );
  assert.deepStrictEqual(bound.pages.map((p) => p.id), ['settings']);
  assert.strictEqual(bound.renamed[0].by, 'route-binding');

  const similar = reconcile([scanned('/account/settings', 'app/account/settings/page.tsx')], [existing('settings', '/settings', 'app/settings/page.tsx')], []);
  assert.deepStrictEqual(similar.pages.map((p) => p.id), ['account-settings'], '不相关证据不足时不合并');
  assert.deepStrictEqual(similar.renameCandidates, [{ pageId: 'settings', fromRoute: '/settings', toRoute: '/account/settings', reason: 'similar-route' }]);
  assert.deepStrictEqual(similar.removed.map((p) => [p.id, p.lifecycle]), [['settings', 'missing']]);
});

test('多个页面共享同一入口时不自动合并', () => {
  const result = reconcile(
    [scanned('/x', 'app/shared.tsx'), scanned('/y', 'app/shared.tsx')],
    [existing('a', '/a', 'app/shared.tsx'), existing('b', '/b', 'app/shared.tsx')],
    [],
  );
  assert.deepStrictEqual(result.renamed, []);
  assert.deepStrictEqual(result.removed.map((p) => p.lifecycle), ['missing', 'missing']);
});

test('缺失 → missing，排除 → excluded，retired 保持；定义保留且只在首次变化时报告', () => {
  const pages = [
    existing('gone', '/gone', 'app/gone/page.tsx'),
    existing('admin', '/admin/users', 'app/admin/users/page.tsx'),
    existing('old', '/old', 'app/old/page.tsx', { lifecycle: 'retired' }),
    existing('home', '/', 'app/page.tsx'),
  ];
  const result = reconcile([scanned('/', 'app/page.tsx'), scanned('/admin/users', 'app/admin/users/page.tsx'), scanned('/old', 'app/old/page.tsx')], pages, ['/admin/**']);
  const lifecycle = Object.fromEntries([...result.pages, ...result.removed].map((p) => [p.id, p.lifecycle]));
  assert.deepStrictEqual(lifecycle, { home: 'active', old: 'retired', gone: 'missing', admin: 'excluded' });
  assert.strictEqual(result.removed.find((p) => p.id === 'gone').title, 'gone', '定义保留');
  assert.deepStrictEqual(result.newlyMissing.map((p) => p.id).sort(), ['admin', 'gone']);
  const again = reconcile([scanned('/', 'app/page.tsx')], [...result.pages, ...result.removed], ['/admin/**']);
  assert.deepStrictEqual(again.newlyMissing, [], '已经 missing / retired 的页面不重复报告');
});

test('missing 页面重新出现时恢复 active', () => {
  const result = reconcile([scanned('/gone', 'app/gone/page.tsx')], [existing('gone', '/gone', 'app/gone/page.tsx', { lifecycle: 'missing' })], []);
  assert.strictEqual(result.pages[0].lifecycle, 'active');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
