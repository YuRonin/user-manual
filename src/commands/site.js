'use strict';

const path = require('path');

const { parseArgs } = require('../cli/args');
const { EXIT, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { buildSite } = require('../site/build');
const { ensureStateGitignore } = require('../runtime/store');

const KNOWN_FLAGS = new Set(['projectRoot', 'force', 'json', 'help']);
const HELP = `
manual site —— 把已发布的手册渲染成静态帮助中心网站

用法:
  manual site [--force] [--project-root <路径>] [--json]

读取 docs.outputDir 下已发布的 Markdown（index.md 的目录 + 页面篇 + tasks/ 任务篇），
生成可直接托管的 HTML：首页目录、正文页、「完成后你会看到」提示框、可选求助区，
截图转为 WebP。文档互链改写为相对 .html，任何死链都会让构建失败且不写入文件。

输出到 site.outputDir（默认 .manual/site/）；标题、主题色、求助区等见 config.yaml 的 site 段。
只清理本命令上次生成的文件；输出目录非空且不是本命令生成的会拒绝写入，确认后加 --force。
`.trim();

async function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  const print = (payload, code) => {
    if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else if (!payload.ok) for (const error of payload.errors) process.stderr.write(`[manual site] ${error.message || error}\n`);
    return code;
  };
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return usageExit(print({ ok: false, errors: [`未知参数: ${unknownFlags.join(', ')}`] }));

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return print({ ok: false, errors: loaded.errors }, EXIT.FAILED);

  // 默认输出在 .manual/site/，确保它被 .manual/.gitignore 覆盖
  ensureStateGitignore(path.join(projectRoot, loaded.config.artifacts.stateDir));

  const result = await buildSite({ projectRoot, config: loaded.config, force: values.force === true });
  if (!result.ok) {
    const conflict = result.errors.some((error) => error.code === 'site-output-unmanaged');
    return print(result, conflict ? EXIT.CONFLICT : EXIT.FAILED);
  }
  if (!json) {
    const out = path.join(projectRoot, result.outputDir);
    process.stdout.write(
      `帮助中心已生成：${path.join(out, 'index.html')}\n` +
      `  ${result.pages} 个页面（${result.documents} 篇目录文档）；` +
      `截图转码 ${result.images.converted}、复制 ${result.images.copied}、未变 ${result.images.skipped}` +
      `${result.removed.length ? `；清理 ${result.removed.length} 个旧文件` : ''}\n`
    );
  }
  return print(result, EXIT.OK);
}

module.exports = { run, HELP, KNOWN_FLAGS };
