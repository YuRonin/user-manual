'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  const root = fx.makeTempDir('manual-task-store-');
  try {
    fn(root);
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    fx.cleanup(root);
  }
}

function task(id = 'edit-profile') {
  return {
    id,
    title: id === 'edit-profile' ? '修改个人资料' : '查看学校权益',
    goal: '完成一个明确的用户目标',
    entryPage: 'user-center',
    priority: 'high',
    preconditions: ['已登录'],
    risk: 'read',
    status: 'candidate',
    steps: [{
      id: 'open',
      instruction: '打开目标面板',
      page: 'user-center',
      action: { type: 'click', target: { role: 'button', name: '入口' } },
    }],
    completion: { description: '目标面板已显示', verification: 'verified' },
    branches: [],
    relatedTasks: [],
    evidence: [{ kind: 'source', file: 'app/user-center/page.tsx' }],
  };
}

function init(root) {
  const result = spawnSync(process.execPath, [CLI, 'init', '--project-root', root, '--base-url', 'http://localhost:3000'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}

function runApprove(root, payload) {
  const input = path.join(root, 'decisions.json');
  fs.writeFileSync(input, JSON.stringify(payload), 'utf8');
  return spawnSync(process.execPath, [CLI, 'approve-tasks', '--project-root', root, '--input', input, '--json'], { encoding: 'utf8' });
}

function writePageModel(root) {
  const config = require('../src/config/load').loadConfig(root).config;
  const stateDir = path.join(root, config.artifacts.stateDir);
  require('../src/inspect/store').writeModel(stateDir, {
    name: 'fixture', framework: 'nextjs', frameworkVersion: '15', router: 'app',
    appDir: 'app', pagesDir: null, generatedAt: new Date().toISOString(),
  }, [{
    id: 'user-center', route: '/user-center', dynamic: false, params: [],
    title: '个人中心', purpose: '管理账号资料。', detectedActions: ['编辑资料'],
    entry: 'app/user-center/page.tsx', source: ['app/user-center/page.tsx'],
    dependencies: { files: ['components/Profile.tsx'], unresolved: [] },
    includeInManual: true, confidence: 'inferred', browser: { verified: false },
    status: { router: 'app', sourceAnalysis: 'completed' },
  }], { docsOutputDir: config.docs.outputDir });
  return stateDir;
}

process.stdout.write('\ntask store and approval\n');

test('任务 YAML 稳定序列化并可读回', (root) => {
  const store = require('../src/tasks/store');
  const stateDir = path.join(root, '.manual');
  const file = store.writeTask(stateDir, task());
  const text = fs.readFileSync(file, 'utf8');
  const parsed = yaml.load(text);

  assert.match(text, /^# \.manual\/tasks\/edit-profile\.yaml/m);
  assert.strictEqual(parsed.id, 'edit-profile');
  assert.strictEqual(parsed.status, 'candidate');
  assert.strictEqual(parsed.steps[0].execution, 'auto');
  assert.deepStrictEqual(store.readTasks(stateDir).tasks.map((item) => item.id), ['edit-profile']);
});

test('读取损坏任务时报告错误而不是静默忽略', (root) => {
  const store = require('../src/tasks/store');
  const dir = store.tasksDirFor(path.join(root, '.manual'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'broken.yaml'), 'id: [', 'utf8');

  const result = store.readTasks(path.join(root, '.manual'));
  assert.strictEqual(result.tasks.length, 0);
  assert.strictEqual(result.errors.length, 1);
  assert.match(result.errors[0], /broken\.yaml/);
});

test('人工审批可以改名和排序字段，并推进为 approved', (root) => {
  init(root);
  const store = require('../src/tasks/store');
  store.writeTask(path.join(root, '.manual'), task());

  const result = runApprove(root, {
    decisions: [{ id: 'edit-profile', decision: 'approve', title: '更新个人资料', priority: 'normal' }],
  });
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepStrictEqual(output.approved, ['edit-profile']);
  const saved = store.readTask(path.join(root, '.manual'), 'edit-profile');
  assert.strictEqual(saved.status, 'approved');
  assert.strictEqual(saved.title, '更新个人资料');
  assert.strictEqual(saved.priority, 'normal');
});

test('人工拒绝只删除 candidate，不允许拒绝已批准任务', (root) => {
  init(root);
  const store = require('../src/tasks/store');
  const stateDir = path.join(root, '.manual');
  store.writeTask(stateDir, task('view-school-benefits'));
  store.writeTask(stateDir, { ...task('edit-profile'), status: 'approved' });

  const rejected = runApprove(root, {
    decisions: [{ id: 'view-school-benefits', decision: 'reject' }],
  });
  assert.strictEqual(rejected.status, 0, rejected.stderr);
  assert.strictEqual(store.readTask(stateDir, 'view-school-benefits'), null);

  const invalid = runApprove(root, {
    decisions: [{ id: 'edit-profile', decision: 'reject' }],
  });
  assert.strictEqual(invalid.status, 1);
  assert.match(invalid.stdout, /只有候选任务可以拒绝/);
  assert.strictEqual(store.readTask(stateDir, 'edit-profile').status, 'approved');
});

test('任一审批决定无效时不部分落盘', (root) => {
  init(root);
  const store = require('../src/tasks/store');
  const stateDir = path.join(root, '.manual');
  store.writeTask(stateDir, task());

  const result = runApprove(root, {
    decisions: [
      { id: 'edit-profile', decision: 'approve' },
      { id: 'missing', decision: 'approve' },
    ],
  });
  assert.strictEqual(result.status, 1);
  assert.strictEqual(store.readTask(stateDir, 'edit-profile').status, 'candidate');
});

test('批准和拒绝后同步重建任务索引', (root) => {
  init(root);
  const stateDir = writePageModel(root);
  const store = require('../src/tasks/store');
  store.writeTask(stateDir, task());
  store.writeTask(stateDir, task('view-school-benefits'));

  const result = runApprove(root, { decisions: [
    { id: 'edit-profile', decision: 'approve' },
    { id: 'view-school-benefits', decision: 'reject' },
  ] });
  assert.strictEqual(result.status, 0, result.stderr);
  const taskForward = JSON.parse(fs.readFileSync(path.join(stateDir, 'index', 'task-forward.json'), 'utf8'));
  assert.strictEqual(taskForward['edit-profile'].status, 'approved');
  assert.strictEqual(taskForward['view-school-benefits'], undefined);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
