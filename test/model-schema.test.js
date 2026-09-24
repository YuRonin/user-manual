'use strict';

const assert = require('assert');
const schema = require('../src/model/schema');
const ids = require('../src/model/ids');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const codes = (r) => r.errors.map((e) => `${e.path}:${e.code}`);
const hasError = (r, path, code) => r.errors.some((e) => e.path === path && e.code === code);

function page(overrides = {}) {
  return {
    id: 'user-center', route: '/user-center', entry: 'app/user-center/page.tsx', source: ['app/user-center/page.tsx'],
    states: {
      default: { assertions: [{ type: 'url', value: '/user-center' }] },
      'editor-open': { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
    },
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: 'edit-profile', title: '修改资料', goal: '修改', entryPage: 'user-center', risk: 'local',
    steps: [{
      id: 'open-editor', instruction: '点击「编辑资料」', page: 'user-center', stateBefore: 'default', stateAfter: 'editor-open',
      action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, replay: 'safe',
      capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] },
    }],
    completion: { description: '完成', claims: [{ id: 'editor-opened', text: '编辑面板已打开。', assertionRefs: ['editor-visible'], checkpoint: 'open-editor' }] },
    ...overrides,
  };
}

console.log('model schema');

test('ids：安全 slug、UUID、生成的断言引用', () => {
  assert.ok(ids.isSafeId('edit-profile'));
  for (const bad of ['Edit', 'a_b', '../x', 'a--b', '-a', '', 'a'.repeat(65), 'a/b']) assert.ok(!ids.isSafeId(bad), bad);
  assert.ok(ids.isUuid(ids.newUuid()));
  assert.ok(ids.isAssertionRef('user-center:default#0'));
  assert.ok(!ids.isAssertionRef('user-center:default#x'));
  assert.equal(ids.suggestSlug('User Center!'), 'user-center');
  assert.equal(ids.suggestSlug('用户中心', 'page'), 'page');
});

test('有效页面与任务通过，错误结构为 {path,code,message}', () => {
  assert.deepStrictEqual(codes(schema.validatePage(page())), []);
  assert.deepStrictEqual(codes(schema.validateUserTask(task(), { pages: [page()] })), []);
  const bad = schema.validateUserTask({});
  assert.equal(bad.ok, false);
  for (const e of bad.errors) assert.deepStrictEqual(Object.keys(e).sort(), ['code', 'message', 'path']);
});

test('action.type 白名单与 target 至少一种有效定位', () => {
  const step = task().steps[0];
  const r1 = schema.validateUserTask(task({ steps: [{ ...step, action: { type: 'drag', target: { text: 'x' } } }] }));
  assert.ok(hasError(r1, 'steps[0].action.type', 'invalid-action'));
  const r2 = schema.validateUserTask(task({ steps: [{ ...step, action: { type: 'click', target: { role: 'button' } } }] }));
  assert.ok(hasError(r2, 'steps[0].action.target', 'invalid-target'));
  const r3 = schema.validateUserTask(task({ steps: [{ ...step, action: { type: 'click', target: { xpath: '//a' } } }] }));
  assert.ok(r3.errors.some((e) => e.code === 'invalid-target'));
  const r4 = schema.validateUserTask(task({ steps: [{ ...step, action: { type: 'fill', target: { label: '昵称' } } }] }));
  assert.ok(hasError(r4, 'steps[0].action', 'invalid-action'), 'fill 需要 value 或 valueRef');
  assert.ok(schema.validateAction({ type: 'fill', target: { label: '昵称' }, valueRef: 'fixtures.nickname' }).ok);
  assert.ok(schema.validateAction({ type: 'inspect' }).ok, 'inspect 可以不带目标');
});

test('assertion 类型与值', () => {
  assert.ok(!schema.validateAssertion({ type: 'url' }).ok);
  assert.ok(!schema.validateAssertion({ type: 'visible' }).ok);
  assert.ok(!schema.validateAssertion({ type: 'exists', target: { text: 'x' } }).ok);
  assert.ok(!schema.validateAssertion({ id: 'Bad Id', type: 'visible', target: { text: 'x' } }).ok);
  assert.ok(schema.validateAssertion({ id: 'ok', type: 'hidden', target: { testId: 'spinner' } }).ok);
  const dup = schema.validatePage(page({ states: { default: { assertions: [
    { id: 'same', type: 'visible', target: { text: 'a' } }, { id: 'same', type: 'visible', target: { text: 'b' } },
  ] } } }));
  assert.ok(dup.errors.some((e) => e.code === 'duplicate-id'));
});

