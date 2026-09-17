#!/usr/bin/env node
'use strict';

/*
 * Living User Manual CLI 入口。
 *
 * V0.1 只注册 init。generate / update / verify 在后续版本加到 COMMANDS 里，
 * 每个子命令导出 run(argv) 并自己负责参数解析与退出码。
 */

const pkg = require('../package.json');

const COMMANDS = {
  init: {
    summary: '初始化当前项目的用户手册配置，生成 .manual/config.yaml',
    load: () => require('../src/commands/init'),
  },
  inspect: {
    summary: '扫描项目路由，建立页面模型，生成 .manual/project.yaml 与 pages/',
    load: () => require('../src/commands/inspect'),
  },
  describe: {
    summary: '把页面的源码分析结果（标题/用途/操作）写回页面模型',
    load: () => require('../src/commands/describe'),
  },
  capture: {
    summary: '用真实浏览器打开页面，按配置的规格截图',
    load: () => require('../src/commands/capture'),
  },
  generate: {
    summary: '生成页面的 Markdown 手册（事实草稿 → 中文自然化 → 事实校验）',
    load: () => require('../src/commands/generate'),
  },
};

// 已规划但尚未实现的子命令：命中时给出明确说明，而不是「未知命令」
const PLANNED = {
  update: '根据代码变化增量更新手册',
  verify: '校验手册与实际页面是否一致',
};

const HELP = `
manual —— Living User Manual (v${pkg.version})
为 Web 项目生成并持续维护图文用户手册。

用法:
  manual <命令> [选项]

命令:
${Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(10)} ${c.summary}`).join('\n')}

尚未实现（后续版本）:
${Object.entries(PLANNED).map(([name, s]) => `  ${name.padEnd(10)} ${s}`).join('\n')}

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

  const entry = COMMANDS[command];
  if (entry) return entry.load().run(rest);

  if (PLANNED[command]) {
    process.stderr.write(
      `[manual] \`${command}\` 尚未实现（计划中：${PLANNED[command]}）。当前版本只支持: ${Object.keys(COMMANDS).join(', ')}\n`
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
