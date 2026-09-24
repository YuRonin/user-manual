'use strict';

const assert = require('assert');
const { revision, pickDefinitionFields, definitionRevision } = require('../src/model/revision');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function page(overrides = {}) {
  return {
    id: 'user-center', route: '/user-center', dynamic: false, params: [], title: '用户中心', purpose: '查看资料',
    detectedActions: ['编辑资料'], entry: 'app/user-center/page.tsx', source: ['app/user-center/page.tsx'],
    includeInManual: true, confidence: 'inferred',
    dependencies: { files: ['app/user-center/page.tsx'], unresolved: [] },
    states: { default: { description: '初始', assertions: [{ type: 'url', value: '/user-center' }] } },
    browser: { verified: true, lastCapture: '2026-09-24T00:00:00.000Z', screenshot: 'a.png', url: 'http://x/user-center' },
    status: { router: 'app', sourceAnalysis: 'completed' },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: 'edit-profile', title: '修改资料', goal: '修改', entryPage: 'user-center', risk: 'local', status: 'approved',
    preconditions: ['已登录'],
    steps: [
      { id: 'a', instruction: '打开', page: 'user-center', action: { type: 'click', target: { role: 'button', name: '编辑' } }, execution: 'auto' },
      { id: 'b', instruction: '保存', page: 'user-center', action: { type: 'click', target: { role: 'button', name: '保存' } }, risk: 'write', execution: 'stop-before-action' },
    ],
    completion: { description: '完成' },
    ...overrides,
  };
}

console.log('revision');

test('对象键顺序不同但内容一致 → revision 相同', () => {
  assert.equal(revision({ a: 1, b: [2, 3] }), revision({ b: [2, 3], a: 1 }));
  assert.equal(revision({ x: { m: 1, n: 2 } }), revision({ x: { n: 2, m: 1 } }));
});

test('数组顺序参与 revision（步骤顺序是语义）', () => {
  assert.notEqual(revision({ steps: ['a', 'b'] }), revision({ steps: ['b', 'a'] }));
});

test('NaN / Infinity / undefined / 循环引用 / 非普通对象抛 invalid-json-value', () => {
  assert.throws(() => revision({ invalid: NaN }), /invalid-json-value/);
  assert.throws(() => revision({ invalid: Infinity }), /invalid-json-value/);
  assert.throws(() => revision({ nested: { value: undefined } }), /invalid-json-value/);
  assert.throws(() => revision([1, undefined]), /invalid-json-value/);
  const loop = {}; loop.self = loop;
  assert.throws(() => revision(loop), /invalid-json-value/);
  assert.throws(() => revision({ at: new Date() }), /invalid-json-value/);
  try { revision({ a: { b: NaN } }); } catch (e) { assert.equal(e.code, 'invalid-json-value'); assert.equal(e.path, '$.a.b'); }
});

test('revision 形如 sha256:<64hex>', () => {
  assert.match(revision({ a: 1 }), /^sha256:[0-9a-f]{64}$/);
});

test('页面观察字段（browser/时间戳/confidence/status/dependencies）不改变定义 revision', () => {
  const base = definitionRevision('page', page());
  const observed = page({
    browser: { verified: false, lastCapture: '2026-09-25T10:00:00.000Z', screenshot: 'b.png', url: null },
    confidence: 'verified', status: { router: 'app', sourceAnalysis: 'stale' },
    dependencies: { files: ['x.tsx'], unresolved: ['y'] },
  });
  assert.equal(definitionRevision('page', observed), base);
});

test('页面定义字段变化一定改变 revision', () => {
  const base = definitionRevision('page', page());
  assert.notEqual(definitionRevision('page', page({ title: '个人中心' })), base);
  assert.notEqual(definitionRevision('page', page({ states: { default: { assertions: [{ type: 'visible', target: { role: 'heading', name: '用户中心' } }] } } })), base);
  assert.notEqual(definitionRevision('page', page({ route: '/me' })), base);
});

test('任务：status/派生 execution/时间戳不影响，步骤顺序/风险/动作/断言引用变化一定影响', () => {
  const base = definitionRevision('userTask', task());
  assert.equal(definitionRevision('userTask', task({ status: 'captured', generatedAt: '2026-09-25', approval: { status: 'approved' } })), base);
  const noExecution = task();
  noExecution.steps = noExecution.steps.map(({ execution, ...rest }) => rest);
  assert.equal(definitionRevision('userTask', noExecution), base);

  const reordered = task(); reordered.steps = [reordered.steps[1], reordered.steps[0]];
  assert.notEqual(definitionRevision('userTask', reordered), base);
  const riskier = task(); riskier.steps[0] = { ...riskier.steps[0], risk: 'destructive' };
  assert.notEqual(definitionRevision('userTask', riskier), base);
  const retarget = task(); retarget.steps[0] = { ...retarget.steps[0], action: { type: 'click', target: { role: 'button', name: '删除' } } };
  assert.notEqual(definitionRevision('userTask', retarget), base);
  assert.notEqual(definitionRevision('userTask', task({ completion: { description: '完成', claims: [{ id: 'c', text: '完成', assertionRefs: ['x'] }] } })), base);
});

test('定义中值为 undefined 的键视为缺省', () => {
  assert.equal(definitionRevision('page', page({ purpose: undefined })), definitionRevision('page', (() => { const p = page(); delete p.purpose; return p; })()));
  assert.deepStrictEqual(Object.keys(pickDefinitionFields('page', { id: 'a', browser: {} })), ['id']);
});

test('未知实体类型抛错', () => {
  assert.throws(() => pickDefinitionFields('nope', {}), /未知实体类型/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
