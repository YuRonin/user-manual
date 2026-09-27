'use strict';

/*
 * 目标解析：page:<id> / task:<id> / manual:<manualId> / scenario:<id>。
 *
 * 无前缀时在任务、页面、手册、Scenario 中查找：唯一命中自动解析；多个命中返回 ambiguous-target
 * 并列出候选，不替用户挑一个。
 * manual:<manualId> 对应已发布手册（task-<id> / page-<id>），解析为其任务或页面。
 * scenario:<id> 解析为该 Scenario 所属的任务或页面，并记住 Scenario id。
 */

const { isSafeId } = require('../model/ids');

const PREFIXES = ['page', 'task', 'manual', 'scenario'];

function candidatesFor(name, { tasks, pages, scenarios }) {
  const found = [];
  if (tasks.some((task) => task.id === name)) found.push({ type: 'task', id: name, ref: `task:${name}` });
  if (pages.some((page) => page.id === name)) found.push({ type: 'page', id: name, ref: `page:${name}` });
  const manual = manualSubject(name, { tasks, pages });
  if (manual) found.push({ ...manual, ref: `manual:${name}`, manualId: name });
  const scenario = scenarios.find((item) => item.id === name);
  if (scenario) found.push({ ...scenario.subject, ref: `scenario:${name}`, scenarioId: name });
  return found;
}

function manualSubject(manualId, { tasks, pages }) {
  const match = /^(task|page)-(.+)$/.exec(manualId);
  if (!match) return null;
  const [, type, id] = match;
  const list = type === 'task' ? tasks : pages;
  return list.some((item) => item.id === id) ? { type, id } : null;
}

/**
 * @param {string} raw
 * @param {{ tasks: object[], pages: object[], scenarios: Array<{ id, subject: { type, id } }> }} index
 * @returns {{ ok: true, target } | { ok: false, code, message, candidates? }}
 */
function resolveTarget(raw, index) {
  const context = { tasks: index.tasks || [], pages: index.pages || [], scenarios: index.scenarios || [] };
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, code: 'invalid-target', message: '需要指定目标，例如 task:edit-profile 或 page:dashboard。' };
  const text = raw.trim();
  const colon = text.indexOf(':');
  if (colon > 0 && PREFIXES.includes(text.slice(0, colon))) {
    const prefix = text.slice(0, colon);
    const name = text.slice(colon + 1);
    if (!isSafeId(name)) return { ok: false, code: 'invalid-target', message: `目标 id 非法: ${name}` };
    let subject = null;
    if (prefix === 'task' && context.tasks.some((task) => task.id === name)) subject = { type: 'task', id: name };
    if (prefix === 'page' && context.pages.some((page) => page.id === name)) subject = { type: 'page', id: name };
    if (prefix === 'manual') subject = manualSubject(name, context) && { ...manualSubject(name, context), manualId: name };
    if (prefix === 'scenario') {
      const scenario = context.scenarios.find((item) => item.id === name);
      subject = scenario ? { ...scenario.subject, scenarioId: name } : null;
    }
    if (!subject) return { ok: false, code: 'unknown-target', message: `找不到目标 ${text}。` };
    return { ok: true, target: { ...subject, ref: text } };
  }
  if (!isSafeId(text)) return { ok: false, code: 'invalid-target', message: `目标需要是 id 或 <page|task|manual|scenario>:<id>，收到: ${text}` };
  const found = candidatesFor(text, context);
  // 同一实体的多种叫法（task:x 与 manual:task-x）不算歧义。
  const distinct = [...new Map(found.map((item) => [`${item.type}:${item.id}`, item])).values()];
  if (distinct.length === 0) return { ok: false, code: 'unknown-target', message: `找不到目标 ${text}。` };
  if (distinct.length > 1) {
    return {
      ok: false,
      code: 'ambiguous-target',
      message: `目标 ${text} 对应多个对象，请用前缀指明: ${distinct.map((item) => `${item.type}:${item.id}`).join('、')}`,
      candidates: distinct.map((item) => `${item.type}:${item.id}`),
    };
  }
  const { ref: _ref, ...subject } = distinct[0];
  return { ok: true, target: { ...subject, ref: `${subject.type}:${subject.id}` } };
}

module.exports = { PREFIXES, resolveTarget };