test('risk / replay / capture timing / stepId 安全字符 / 重复 stepId', () => {
  const step = task().steps[0];
  const r = schema.validateUserTask(task({ steps: [
    { ...step, id: '../evil', risk: 'huge', replay: 'maybe', capture: { timing: 'during' } },
    { ...step },
    { ...step },
  ] }));
  assert.ok(hasError(r, 'steps[0].id', 'invalid-id'));
  assert.ok(hasError(r, 'steps[0].risk', 'invalid-risk'));
  assert.ok(hasError(r, 'steps[0].replay', 'invalid-replay'));
  assert.ok(hasError(r, 'steps[0].capture.timing', 'invalid-capture'));
  assert.ok(hasError(r, 'steps[2].id', 'duplicate-id'));
});

test('引用存在性：页面、状态、claim 断言、checkpoint', () => {
  const step = task().steps[0];
  const r = schema.validateUserTask(task({
    entryPage: 'nowhere',
    steps: [{ ...step, stateAfter: 'no-such-state' }, { ...step, id: 'second', page: 'ghost' }],
    completion: { description: 'x', claims: [{ id: 'c', text: 't', assertionRefs: ['missing-assertion'], checkpoint: 'nope' }] },
  }), { pages: [page()] });
  assert.ok(hasError(r, 'entryPage', 'missing-reference'));
  assert.ok(hasError(r, 'steps[0].stateAfter', 'missing-reference'));
  assert.ok(hasError(r, 'steps[1].page', 'missing-reference'));
  assert.ok(hasError(r, 'completion.claims[0].assertionRefs[0]', 'missing-reference'));
  assert.ok(hasError(r, 'completion.claims[0].checkpoint', 'missing-reference'));
  // 执行器生成的断言 id 也可被引用
  const auto = schema.validateUserTask(task({ completion: { description: 'x', claims: [{ id: 'c', text: 't', assertionRefs: ['user-center:editor-open#0'] }] } }), { pages: [page()] });
  assert.deepStrictEqual(codes(auto), []);
});

test('页面路径必须是项目根相对路径', () => {
  for (const bad of ['../outside.tsx', '/abs/page.tsx', 'C:/x/page.tsx', 'https://x/y.tsx']) {
    assert.ok(hasError(schema.validatePage(page({ entry: bad })), 'entry', 'invalid-path'), bad);
  }
  assert.ok(hasError(schema.validatePage(page({ lifecycle: 'deleted' })), 'lifecycle', 'invalid-lifecycle'));
});

test('更高 schemaVersion 返回 schema-too-new；非法版本返回 invalid-schema-version', () => {
  assert.ok(hasError(schema.validatePage(page({ schemaVersion: 99 })), 'schemaVersion', 'schema-too-new'));
  assert.ok(hasError(schema.validateUserTask(task({ schemaVersion: 3 })), 'schemaVersion', 'schema-too-new'));
  assert.ok(hasError(schema.validatePage(page({ schemaVersion: 'x' })), 'schemaVersion', 'invalid-schema-version'));
  assert.equal(schema.checkSchemaVersion('config', { version: 3 }).code, 'schema-too-new');
  assert.equal(schema.checkSchemaVersion('config', { version: 2 }).ok, true);
  assert.equal(schema.normalizeLegacy('page', page({ schemaVersion: 9 })).code, 'schema-too-new');
});

