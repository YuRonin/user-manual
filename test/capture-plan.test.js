'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function page() {
  return {
    id: 'user-center', route: '/user-center',
    states: {
      default: { description: '个人中心初始状态', assertions: [{ type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
      'edit-profile-open': { description: '编辑资料抽屉已打开', assertions: [{ type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
    },
  };
}

function task(status = 'approved') {
  return {
    id: 'edit-profile', title: '修改个人资料', entryPage: 'user-center', risk: 'local', status,
    steps: [
      { id: 'open', instruction: '点击「编辑资料」', page: 'user-center', stateBefore: 'default', stateAfter: 'edit-profile-open', action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'before', annotations: [{ target: 'action.target', label: 1 }] } },
      { id: 'save', instruction: '点击「保存修改」', page: 'user-center', stateBefore: 'edit-profile-open', action: { type: 'click', target: { role: 'button', name: '保存修改' } }, risk: 'write' },
    ],
  };
}

process.stdout.write('\ncapture plan\n');

test('为 approved 任务生成可审阅计划并继承风险边界', () => {
  const { buildCapturePlan } = require('../src/tasks/capture-plan');
  const result = buildCapturePlan(task(), [page()]);
  assert.strictEqual(result.ok, true, result.errors?.join('\n'));
  assert.strictEqual(result.plan.entry.route, '/user-center');
  assert.strictEqual(result.plan.steps[0].expectedState.assertions[0].target.name, '编辑资料');
  assert.strictEqual(result.plan.steps[0].execution, 'auto');
  assert.strictEqual(result.plan.steps[1].execution, 'stop-before-action');
  assert.strictEqual(result.plan.steps[1].willExecute, false);
});

test('未批准任务不能生成截图计划', () => {
  const { buildCapturePlan } = require('../src/tasks/capture-plan');
  const result = buildCapturePlan(task('candidate'), [page()]);
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join('\n'), /approved/);
});

test('引用不存在的页面状态时拒绝生成计划', () => {
  const { buildCapturePlan } = require('../src/tasks/capture-plan');
  const broken = task();
  broken.steps[0].stateAfter = 'missing';
  const result = buildCapturePlan(broken, [page()]);
  assert.strictEqual(result.ok, false);
  assert.match(result.errors.join('\n'), /missing/);
});

test('计划清单写入 artifacts/manifests 而不是发布目录', () => {
  const { writeCapturePlan } = require('../src/tasks/capture-plan');
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'manual-plan-'));
  try {
    const built = require('../src/tasks/capture-plan').buildCapturePlan(task(), [page()]);
    const file = writeCapturePlan(path.join(root, '.manual'), built.plan);
    assert.strictEqual(file, path.join(root, '.manual', 'artifacts', 'manifests', 'edit-profile--capture-plan.json'));
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).taskId, 'edit-profile');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
