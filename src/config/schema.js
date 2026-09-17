'use strict';

/*
 * 配置 schema：默认值、校验、以及最终 config 对象的组装。
 *
 * 这里只产出普通 JS 对象；序列化成带注释的 YAML 是 render.js 的事。
 * 校验一次性收集所有错误再返回，避免用户改一个跑一次。
 */

const path = require('path');
const profiles = require('./profiles');
const providers = require('./providers');
const { DEFAULT_ANNOTATION } = require('./annotation');

/**
 * 配置结构版本。
 * 只有在「旧配置无法被新代码直接读懂」时才 +1，并同步提供迁移逻辑。
 * 纯新增字段（加 profile、加 provider、加可选键）不需要动这个号。
 */
const CONFIG_VERSION = 1;

const DEFAULTS = {
  baseUrl: 'http://localhost:5173',
  profileId: profiles.DEFAULT_PROFILE_ID,
  providerId: providers.DEFAULT_PROVIDER_ID,
  language: 'zh-CN',
  docsDir: 'docs/manual',
  stateDir: '.manual',
  screenshotFormat: 'png',
};

/** 常见文档语言，仅用于 CLI 提示，不构成白名单（其它 BCP-47 标签同样接受）。 */
const COMMON_LANGUAGES = ['zh-CN', 'zh-TW', 'en-US', 'ja-JP'];

const LANGUAGE_RE = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{2,8})*$/;
// 项目名进文件名和 YAML 标量，限制成安全字符集
const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------- 单项校验

function validateBaseUrl(raw, errors) {
  if (raw == null || raw === '') {
    errors.push('缺少 --base-url：项目的访问地址，例如 http://localhost:5173');
    return null;
  }
  let url;
  try {
    url = new URL(String(raw));
  } catch (_) {
    errors.push(`--base-url 不是合法 URL: ${raw}`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    errors.push(`--base-url 只支持 http/https，收到: ${url.protocol.replace(':', '')}`);
    return null;
  }
  // 去掉末尾斜杠，后续拼路径时统一由调用方加 '/'
  return url.href.replace(/\/$/, '');
}

/** 解析 "1440x900" → { width, height }，越界或格式错时记错并返回 null。 */
function parseViewport(raw, errors) {
  if (raw == null || raw === '') {
    errors.push('自定义截图规格需要 --viewport <宽x高>，例如 --viewport 1600x1000');
    return null;
  }
  const m = /^(\d+)\s*[xX*×]\s*(\d+)$/.exec(String(raw).trim());
  if (!m) {
    errors.push(`--viewport 格式应为 <宽>x<高>，例如 1600x1000，收到: ${raw}`);
    return null;
  }
  const width = Number(m[1]);
  const height = Number(m[2]);
  const { width: wl, height: hl } = profiles.VIEWPORT_LIMITS;
  let ok = true;
  if (width < wl.min || width > wl.max) {
    errors.push(`--viewport 宽度需在 ${wl.min}-${wl.max} 之间，收到: ${width}`);
    ok = false;
  }
  if (height < hl.min || height > hl.max) {
    errors.push(`--viewport 高度需在 ${hl.min}-${hl.max} 之间，收到: ${height}`);
    ok = false;
  }
  return ok ? { width, height } : null;
}

function parseDpr(raw, errors) {
  if (raw == null || raw === '') {
    errors.push('自定义截图规格需要 --dpr <倍数>，例如 --dpr 2');
    return null;
  }
  const dpr = Number(raw);
  if (!Number.isFinite(dpr)) {
    errors.push(`--dpr 需要是数字，收到: ${raw}`);
    return null;
  }
  const { min, max } = profiles.DPR_LIMITS;
  if (dpr < min || dpr > max) {
    errors.push(`--dpr 需在 ${min}-${max} 之间，收到: ${dpr}`);
    return null;
  }
  return dpr;
}

/**
 * 校验文档输出目录：必须是项目根内部的相对路径。
 * 挡住绝对路径、`../` 逃逸，以及写进 node_modules / .git / .manual 这类不该放文档的地方。
 * 返回统一用 '/' 分隔的相对路径（写进 YAML 要跨平台可读）。
 */
function validateDocsDir(raw, errors) {
  const value = String(raw == null || raw === '' ? DEFAULTS.docsDir : raw).trim();
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    errors.push(`--docs-dir 需要是相对项目根的路径，不能是绝对路径: ${value}`);
    return null;
  }
  const normalized = path.normalize(value).replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === '' || normalized === '.') {
    errors.push('--docs-dir 不能是项目根目录本身，请指定子目录，例如 docs/manual');
    return null;
  }
  if (normalized === '..' || normalized.startsWith('../')) {
    errors.push(`--docs-dir 不能超出项目根目录: ${value}`);
    return null;
  }
  const firstSegment = normalized.split('/')[0];
  const reserved = ['node_modules', '.git', DEFAULTS.stateDir];
  if (reserved.includes(firstSegment)) {
    errors.push(`--docs-dir 不能放在 ${firstSegment}/ 里，请换一个目录，例如 docs/manual`);
    return null;
  }
  return normalized;
}

function validateLanguage(raw, errors) {
  const value = String(raw == null || raw === '' ? DEFAULTS.language : raw).trim();
  if (!LANGUAGE_RE.test(value)) {
    errors.push(`--lang 需要是语言标签，例如 zh-CN / en-US，收到: ${value}`);
    return null;
  }
  return value;
}

