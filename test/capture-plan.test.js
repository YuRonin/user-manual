'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { buildCapturePlan, writeCapturePlan } = require('../src/tasks/capture-plan');
const { approve } = require('../src/model/approval');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function page(overrides = {}) {
  return {
    id: 'user-center', route: '/user-center',
    states: {
      default: { description: '个人中心初始状态', assertions: [{ type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
      'edit-profile-open': { description: '编辑资料抽屉已打开', assertions: [{ type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
    },
    ...overrides,
  };
}

function draftTask(status = 'approved') {
  return {
    id: 'edit-profile', title: '修改个人资料', entryPage: 'user-center', risk: 'local', status,
    steps: [
      { id: 'open', instruction: '点击「编辑资料」', page: 'user-center', stateBefore: 'default', stateAfter: 'edit-profile-open', action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'before', annotations: [{ target: 'action.target', label: 1 }] } },
      { id: 'save', instruction: '点击「保存修改」', page: 'user-center', stateBefore: 'edit-profile-open', action: { type: 'click', target: { role: 'button', name: '保存修改' } }, risk: 'write' },
    ],
  };
}

/** 经过人工确认的任务：审批范围按确认时的定义与页面计算。 */
function approvedTask(pages = [page()], mutate = (t) => t) {
  const task = mutate(draftTask());
  return { ...task, approval: approve(task, pages) };
}

process.stdout.write('\ncapture plan\n');

test('获批任务生成可审阅计划并继承风险边界', () => {
  const result = buildCapturePlan(approvedTask(), [page()]);
  assert.strictEqual(result.ok, true, result.errors?.join('\n'));
  assert.strictEqual(result.plan.entry.route, '/user-center');
  assert.strictEqual(result.plan.steps[0].expectedState.assertions[0].target.name, '编辑资料');
  assert.strictEqual(result.plan.steps[0].execution, 'auto');
  assert.strictEqual(result.plan.steps[0].replay, 'safe');
  assert.strictEqual(result.plan.steps[1].execution, 'stop-before-action');
  assert.strictEqual(result.plan.steps[1].replay, 'requires-input');
  assert.strictEqual(result.plan.steps[1].willExecute, false);
  assert.match(result.plan.approvalScopeHash, /^sha256:/);
});

test('未批准、旧版只有 status、已拒绝的任务都不能生成计划', () => {
  for (const [task, code] of [
    [draftTask('candidate'), /approval-required/],
    [draftTask('approved'), /approval-scope-unknown/],
    [{ ...draftTask('candidate'), approval: { status: 'rejected' } }, /approval-rejected/],
  ]) {
    const result = buildCapturePlan(task, [page()]);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join('\n'), code);
  }
});

test('同一获批任务可重复生成计划（与 status 无关）', () => {
  const task = approvedTask();
  for (const status of ['approved', 'captured', 'generated', 'verified', 'stale']) {
    assert.strictEqual(buildCapturePlan({ ...task, status }, [page()]).ok, true, status);
  }
});

test('审批范围：动作、风险、断言变化需要重新确认；标题 / 说明文字润色不需要', () => {
  const task = approvedTask();
  const retitled = { ...task, title: '编辑个人资料', goal: '改一下', steps: task.steps.map((s) => ({ ...s, instruction: `${s.instruction}。` })) };
  assert.strictEqual(buildCapturePlan(retitled, [page()]).ok, true);

  const changedAction = { ...task, steps: [{ ...task.steps[0], action: { type: 'click', target: { role: 'button', name: '删除账号' } } }, task.steps[1]] };
  const changedRisk = { ...task, steps: [task.steps[0], { ...task.steps[1], risk: 'read' }] };
  for (const changed of [changedAction, changedRisk]) {
    const result = buildCapturePlan(changed, [page()]);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join('\n'), /approval-scope-changed/);
  }
  // 页面上的断言是审批范围的一部分
  const pageChanged = page({ states: { ...page().states, 'edit-profile-open': { assertions: [{ type: 'visible', target: { role: 'dialog', name: '别的面板' } }] } } });
  assert.match(buildCapturePlan(task, [pageChanged]).errors.join('\n'), /approval-scope-changed/);
});

test('引用不存在的页面状态时拒绝生成计划', () => {
  const task = approvedTask([page()], (t) => { t.steps[0].stateAfter = 'missing'; return t; });
  const result = buildCapturePlan(task, [page()]);
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join('\n'), /missing/);
});

test('missing / retired 页面拒绝采集', () => {
  for (const lifecycle of ['missing', 'retired', 'excluded']) {
    const pages = [page({ lifecycle })];
    const result = buildCapturePlan(approvedTask(pages), pages);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(`page-not-active.*${lifecycle}`));
  }
});

test('动态入口：普通参数编码斜杠，catch-all 参数为 string[] 逐段编码；缺参数报错', () => {
  const docs = page({ id: 'docs', route: '/docs/:slug*' });
  const task = (t) => ({ ...t, entryPage: 'docs', steps: t.steps.map((s) => ({ ...s, page: 'docs' })) });
  const approved = approvedTask([docs], task);
  assert.strictEqual(buildCapturePlan(approved, [docs], { params: { slug: ['a b', 'c/d'] } }).plan.entry.route, '/docs/a%20b/c%2Fd');
  assert.match(buildCapturePlan(approved, [docs]).errors.join('\n'), /缺少参数: slug/);

  const item = page({ id: 'item', route: '/item/:id' });
  const itemTask = approvedTask([item], (t) => ({ ...t, entryPage: 'item', steps: t.steps.map((s) => ({ ...s, page: 'item' })) }));
  assert.strictEqual(buildCapturePlan(itemTask, [item], { params: { id: 'x/y' } }).plan.entry.route, '/item/x%2Fy');
});

test('未分类的高风险动作不自动执行；显式声明风险的步骤按声明执行', () => {
  const unclassified = approvedTask([page()], (t) => {
    t.steps = [{ id: 'delete', instruction: '点击「删除」', page: 'user-center', action: { type: 'click', target: { role: 'button', name: '删除' } } }];
    return t;
  });
  const step = buildCapturePlan(unclassified, [page()]).plan.steps[0];
  assert.strictEqual(step.execution, 'stop-before-action');
  assert.strictEqual(step.riskReason, 'unclassified-high-risk');
  assert.strictEqual(step.willExecute, false);

  const declared = approvedTask([page()], (t) => {
    t.steps = [{ id: 'confirm-filter', instruction: '点击「确认」筛选', page: 'user-center', risk: 'read', action: { type: 'click', target: { role: 'button', name: '确认' } } }];
    return t;
  });
  assert.strictEqual(buildCapturePlan(declared, [page()]).plan.steps[0].execution, 'auto');
});

test('跨页面步骤被标出，before 断言属于目标页面', () => {
  const settings = page({ id: 'settings', route: '/settings', states: { default: { assertions: [{ type: 'visible', target: { role: 'heading', name: '设置' } }] } } });
  const pages = [page(), settings];
  const task = approvedTask(pages, (t) => {
    t.steps = [t.steps[0], { id: 'go-settings', instruction: '打开设置', page: 'settings', action: { type: 'inspect' } }];
    return t;
  });
  const plan = buildCapturePlan(task, pages).plan;
  assert.deepStrictEqual(plan.steps.map((s) => s.crossPage), [false, true]);
  assert.strictEqual(plan.steps[1].beforeState.assertions[0].target.name, '设置');
});

test('计划清单写入 artifacts/manifests 而不是发布目录', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'manual-plan-'));
  try {
    const built = buildCapturePlan(approvedTask(), [page()]);
    const file = writeCapturePlan(path.join(root, '.manual'), built.plan);
    assert.strictEqual(file, path.join(root, '.manual', 'artifacts', 'manifests', 'edit-profile--capture-plan.json'));
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).taskId, 'edit-profile');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