test('normalizeLegacy：旧版转内存兼容模型，不修改入参', () => {
  const oldPage = page();
  const before = JSON.stringify(oldPage);
  const n = schema.normalizeLegacy('page', oldPage);
  assert.equal(n.legacy, true);
  assert.equal(n.fromVersion, 1);
  assert.equal(n.value.schemaVersion, 2);
  assert.equal(n.value.lifecycle, 'active');
  assert.deepStrictEqual(n.value.routeBindings, [{ id: 'main', template: '/user-center', entryFiles: ['app/user-center/page.tsx'] }]);
  assert.equal(JSON.stringify(oldPage), before);

  const candidate = schema.normalizeLegacy('userTask', task({ status: 'candidate' })).value;
  assert.deepStrictEqual(candidate.approval, { status: 'pending', scopeHash: null });
  const verified = schema.normalizeLegacy('userTask', task({ status: 'verified' })).value;
  assert.equal(verified.approval.status, 'approved');
  assert.equal(verified.approval.scopeHash, null, '旧状态不能伪造当前范围');
  assert.equal(verified.approval.provenance, 'legacy-status');
  assert.equal(verified.steps[0].pageId, 'user-center');
  const current = task({ schemaVersion: 2 });
  assert.strictEqual(schema.normalizeLegacy('userTask', current).value, current);
});

test('未知字段给 warning 并保留，不当作错误', () => {
  const t = task({ ownerNote: '别删' });
  const r = schema.validateUserTask(t);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.path === 'ownerNote' && w.code === 'unknown-field'));
  assert.equal(schema.normalizeLegacy('userTask', t).value.ownerNote, '别删');
});

test('Scenario：authProfile 必须显式、catch-all 参数 string[]、checkpoint 引用步骤', () => {
  const base = {
    id: 'profile-member-editor', userTaskId: 'edit-profile', environment: 'local', authProfile: 'member',
    entry: { pageId: 'user-center', params: { slug: ['a', 'b'], id: '42' } },
    checkpoints: [{ id: 'editor', afterStepId: 'open-editor', assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }], capture: { mode: 'viewport' } }],
  };
  assert.deepStrictEqual(codes(schema.validateScenario(base, { stepIds: ['open-editor'] })), []);
  const r = schema.validateScenario({ ...base, authProfile: undefined, entry: { pageId: 'user-center', params: { slug: [1] } } }, { stepIds: ['other'] });
  assert.ok(hasError(r, 'authProfile', 'required'));
  assert.ok(hasError(r, 'entry.params.slug', 'invalid-params'));
  assert.ok(hasError(r, 'checkpoints[0].afterStepId', 'missing-reference'));
});

test('Capture / Release 记录校验', () => {
  const capture = {
    schemaVersion: 1, id: ids.newUuid(), observedAt: new Date().toISOString(),
    finalUrl: { origin: 'http://localhost:5173', pathname: '/user-center' },
    validations: [{ scope: 'page-identity', outcome: 'passed' }],
    privacy: { status: 'passed' },
    artifacts: [{ kind: 'published', path: 'docs/manual/images/annotated/abc.png', sha256: 'a'.repeat(64), bytes: 10 }],
  };
  assert.deepStrictEqual(codes(schema.validateCapture(capture)), []);
  const bad = schema.validateCapture({ ...capture, id: '2026-09-24', finalUrl: { pathname: '/x', search: '?token=1' },
    validations: [{ scope: 'everything', outcome: 'ok' }], artifacts: [{ kind: 'raw', path: '../x.png', sha256: 'nope' }] });
  for (const [path, code] of [['id', 'invalid-id'], ['finalUrl.search', 'sensitive-field'], ['validations[0].scope', 'invalid-validation'],
    ['validations[0].outcome', 'invalid-validation'], ['artifacts[0].path', 'invalid-path'], ['artifacts[0].sha256', 'invalid-hash']]) {
    assert.ok(hasError(bad, path, code), `${path}:${code}`);
  }
  const release = {
    schemaVersion: 1, id: ids.newUuid(), manualId: 'edit-profile', documentPath: 'docs/manual/tasks/edit-profile.md',
    documentHash: `sha256:${'b'.repeat(64)}`, factsHash: `sha256:${'c'.repeat(64)}`, captureIds: [capture.id],
    definitionRevisions: { 'edit-profile': `sha256:${'d'.repeat(64)}` }, createdAt: new Date().toISOString(),
  };
  assert.deepStrictEqual(codes(schema.validateRelease(release)), []);
  assert.ok(hasError(schema.validateRelease({ ...release, captureIds: ['x'] }), 'captureIds', 'invalid-id'));
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
