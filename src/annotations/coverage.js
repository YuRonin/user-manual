'use strict';

const { createHash } = require('crypto');
const { stepPageId } = require('../tasks/model');

const PRIORITIES = new Set(['required', 'optional', 'skip', 'undecided']);
const key = (value) => String(value || '').trim().toLocaleLowerCase();
const list = (value) => Array.isArray(value) ? value : value ? [value] : [];
const stableId = (scope, value) => `${scope}:${createHash('sha256').update(String(value)).digest('hex').slice(0, 12)}`;
const sameTarget = (a, b) => !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
// 功能字段的兼容读取：新写法 id / taskIds / stepIds，旧写法 feature_id / task_ids（B2-04）
const featureIdOf = (item) => item?.feature_id ?? item?.id;
const taskIdsOf = (item) => item?.task_ids ?? item?.taskIds ?? [];
const guideFeatureId = (guide) => guide?.featureId ?? guide?.feature_id;
// 步骤的功能 id：显式 feature_id > 目标与动作一致的已知功能 > 由任务/步骤派生
const stepFeatureId = (task, step, known = []) => step.feature_id
  || known.find((item) => sameTarget(item.target, step.action?.target))?.feature_id
  || `task:${task.id}:${step.id}`;

/** 页面上显式声明、归属这一步的功能：feature_id 指向它，或目标与步骤动作一致。只按 task_ids 不足以归属到某一步。 */
function stepFeatures({ page, task, step }) {
  return (page?.features || []).filter((feature) => taskIdsOf(feature).includes(task.id)
    && (featureIdOf(feature) === step.feature_id || sameTarget(feature.target, step.action?.target)));
}

