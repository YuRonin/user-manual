#!/usr/bin/env node
'use strict';

/*
 * 安装客户端别名：Codex `$manual-<命令>` 与 Claude Code `/manual-<命令>`。
 * 只覆盖主流程命令；旧版本生成、当前不再提供的别名会被清理（只删带生成标记的文件）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { COMMANDS, ALL_COMMANDS, aliasName, renderCodexAlias, renderClaudeCommand, isGeneratedAlias } = require('../src/compat/aliases');

function value(argv, name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
}

function readIfExists(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

/** 删除旧版本生成的别名；Codex 别名目录只有 SKILL.md 时才整体删除。 */
function removeStale({ codexHome, claudeHome, client }) {
  const removed = [];
  for (const command of ALL_COMMANDS.filter((name) => !COMMANDS.includes(name))) {
    const name = aliasName(command);
    if (client !== 'claude') {
      const dir = path.join(codexHome, 'skills', name);
      const skillFile = path.join(dir, 'SKILL.md');
      if (isGeneratedAlias(readIfExists(skillFile)) && fs.readdirSync(dir).length === 1) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(skillFile);
      }
    }
    if (client !== 'codex') {
      const commandFile = path.join(claudeHome, 'commands', `${name}.md`);
      if (isGeneratedAlias(readIfExists(commandFile))) {
        fs.rmSync(commandFile, { force: true });
        removed.push(commandFile);
      }
    }
  }
  return removed;
}

function main(argv) {
  const codexHome = path.resolve(value(argv, '--codex-home', process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const claudeHome = path.resolve(value(argv, '--claude-home', path.join(os.homedir(), '.claude')));
  const json = argv.includes('--json');
  const client = value(argv, '--client', 'all');
  if (!['all', 'codex', 'claude'].includes(client)) throw new Error('--client 需要 codex / claude / all');
  const manualRoot = path.join(codexHome, 'skills', 'manual');
  const installed = [];
  for (const command of COMMANDS) {
    const name = aliasName(command);
    if (client !== 'claude') {
      const skillFile = path.join(codexHome, 'skills', name, 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, renderCodexAlias(command, manualRoot), 'utf8');
      installed.push(skillFile);
    }
    if (client !== 'codex') {
      const commandFile = path.join(claudeHome, 'commands', `${name}.md`);
      fs.mkdirSync(path.dirname(commandFile), { recursive: true });
      fs.writeFileSync(commandFile, renderClaudeCommand(command, manualRoot), 'utf8');
      installed.push(commandFile);
    }
  }
  const removed = removeStale({ codexHome, claudeHome, client });
  if (json) process.stdout.write(JSON.stringify({ ok: true, manualRoot, installed, removed }, null, 2) + '\n');
  else process.stdout.write(`已安装 ${COMMANDS.length} 组 manual 别名（${COMMANDS.join(', ')}）；清理旧别名 ${removed.length} 个。\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
