'use strict';

/*
 * `manual init` —— 初始化当前项目的用户手册配置。
 *
 * 只做一件事：收集 5 项配置 → 写 .manual/config.yaml（+ .manual/.gitignore）。
 * 不启动浏览器、不扫描路由、不碰业务项目的任何代码。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { parseArgs } = require('../cli/args');
const schema = require('../config/schema');
const profiles = require('../config/profiles');
const providers = require('../config/providers');
const { renderConfigYaml, renderStateGitignore } = require('../config/render');
const { isUuid } = require('../model/ids');
const { writeText, backupFile, displayPath } = require('../util/fsx');

const KNOWN_FLAGS = new Set([
  'projectRoot', 'baseUrl', 'profile', 'viewport', 'dpr', 'provider',
  'lang', 'docsDir', 'name', 'audience', 'force', 'yes', 'json', 'help',
]);

const HELP = `
manual init —— 初始化当前项目的用户手册配置

用法:
  manual init --base-url <url> [选项]

选项:
  --base-url <url>        项目访问地址，例如 http://localhost:5173
                          （必填；加 --yes 时缺省为 ${schema.DEFAULTS.baseUrl}）
  --profile <id>          截图规格，默认 ${schema.DEFAULTS.profileId}
                          可选: ${profiles.presetIds().join(' | ')} | ${profiles.CUSTOM_PROFILE_ID}
  --viewport <宽x高>      自定义规格的视口，仅 --profile ${profiles.CUSTOM_PROFILE_ID} 时使用，例如 1600x1000
  --dpr <倍数>            自定义规格的 DPR，仅 --profile ${profiles.CUSTOM_PROFILE_ID} 时使用，例如 2
  --provider <id>         Browser Provider，默认 ${schema.DEFAULTS.providerId}
                          可选: ${providers.providerIds().join(' | ')}
  --lang <语言标签>        文档语言，默认 ${schema.DEFAULTS.language}（常见: ${schema.COMMON_LANGUAGES.join(', ')}）
  --docs-dir <相对路径>    文档输出目录，默认 ${schema.DEFAULTS.docsDir}
  --name <项目名>          项目名，默认取项目根目录名
  --audience <范围>        发布范围，public（默认）或 internal
  --project-root <路径>    项目根目录，默认当前工作目录
  --force                 已存在配置时覆盖（先备份为 config.yaml.bak）
  --yes                   非交互模式，未给出的项一律用默认值
  --json                  以 JSON 输出结果，便于程序/AI 解析
  --help                  显示本帮助

截图规格预设:
${Object.entries(profiles.PRESETS).map(([id, p]) => `  ${id.padEnd(18)} ${p.label}`).join('\n')}
  ${profiles.CUSTOM_PROFILE_ID.padEnd(18)} 自定义（需配合 --viewport 与 --dpr）

Browser Provider:
${Object.entries(providers.PROVIDERS).map(([id, p]) => `  ${id.padEnd(22)} ${p.label}`).join('\n')}

示例:
  manual init --base-url http://localhost:5173 --profile desktop-standard --provider playwright-headless
  manual init --base-url https://app.example.com --profile custom --viewport 1600x1000 --dpr 1.5 --lang en-US
`.trim();

/** 统一的失败输出：--json 时给结构化错误，否则给人读的多行提示。 */
function fail(errors, { json }) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  } else {
    process.stderr.write('\n[manual init] 配置未生成：\n');
    for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write('\n用 `manual init --help` 查看用法。\n');
  }
  return 1;
}

function renderSummary(summary, files, projectRoot) {
  const lines = [];
  lines.push('');
  lines.push('[manual init] 配置已生成。');
  lines.push('');
  lines.push(`  项目名           ${summary.projectName}`);
  lines.push(`  访问地址         ${summary.baseUrl}`);
  lines.push(
    `  截图规格         ${summary.activeProfile} ` +
    `(${summary.viewport.width}x${summary.viewport.height} @${summary.deviceScaleFactor}x)`
  );
  lines.push(
    `  Browser Provider ${summary.activeProvider} ` +
    `(${summary.providerType}, ${summary.headless ? '无头' : '有头'})`
  );
  lines.push(`  文档语言         ${summary.language}`);
  lines.push(`  发布范围         ${summary.audience}`);
  lines.push(`  文档输出目录     ${summary.docsDir}/`);
  lines.push('');
  lines.push('  写入文件:');
  for (const f of files) lines.push(`    + ${displayPath(f, projectRoot)}`);
  if (summary.backupPath) {
    lines.push(`    ~ ${displayPath(summary.backupPath, projectRoot)} (原配置备份)`);
  }
  lines.push('');
  lines.push('  下一步：检查 .manual/config.yaml，按需调整 activeProfile / activeProvider。');
  lines.push('  页面清单（pages）留待后续版本的扫描与生成命令填充。');
  lines.push('');
  return lines.join('\n');
}


