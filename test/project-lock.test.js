'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { acquireLock, releaseLock, lockFileFor } = require('../src/store/lock');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-lock-'));
  try { await fn(dir); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function writeOwner(dir, owner) {
  const file = lockFileFor(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(owner));
  return file;
}

function holdInChild(dir, holdMs) {
  const script = `
    const { acquireLock } = require(${JSON.stringify(path.resolve(__dirname, '../src/store/lock'))});
    const lock = acquireLock(${JSON.stringify(dir)});
    process.stdout.write('locked\\n');
    setTimeout(() => { lock.release(); process.exit(0); }, ${holdMs});
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}

(async () => {
  process.stdout.write('\nproject lock\n');

  await test('排他获取；只有持有者 token 能释放', async (dir) => {
    const lock = acquireLock(dir);
    assert.throws(() => acquireLock(dir, { timeoutMs: 100 }), (e) => e.code === 'lock-timeout');
    assert.strictEqual(releaseLock(lock.file, 'someone-else'), false);
    assert.ok(fs.existsSync(lock.file));
    assert.strictEqual(lock.release(), true);
    acquireLock(dir).release();
  });

  await test('另一个进程持有时等待，释放后获得', async (dir) => {
    const child = await holdInChild(dir, 300);
    const started = Date.now();
    const lock = acquireLock(dir, { timeoutMs: 5000 });
    assert.ok(Date.now() - started >= 150, '应等待对方释放');
    lock.release();
    await new Promise((resolve) => child.on('exit', resolve));
  });

  await test('同机残留锁：进程已退出 → 自动清理；租约过期（PID 可能被复用）→ 自动清理', async (dir) => {
    writeOwner(dir, { token: 'dead', pid: 999999, host: os.hostname(), createdAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60000).toISOString() });
    acquireLock(dir, { timeoutMs: 200 }).release();
    writeOwner(dir, { token: 'reused', pid: process.pid, host: os.hostname(), createdAt: new Date(0).toISOString(), leaseUntil: new Date(1000).toISOString() });
    acquireLock(dir, { timeoutMs: 200 }).release();
  });

  await test('同机存活且租约有效的锁不被抢占', async (dir) => {
    writeOwner(dir, { token: 'alive', pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + 60000).toISOString() });
    assert.throws(() => acquireLock(dir, { timeoutMs: 150 }), (e) => e.code === 'lock-timeout');
  });

  await test('其他主机的锁从不自动清理，返回 lock-held-remote 与恢复提示', async (dir) => {
    const file = writeOwner(dir, { token: 'remote', pid: 1, host: 'another-host.example', createdAt: new Date(0).toISOString(), leaseUntil: new Date(0).toISOString() });
    assert.throws(() => acquireLock(dir, { timeoutMs: 150 }), (e) => e.code === 'lock-held-remote' && /删除/.test(e.hint));
    assert.ok(fs.existsSync(file));
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
