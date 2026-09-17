'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-migrate-'));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

try {
  let result = run(['init', '--project-root', root, '--base-url', 'http://localhost:3000']);
  assert.strictEqual(result.status, 0, result.stderr);
  const legacy = path.join(root, 'docs', 'manual', 'images', 'raw', 'profile.png');
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, Buffer.from('legacy-image'));

  result = run(['migrate-artifacts', '--project-root', root, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.strictEqual(output.mode, 'report');
  assert.deepStrictEqual(output.found, ['docs/manual/images/raw/profile.png']);
  assert.strictEqual(output.copied.length, 0);
  const migrated = path.join(root, '.manual', 'artifacts', 'raw', 'legacy', 'profile.png');
  assert.strictEqual(fs.existsSync(migrated), false, '默认检查不得写文件');

  result = run(['migrate-artifacts', '--project-root', root, '--copy', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.strictEqual(output.mode, 'copy');
  assert.deepStrictEqual(output.copied, ['.manual/artifacts/raw/legacy/profile.png']);
  assert.strictEqual(fs.readFileSync(migrated, 'utf8'), 'legacy-image');
  assert.strictEqual(fs.existsSync(legacy), true, '迁移不得删除用户旧原图');

  result = run(['migrate-artifacts', '--project-root', root, '--copy', '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.deepStrictEqual(output.skipped, ['.manual/artifacts/raw/legacy/profile.png']);

  process.stdout.write('\nartifact migration\n  ✓ 默认只报告，显式复制且不删除旧文件\n  ✓ 已存在目标不会被静默覆盖\n\n2 passed, 0 failed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
