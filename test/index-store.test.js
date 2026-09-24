'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');

let passed = 0;
const failures = [];

function test(name, fn) {
  const root = fx.makeTempDir('manual-index-store-');
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

function writeJson(root, name, value) {
  const dir = path.join(root, 'index');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value), 'utf8');
}

process.stdout.write('\nindex store\n');

test('读取由当前提交派生的索引并优先按 route 查找页面', (root) => {
  const pageStore = require('../src/inspect/store');
  const { createProjectStore } = require('../src/store/project');
  pageStore.writeModel(root, { name: 'x' }, [{
    id: 'login', route: '/login', dynamic: false, params: [], entry: 'src/login.tsx', source: ['src/login.tsx'],
    dependencies: { files: [], unresolved: [] }, states: {}, status: { sourceAnalysis: 'pending' },
  }]);
  createProjectStore({ stateDirAbs: root, docsOutputDir: 'docs/manual' }).load();

  const { readIndexes, findForwardPage } = require('../src/inspect/index-store');
  const result = readIndexes(root);

  assert.strictEqual(result.ok, true, result.warning);
  const login = result.forward['/login'];
  assert.strictEqual(login.id, 'login');
  assert.deepStrictEqual(findForwardPage(result.forward, { id: 'wrong', route: '/login' }), login);
  assert.deepStrictEqual(findForwardPage(result.forward, { id: 'login', route: '/missing' }), login);
  assert.strictEqual(findForwardPage(result.forward, { id: 'missing', route: '/missing' }), null);
});

test('手写或过期的索引（没有对应提交）即使能解析也不可用', (root) => {
  writeJson(root, 'forward.json', { '/login': { id: 'login', route: '/login' } });
  writeJson(root, 'reverse.json', {});
  const { readIndexes } = require('../src/inspect/index-store');
  const result = readIndexes(root);
  assert.strictEqual(result.ok, false);
  assert.match(result.warning, /no-committed-model/);
});

test('索引缺失时返回 warning 而不是抛错', (root) => {
  const { readIndexes } = require('../src/inspect/index-store');
  const result = readIndexes(root);
  assert.strictEqual(result.ok, false);
  assert.match(result.warning, /不存在|找不到/);
});

test('JSON 损坏或根节点不是对象时安全失败', (root) => {
  const dir = path.join(root, 'index');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'forward.json'), '{broken', 'utf8');
  writeJson(root, 'reverse.json', []);

  const { readIndexes } = require('../src/inspect/index-store');
  const result = readIndexes(root);
  assert.strictEqual(result.ok, false);
  assert.match(result.warning, /解析|格式/);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
