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
  // 旧版本为高级命令生成过别名：模拟残留，安装后应被清理；用户自建的同名文件不动。
  fs.mkdirSync(path.join(codex, 'skills', 'manual-capture'), { recursive: true });
  fs.writeFileSync(path.join(codex, 'skills', 'manual-capture', 'SKILL.md'), 'This is a compatibility alias for the `manual` skill. node manual.js capture');
  fs.mkdirSync(path.join(claude, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'commands', 'manual-capture.md'), 'Run the Living User Manual capture workflow\nnode manual.js capture');
  fs.writeFileSync(path.join(claude, 'commands', 'manual-status.md'), '用户自己写的命令');
  const result = spawnSync(process.execPath, [CLI, '--codex-home', codex, '--claude-home', claude, '--json'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(!fs.existsSync(path.join(codex, 'skills', 'manual-capture')), '旧 Codex 别名已清理');
  assert.ok(!fs.existsSync(path.join(claude, 'commands', 'manual-capture.md')), '旧 Claude 别名已清理');
  assert.strictEqual(fs.readFileSync(path.join(claude, 'commands', 'manual-status.md'), 'utf8'), '用户自己写的命令');
  assert.strictEqual(output.removed.length, 2);
  for (const name of ['manual-init', 'manual-inspect', 'manual-describe', 'manual-auth', 'manual-generate', 'manual-update', 'manual-verify', 'manual-site', 'manual-doctor']) {
    const skill = path.join(codex, 'skills', name, 'SKILL.md');
    const command = path.join(claude, 'commands', `${name}.md`);
    assert.ok(fs.existsSync(skill), skill);
    assert.ok(fs.existsSync(command), command);
    assert.match(fs.readFileSync(skill, 'utf8'), new RegExp(`name: ${name}`));
    assert.match(fs.readFileSync(command, 'utf8'), new RegExp(`manual\\.js" ${name.replace(/^manual-/, '')}`));
  }
  assert.strictEqual(output.installed.length, 18);

  const readme = fs.readFileSync(path.resolve(__dirname, '..', 'README.md'), 'utf8');
  const architecture = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'ARCHITECTURE.md'), 'utf8');
  assert.match(readme, /manual auth login/);
  assert.match(readme, /auth-missing/);
  assert.match(architecture, /%LOCALAPPDATA%/);
  assert.doesNotMatch(architecture, /登录态：.*需要持久化 context/);

  process.stdout.write('\ncompat aliases\n  ✓ 只为主流程命令安装 Codex $manual-* 与 Claude /manual-* 别名，并清理旧别名\n  ✓ 认证缓存与公开脱敏文档已同步\n\n2 passed, 0 failed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
