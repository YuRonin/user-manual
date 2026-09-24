'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeFileAtomic } = require('../src/util/atomic-write');
const { writeText } = require('../src/util/fsx');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-atomic-'));
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

/** 在真实 fs 上叠加一个故障点。 */
function faulty(overrides) {
  return { ...fs, ...overrides };
}

function leftovers(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

process.stdout.write('\natomic write\n');

test('正常替换：内容更新，不留 temp，也不使用固定 .tmp 名', (root) => {
  const file = path.join(root, 'docs', 'a.md');
  writeFileAtomic(file, 'one');
  fs.writeFileSync(`${file}.tmp`, 'someone else');
  writeFileAtomic(file, 'two');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'two');
  assert.strictEqual(fs.readFileSync(`${file}.tmp`, 'utf8'), 'someone else', '不能占用或覆盖别人的 .tmp');
  assert.deepStrictEqual(leftovers(path.dirname(file)).filter((n) => n !== 'a.md.tmp'), []);
});

for (const [label, point] of [['write', 'writeFileSync'], ['fsync', 'fsyncSync'], ['rename', 'renameSync']]) {
  test(`${label} 失败：旧文件字节不变，临时文件被清理`, (root) => {
    const file = path.join(root, 'a.md');
    fs.writeFileSync(file, 'OLD');
    const fsImpl = faulty({ [point]: () => { throw Object.assign(new Error(`${label} boom`), { code: 'EIO' }); } });
    assert.throws(() => writeFileAtomic(file, 'NEW', { fsImpl }), (e) => e.code === 'write-failed');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'OLD');
    assert.deepStrictEqual(leftovers(root), []);
  });
}

test('目标被占用（EPERM/EBUSY）：有限重试后返回 file-busy，不先删除目标', (root) => {
  const file = path.join(root, 'a.md');
  fs.writeFileSync(file, 'OLD');
  let renames = 0;
  let unlinkedTarget = false;
  const fsImpl = faulty({
    renameSync: () => { renames++; throw Object.assign(new Error('busy'), { code: 'EPERM' }); },
    unlinkSync: (target) => { if (path.resolve(target) === path.resolve(file)) unlinkedTarget = true; return fs.unlinkSync(target); },
  });
  assert.throws(() => writeFileAtomic(file, 'NEW', { fsImpl, renameRetries: 2 }), (e) => e.code === 'file-busy');
  assert.strictEqual(renames, 3);
  assert.strictEqual(unlinkedTarget, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'OLD');
  assert.deepStrictEqual(leftovers(root), []);
});

test('短暂占用后恢复：重试成功', (root) => {
  const file = path.join(root, 'a.md');
  let first = true;
  const fsImpl = faulty({ renameSync: (a, b) => { if (first) { first = false; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } return fs.renameSync(a, b); } });
  writeFileAtomic(file, 'NEW', { fsImpl });
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'NEW');
});

test('writeText 走原子写入并统一 LF', (root) => {
  const file = path.join(root, 'x', 'y.txt');
  writeText(file, 'a\r\nb\r\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'a\nb\n');
  assert.deepStrictEqual(leftovers(path.dirname(file)), []);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
