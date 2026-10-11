'use strict';

/*
 * 测试分组一致性：test/run.js 的 FILES 覆盖磁盘上的全部测试文件，启动浏览器 / 测试服务器的文件都在 browser 组，
 * e2e / golden 是 browser 组的子集；npm scripts 与分组对应。不启动浏览器。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');
const { FILES, BROWSER, E2E, GOLDEN, groupOf } = require('./run');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

process.stdout.write('\ntest groups\n');

test('run.js 覆盖全部测试文件；启动浏览器 / 测试服务器的文件都在 browser 组', () => {
  const onDisk = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  assert.deepStrictEqual([...FILES].sort(), onDisk, 'test/run.js 的 FILES 与磁盘上的测试文件一致');
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const usesBrowser = /require\('\.\/server'\)|createBrowserSession\(\)|chromium\.launch|launchBrowser\(/.test(source);
    if (usesBrowser) assert.strictEqual(groupOf(file), 'browser', `${file} 启动浏览器，应在 browser 组`);
  }
  for (const file of BROWSER) assert.ok(FILES.includes(file), `${file} 在 BROWSER 中但不在 FILES 中`);
});

test('e2e / golden 是 browser 组的子集；npm scripts 与分组对应', () => {
  for (const file of [...E2E, ...GOLDEN]) assert.ok(FILES.includes(file) && BROWSER.has(file), `${file} 需要在 FILES 且属于 browser 组`);
  assert.strictEqual(pkg.scripts['test:unit'], 'node test/run.js --group unit');
  assert.strictEqual(pkg.scripts['test:browser'], 'node test/run.js --group browser');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
