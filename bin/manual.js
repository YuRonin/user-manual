#!/usr/bin/env node
'use strict';

/*
 * Living User Manual CLI 入口。
 *
 * 命令清单来自 src/cli/commands.js（与 compat 别名共用）。
 * 每个子命令导出 run(argv) 并自己负责参数解析与退出码。
 */

const pkg = require('../package.json');
const { COMMANDS, PLANNED, findCommand, loadCommand } = require('../src/cli/commands');

const HELP = `
manual —— Living User Manual (v${pkg.version})
为 Web 项目生成并持续维护图文用户手册。

用法:
  manual <命令> [选项]

命令:
${COMMANDS.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`).join('\n')}

尚未实现（后续版本）:
${PLANNED.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`).join('\n')}

全局选项:
  --help      显示帮助（manual <命令> --help 查看子命令用法）
  --version   显示版本

示例:
  manual init --base-url http://localhost:5173
  manual init --help
`.trim();

function main(argv) {
  const [command, ...rest] = argv;

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(pkg.version + '\n');
    return 0;
  }

  const entry = findCommand(command);
  if (entry) return loadCommand(entry).run(rest);

  const planned = PLANNED.find((c) => c.name === command);
  if (planned) {
    process.stderr.write(
      `[manual] \`${command}\` 尚未实现（计划中：${planned.summary}）。当前版本只支持: ${COMMANDS.map((c) => c.name).join(', ')}\n`
    );
    return 2;
  }

  process.stderr.write(`[manual] 未知命令: ${command}\n\n${HELP}\n`);
  return 2;
}

// 子命令可以是同步的（init/inspect/describe）或异步的（capture）。
// 统一按 Promise 处理，避免异步命令在退出码还没定下来时就结束进程。
Promise.resolve(main(process.argv.slice(2)))
  .then((code) => { process.exitCode = code; })
  .catch((e) => {
    process.stderr.write(`[manual] 未捕获的错误: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  });
