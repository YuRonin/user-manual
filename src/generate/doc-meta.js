'use strict';

/*
 * docs/manual/meta.json：每篇已发布手册的「最后更新时间」与「相关文章」，供帮助中心等下游只读消费。
 *
 *   { "version": 1, "docs": { "tasks/x.md": { "updatedAt": "<ISO>", "related": [ { "target", "title", "reason" } ] } } }
 *
 * - 键与 target 都是相对 docs.outputDir 的 posix 路径（与 index.md 目录里的链接一致）；只含已发布文档。
 * - updatedAt 取当前发布记录的 createdAt。
 * - related 按理由强度排序，去掉自身、去重保留最强理由，每篇最多 5 条；同强度按目录顺序、再按路径。
 * - 整文件确定性输出：同样的发布状态得到逐字节相同的文件。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../util/atomic-write');
const { collectEntries, groupEntries } = require('./handbook');

const META_VERSION = 1;
const MAX_RELATED = 5;
// 理由强度从高到低；数组下标即强度排名。
const REASONS = ['explicit', 'guide-link', 'entry-page', 'shared-page', 'same-group'];
const RANK = Object.fromEntries(REASONS.map((reason, index) => [reason, index]));

// 路由比较只看路径部分：去掉查询串、锚点与尾部斜杠。
function normalizeRoute(route) {
  if (typeof route !== 'string' || !route) return null;
  const bare = route.split(/[?#]/)[0].replace(/\/+$/, '');
  return bare || '/';
}

/** 计算 meta.json 对象（不写盘）。 */
function buildDocMeta({ projectRoot, config }) {
  const entries = collectEntries(projectRoot, config);
  const { sections } = groupEntries(entries, config.docs.catalog || null);
  const byId = new Map(entries.map((e) => [e.id, e]));
  // 目录顺序：与 index.md 一致（配置分组 → 兜底分组，或默认两组）。
  const order = new Map(sections.flatMap(([, rows]) => rows).map((e, index) => [e.id, index]));

  const relations = new Map(entries.map((e) => [e.id, new Map()]));
  const add = (from, to, reason) => {
    if (from === to || !byId.has(from) || !byId.has(to)) return; // 自身与未发布目标直接丢弃
    const links = relations.get(from);
    const prior = links.get(to);
    if (prior === undefined || RANK[reason] < RANK[prior]) links.set(to, reason);
  };
  const both = (a, b, reason) => { add(a, b, reason); add(b, a, reason); };

  const pages = entries.filter((e) => e.kind === 'page');
  const tasks = entries.filter((e) => e.kind === 'task');
  const pageByRoute = new Map();
  for (const page of pages) {
    const route = normalizeRoute(page.pack.route);
    if (route && !pageByRoute.has(route)) pageByRoute.set(route, page.id);
  }

  for (const task of tasks) {
    const pack = task.pack;
    // explicit：任务自己声明的相关任务（单向）。
    const explicitIds = [...(pack.relatedTasks || []), ...(pack.related || []).map((r) => r?.id)];
    for (const id of explicitIds) if (typeof id === 'string' && id) add(task.id, `task-${id}`, 'explicit');
    // entry-page：任务入口路由 = 某页面路由（双向）。
    const entryPage = pageByRoute.get(normalizeRoute(pack.entry?.route));
    if (entryPage) both(task.id, entryPage, 'entry-page');
    // shared-page：任务步骤经过的页面（双向）。
    for (const step of pack.steps || []) if (step?.pageId) both(task.id, `page-${step.pageId}`, 'shared-page');
  }
  // guide-link：页面指南引用的任务（双向）。
  for (const page of pages) {
    for (const item of page.pack.guide || []) if (item?.taskId) both(page.id, `task-${item.taskId}`, 'guide-link');
  }
  // same-group：同一目录分组（双向，组内两两）。
  for (const [, rows] of sections) {
    for (const a of rows) for (const b of rows) add(a.id, b.id, 'same-group');
  }

  const docs = {};
  for (const entry of [...entries].sort((a, b) => (a.href < b.href ? -1 : a.href > b.href ? 1 : 0))) {
    const related = [...relations.get(entry.id)]
      .map(([id, reason]) => ({ target: byId.get(id), reason }))
      .sort((a, b) => RANK[a.reason] - RANK[b.reason]
        || (order.get(a.target.id) ?? Infinity) - (order.get(b.target.id) ?? Infinity)
        || (a.target.href < b.target.href ? -1 : a.target.href > b.target.href ? 1 : 0))
      .slice(0, MAX_RELATED)
      .map(({ target, reason }) => ({ target: target.href, title: target.title, reason }));
    docs[entry.href] = { updatedAt: entry.createdAt, related };
  }
  return { version: META_VERSION, docs };
}

/** 重算并原子写入 <docs.outputDir>/meta.json。 */
function updateDocMeta({ projectRoot, config }) {
  const meta = buildDocMeta({ projectRoot, config });
  const file = path.join(projectRoot, config.docs.outputDir, 'meta.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(meta, null, 2)}\n`);
  return { file, updated: true, docs: Object.keys(meta.docs).length };
}

module.exports = { buildDocMeta, updateDocMeta, REASONS, MAX_RELATED };
