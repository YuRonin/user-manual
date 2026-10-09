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

const {
  DEFAULTS, deriveCacheKey, AUDIENCES, validateBaseUrl, validateDocsDir, validateLanguage, runtimeDefaults,
} = require('./schema');
const profiles = require('./profiles');
const { checkSchemaVersion, isProjectRelativePath } = require('../model/schema');
const { isUuid } = require('../model/ids');

const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const { resolveAnnotationConfig } = require('./annotation');
const { resolveSiteConfig } = require('./site');
const { resolveCatalogConfig } = require('./catalog');

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
  } else {
    const version = checkSchemaVersion('config', raw);
    if (!version.ok) errors.push(`${version.code}: ${version.message}`);
  }

  validateProjectBlock(raw.project, errors, warnings);
  validateCaptureBlock(raw.capture, errors);

  const activeProvider = raw.browser?.activeProvider;
  if (!activeProvider) {
    errors.push('配置缺少 browser.activeProvider。');
  } else if (!raw.browser?.providers?.[activeProvider]) {
    errors.push(`browser.activeProvider 指向了不存在的 Provider: ${activeProvider}`);
  }

  validatePathsBlock(raw, errors);

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
      rawDir: `${DEFAULTS.stateDir}/artifacts/raw/pages`,
      annotatedDir: `${raw.docs?.outputDir || DEFAULTS.docsDir}/images/annotated`,
      taskRawDir: `${DEFAULTS.stateDir}/artifacts/raw`,
      sanitizedDir: `${DEFAULTS.stateDir}/artifacts/sanitized`,
      diagnosticsDir: `${DEFAULTS.stateDir}/artifacts/diagnostics`,
      manifestsDir: `${DEFAULTS.stateDir}/artifacts/manifests`,
      ...(raw.artifacts || {}),
    },
    inspect: { exclude: [], ...(raw.inspect || {}) },
    privacy: {
      audience: 'public',
      redaction: 'balanced',
      maskStyle: 'neutral-mosaic',
      rules: { redact: [], preserve: [], ...(raw.privacy?.rules || {}) },
      ...(raw.privacy || {}),
    },
    auth: {
      enabled: true,
      cacheKey: deriveCacheKey(raw.project.name, raw.project.baseUrl),
      activeProfile: 'default',
      loginUrl: '/login',
      verifyPath: null,
      identityAssertions: [],
      capabilities: ['cookies', 'localStorage'],
      ...(raw.auth || {}),
    },
  };

  const defaults = runtimeDefaults();
  config.runtime = { ...(raw.runtime || {}), budget: { ...defaults.budget, ...(raw.runtime?.budget || {}) } };
  config.cache = { ...defaults.cache, ...(raw.cache || {}) };
  for (const [field, value] of [...Object.entries(config.runtime.budget).map(([k, v]) => [`runtime.budget.${k}`, v]), ...Object.entries(config.cache).map(([k, v]) => [`cache.${k}`, v])]) {
    if (!Number.isInteger(value) || value <= 0) return { ok: false, errors: [`${field} 需要是正整数，收到: ${value}`] };
  }

  // 在线验证的漂移比较（P3-04）：阈值、容差与动态区域（只用于视觉比较，不能跳过断言）
  const visual = raw.verify?.visual || {};
  config.verify = {
    ...(raw.verify || {}),
    visual: { threshold: 0.002, tolerance: 24, dynamicRegions: [], ...visual },
  };
  const v = config.verify.visual;
  if (typeof v.threshold !== 'number' || !(v.threshold >= 0 && v.threshold < 1)) return { ok: false, errors: [`verify.visual.threshold 需要是 [0, 1) 之间的数字，收到: ${v.threshold}`] };
  if (!Number.isInteger(v.tolerance) || v.tolerance < 0 || v.tolerance > 255) return { ok: false, errors: [`verify.visual.tolerance 需要是 0-255 的整数，收到: ${v.tolerance}`] };
  if (!Array.isArray(v.dynamicRegions) || v.dynamicRegions.some((r) => !r || typeof r.selector !== 'string' || !r.selector.trim())) {
    return { ok: false, errors: ['verify.visual.dynamicRegions 需要是 [{ id, selector }] 数组（selector 必填）。'] };
  }

  // 产物保留（P3-08）：天数为正整数；固定的 Capture 为 UUID 列表
  if (raw.retention !== undefined) {
    const { DEFAULT_RETENTION } = require('../store/retention');
    config.retention = { ...DEFAULT_RETENTION, ...raw.retention };
    for (const field of ['stagingDays', 'diagnosticsDays', 'runLogDays', 'rawDays', 'unreferencedCaptureDays']) {
      if (!Number.isInteger(config.retention[field]) || config.retention[field] <= 0) return { ok: false, errors: [`retention.${field} 需要是正整数，收到: ${config.retention[field]}`] };
    }
    const { isUuid } = require('../model/ids');
    if (!Array.isArray(config.retention.pinnedCaptures) || config.retention.pinnedCaptures.some((id) => !isUuid(id))) {
      return { ok: false, errors: ['retention.pinnedCaptures 需要是 Capture id（UUID）数组。'] };
    }
  }

  config.privacy.rules = {
    redact: [],
    preserve: [],
    ...(raw.privacy?.rules || {}),
  };

  // 旧版默认把页面原图放进文档目录：仍可读取，但发布时会被阻止，这里提前提示迁移。
  const docsPrefix = String(config.docs.outputDir || DEFAULTS.docsDir).replace(/\\/g, '/').replace(/\/$/, '') + '/';
  if (String(config.artifacts.rawDir).replace(/\\/g, '/').startsWith(docsPrefix)) {
    warnings.push(
      `legacy-raw-reference: artifacts.rawDir (${config.artifacts.rawDir}) 位于文档目录内，其中的原图不能发布。` +
      ` 改为 ${DEFAULTS.stateDir}/artifacts/raw/pages 后重新 \`manual capture\`；可用 \`manual migrate-artifacts\` 查看旧原图。`
    );
  }

  const annotation = resolveAnnotationConfig(raw.annotation);
  if (!annotation.ok) return { ok: false, errors: annotation.errors };
  config.annotation = annotation.config;

  // index.md 目录分组（docs.catalog）：整段可选，不配置时沿用默认两组
  const catalog = resolveCatalogConfig(raw.docs?.catalog);
  if (!catalog.ok) return { ok: false, errors: catalog.errors };
  config.docs.catalog = catalog.config;

  // 帮助中心静态站（manual site）：整段可选，缺省值即可构建
  const site = resolveSiteConfig(raw.site, {
    stateDir: config.artifacts.stateDir,
    docsOutputDir: config.docs.outputDir || DEFAULTS.docsDir,
    language: config.docs.language,
    audience: config.privacy.audience,
  });
  if (!site.ok) return { ok: false, errors: site.errors };
  config.site = site.config;

  if (!Array.isArray(config.inspect.exclude)) {
    return { ok: false, errors: ['inspect.exclude 需要是数组。'] };
  }
  if (!AUDIENCES.includes(config.privacy.audience)) {
    return { ok: false, errors: ['privacy.audience 需要是 public 或 internal。'] };
  }
  if (!Array.isArray(config.privacy.rules.redact) || !Array.isArray(config.privacy.rules.preserve)) {
    return { ok: false, errors: ['privacy.rules.redact/preserve 需要是数组。'] };
  }
  const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  if (!safeName.test(String(config.auth.cacheKey)) || !safeName.test(String(config.auth.activeProfile))) {
    return { ok: false, errors: ['auth.cacheKey 与 auth.activeProfile 只能使用安全名称字符。'] };
  }

  return { ok: true, config, configPath, warnings };
}

