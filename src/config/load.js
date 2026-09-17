'use strict';

/*
 * 读取 .manual/config.yaml。
 *
 * 容忍老配置：V0.1 的 config 里有 `pages: []`，V0.2 起页面模型迁到了 project.yaml。
 * 缺少 `inspect` 时按默认值补齐——这正是 ARCHITECTURE.md 里写的演进规则：
 * 新增字段一律可选，缺省行为与旧配置一致，不需要动 version。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { CONFIG_VERSION, DEFAULTS } = require('./schema');
const { resolveAnnotationConfig } = require('./annotation');

const CONFIG_RELATIVE = path.join(DEFAULTS.stateDir, 'config.yaml');

/** 配置文件的绝对路径。 */
function configPathFor(projectRoot) {
  return path.join(projectRoot, CONFIG_RELATIVE);
}

/**
 * 读取并做基本校验。
 * @returns {{ ok: true, config, configPath, warnings: string[] } | { ok: false, errors: string[] }}
 */
function loadConfig(projectRoot) {
  const configPath = configPathFor(projectRoot);

  if (!fs.existsSync(configPath)) {
    return {
      ok: false,
      errors: [
        `找不到配置: ${CONFIG_RELATIVE.replace(/\\/g, '/')}`,
        '先运行 `manual init` 初始化这个项目。',
      ],
    };
  }

  let raw;
  try {
    raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`配置不是合法 YAML: ${e.message}`] };
  }

  if (!raw || typeof raw !== 'object') {
    return { ok: false, errors: ['配置内容为空或不是对象。'] };
  }

  const errors = [];
  const warnings = [];

  if (raw.version == null) {
    errors.push('配置缺少 version 字段，可能不是 manual init 生成的。');
  } else if (raw.version > CONFIG_VERSION) {
    errors.push(
      `配置版本 ${raw.version} 高于当前工具支持的 ${CONFIG_VERSION}，请升级 manual 工具。`
    );
  }

  if (!raw.project?.baseUrl) errors.push('配置缺少 project.baseUrl。');
  if (!raw.project?.name) errors.push('配置缺少 project.name。');

  const activeProfile = raw.capture?.activeProfile;
  if (!activeProfile) {
    errors.push('配置缺少 capture.activeProfile。');
  } else if (!raw.capture?.profiles?.[activeProfile]) {
    errors.push(`capture.activeProfile 指向了不存在的规格: ${activeProfile}`);
  }

  const activeProvider = raw.browser?.activeProvider;
  if (!activeProvider) {
    errors.push('配置缺少 browser.activeProvider。');
  } else if (!raw.browser?.providers?.[activeProvider]) {
    errors.push(`browser.activeProvider 指向了不存在的 Provider: ${activeProvider}`);
  }

  if (errors.length > 0) {
    errors.push(`（配置文件: ${configPath}）`);
    return { ok: false, errors };
  }

  // V0.1 遗留字段：页面模型已迁走，非空时提醒一次，避免用户以为它还在生效
  if (Array.isArray(raw.pages) && raw.pages.length > 0) {
    warnings.push(
      'config.yaml 里的 `pages` 已废弃（页面模型现在在 project.yaml / pages/），本次扫描忽略它。'
    );
  }

  const config = {
    ...raw,
    docs: { language: DEFAULTS.language, ...(raw.docs || {}) },
    artifacts: {
      stateDir: DEFAULTS.stateDir,
      taskRawDir: `${DEFAULTS.stateDir}/artifacts/raw`,
      sanitizedDir: `${DEFAULTS.stateDir}/artifacts/sanitized`,
      diagnosticsDir: `${DEFAULTS.stateDir}/artifacts/diagnostics`,
      manifestsDir: `${DEFAULTS.stateDir}/artifacts/manifests`,
      ...(raw.artifacts || {}),
    },
    inspect: { exclude: [], ...(raw.inspect || {}) },
  };

  const annotation = resolveAnnotationConfig(raw.annotation);
  if (!annotation.ok) return { ok: false, errors: annotation.errors };
  config.annotation = annotation.config;

  if (!Array.isArray(config.inspect.exclude)) {
    return { ok: false, errors: ['inspect.exclude 需要是数组。'] };
  }

  return { ok: true, config, configPath, warnings };
}

module.exports = { loadConfig, configPathFor, CONFIG_RELATIVE };
