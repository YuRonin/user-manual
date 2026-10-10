'use strict';

const { createHash } = require('crypto');
const { stepPageId } = require('../tasks/model');

const PRIORITIES = new Set(['required', 'optional', 'skip', 'undecided']);
const key = (value) => String(value || '').trim().toLocaleLowerCase();
const list = (value) => Array.isArray(value) ? value : value ? [value] : [];
const stableId = (scope, value) => `${scope}:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
const sameTarget = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
// 步骤的功能 id：显式 feature_id > 目标与动作一致的已知功能 > 由任务/步骤派生
const stepFeatureId = (task, step, known = []) => step.feature_id
  || known.find((item) => sameTarget(item.target, step.action?.target))?.feature_id
  || `task:${task.id}:${step.id}`;

/** 页面上显式声明、归属这一步的功能：feature_id 指向它，或目标与步骤动作一致。只按 task_ids 不足以归属到某一步。 */
function stepFeatures({ page, task, step }) {
  return (page?.features || []).filter((feature) => (feature.task_ids || []).includes(task.id)
    && (feature.feature_id === step.feature_id || sameTarget(feature.target, step.action?.target)));
}

/** Independent feature inventory. Explicit decisions win over inferred guide and action hints. */
function buildInventory({ page, task = null, scenario = 'default' }) {
  const features = new Map();
  const put = (item) => {
    if (!item.feature_id) throw new Error('feature_id is required');
    if (!PRIORITIES.has(item.priority)) throw new Error(`invalid feature priority: ${item.priority}`);
    const prior = features.get(item.feature_id);
    features.set(item.feature_id, prior
      ? { ...prior, ...item, source: [...new Set([...list(prior.source), ...list(item.source)])], source_refs: [...new Set([...list(prior.source_refs), ...list(item.source_refs)])] }
      : { ...item, source: list(item.source), source_refs: list(item.source_refs) });
  };
  for (const item of page.features || []) put({ feature_id: item.feature_id, label: item.label, priority: item.priority || 'undecided', source: item.source || ['page.features'], source_refs: [`page.features:${item.feature_id}`], task_ids: item.task_ids || [], scenario: item.scenario || scenario, description: item.description || '', explanation_ref: item.explanation_ref || null, target: item.target || null });
  for (const guide of page.guide || []) {
    const match = [...features.values()].find((item) => item.feature_id === guide.feature_id || key(item.label) === key(guide.title));
    const id = match?.feature_id || guide.feature_id || `page:${page.id}:${guide.id}`;
    // 没有显式功能决定时：有 target 的 guide 才要求画出；纯文字说明的 guide 只是提示（optional）
    put({ ...match, feature_id: id, label: match?.label || guide.title, priority: match?.priority || (guide.target ? 'required' : 'optional'), source: ['page.guide'], source_refs: [`page.guide:${guide.id}`], task_ids: [...new Set([...(match?.task_ids || []), ...(guide.taskId ? [guide.taskId] : [])])], scenario: match?.scenario || scenario, description: match?.description || guide.instruction || '', explanation_ref: match?.explanation_ref || `guide.${guide.id}`, target: match?.target || guide.target || null });
  }
  for (const action of page.detectedActions || []) {
    const match = [...features.values()].find((item) => key(item.label) === key(action));
    if (match) put({ ...match, source: ['detectedActions'], source_refs: [`detectedActions:${action}`] });
    else put({ feature_id: stableId(`page:${page.id}:action`, key(action)), label: action, priority: 'undecided', source: ['detectedActions'], source_refs: [`detectedActions:${action}`], task_ids: [], scenario, description: '', target: null });
  }
  if (task) for (const step of task.steps || []) {
    if (stepPageId(step) !== page.id) continue;
    const id = stepFeatureId(task, step, [...features.values()]);
    // 隐式动作目标默认是提示性标注：截"操作后"图时目标可能已消失；显式功能声明的优先级优先
    put({ feature_id: id, label: step.action?.target?.name || step.instruction, priority: features.get(id)?.priority || 'optional', source: ['task.steps'], source_refs: [`task.steps:${task.id}/${step.id}`], task_ids: [task.id], scenario: task.scenarioId || scenario, description: step.instruction || '', explanation_ref: `step.${step.id}`, target: step.action?.target || null });
  }
  return [...features.values()];
}

/** A plan is a separate selection; inventory items do not become annotations automatically. */
function buildPlan({ inventory, page, task = null, step = null, annotations = null }) {
  const byId = new Map(inventory.map((item) => [item.feature_id, item]));
  const out = [];
  if (!task) {
    if (annotations) {
      for (const [index, annotation] of annotations.entries()) {
        const feature = byId.get(annotation.feature_id);
        out.push({ feature_id: annotation.feature_id, priority: feature?.priority || 'optional', label: annotation.label || String(index + 1), target: annotation.target || feature?.target, rect: annotation.rect, scenario: feature?.scenario || 'default' });
      }
    } else {
      // 编号 = guide 下标 + 1（含没有 target 的条目），与正文 guide 小节编号一致（render.js）
      for (const [index, guide] of (page.guide || []).entries()) {
        const feature = inventory.find((item) => item.feature_id === guide.feature_id || key(item.label) === key(guide.title));
        if (feature) out.push({ feature_id: feature.feature_id, priority: feature.priority, label: String(index + 1), target: guide.target || feature.target, scenario: feature.scenario });
      }
    }
  } else if (step?.capture) {
    const declared = step.capture.annotations || [];
    for (const [index, annotation] of declared.entries()) {
      const actionTarget = step.action?.target;
      const isAction = annotation.target === 'action.target' || (actionTarget && JSON.stringify(annotation.target) === JSON.stringify(actionTarget));
      const id = annotation.feature_id || (isAction ? stepFeatureId(task, step, inventory) : `task:${task.id}:${step.id}:annotation:${index}`);
      out.push({ feature_id: id, priority: byId.get(id)?.priority || 'optional', label: annotation.label || String(index + 1), target: annotation.target === 'action.target' ? step.action?.target : annotation.target, rect: annotation.rect, scenario: task.scenarioId || 'default' });
    }
    if (!declared.length && step.action?.target) {
      const id = stepFeatureId(task, step, inventory);
      // 隐式标注用步骤号，与正文步骤编号一致；没有序号时退回 1
      out.push({ feature_id: id, priority: byId.get(id)?.priority || 'optional', label: String(step.number || 1), target: step.action.target, scenario: task.scenarioId || 'default' });
    }
  }
  return out;
}

function verifyCoverage({ inventory = [], plan = [], rendered = [], discovered = inventory }) {
  const failures = [];
  const planned = new Map(plan.map((item) => [item.feature_id, item]));
  const drawn = new Map(rendered.map((item) => [item.feature_id, item]));
  const listed = new Set(inventory.map((item) => item.feature_id));
  const discoveryMissing = discovered.filter((item) => !listed.has(item.feature_id));
  for (const item of discoveryMissing) failures.push({ feature_id: item.feature_id, reason: 'missing-from-inventory' });
  const required = inventory.filter((item) => item.priority === 'required');
  for (const item of required) {
    const id = item.feature_id;
    const selected = planned.get(id);
    const result = drawn.get(id);
    if (!selected) failures.push({ feature_id: id, reason: 'missing-from-plan' });
    else if (!result?.drawn || !result?.outlined || !result?.intersects || !result?.located) failures.push({ feature_id: id, reason: result?.reason || 'not-drawn' });
    if (!String(item.description || '').trim()) failures.push({ feature_id: id, reason: 'description-missing' });
  }
  const passed = required.filter((item) => !failures.some((failure) => failure.feature_id === item.feature_id)).length;
  const pending = inventory.filter((item) => item.priority === 'undecided').map((item) => ({ feature_id: item.feature_id, label: item.label, reason: 'priority-undecided' }));
  const ok = failures.length === 0;
  return { ok, complete: ok && pending.length === 0 && inventory.length > 0,
    discovery: { status: discoveryMissing.length ? 'missing' : !inventory.length ? 'insufficient-evidence' : pending.length ? 'pending-review' : 'complete', checked: discovered.length, missing: discoveryMissing.length },
    required: { total: required.length, verified: passed, percent: required.length ? Math.round(100 * passed / required.length) : 100 }, pending, discoveryMissing, failures };
}

function verifyExplanations(markdown, inventory = []) {
  const failures = [];
  const text = String(markdown || '');
  const visibleText = text.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?```/g, '');
  for (const item of inventory.filter((feature) => feature.priority === 'required')) {
    const ref = item.explanation_ref;
    let explained = false;
    if (ref?.startsWith('guide.')) {
      const start = `<!-- manual:block id=${ref} -->`;
      const at = text.indexOf(start);
      const end = at < 0 ? -1 : text.indexOf('<!-- /manual:block -->', at + start.length);
      explained = end > at && text.slice(at + start.length, end).split(/\r?\n/).some((line) => {
        const value = line.trim();
        return value && !/^#{1,6}\s/.test(value) && !/^!?\[[^\]]+\]\([^)]*\)$/.test(value) && !/^<!--/.test(value);
      });
    } else if (ref?.startsWith('step.')) {
      const start = `<!-- step:${ref.slice(5)} -->`;
      const at = text.indexOf(start);
      const next = at < 0 ? -1 : text.indexOf('<!-- step:', at + start.length);
      explained = at >= 0 && text.slice(at + start.length, next < 0 ? undefined : next).split(/\r?\n/).some((line) => /^\s*\d+\.\s+\S/.test(line));
    } else {
      explained = !!item.description && visibleText.includes(item.description);
    }
    if (!explained) failures.push({ feature_id: item.feature_id, reason: 'manual-explanation-missing' });
  }
  return failures;
}

/** 页面截图的 inventory 作用域：默认 Scenario 只看 default 项；变体只看本 Scenario 的项与 checkpoint 显式引用的项。采集与发布门禁共用。 */
function pageInventory({ page, scenarioId, checkpoint = null }) {
  const isDefault = !scenarioId || scenarioId === `page-${page.id}`;
  const referenced = new Set((checkpoint?.capture?.annotations || []).map((item) => item.feature_id).filter(Boolean));
  return buildInventory({ page }).filter((item) => isDefault ? item.scenario === 'default' : item.scenario === scenarioId || referenced.has(item.feature_id));
}

/** 任务步骤截图的 inventory：步骤本身 + 归属这一步的页面功能。采集与发布门禁共用。 */
function stepInventory({ page, task, step }) {
  const scoped = { id: page?.id ?? stepPageId(step), features: stepFeatures({ page, task, step }), guide: [], detectedActions: [] };
  return buildInventory({ page: scoped, task: { ...task, steps: [step] } });
}

module.exports = { buildInventory, buildPlan, verifyCoverage, verifyExplanations, pageInventory, stepInventory, stepFeatures };
