'use strict';

/*
 * `docs.catalog` 配置段：自定义 index.md 目录（manual:catalog 区块）的分组。
 * 整段可选；不配置时目录保持默认的「操作指南 / 功能介绍」两组。
 *
 *   docs:
 *     catalog:
 *       fallbackTitle: 更多          # 未被任何分组引用的已发布手册落到这一组
 *       groups:
 *         - title: 快速开始
 *           entries: [page-login, task-reset-password]
 *
 * entries 填的是 manualId（.manual/releases/ 下的目录名，page-<id> / task-<id>），不是发布记录 UUID。
 * 这里只校验形状；条目是否已发布要看发布状态，由 updateHandbook 告警、manual doctor 检查。
 */

const MANUAL_ID_RE = /^(page|task)-[a-z0-9-]+$/;
const DEFAULT_FALLBACK_TITLE = '更多';

const isTitle = (value) => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value);

/**
 * @param {object|undefined|null} raw  config.yaml 里的 docs.catalog
 * @returns {{ok:true, config:null|{groups:{title:string,entries:string[]}[], fallbackTitle:string}} | {ok:false, errors:string[]}}
 */
function resolveCatalogConfig(raw) {
  if (raw === undefined || raw === null) return { ok: true, config: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['docs.catalog 需要是对象。'] };

  const errors = [];
  const fallbackTitle = raw.fallbackTitle ?? DEFAULT_FALLBACK_TITLE;
  if (!isTitle(fallbackTitle)) errors.push('docs.catalog.fallbackTitle 需要是单行非空字符串。');
  if (!Array.isArray(raw.groups) || raw.groups.length === 0) {
    errors.push('docs.catalog.groups 需要是非空数组。');
    return { ok: false, errors };
  }

  const seen = new Map();
  const groups = raw.groups.map((group, index) => {
    const at = `docs.catalog.groups[${index}]`;
    if (!group || typeof group !== 'object' || Array.isArray(group)) {
      errors.push(`${at} 需要是对象。`);
      return null;
    }
    if (!isTitle(group.title)) errors.push(`${at}.title 需要是单行非空字符串。`);
    else if (group.title.trim() === String(fallbackTitle).trim()) errors.push(`${at}.title 不能与 fallbackTitle「${fallbackTitle}」同名。`);
    if (!Array.isArray(group.entries) || group.entries.length === 0) {
      errors.push(`${at}.entries 需要是非空数组。`);
      return null;
    }
    for (const entry of group.entries) {
      if (typeof entry !== 'string' || !MANUAL_ID_RE.test(entry)) {
        errors.push(`${at}.entries 中「${entry}」不是手册 id（应为 page-<id> 或 task-<id>）。`);
      } else if (seen.has(entry)) {
        errors.push(`${at}.entries 中「${entry}」已出现在 ${seen.get(entry)}，同一篇手册只能属于一个分组。`);
      } else {
        seen.set(entry, at);
      }
    }
    return { title: String(group.title).trim(), entries: [...group.entries] };
  });

  return errors.length ? { ok: false, errors } : { ok: true, config: { groups, fallbackTitle: String(fallbackTitle).trim() } };
}

module.exports = { resolveCatalogConfig, MANUAL_ID_RE, DEFAULT_FALLBACK_TITLE };
