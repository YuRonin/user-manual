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
  assert.strictEqual(output.complete, false, '复制原图不等于迁移完成');
  assert.ok(output.pending.some((item) => item.code === 'recapture-required'));

  // 旧配置（rawDir 在文档目录内）与仍引用原图的文档都进入 pending，且只报告不修改。
  const configFile = path.join(root, '.manual', 'config.yaml');
  const legacyConfig = fs.readFileSync(configFile, 'utf8').replace(/rawDir: .*/, 'rawDir: docs/manual/images/raw');
  fs.writeFileSync(configFile, legacyConfig);
  const doc = path.join(root, 'docs', 'manual', 'profile.md');
  const docText = '# 个人中心\n\n![个人中心](images/raw/profile.png)\n';
  fs.writeFileSync(doc, docText);
  result = run(['migrate-artifacts', '--project-root', root, '--json']);
  assert.strictEqual(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  const codes = output.pending.map((item) => item.code);
  assert.ok(codes.includes('legacy-raw-config'), JSON.stringify(output.pending));
  assert.ok(codes.includes('legacy-raw-reference'), JSON.stringify(output.pending));
  assert.strictEqual(fs.readFileSync(configFile, 'utf8'), legacyConfig);
  assert.strictEqual(fs.readFileSync(doc, 'utf8'), docText);

  process.stdout.write('\nartifact migration\n  ✓ 默认只报告，显式复制且不删除旧文件\n  ✓ 已存在目标不会被静默覆盖\n  ✓ 报告旧配置、原图引用与重新采集等待处理项，不声称迁移完成\n\n3 passed, 0 failed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
