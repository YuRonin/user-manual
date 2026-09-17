'use strict';

/*
 * 把 config 对象渲染成带注释的 YAML。
 *
 * 为什么不用 js-yaml.dump：它会把注释全部丢掉。而这份文件是给人读、给人改的——
 * 注释里的 mobile profile / computer-use provider 示例就是「后续扩展怎么加」的说明书，
 * 用户取消注释即可生效。所以这里手写渲染，js-yaml 只用来把产物解析回来做自检。
 */

const { CONFIG_VERSION } = require('./schema');
const { scalar } = require('../util/yaml-emit');

/** 渲染单个截图规格条目。 */
function renderProfile(id, profile, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const lines = [`${pad}${scalar(id)}:`];
  lines.push(`${inner}kind: ${scalar(profile.kind)}`);
  lines.push(`${inner}viewport:`);
  lines.push(`${inner}  width: ${scalar(profile.viewport.width)}`);
  lines.push(`${inner}  height: ${scalar(profile.viewport.height)}`);
  lines.push(`${inner}deviceScaleFactor: ${scalar(profile.deviceScaleFactor)}`);
  return lines;
}

/** 渲染单个 Browser Provider 条目。type 之外的键按声明顺序原样输出。 */
function renderProvider(id, provider, indent) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  const lines = [`${pad}${scalar(id)}:`];
  lines.push(`${inner}type: ${scalar(provider.type)}`);
  for (const [key, value] of Object.entries(provider)) {
    if (key === 'type') continue;
    lines.push(`${inner}${key}: ${scalar(value)}`);
  }
  return lines;
}

/**
 * 渲染完整配置文件。
 * @param {object} config  schema.buildConfig() 产出的对象
 * @param {object} [meta]  { generatedAt: ISO 字符串 }
 */
function renderConfigYaml(config, meta = {}) {
  const generatedAt = meta.generatedAt || new Date().toISOString();
  const L = [];

  L.push('# Living User Manual —— 项目级配置');
  L.push('# 由 `manual init` 生成，可手工编辑；重跑 init 会覆盖（默认先备份为 config.yaml.bak）。');
  L.push(`# 生成时间: ${generatedAt}`);
  L.push('');
  L.push('# 配置结构版本。仅在不兼容变更时递增；新增 profile / provider / 可选字段不影响它。');
  L.push(`version: ${scalar(config.version != null ? config.version : CONFIG_VERSION)}`);
  L.push('');

  // ---- project
  L.push('# ---------------------------------------------------------------- 项目');
  L.push('project:');
  L.push(`  name: ${scalar(config.project.name)}`);
  L.push('  # 项目的访问地址。手册里所有页面路径都相对它拼接。');
  L.push(`  baseUrl: ${scalar(config.project.baseUrl)}`);
  L.push('');

  // ---- capture
  L.push('# ---------------------------------------------------------------- 截图规格');
  L.push('# activeProfile 指向 profiles 里的一项；改这一行即可切换规格，无需重跑 init。');
  L.push('capture:');
  L.push(`  activeProfile: ${scalar(config.capture.activeProfile)}`);
  L.push('  profiles:');
  for (const [id, profile] of Object.entries(config.capture.profiles)) {
    L.push(...renderProfile(id, profile, 4));
  }
  L.push('');
  L.push('    # —— 移动端规格示例（后续版本支持，取消注释即可使用）——');
  L.push('    # mobile-iphone:');
  L.push('    #   kind: mobile');
  L.push('    #   viewport:');
  L.push('    #     width: 390');
  L.push('    #     height: 844');
  L.push('    #   deviceScaleFactor: 3');
  L.push('    #   isMobile: true');
  L.push('    #   hasTouch: true');
  L.push("    #   userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ...'");
  L.push('');

  // ---- browser
  L.push('# ---------------------------------------------------------------- Browser Provider');
  L.push('# 谁来驱动真实浏览器。type 决定运行时挂哪个 adapter，id 只是名字——');
  L.push('# 同一个 type 可以有多个实例（比如两套不同 channel 的 playwright）。');
  L.push('browser:');
  L.push(`  activeProvider: ${scalar(config.browser.activeProvider)}`);
  L.push('  providers:');
  for (const [id, provider] of Object.entries(config.browser.providers)) {
    L.push(...renderProvider(id, provider, 4));
  }
  L.push('');
  L.push('    # —— 以下 Provider 后续版本接入，结构已预留，取消注释并补齐字段即可 ——');
  L.push('    # chatgpt-desktop:');
  L.push('    #   type: computer-use');
  L.push('    #   target: chatgpt-desktop');
  L.push('    #');
  L.push('    # agent-browser:');
  L.push('    #   type: agent-browser');
  L.push("    #   endpoint: 'http://127.0.0.1:0000'");
  L.push('');

  // ---- docs
  L.push('# ---------------------------------------------------------------- 文档输出');
  L.push('docs:');
  L.push('  # 手册正文使用的语言。');
  L.push(`  language: ${scalar(config.docs.language)}`);
  L.push('  # Markdown 手册落点，相对项目根。');
  L.push(`  outputDir: ${scalar(config.docs.outputDir)}`);
  L.push('  # 手册引用的图片落点。这份是要随手册入库的。');
  L.push(`  imagesDir: ${scalar(config.docs.imagesDir)}`);
  L.push('');

  // ---- artifacts
  L.push('# ---------------------------------------------------------------- 截图产物');
  L.push('# 原图与标注图都留存：原图可复用、可重新标注，标注图进手册。');
  L.push('# 两者都在文档目录下，跟手册一起入库——手册要引用它们。');
  L.push('# rawDir 是 `manual capture` 的输出目录。');
  L.push('artifacts:');
  L.push(`  stateDir: ${scalar(config.artifacts.stateDir)}`);
  L.push(`  rawDir: ${scalar(config.artifacts.rawDir)}`);
  L.push(`  annotatedDir: ${scalar(config.artifacts.annotatedDir)}`);
  L.push(`  format: ${scalar(config.artifacts.format)}`);
  L.push('');

  // ---- inspect
  L.push('# ---------------------------------------------------------------- 项目扫描');
  L.push('# `manual inspect` 的扫描选项。页面清单本身不在这里——它是扫描产出，');
  L.push('# 落在 .manual/project.yaml（索引）与 .manual/pages/<id>.yaml（每页详情）。');
  L.push('inspect:');
  L.push('  # 不写进手册的路由。支持 * 通配一段、** 通配多段，例如:');
  L.push("  #   - '/admin/**'");
  L.push("  #   - '/debug/*'");
  const exclude = Array.isArray(config.inspect?.exclude) ? config.inspect.exclude : [];
  if (exclude.length === 0) {
    L.push('  exclude: []');
  } else {
    L.push('  exclude:');
    for (const pattern of exclude) L.push(`    - ${scalar(pattern)}`);
  }
  L.push('');

  return L.join('\n');
}

/**
 * `.manual/.gitignore`。
 * config.yaml / project.yaml / pages/ 是项目资产，要入库；
 * 浏览器会话、缓存、备份是本机中间产物，不入库。
 * （截图不在这里——它们在文档目录下，跟手册一起入库。）
 */
function renderStateGitignore() {
  return [
    '# 由 manual init 生成。',
    '# config.yaml / project.yaml / pages/ 应当入库；下面这些是本机中间产物。',
    'session/',
    'cache/',
    'screenshots/',
    '*.bak',
    '',
  ].join('\n');
}

module.exports = { renderConfigYaml, renderStateGitignore, scalar };
