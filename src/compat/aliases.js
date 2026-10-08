'use strict';

/*
 * 客户端别名（Codex skill / Claude Code 命令）由共享命令注册表生成，不手写第二份列表。
 * 只给主流程（core）命令生成别名；其它命令通过主 skill `manual` 使用，避免别名铺满技能列表。
 */

const { COMMANDS } = require('../cli/commands');

const ALIAS_COMMANDS = COMMANDS.filter((command) => command.group === 'core').map((command) => command.name);
// 旧版本为所有命令生成过别名；安装时据此识别并清理不再提供的别名。
const ALL_COMMANDS = COMMANDS.map((command) => command.name);
const MARKER = 'Living User Manual';

function aliasName(command) {
  return `manual-${command}`;
}

function summaryOf(command) {
  return COMMANDS.find((item) => item.name === command)?.summary || command;
}

function posix(file) {
  return file.replace(/\\/g, '/');
}

function renderCodexAlias(command, manualRoot) {
  const name = aliasName(command);
  const root = posix(manualRoot);
  return `---
name: ${name}
description: Use when the user invokes $${name} or asks to run the manual ${command} workflow (${MARKER}).
---

# ${name}

This is a compatibility alias for the \`manual\` skill: ${summaryOf(command)}.
Treat \`$${name}\` as \`$manual ${command}\`. Read \`${root}/SKILL.md\` and follow the \`${command}\` workflow.

Run the deterministic CLI as:

\`\`\`bash
node "${root}/bin/manual.js" ${command} <arguments>
\`\`\`

Preserve all approval, browser, privacy, and publication gates from the main skill.
`;
}

function renderClaudeCommand(command, manualRoot) {
  const name = aliasName(command);
  const root = posix(manualRoot);
  return `---
description: ${MARKER}：${summaryOf(command)}
argument-hint: [arguments]
---

Treat \`/${name} $ARGUMENTS\` as the \`manual ${command}\` workflow. Read \`${root}/SKILL.md\`, then run:

\`\`\`bash
node "${root}/bin/manual.js" ${command} $ARGUMENTS
\`\`\`

Follow the main skill's approval, safety, privacy, and verification rules.
`;
}

/** 由本安装器生成、但当前版本不再提供的别名（只认带标记的文件，不碰用户自建的同名文件）。 */
function isGeneratedAlias(content) {
  if (typeof content !== 'string' || !content.includes('manual.js')) return false;
  // 旧版 Codex 别名没有标记，只能按固定措辞识别。
  return content.includes(MARKER) || content.includes('compatibility alias for the `manual` skill');
}

module.exports = { COMMANDS: ALIAS_COMMANDS, ALL_COMMANDS, aliasName, renderCodexAlias, renderClaudeCommand, isGeneratedAlias };