/**
 * 功能清单（B2-02）。Required 只来自显式确认的 Page.features；guide、detectedActions 只是候选：
 * 带 target 的 guide 照常进入标注计划，但优先级是 undecided（待确认），不能同时充当分母与分子。
 * 显式功能与 guide 的对应：guide.featureId > 目标一致 > 唯一同名（重名不猜）。
 */
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
  for (const item of page.features || []) put({ feature_id: featureIdOf(item), label: item.label, priority: item.priority || 'undecided', source: item.source || ['page.features'], source_refs: [`page.features:${featureIdOf(item)}`], task_ids: taskIdsOf(item), scenario: item.scenario || scenario, description: item.description || '', explanation_ref: item.explanation_ref || null, target: item.target || null, explicit: true });
  const explicit = () => [...features.values()].filter((item) => item.explicit);
  for (const guide of page.guide || []) {
    const sameName = explicit().filter((item) => key(item.label) === key(guide.title));
    const match = explicit().find((item) => item.feature_id === guideFeatureId(guide))
      || explicit().find((item) => sameTarget(item.target, guide.target))
      || (sameName.length === 1 ? sameName[0] : null);
    const id = match?.feature_id || guideFeatureId(guide) || `page:${page.id}:${guide.id}`;
    // 没有显式决定时：带 target 的 guide 是待确认候选（undecided）；纯文字说明的 guide 不要求画出（optional）
    put({ ...match, feature_id: id, label: match?.label || guide.title, priority: match?.priority || (guide.target ? 'undecided' : 'optional'), source: ['page.guide'], guide_id: guide.id, source_refs: [`page.guide:${guide.id}`], task_ids: [...new Set([...(match?.task_ids || []), ...(guide.taskId ? [guide.taskId] : [])])], scenario: match?.scenario || scenario, description: match?.description || guide.instruction || '', explanation_ref: match?.explanation_ref || `guide.${guide.id}`, target: match?.target || guide.target || null });
  }
  for (const action of page.detectedActions || []) {
    // 动作句里用「」标出的控件名与功能名称 / 目标名称一致，也算同一个功能
    const quoted = [...String(action).matchAll(/「([^」]+)」/g)].map((m) => key(m[1]));
    const names = (item) => [item.label, item.target?.name, item.target?.text].filter(Boolean).map(key);
    const match = [...features.values()].find((item) => names(item).includes(key(action)) || names(item).some((name) => quoted.includes(name)));
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
        const feature = inventory.find((item) => item.guide_id === guide.id) || inventory.find((item) => item.feature_id === guideFeatureId(guide));
        if (feature) out.push({ feature_id: feature.feature_id, priority: feature.priority, label: String(index + 1), target: guide.target || feature.target, scenario: feature.scenario, guide_id: guide.id });
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

function verifyCoverage({ inventory = [], plan = [], rendered = [], discovered = inventory, candidates = [] }) {
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
    // visible === false：画了框，但元素大半在图外或被遮罩盖住（旧结果没有该字段，按画出判断）
    else if (!result?.drawn || !result?.outlined || !result?.intersects || !result?.located || result.visible === false) failures.push({ feature_id: id, reason: result?.reason || 'not-drawn' });
    if (!String(item.description || '').trim()) failures.push({ feature_id: id, reason: 'description-missing' });
  }
  const passed = required.filter((item) => !failures.some((failure) => failure.feature_id === item.feature_id)).length;
  const pending = inventory.filter((item) => item.priority === 'undecided').map((item) => ({ feature_id: item.feature_id, label: item.label, reason: 'priority-undecided' }));
  const ok = failures.length === 0;
  // 页面上观察到、清单里没有的可交互元素：不编造 Required，但未决时不能宣称"功能已全部覆盖"（B2-03）
  const unresolvedCandidates = candidates.map((item) => ({ candidate_id: item.candidate_id, label: item.label, role: item.role, source: item.source || 'dom-observed', reason: 'candidate-unresolved' }));
  const review = pending.length + unresolvedCandidates.length;
  return { ok, complete: ok && review === 0 && required.length > 0,
    discovery: { status: discoveryMissing.length ? 'missing' : !inventory.length ? 'insufficient-evidence' : review ? 'pending-review' : 'complete', checked: discovered.length, missing: discoveryMissing.length },
    // 没有已确认的 Required 时覆盖率是 N/A（null），不是 100%
    required: { total: required.length, verified: passed, percent: required.length ? Math.round(100 * passed / required.length) : null }, pending, unresolvedCandidates, discoveryMissing, failures };
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

const CANDIDATE_ROLES = new Set(['button', 'tab', 'menuitem', 'switch', 'checkbox', 'radio', 'combobox']);

/**
 * 页面截图时观察到的可交互元素（无障碍树：角色 + 名称）中，清单没有覆盖的部分（B2-03）。
 * 链接与输入框不计（多为导航与表单字段）；ignore 列出全站通用控件的名称（`前缀*` 为前缀匹配）。
 * 已被清单的名称、guide 标题或目标名称覆盖的元素不算候选。
 */
function domCandidates({ semantic, inventory = [], page = null, ignore = [] }) {
  if (!semantic?.items) return [];
  const known = new Set([
    ...inventory.flatMap((item) => [item.label, item.target?.name, item.target?.text]),
    ...(page?.guide || []).flatMap((guide) => [guide.title, guide.target?.name, guide.target?.text]),
    ...(page?.detectedActions || []),
  ].filter(Boolean).map(key));
  const ignored = (name) => ignore.some((pattern) => pattern.endsWith('*') ? key(name).startsWith(key(pattern.slice(0, -1))) : key(name) === key(pattern));
  const seen = new Set();
  const out = [];
  for (const item of semantic.items) {
    const name = String(item.name || '').trim();
    if (!CANDIDATE_ROLES.has(item.role) || !name || name.includes('[redacted]') || known.has(key(name)) || ignored(name) || seen.has(key(name))) continue;
    seen.add(key(name));
    out.push({ candidate_id: stableId(`page:${page?.id || 'page'}:dom`, `${item.role}:${key(name)}`), label: name, role: item.role, source: 'dom-observed' });
  }
  return out;
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

module.exports = { buildInventory, buildPlan, verifyCoverage, verifyExplanations, pageInventory, stepInventory, stepFeatures, domCandidates };
