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

test('读取有效索引并优先按 route 查找页面', (root) => {
  const login = { id: 'login', route: '/login', files: ['src/login.tsx'] };
  writeJson(root, 'forward.json', { '/login': login });
  writeJson(root, 'reverse.json', { 'src/login.tsx': ['/login'] });

  const { readIndexes, findForwardPage } = require('../src/inspect/index-store');
  const result = readIndexes(root);

  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(findForwardPage(result.forward, { id: 'wrong', route: '/login' }), login);
  assert.deepStrictEqual(findForwardPage(result.forward, { id: 'login', route: '/missing' }), login);
  assert.strictEqual(findForwardPage(result.forward, { id: 'missing', route: '/missing' }), null);
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
