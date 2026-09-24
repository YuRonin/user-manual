'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'bin', 'install-compat.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-compat-'));

try {
  const codex = path.join(root, 'codex');
  const claude = path.join(root, 'claude');
  const result = spawnSync(process.execPath, [CLI, '--codex-home', codex, '--claude-home', claude, '--json'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  for (const name of ['manual-init', 'manual-inspect', 'manual-capture', 'manual-generate', 'manual-discover-tasks', 'manual-verify']) {
    const skill = path.join(codex, 'skills', name, 'SKILL.md');
    const command = path.join(claude, 'commands', `${name}.md`);
    assert.ok(fs.existsSync(skill), skill);
    assert.ok(fs.existsSync(command), command);
    assert.match(fs.readFileSync(skill, 'utf8'), new RegExp(`name: ${name}`));
    assert.match(fs.readFileSync(command, 'utf8'), new RegExp(`manual\\.js" ${name.replace(/^manual-/, '')}`));
  }
  assert.ok(output.installed.length >= 12);

  const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  const architecture = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'ARCHITECTURE.md'), 'utf8');
  assert.match(readme, /manual auth login/);
  assert.match(readme, /auth-missing/);
  assert.match(architecture, /%LOCALAPPDATA%/);
  assert.doesNotMatch(architecture, /登录态：.*需要持久化 context/);

  process.stdout.write('\ncompat aliases\n  ✓ Codex $manual-* 与 Claude /manual-* 别名安装成功\n  ✓ 认证缓存与公开脱敏文档已同步\n\n2 passed, 0 failed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
