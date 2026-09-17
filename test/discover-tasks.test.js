'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  const root = fx.makeTempDir('manual-discover-');
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

function prepare(root) {
  const init = spawnSync(process.execPath, [CLI, 'init', '--project-root', root, '--base-url', 'http://localhost:3000'], { encoding: 'utf8' });
  assert.strictEqual(init.status, 0, init.stderr);
  const config = require('../src/config/load').loadConfig(root).config;
  const stateDir = path.join(root, config.artifacts.stateDir);
  const page = {
    id: 'user-center', route: '/user-center', dynamic: false, params: [],
    title: '个人中心', purpose: '查看和管理账号资料。',
    detectedActions: ['编辑资料', '查看学校权益'],
    entry: 'app/user-center/page.tsx',
    source: ['app/user-center/page.tsx', 'components/user/ProfileSheet.tsx'],
    dependencies: { files: ['components/user/ProfileSheet.tsx'], unresolved: [] },
    includeInManual: true, confidence: 'inferred',
    browser: { verified: false, screenshot: null },
    status: { router: 'app', sourceAnalysis: 'completed' },
  };
  require('../src/inspect/store').writeModel(stateDir, {
    name: 'fixture', framework: 'nextjs', frameworkVersion: '15', router: 'app',
    appDir: 'app', pagesDir: null, generatedAt: new Date().toISOString(),
  }, [page], { docsOutputDir: config.docs.outputDir });
  return stateDir;
}

function run(root, args) {
  return spawnSync(process.execPath, [CLI, 'discover-tasks', ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
}

function candidate() {
  return {
    id: 'edit-profile',
    title: '修改个人资料',
    goal: '更新昵称、性别或教学信息',
    entryPage: 'user-center',
    priority: 'high',
    preconditions: ['已登录'],
    risk: 'local',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'user-center', action: { type: 'click', target: { role: 'button', name: '编辑资料' } } },
      { id: 'save-profile', instruction: '点击「保存修改」', page: 'user-center', action: { type: 'click', target: { role: 'button', name: '保存修改' } }, risk: 'write' },
    ],
    completion: { description: '个人中心显示更新后的内容', verification: 'expected' },
    evidence: [{ kind: 'source', file: 'components/user/ProfileSheet.tsx' }],
  };
}

process.stdout.write('\ndiscover tasks\n');

test('无输入时返回候选发现工作清单且不写任务', (root) => {
  const stateDir = prepare(root);
  const result = run(root, ['user-center']);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.strictEqual(output.phase, 'worklist');
  assert.strictEqual(output.worklist[0].page.id, 'user-center');
  assert.deepStrictEqual(output.worklist[0].detectedActions, ['编辑资料', '查看学校权益']);
  assert.ok(output.worklist[0].read.includes('components/user/ProfileSheet.tsx'));
  assert.strictEqual(require('../src/tasks/store').readTasks(stateDir).tasks.length, 0);
});

test('候选 JSON 经过校验后写入，状态强制为 candidate', (root) => {
  const stateDir = prepare(root);
  const input = path.join(root, 'candidates.json');
  fs.writeFileSync(input, JSON.stringify({ tasks: [{ ...candidate(), status: 'verified' }] }), 'utf8');

  const result = run(root, ['user-center', '--input', input]);
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepStrictEqual(output.created, ['edit-profile']);
  const saved = require('../src/tasks/store').readTask(stateDir, 'edit-profile');
  assert.strictEqual(saved.status, 'candidate');
  assert.strictEqual(saved.steps[1].execution, 'stop-before-action');
});

test('拒绝引用未选择页面的候选，且不部分写入', (root) => {
  const stateDir = prepare(root);
  const input = path.join(root, 'candidates.json');
  fs.writeFileSync(input, JSON.stringify({ tasks: [candidate(), { ...candidate(), id: 'bad-task', entryPage: 'other' }] }), 'utf8');

  const result = run(root, ['user-center', '--input', input]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /other.*不在本次发现范围|不在本次发现范围.*other/);
  assert.strictEqual(require('../src/tasks/store').readTasks(stateDir).tasks.length, 0);
});

test('拒绝覆盖已批准任务', (root) => {
  const stateDir = prepare(root);
  const store = require('../src/tasks/store');
  store.writeTask(stateDir, { ...candidate(), status: 'approved' });
  const input = path.join(root, 'candidates.json');
  fs.writeFileSync(input, JSON.stringify({ tasks: [candidate()] }), 'utf8');

  const result = run(root, ['user-center', '--input', input]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /不能覆盖.*approved|approved.*不能覆盖/);
  assert.strictEqual(store.readTask(stateDir, 'edit-profile').status, 'approved');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