function existingConfig(projectRoot) {
  try {
    return yaml.load(fs.readFileSync(path.join(projectRoot, schema.DEFAULTS.stateDir, 'config.yaml'), 'utf8')) || null;
  } catch (_) {
    return null;
  }
}

/** 读取已有 config 中的 project.id；没有或不是 UUID 时返回 null（由 buildConfig 新建）。 */
function existingProjectId(projectRoot) {
  const id = existingConfig(projectRoot)?.project?.id;
  return isUuid(id) ? id : null;
}

function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;

  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }

  if (unknownFlags.length > 0) {
    return fail([`未知参数: ${unknownFlags.join(', ')}`], { json });
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  // --yes 只影响「没给 baseUrl 怎么办」：显式给了就用给的，没给才落到默认值。
  const baseUrl = values.baseUrl !== undefined && values.baseUrl !== ''
    ? values.baseUrl
    : (values.yes ? schema.DEFAULTS.baseUrl : values.baseUrl);

  // --force 重建配置时保留已有项目身份：身份不能被重新推导，丢了就等于换了一个项目。
  const built = schema.buildConfig({
    projectRoot,
    projectId: existingProjectId(projectRoot),
    baseUrl,
    name: values.name,
    language: values.lang,
    docsDir: values.docsDir,
    profileId: values.profile,
    viewport: values.viewport,
    dpr: values.dpr,
    providerId: values.provider,
    audience: values.audience,
  });

  if (!built.ok) return fail(built.errors, { json });
  // 已迁移到 v2 的项目重建配置时不能降回 v1（否则旧版工具会重新获得写权限）
  const previousVersion = existingConfig(projectRoot)?.version;
  if (Number.isInteger(previousVersion) && previousVersion > built.config.version && previousVersion <= schema.MAX_CONFIG_VERSION) {
    built.config.version = previousVersion;
  }

  const stateDir = path.join(projectRoot, built.config.artifacts.stateDir);
  const configPath = path.join(stateDir, 'config.yaml');
  const gitignorePath = path.join(stateDir, '.gitignore');

  if (fs.existsSync(configPath) && !values.force) {
    return fail(
      [
        `配置已存在: ${displayPath(configPath, projectRoot)}`,
        '加 --force 覆盖（会先备份为 config.yaml.bak），或直接编辑现有文件。',
      ],
      { json }
    );
  }

  const backupPath = values.force ? backupFile(configPath) : null;
  const yamlText = renderConfigYaml(built.config);

  // 自检：把刚渲染的文本解析回来，确认是合法 YAML 且关键字段没写飞。
  // 手写渲染器最怕静默产出坏文件，这一步把它挡在落盘前。
  let parsed;
  try {
    parsed = yaml.load(yamlText);
  } catch (e) {
    return fail([`内部错误：生成的 YAML 无法解析（${e.message}）。这是 bug，请反馈。`], { json });
  }
  if (
    !parsed ||
    parsed.capture?.activeProfile !== built.config.capture.activeProfile ||
    parsed.browser?.activeProvider !== built.config.browser.activeProvider ||
    !parsed.capture?.profiles?.[built.config.capture.activeProfile]
  ) {
    return fail(['内部错误：生成的 YAML 自检未通过。这是 bug，请反馈。'], { json });
  }

  writeText(configPath, yamlText);
  writeText(gitignorePath, renderStateGitignore());

  const files = [configPath, gitignorePath];
  const summary = { ...built.summary, backupPath };

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          configPath,
          gitignorePath,
          backupPath,
          projectRoot,
          version: built.config.version,
          ...built.summary,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(renderSummary(summary, files, projectRoot) + '\n');
  }

  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