// ---------------------------------------------------------------- 与 init 共用的完整校验

function validateProjectBlock(project, errors, warnings) {
  if (!project?.baseUrl) errors.push('配置缺少 project.baseUrl。');
  else validateBaseUrl(project.baseUrl, errors);
  if (!project?.name) errors.push('配置缺少 project.name。');
  else if (!PROJECT_NAME_RE.test(String(project.name))) errors.push(`project.name 只允许字母/数字/点/下划线/连字符: ${project.name}`);
  if (project?.id != null && !isUuid(project.id)) errors.push(`project.id 需要是 UUID，收到: ${project.id}`);
  // 旧配置没有项目身份：只读兼容，不在读取时写回；迁移或 init --force 时补上。
  if (project && project.id == null) warnings.push('project-id-missing: 配置还没有 project.id，运行 `manual migrate` 或 `manual init --force` 补上稳定项目身份。');
}

function validateCaptureBlock(capture, errors) {
  const activeProfile = capture?.activeProfile;
  if (!activeProfile) { errors.push('配置缺少 capture.activeProfile。'); return; }
  const profile = capture?.profiles?.[activeProfile];
  if (!profile) { errors.push(`capture.activeProfile 指向了不存在的规格: ${activeProfile}`); return; }
  const { width, height } = profile.viewport || {};
  const limits = profiles.VIEWPORT_LIMITS;
  if (!Number.isInteger(width) || width < limits.width.min || width > limits.width.max) {
    errors.push(`capture.profiles.${activeProfile}.viewport.width 需在 ${limits.width.min}-${limits.width.max} 之间，收到: ${width}`);
  }
  if (!Number.isInteger(height) || height < limits.height.min || height > limits.height.max) {
    errors.push(`capture.profiles.${activeProfile}.viewport.height 需在 ${limits.height.min}-${limits.height.max} 之间，收到: ${height}`);
  }
  const dpr = profile.deviceScaleFactor;
  if (!Number.isFinite(dpr) || dpr < profiles.DPR_LIMITS.min || dpr > profiles.DPR_LIMITS.max) {
    errors.push(`capture.profiles.${activeProfile}.deviceScaleFactor 需在 ${profiles.DPR_LIMITS.min}-${profiles.DPR_LIMITS.max} 之间，收到: ${dpr}`);
  }
}

/** 所有写入目录都必须落在业务项目根内：文档目录沿用 init 的规则，产物目录至少是根相对路径。 */
function validatePathsBlock(raw, errors) {
  if (raw.docs?.outputDir !== undefined) validateDocsDir(raw.docs.outputDir, errors);
  if (raw.docs?.language !== undefined) validateLanguage(raw.docs.language, errors);
  const dirs = {
    'docs.imagesDir': raw.docs?.imagesDir,
    ...Object.fromEntries(Object.entries(raw.artifacts || {}).filter(([key]) => /Dir$/.test(key)).map(([key, value]) => [`artifacts.${key}`, value])),
  };
  for (const [field, value] of Object.entries(dirs)) {
    if (value === undefined) continue;
    if (!isProjectRelativePath(String(value))) errors.push(`${field} 需要是项目根内的相对路径，收到: ${value}`);
  }
}

module.exports = { loadConfig, configPathFor, CONFIG_RELATIVE };
