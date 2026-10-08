'use strict';

/*
 * P3-08：用户文档与实际 CLI 一致。
 *   - 注册表里的每个命令都出现在 SKILL.md 与 README.md，且有 --help
 *   - 文档里写到的 update / verify / gc / capture 选项都是命令真实接受的参数
 *   - 不再把已实现的命令标为"计划中"，不再承诺"同一页面截图字节一致"
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const { COMMANDS, PLANNED } = require('../src/cli/commands');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'manual.js');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const docs = { skill: read('SKILL.md'), readme: read('README.md'), runtime: read('docs/RUNTIME.md'), migration: read('docs/MIGRATION.md'), architecture: read('docs/ARCHITECTURE.md') };

function camel(flag) {
  return flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

process.stdout.write('\ndocs consistency\n');

test('命令按分组出现在文档中：主流程 / 任务 / Run 在 SKILL.md，高级命令在命令细节，兼容入口不进 SKILL.md；--help 退出 0', () => {
  assert.deepStrictEqual(PLANNED, [], '没有"计划中"的命令');
  const workflows = read('references/command-workflows.md');
  const mentions = (text, name) => new RegExp(`(manual ${name}\\b|\`${name}\`)`).test(text);
  for (const command of COMMANDS) {
    if (['core', 'task', 'run'].includes(command.group)) assert.ok(mentions(docs.skill, command.name), `SKILL.md 缺少 ${command.name}`);
    if (command.group === 'advanced') assert.ok(mentions(workflows, command.name), `command-workflows.md 缺少 ${command.name}`);
    if (command.group === 'legacy') {
      assert.ok(!new RegExp(`manual ${command.name}\\b`).test(docs.skill), `SKILL.md 不应引导使用兼容入口 ${command.name}`);
      assert.ok(docs.migration.includes(command.name), `MIGRATION.md 缺少兼容入口 ${command.name} 的替代说明`);
    }
    assert.ok(docs.readme.includes(command.name), `README.md 缺少 ${command.name}`);
    const help = spawnSync(process.execPath, [CLI, command.name, '--help'], { encoding: 'utf8' });
    assert.strictEqual(help.status, 0, `${command.name} --help`);
  }
});

test('文档中的 update / verify / gc 选项都是命令真实接受的参数', () => {
  const all = Object.values(docs).join('\n');
  for (const name of ['update', 'verify', 'gc']) {
    const { KNOWN_FLAGS } = require(`../src/commands/${name}`);
    const used = [...all.matchAll(new RegExp(`manual ${name}\\b([^\\n\`|]*)`, 'g'))].flatMap((m) => m[1].match(/--[a-z][a-z-]*/g) || []);
    for (const flag of new Set(used)) assert.ok(KNOWN_FLAGS.has(camel(flag)), `文档中 manual ${name} ${flag} 不是有效参数`);
  }
});

test('不再有过时的说法：计划中的 update、字节一致的截图、从个人工具目录加载 Playwright', () => {
  assert.doesNotMatch(docs.skill, /⏳/);
  assert.doesNotMatch(docs.readme, /⏳/);
  assert.doesNotMatch(docs.architecture, /必须字节一致/);
  assert.doesNotMatch(docs.architecture, /gstack\/node_modules\/playwright` 是本机现成/);
});

test('RUNTIME.md 覆盖完整流程：安装、登录、generate、等待输入、resume、update、verify、迁移、故障排查', () => {
  for (const keyword of ['npm ci', 'auth login', 'generate', 'waiting', '--request', 'resume', 'update', 'verify', 'gc', '故障排查']) {
    assert.ok(docs.runtime.includes(keyword), `RUNTIME.md 缺少 ${keyword}`);
  }
  assert.ok(docs.migration.includes('manual migrate --dry-run'));
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