function validateProjectName(raw, projectRoot, errors) {
  const fallback = path.basename(path.resolve(projectRoot)) || 'web-project';
  const value = String(raw == null || raw === '' ? fallback : raw).trim();
  if (!PROJECT_NAME_RE.test(value)) {
    errors.push(`--name 只允许字母/数字/点/下划线/连字符且以字母数字开头，收到: ${value}`);
    return null;
  }
  return value;
}

/** 解析截图规格：预设走注册表，custom 需要 --viewport + --dpr。 */
function resolveProfile({ profileId, viewport, dpr }, errors) {
  const id = String(profileId == null || profileId === '' ? DEFAULTS.profileId : profileId).trim();

  if (id === profiles.CUSTOM_PROFILE_ID) {
    const size = parseViewport(viewport, errors);
    const scale = parseDpr(dpr, errors);
    if (!size || scale == null) return null;
    return {
      id,
      profile: profiles.buildCustomProfile({
        width: size.width,
        height: size.height,
        deviceScaleFactor: scale,
      }),
    };
  }

  const preset = profiles.getPreset(id);
  if (!preset) {
    errors.push(
      `未知的截图规格 --profile ${id}，可选: ${profiles.presetIds().join(', ')}, ${profiles.CUSTOM_PROFILE_ID}`
    );
    return null;
  }
  // 预设已经定死尺寸，此时再给 --viewport/--dpr 属于矛盾输入，明确拒绝而不是静默忽略
  if (viewport != null && viewport !== '') {
    errors.push(`--viewport 只在 --profile ${profiles.CUSTOM_PROFILE_ID} 时有效（当前 --profile ${id}）`);
  }
  if (dpr != null && dpr !== '') {
    errors.push(`--dpr 只在 --profile ${profiles.CUSTOM_PROFILE_ID} 时有效（当前 --profile ${id}）`);
  }
  return { id, profile: preset };
}

function resolveProvider(providerId, errors) {
  const id = String(providerId == null || providerId === '' ? DEFAULTS.providerId : providerId).trim();
  const provider = providers.getProvider(id);
  if (!provider) {
    errors.push(`未知的 Browser Provider --provider ${id}，可选: ${providers.providerIds().join(', ')}`);
    return null;
  }
  return { id, provider };
}

// ---------------------------------------------------------------- 组装

/**
 * 校验输入并组装完整 config 对象。
 * @returns {{ ok: true, config: object, summary: object } | { ok: false, errors: string[] }}
 */
function buildConfig(input) {
  const errors = [];
  const projectRoot = input.projectRoot || process.cwd();

  const baseUrl = validateBaseUrl(input.baseUrl, errors);
  const name = validateProjectName(input.name, projectRoot, errors);
  const language = validateLanguage(input.language, errors);
  const docsDir = validateDocsDir(input.docsDir, errors);
  const resolvedProfile = resolveProfile(
    { profileId: input.profileId, viewport: input.viewport, dpr: input.dpr },
    errors
  );
  const resolvedProvider = resolveProvider(input.providerId, errors);

  if (errors.length > 0) return { ok: false, errors };

  const stateDir = DEFAULTS.stateDir;

  // 预设全部落进 profiles，用户改 activeProfile 就能切换，不必重跑 init
  const profileMap = {};
  for (const id of profiles.presetIds()) profileMap[id] = profiles.getPreset(id);
  profileMap[resolvedProfile.id] = resolvedProfile.profile;

  const providerMap = {};
  for (const id of providers.providerIds()) providerMap[id] = providers.getProvider(id);

  const config = {
    version: CONFIG_VERSION,
    project: { name, baseUrl },
    capture: { activeProfile: resolvedProfile.id, profiles: profileMap },
    browser: { activeProvider: resolvedProvider.id, providers: providerMap },
    docs: { language, outputDir: docsDir, imagesDir: `${docsDir}/images` },
    // 截图放在文档目录下：手册要引用它们，得跟手册一起入库。
    // 标注功能落地前，raw 就是手册直接引用的图。
    artifacts: {
      stateDir,
      rawDir: `${docsDir}/images/raw`,
      taskRawDir: `${stateDir}/artifacts/raw`,
      sanitizedDir: `${stateDir}/artifacts/sanitized`,
      diagnosticsDir: `${stateDir}/artifacts/diagnostics`,
      manifestsDir: `${stateDir}/artifacts/manifests`,
      annotatedDir: `${docsDir}/images/annotated`,
      format: DEFAULTS.screenshotFormat,
    },
    annotation: JSON.parse(JSON.stringify(DEFAULT_ANNOTATION)),
    // 页面清单不在 config 里——它是 `manual inspect` 的扫描产出，落在 project.yaml / pages/。
    // 这里只放扫描选项。
    inspect: { exclude: [] },
  };

  return {
    ok: true,
    config,
    summary: {
      projectName: name,
      baseUrl,
      activeProfile: resolvedProfile.id,
      viewport: resolvedProfile.profile.viewport,
      deviceScaleFactor: resolvedProfile.profile.deviceScaleFactor,
      activeProvider: resolvedProvider.id,
      providerType: resolvedProvider.provider.type,
      headless: resolvedProvider.provider.headless,
      language,
      docsDir,
    },
  };
}

module.exports = {
  CONFIG_VERSION,
  DEFAULTS,
  COMMON_LANGUAGES,
  buildConfig,
  // 导出供测试直接打点
  validateBaseUrl,
  validateDocsDir,
  parseViewport,
  parseDpr,
};
