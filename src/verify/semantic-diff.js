'use strict';

/*
 * 语义漂移（P3-04）：比较页面的"可访问结构摘要"，而不是保存整页 DOM。
 *
 * 只保留白名单角色（标题、按钮、链接、对话框、表单控件、标签页、菜单项……）的可访问名称，
 * 丢弃正文段落与控件的值（值里常有个人信息）；名称再经隐私检测把手机号 / 邮箱 / 证件号替换掉。
 * 采集时记入 Capture（semantic），在线验证时重新读取并比较：增加 / 删除的项即内容变化。
 */

const { sha256Hex } = require('../util/hash');

const ROLES = new Set([
  'heading', 'button', 'link', 'dialog', 'alertdialog', 'tab', 'tabpanel', 'menuitem', 'checkbox', 'radio',
  'combobox', 'textbox', 'searchbox', 'switch', 'slider', 'spinbutton', 'navigation', 'banner', 'main', 'form',
  'table', 'columnheader', 'alert', 'status',
]);

// 与 privacy/detector 同类的模式：摘要里绝不保留这些值
const PII = [
  /1[3-9]\d{9}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b\d{15,18}[\dXx]?\b/g,
  /\b(?:\d[ -]?){13,19}\b/g,
];

function redact(text) {
  let out = String(text);
  for (const re of PII) out = out.replace(re, '[redacted]');
  return out;
}

/** 解析 Playwright ariaSnapshot 文本：`- role "name" [attrs]: 内容`。只取角色、名称与 level。 */
function parseAriaSnapshot(text) {
  const items = [];
  for (const line of String(text || '').split('\n')) {
    const match = /^\s*- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)/.exec(line);
    if (!match || !ROLES.has(match[1])) continue;
    const name = match[2] === undefined ? '' : redact(match[2].replace(/\\"/g, '"'));
    const level = /\[level=(\d)\]/.exec(match[3] || '')?.[1];
    items.push({ role: match[1], name, ...(level ? { level: Number(level) } : {}) });
  }
  return items;
}

function keyOf(item) {
  return `${item.role}${item.level ? `/${item.level}` : ''}:${item.name}`;
}

/** 可比较的摘要：条目按出现顺序保留，hash 用于快速判等。 */
function semanticSummary(items) {
  const list = (items || []).map((item) => ({ role: item.role, name: item.name, ...(item.level ? { level: item.level } : {}) }));
  return { version: 1, items: list, hash: `sha256:${sha256Hex(JSON.stringify(list.map(keyOf)))}` };
}

/** 多重集比较：增加 / 删除的条目；只有顺序变化记为 reordered。 */
function compareSemantic(baseline, current) {
  if (!baseline || !Array.isArray(baseline.items)) return { status: 'baseline-missing', added: [], removed: [] };
  if (!current) return { status: 'unavailable', added: [], removed: [] };
  if (baseline.hash && baseline.hash === current.hash) return { status: 'same', added: [], removed: [] };
  const count = (list) => list.reduce((m, item) => m.set(keyOf(item), (m.get(keyOf(item)) || 0) + 1), new Map());
  const a = count(baseline.items);
  const b = count(current.items);
  const added = [];
  const removed = [];
  for (const [key, n] of b) for (let i = (a.get(key) || 0); i < n; i++) added.push(key);
  for (const [key, n] of a) for (let i = (b.get(key) || 0); i < n; i++) removed.push(key);
  if (!added.length && !removed.length) return { status: 'reordered', added, removed };
  return { status: 'changed', added: added.sort(), removed: removed.sort() };
}

module.exports = { ROLES, parseAriaSnapshot, semanticSummary, compareSemantic, redact };
