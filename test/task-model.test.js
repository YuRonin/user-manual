'use strict';

const assert = require('assert');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  }
}

function validTask(overrides = {}) {
  return {
    id: 'edit-profile',
    title: '修改个人资料',
    goal: '更新昵称、性别或教学信息',
    entryPage: 'user-center',
    preconditions: ['已登录'],
    risk: 'local',
    status: 'candidate',
    steps: [
      {
        id: 'open-editor',
        instruction: '点击「编辑资料」',
        page: 'user-center',
        stateBefore: 'default',
        stateAfter: 'edit-profile-open',
        action: { type: 'click', target: { role: 'button', name: '编辑资料' } },
      },
      {
        id: 'save-profile',
        instruction: '确认资料无误后，点击「保存修改」',
        page: 'user-center',
        stateBefore: 'edit-profile-open',
        action: { type: 'click', target: { role: 'button', name: '保存修改' } },
        risk: 'write',
      },
    ],
    completion: {
      description: '资料编辑面板关闭，个人中心显示更新后的内容',
      verification: 'expected',
    },
    ...overrides,
  };
}

process.stdout.write('\ntask model\n');

test('归一化任务时继承风险，并给写操作补 stop-before-action', () => {
  const { normalizeTask, effectiveRisk } = require('../src/tasks/model');
  const task = normalizeTask(validTask());

  assert.strictEqual(effectiveRisk(task, task.steps[0]), 'local');
  assert.strictEqual(task.steps[0].execution, 'auto');
  assert.strictEqual(effectiveRisk(task, task.steps[1]), 'write');
  assert.strictEqual(task.steps[1].execution, 'stop-before-action');
});

test('破坏性步骤不能被配置成自动执行', () => {
  const { normalizeTask } = require('../src/tasks/model');
  const input = validTask({
    steps: [{
      id: 'delete-account',
      instruction: '删除账号',
      page: 'user-center',
      action: { type: 'click', target: { role: 'button', name: '删除账号' } },
      risk: 'destructive',
      execution: 'auto',
    }],
  });

  const task = normalizeTask(input);
  assert.strictEqual(task.steps[0].execution, 'never');
});

test('拒绝缺失必填字段和重复 step.id 的任务', () => {
  const { validateTask } = require('../src/tasks/model');
  const result = validateTask(validTask({
    goal: '',
    steps: [
      { id: 'same', instruction: '第一步', page: 'user-center', action: { type: 'inspect' } },
      { id: 'same', instruction: '第二步', page: 'user-center', action: { type: 'inspect' } },
    ],
  }));

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => /goal/.test(e)));
  assert.ok(result.errors.some((e) => /step\.id.*重复|重复.*step\.id/.test(e)));
});

test('拒绝未知风险和无法验证的完成标志', () => {
  const { validateTask } = require('../src/tasks/model');
  const result = validateTask(validTask({
    risk: 'dangerous',
    completion: { description: '已完成', verification: 'maybe' },
  }));

  assert.strictEqual(result.ok, false);
  assert.ok(result.errors.some((e) => /risk/.test(e)));
  assert.ok(result.errors.some((e) => /completion\.verification/.test(e)));
});

test('生命周期只能顺序推进，candidate 到 approved 需要人工确认', () => {
  const { transitionTask } = require('../src/tasks/model');
  const task = validTask();

  assert.throws(() => transitionTask(task, 'approved'), /人工确认/);
  const approved = transitionTask(task, 'approved', { humanConfirmed: true });
  assert.strictEqual(approved.status, 'approved');
  assert.throws(() => transitionTask(approved, 'generated'), /不能从 approved 直接进入 generated/);
  assert.strictEqual(transitionTask(approved, 'captured').status, 'captured');
});

test('活动任务可以进入 stale，但不能从 stale 跳到 verified', () => {
  const { transitionTask } = require('../src/tasks/model');
  const stale = transitionTask(validTask({ status: 'captured' }), 'stale');
  assert.strictEqual(stale.status, 'stale');
  assert.throws(() => transitionTask(stale, 'verified'), /不能从 stale 直接进入 verified/);
});

test('读取任务时执行共享结构校验：动作白名单、定位、replay、截图时机、stepId 字符、版本', () => {
  const { validateTask } = require('../src/tasks/model');
  const step = validTask().steps[0];
  const result = validateTask(validTask({
    steps: [
      { ...step, id: 'Bad Id', action: { type: 'drag', target: { text: 'x' } } },
      { ...step, id: 'no-target', action: { type: 'click', target: { role: 'button' } }, replay: 'sometimes', capture: { timing: 'later' } },
    ],
  }));
  assert.strictEqual(result.ok, false);
  const text = result.errors.join('\n');
  for (const pattern of [/steps\[0\]\.id/, /steps\[0\]\.action\.type/, /steps\[1\]\.action\.target/, /steps\[1\]\.replay/, /steps\[1\]\.capture\.timing/]) {
    assert.match(text, pattern);
  }
  const tooNew = validateTask(validTask({ schemaVersion: 99 }));
  assert.strictEqual(tooNew.ok, false);
  assert.match(tooNew.errors.join('\n'), /高于当前工具支持/);
});

test('读取页面文件时拒绝更高 schemaVersion，不静默降级', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readExistingPages } = require('../src/inspect/store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-page-version-'));
  try {
    fs.mkdirSync(path.join(dir, 'pages'));
    fs.writeFileSync(path.join(dir, 'pages', 'a.yaml'), 'id: a\nroute: /a\n');
    fs.writeFileSync(path.join(dir, 'pages', 'b.yaml'), 'schemaVersion: 9\nid: b\nroute: /b\n');
    const result = readExistingPages(dir);
    assert.deepStrictEqual(result.pages.map((p) => p.id), ['a']);
    assert.match(result.errors.join('\n'), /b\.yaml: schema-too-new/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;

module.exports = { validTask };
