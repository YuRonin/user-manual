'use strict';

/*
 * `site:` 配置段：`manual site` 把已发布手册渲染成静态帮助中心时使用。
 * 整段可选；缺省值即可直接构建，输出落在 .manual/site/（已被 .manual/.gitignore 忽略）。
 *
 * 校验是 fail-closed 的：颜色只接受十六进制（写进 CSS 变量，防止样式注入），
 * URL 只接受 http(s) 或站内绝对路径，输出目录必须在项目内且不能与手册目录重叠
 * （构建会清理自己生成过的文件，重叠会删到手册源）。
 */

const path = require('path');

const DEFAULT_THEME = {
  primary: '#2f5bd3',
  text: '#1f2933',
  muted: '#5f6b7a',
  background: '#f7f8fa',
  surface: '#ffffff',
  border: '#e3e7ee',
  soft: '#f1f5fb',
};

const DEFAULT_LABELS = {
  completion: '完成后你会看到',
  backToIndex: '返回帮助中心',
  backToApp: '返回应用',
};

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;
const posix = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '');

function isProjectRelative(value) {
  const v = posix(value);
  return v !== '' && v !== '.' && !path.isAbsolute(v) && !/^[A-Za-z]:/.test(v) && !v.split('/').includes('..');
}

function overlaps(a, b) {
  const x = posix(a) + '/';
  const y = posix(b) + '/';
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * @param {object|undefined} raw  config.yaml 里的 site 段
 * @param {{stateDir:string, docsOutputDir:string, language:string, audience:string}} context
 */
function resolveSiteConfig(raw, context) {
  const input = raw || {};
  if (typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['site 需要是对象。'] };
  const errors = [];
  const str = (field, value) => {
    if (value !== undefined && value !== null && typeof value !== 'string') errors.push(`site.${field} 需要是字符串。`);
  };

  const site = {
    outputDir: input.outputDir ?? `${context.stateDir}/site`,
    title: input.title ?? '帮助中心',
    description: input.description ?? '',
    language: input.language ?? context.language,
    homeUrl: input.homeUrl ?? null,
    appBaseUrl: input.appBaseUrl ?? null,
    // 手册仅供内部时默认不让搜索引擎收录
    noindex: input.noindex ?? context.audience !== 'public',
    webpQuality: input.webpQuality ?? 82,
    theme: { ...DEFAULT_THEME, ...(input.theme || {}) },
    labels: { ...DEFAULT_LABELS, ...(input.labels || {}) },
    support: {
      title: input.support?.title ?? '没找到答案？',
      description: input.support?.description ?? '',
      items: input.support?.items ?? [],
    },
  };

  for (const field of ['outputDir', 'title', 'description', 'language']) str(field, site[field]);
  if (typeof site.outputDir === 'string') {
    if (!isProjectRelative(site.outputDir)) errors.push(`site.outputDir 需要是项目内的相对路径，收到: ${site.outputDir}`);
    else if (overlaps(site.outputDir, context.docsOutputDir)) errors.push(`site.outputDir 不能与手册目录 ${context.docsOutputDir} 重叠（构建会清理旧产物）。`);
  }
  if (site.homeUrl !== null && !(typeof site.homeUrl === 'string' && /^(https?:\/\/|\/)/i.test(site.homeUrl) && !site.homeUrl.startsWith('//'))) {
    errors.push(`site.homeUrl 需要是 http(s) 地址或站内绝对路径，收到: ${site.homeUrl}`);
  }
  if (site.appBaseUrl !== null && !(typeof site.appBaseUrl === 'string' && /^https?:\/\//i.test(site.appBaseUrl))) {
    errors.push(`site.appBaseUrl 需要是 http(s) 地址，收到: ${site.appBaseUrl}`);
  }
  if (typeof site.noindex !== 'boolean') errors.push('site.noindex 需要是布尔值。');
  if (!Number.isInteger(site.webpQuality) || site.webpQuality < 1 || site.webpQuality > 100) {
    errors.push(`site.webpQuality 需要是 1-100 的整数，收到: ${site.webpQuality}`);
  }
  for (const [key, value] of Object.entries(site.theme)) {
    if (!(key in DEFAULT_THEME)) errors.push(`site.theme.${key} 不是可配置的颜色（可用：${Object.keys(DEFAULT_THEME).join('、')}）。`);
    else if (typeof value !== 'string' || !HEX_RE.test(value)) errors.push(`site.theme.${key} 需要是十六进制颜色（如 #213271），收到: ${value}`);
  }
  for (const [key, value] of Object.entries(site.labels)) {
    if (typeof value !== 'string' || !value.trim()) errors.push(`site.labels.${key} 需要是非空字符串。`);
  }
  str('support.title', site.support.title);
  str('support.description', site.support.description);
  if (!Array.isArray(site.support.items)) errors.push('site.support.items 需要是数组。');
  else site.support.items.forEach((item, index) => {
    const at = `site.support.items[${index}]`;
    if (!item || typeof item.title !== 'string' || !item.title.trim()) errors.push(`${at}.title 必填。`);
    if (item?.description !== undefined && typeof item.description !== 'string') errors.push(`${at}.description 需要是字符串。`);
    if (item?.image !== undefined && !(typeof item.image === 'string' && isProjectRelative(item.image))) {
      errors.push(`${at}.image 需要是项目内的相对路径。`);
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true, config: site };
}

module.exports = { resolveSiteConfig, DEFAULT_THEME, DEFAULT_LABELS };
