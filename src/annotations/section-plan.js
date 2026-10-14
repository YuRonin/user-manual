'use strict';

// Semantic definitions stay in pages; observations stay in Capture records.
const { isSafeId } = require('../model/ids');
const { revisionOf } = require('../util/hash');

const featureId = (f) => f?.id ?? f?.feature_id;
const defaultScenario = (p) => `page-${p.id}`;
const grouped = (p) => Array.isArray(p.sections) && p.sections.length > 0;

function operationsOf(page) {
  return (Array.isArray(page.features) ? page.features : []).filter(Boolean).flatMap((f) => (Array.isArray(f.operations) ? f.operations : []).filter(Boolean).map((op) => ({ ...op, featureId: featureId(f), featureLabel: f.label, contentKind: f.contentKind || 'operation', priority: f.priority })));
}

/**
 * 小节里的步骤：按 featureRefs、再按功能内 operations 的顺序。
 * 操作类功能的操作（以及被图片标注的说明类操作）从 1 连续编号——正文序号与截图标注号是同一个数；
 * 其余说明类操作 step 为 null，正文写成步骤之后的普通段落。
 */
function sectionSteps(page, section) {
  const features = new Map((Array.isArray(page.features) ? page.features : []).filter(Boolean).map((f) => [featureId(f), f]));
  const annotated = new Set((Array.isArray(page.figures) ? page.figures : []).filter((f) => f?.sectionId === section?.id).flatMap((f) => (Array.isArray(f.operationRefs) ? f.operationRefs : [])));
  const out = [];
  let n = 0;
  for (const id of Array.isArray(section?.featureRefs) ? section.featureRefs : []) {
    const feature = features.get(id);
    if (!feature) continue;
    for (const op of (Array.isArray(feature.operations) ? feature.operations : []).filter(Boolean)) {
      const numbered = (feature.contentKind || 'operation') === 'operation' || annotated.has(op.id);
      out.push({ op: { ...op, featureId: id }, feature, step: numbered ? ++n : null });
    }
  }
  return out;
}

/** 操作 id → 所在小节的步骤号（只含已收录、已编号的操作）。 */
function stepNumbers(page) {
  const out = new Map();
  for (const section of Array.isArray(page.sections) ? page.sections : []) {
    for (const item of sectionSteps(page, section)) if (item.step) out.set(item.op.id, item.step);
  }
  return out;
}

function validateLayout(page) {
  const errors = [];
  const issue = (path, message) => errors.push({ path, code: 'invalid-manual-layout', message });
  const features = new Map((Array.isArray(page.features) ? page.features : []).filter(Boolean).map((f) => [featureId(f), f]));
  const operations = new Map();
  for (const [fi, f] of (Array.isArray(page.features) ? page.features : []).entries()) {
    if (!f || typeof f !== 'object') { issue(`features[${fi}]`, '需要功能对象'); continue; }
    if (grouped(page) && !/^[A-Za-z0-9._:-]+$/.test(featureId(f) || '')) issue(`features[${fi}].id`, '功能 id 必须适合稳定块引用');
    if (f.guideId !== undefined && !isSafeId(f.guideId)) issue(`features[${fi}].guideId`, 'guideId 非法');
    if (f.sourceRefs !== undefined && (!Array.isArray(f.sourceRefs) || f.sourceRefs.some(r => typeof r !== 'string' || !r.trim()))) issue(`features[${fi}].sourceRefs`, '来源需要非空字符串数组');
    if (f.contentKind !== undefined && !['operation', 'concept', 'reference'].includes(f.contentKind)) issue(`features[${fi}].contentKind`, '需要 operation / concept / reference');
    if (f.operations !== undefined && !Array.isArray(f.operations)) { issue(`features[${fi}].operations`, '需要操作数组'); continue; }
    for (const [oi, op] of (f.operations || []).entries()) {
      const at = `features[${fi}].operations[${oi}]`;
      if (!op || !isSafeId(op.id) || operations.has(op.id)) { issue(at, '操作 id 需要在页面内唯一的安全 slug'); continue; }
      operations.set(op.id, { ...op, featureId: featureId(f) });
      if (op.bindingIntent !== undefined && (!op.bindingIntent || typeof op.bindingIntent.name !== 'string' || !op.bindingIntent.name.trim() || (op.bindingIntent.role !== undefined && typeof op.bindingIntent.role !== 'string'))) issue(`${at}.bindingIntent`, '需要控件 name 和可选 role');
      if (op.sourceRefs !== undefined && (!Array.isArray(op.sourceRefs) || op.sourceRefs.some(r => typeof r !== 'string' || !r.trim()))) issue(`${at}.sourceRefs`, '来源需要非空字符串数组');
      if (op.taskId !== undefined && !isSafeId(op.taskId) || op.claimId !== undefined && !isSafeId(op.claimId)) issue(at, '任务与声明 id 非法');
      if (!String(op.instruction || '').trim()) issue(`${at}.instruction`, '需要有来源的操作说明');
      if (!['entry', 'state', 'result', 'none'].includes(op.evidenceRequirement)) issue(`${at}.evidenceRequirement`, '需要 entry / state / result / none');
      if (op.evidenceRequirement === 'none' && !f.sourceRefs?.length && !op.sourceRefs?.length) issue(at, '无图说明须填写 sourceRefs');
      if (op.evidenceRequirement === 'none' && (f.contentKind === 'operation' || !f.contentKind || !String(op.noImageReason || '').trim())) issue(at, '无图说明须为 concept/reference 且填写 noImageReason');
      if (op.risk !== undefined && !['read', 'write', 'destructive'].includes(op.risk)) issue(`${at}.risk`, '风险必须是 read / write / destructive');
      if (op.evidenceRequirement === 'result' && !op.taskId) issue(at, '结果验证须引用已有任务 taskId 和 claimId');
      if (op.evidenceRequirement === 'result' && !op.claimId) issue(at, '结果验证须引用 claimId');
      // 结果说明（做完这一步看到什么）必须由同一小节的状态图证明
      if (op.outcome !== undefined && (typeof op.outcome !== 'string' || !op.outcome.trim())) issue(`${at}.outcome`, '结果说明需要非空文字');
      if (op.outcomeFigure !== undefined && !isSafeId(op.outcomeFigure)) issue(`${at}.outcomeFigure`, 'outcomeFigure 需要图片 id');
      if (op.outcome !== undefined && op.outcomeFigure === undefined) issue(at, '结果说明需要 outcomeFigure 指向证明这一状态的状态图');
      if (op.outcomeFigure !== undefined && op.outcome === undefined) issue(at, 'outcomeFigure 只能和 outcome 一起使用');
    }
  }
  if (page.faq !== undefined) {
    if (!Array.isArray(page.faq)) issue('faq', '常见问题需要数组');
    else {
      const ids = new Set();
      page.faq.forEach((item, i) => {
        if (!item || typeof item !== 'object' || !isSafeId(item.id) || ids.has(item.id)) { issue(`faq[${i}]`, '常见问题需要唯一安全 id'); return; }
        ids.add(item.id);
        for (const field of ['question', 'answer']) if (typeof item[field] !== 'string' || !item[field].trim()) issue(`faq[${i}].${field}`, `常见问题需要非空 ${field}`);
      });
    }
  }
  if (page.sections === undefined && page.figures === undefined) return errors;
  if (!Array.isArray(page.sections) || !page.sections.length) issue('sections', '分类手册需要至少一个小节');
  if (!Array.isArray(page.figures)) issue('figures', '需要图片计划数组');
  const sections = new Map();
  const figures = new Map();
  for (const [i, s] of (Array.isArray(page.sections) ? page.sections : []).entries()) {
    const at = `sections[${i}]`;
    if (!s || !isSafeId(s.id) || sections.has(s.id)) { issue(at, '小节 id 需要唯一安全 slug'); continue; }
    sections.set(s.id, s);
    if (!String(s.title || '').trim() || !String(s.goal || '').trim()) issue(at, '小节需要 title 和 goal');
    if (!Array.isArray(s.featureRefs) || !s.featureRefs.length) issue(at, '小节需要 featureRefs');
    for (const id of Array.isArray(s.featureRefs) ? s.featureRefs : []) if (!features.has(id) || ['skip', 'undecided'].includes(features.get(id).priority)) issue(`${at}.featureRefs`, `功能不存在、未确认或已跳过: ${id}`);
    if (!Array.isArray(s.figureRefs)) issue(at, '小节需要 figureRefs（无图概念小节可为空）');
    if (s.tips !== undefined && (!Array.isArray(s.tips) || s.tips.some((t) => typeof t !== 'string' || !t.trim()))) issue(`${at}.tips`, '提示需要非空字符串数组');
  }
  for (const [i, fig] of (Array.isArray(page.figures) ? page.figures : []).entries()) {
    const at = `figures[${i}]`;
    if (!fig || !isSafeId(fig.id) || figures.has(fig.id)) { issue(at, '图片 id 需要唯一安全 slug'); continue; }
    figures.set(fig.id, fig);
    if (!sections.has(fig.sectionId)) issue(at, '图片须引用已有 sectionId');
    if (fig.scenarioId !== undefined && !isSafeId(fig.scenarioId)) issue(at, 'scenarioId 非法');
    if (fig.checkpointId !== undefined && !isSafeId(fig.checkpointId)) issue(at, 'checkpointId 非法');
    if (!String(fig.caption || '').trim()) issue(at, '图片需要 caption');
    if (!['entry', 'state', 'overview'].includes(fig.purpose)) issue(at, '图片 purpose 需要 entry / state / overview');
    if (!Array.isArray(fig.operationRefs)) issue(at, '需要 operationRefs');
    if (fig.purpose === 'entry' && !fig.operationRefs?.length) issue(at, '入口图需要至少一个操作');
    for (const id of Array.isArray(fig.operationRefs) ? fig.operationRefs : []) {
      const op = operations.get(id);
      const section = sections.get(fig.sectionId);
      if (!op || !Array.isArray(section?.featureRefs) || !section.featureRefs.includes(op.featureId)) issue(`${at}.operationRefs`, `操作不存在或不属于当前小节: ${id}`);
    }
    if (Array.isArray(fig.operationRefs) && new Set(fig.operationRefs).size !== fig.operationRefs.length) issue(at, '图片不能重复引用操作');
    if (fig.frame && !['auto', 'region', 'viewport'].includes(fig.frame.mode)) issue(at, 'frame.mode 需要 auto / region / viewport');
    if (fig.frame?.padding !== undefined && (!Number.isFinite(fig.frame.padding) || fig.frame.padding < 32 || fig.frame.padding > 200)) issue(at, '裁剪留白须在 32～200 CSS px');
    if (fig.frame?.mode === 'region' && !fig.frame.target) issue(at, 'region 需要可验证的区域 target');
  }
  if (errors.length) return errors;
  for (const s of sections.values()) {
    if (Array.isArray(s.featureRefs) && new Set(s.featureRefs).size !== s.featureRefs.length || Array.isArray(s.figureRefs) && new Set(s.figureRefs).size !== s.figureRefs.length) issue(`sections.${s.id}`, '引用不能重复');
    for (const id of Array.isArray(s.figureRefs) ? s.figureRefs : []) if (!figures.has(id) || figures.get(id).sectionId !== s.id) issue(`sections.${s.id}.figureRefs`, `图片不存在或属于其它小节: ${id}`);
  }
  for (const fig of figures.values()) if (!sections.get(fig.sectionId)?.figureRefs?.includes(fig.id)) issue(`figures.${fig.id}`, '图片没有被所属小节引用');
  if (grouped(page)) {
    const refs = page.sections.flatMap((s) => Array.isArray(s?.featureRefs) ? s.featureRefs : []);
    const included = new Set(refs);
    if (included.size !== refs.length) issue('sections', '一个功能只能属于一个小节；多状态图片可放在同一小节');
    const guideIds = (page.features || []).map(f => f?.guideId).filter(Boolean);
    if (new Set(guideIds).size !== guideIds.length) issue('features', '旧 guideId 映射必须唯一');
    for (const f of features.values()) {
      if (!f) continue;
      if (f.priority === 'required' && !included.has(featureId(f))) issue('sections', `必需功能没有进入小节: ${featureId(f)}`);
      if (included.has(featureId(f)) && !(f.operations || []).length) issue('features', `已收录功能需要操作或显式无图说明: ${featureId(f)}`);
    }
    for (const op of operations.values()) if (included.has(op.featureId) && op.evidenceRequirement !== 'none' && ![...figures.values()].some((f) => f.operationRefs?.includes(op.id))) issue('figures', `已收录操作没有图片计划: ${op.id}`);
    for (const op of operations.values()) {
      if (op.outcomeFigure === undefined) continue;
      const fig = figures.get(op.outcomeFigure);
      const home = page.sections.find((s) => s.featureRefs.includes(op.featureId));
      if (!fig || fig.purpose !== 'state' || !home || fig.sectionId !== home.id) issue(`operations.${op.id}.outcomeFigure`, `结果图须是同一小节的状态图（purpose: state）: ${op.outcomeFigure}`);
    }
  }
  return errors;
}

/** 小节的步骤数与操作功能数上限：超过时多半混了几条子流程。 */
const SECTION_MAX_STEPS = 6;
const SECTION_MAX_FEATURES = 3;

/**
 * 分类计划的写法提示（不阻断，可用 quality.blockOn 升级）：
 *   section-too-broad       编号步骤过多或操作功能过多：一节只讲一条读者能独立完成的子流程
 *   section-outcome-missing 操作小节的最后一步没有结果说明：读者不知道做完会看到什么
 */
function layoutQuality(page) {
  if (!grouped(page)) return [];
  const warnings = [];
  for (const section of page.sections) {
    const steps = sectionSteps(page, section).filter((s) => s.step);
    const operationFeatures = new Set(steps.filter((s) => (s.feature.contentKind || 'operation') === 'operation').map((s) => s.op.featureId));
    if (steps.length > SECTION_MAX_STEPS || operationFeatures.size > SECTION_MAX_FEATURES) warnings.push(`section-too-broad:${section.id}`);
    if (steps.length && !steps[steps.length - 1].op.outcome) warnings.push(`section-outcome-missing:${section.id}`);
  }
  return warnings;
}

function figuresFor(page, scenarioId, checkpointId = 'default') {
  return (page.figures || []).filter((f) => (f.scenarioId || defaultScenario(page)) === scenarioId && (f.checkpointId || 'default') === checkpointId);
}

// 标注号 = 操作在小节里的步骤号：读者看到图上的 ②，就是正文第 2 步。
function layoutPlan(page, scenarioId, checkpointId = 'default') {
  const ops = new Map(operationsOf(page).map((op) => [op.id, op]));
  const steps = stepNumbers(page);
  return figuresFor(page, scenarioId, checkpointId).flatMap((f) => f.operationRefs.map((id, index) => {
    const op = ops.get(id);
    return { feature_id: op.featureId, operation_id: op.id, figure_id: f.id, section_id: f.sectionId, label: String(steps.get(id) ?? index + 1),
      priority: 'optional', target: op.targetHint || null, bindingIntent: op.bindingIntent || null,
      description: op.instruction, evidenceRequirement: op.evidenceRequirement, scenario: scenarioId };
  }));
}

// 标注号进入 layoutRevision：步骤顺序变了，旧图上的编号就对不上正文，需要重新派生或重采。
function captureLayout(page) {
  const steps = stepNumbers(page);
  return { operations: operationsOf(page).map(({ id, featureId: fid, targetHint, bindingIntent, evidenceRequirement, taskId, claimId }) => ({ id, featureId: fid, targetHint, bindingIntent, evidenceRequirement, taskId, claimId })),
    figures: (page.figures || []).map(({ id, sectionId, operationRefs, scenarioId, checkpointId, frame, purpose }) => ({ id, sectionId, operationRefs, scenarioId, checkpointId, frame, purpose, labels: (Array.isArray(operationRefs) ? operationRefs : []).map((op) => steps.get(op) ?? null) })) };
}

function bindingLayout(page) {
  return {
    operations: operationsOf(page).map(({ id, featureId, targetHint, bindingIntent, evidenceRequirement, taskId, claimId }) => ({ id, featureId, targetHint, bindingIntent, evidenceRequirement, taskId, claimId })).sort((a, b) => a.id.localeCompare(b.id)),
    states: [...new Set((page.figures || []).flatMap(f => f.operationRefs.map(id => `${id}@${f.scenarioId || defaultScenario(page)}#${f.checkpointId || 'default'}`)))].sort(),
    regions: (page.figures || []).filter(f => f.frame?.target).map(f => ({ scenarioId: f.scenarioId || defaultScenario(page), checkpointId: f.checkpointId || 'default', target: f.frame.target })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}
function bindingRevision(page) { return revisionOf(JSON.parse(JSON.stringify(bindingLayout(page)))); }
function layoutRevision(page) { return revisionOf(JSON.parse(JSON.stringify(captureLayout(page)))); }

// Proof is checked against the exact final images, not any image in the same Capture.
function documentCoverage(page, images, records, claims = []) {
  const errors = [];
  const links = [];
  const add = (op, reason) => errors.push({ code: 'manual-operation-uncovered', operationId: op.id, featureId: op.featureId, message: `${op.id}: ${reason}` });
  if (!grouped(page)) {
    for (const g of page.guide || []) {
      if (['concept', 'reference'].includes(g.contentKind) && g.noImageReason && Array.isArray(g.sourceRefs) && g.sourceRefs.length) continue;
      const rendered = records.some(r => {
        const ids = new Set([g.featureId || `page:${page.id}:${g.id}`, ...(r.annotationProof?.inventory || []).filter(i => i.guide_id === g.id).map(i => i.feature_id), ...(r.annotationProof?.plan || []).filter(i => i.guide_id === g.id).map(i => i.feature_id)]);
        return (r.annotationProof?.rendered || []).some(t => ids.has(t.feature_id) && t.drawn && t.visible !== false && images.some(i => i.captureId === r.id && (i.part || 1) === (t.part || 1)));
      });
      if (!rendered) add({ id: g.id }, '操作说明缺少可验证的标注；生成分类图文计划后补证据');
    }
    return { ok: !errors.length, errors, links, total: (page.guide || []).length, verified: (page.guide || []).length - errors.length };
  }
  const included = new Set(page.sections.flatMap((s) => s.featureRefs));
  const required = operationsOf(page).filter((op) => included.has(op.featureId));
  for (const op of required) {
    if (op.evidenceRequirement === 'none') { links.push({ operationId: op.id, featureId: op.featureId, scope: 'source', noImageReason: op.noImageReason }); continue; }
    let satisfied = false;
    for (const fig of page.figures.filter((f) => f.operationRefs.includes(op.id))) {
      for (const image of images.filter((i) => i.figureId === fig.id)) {
        const record = records.find((r) => r.id === image.captureId);
        if (!record || record.layoutRevision !== layoutRevision(page)) continue;
        const proof = record.annotationProof;
        const frame = proof?.figures?.find((f) => f.figureId === fig.id && f.part === (image.part || 1));
        if (!frame || frame.status !== 'verified' || frame.purpose !== fig.purpose || record.scenarioId !== (fig.scenarioId || defaultScenario(page)) || record.checkpointId !== (fig.checkpointId || 'default')) continue;
        const rendered = (proof.rendered || []).find((r) => r.operation_id === op.id && r.figure_id === fig.id && (r.part || 1) === (image.part || 1) && r.drawn && r.visible !== false && r.located && r.outlined && r.intersects);
        if (!rendered || !proof.bindings?.some((b) => b.operationId === op.id && b.figureId === fig.id && b.status === 'verified')) continue;
        if (op.evidenceRequirement === 'state' && (!frame.stateVerified || fig.purpose !== 'state' || !record.validations?.some(v => v.scope === 'scenario-state' && v.outcome === 'passed'))) continue;
        if (op.evidenceRequirement === 'result') {
          const claim = claims.find((c) => c.id === op.claimId && c.taskId === op.taskId && c.status === 'verified' && c.releaseId && c.evidence?.length);
          if (!claim) continue;
        }
        satisfied = true;
        links.push({ featureId: op.featureId, operationId: op.id, figureId: fig.id, sectionId: fig.sectionId, captureId: record.id, artifactPath: image.artifactPath, part: image.part || 1, label: rendered.label,
          scope: op.evidenceRequirement === 'entry' ? 'entry-observed' : op.evidenceRequirement === 'result' ? 'result-verified' : 'state-observed', provenance: record.provenance?.mode || 'live',
          ...(op.evidenceRequirement === 'result' ? { taskId: op.taskId, claimId: op.claimId, taskReleaseId: claims.find(c => c.id === op.claimId && c.taskId === op.taskId).releaseId } : {}) });
      }
    }
    if (!satisfied) add(op, `缺少 ${op.evidenceRequirement} 证据或图片/状态/绑定已失效`);
  }
  // 结果说明：outcomeFigure 的最终图必须存在、状态在截图前后都复核通过
  for (const op of required.filter((o) => o.outcome)) {
    const fig = page.figures.find((f) => f.id === op.outcomeFigure);
    const proven = fig && images.filter((i) => i.figureId === fig.id).some((image) => {
      const record = records.find((r) => r.id === image.captureId);
      const frame = record?.annotationProof?.figures?.find((f) => f.figureId === fig.id && f.part === (image.part || 1));
      return record && record.layoutRevision === layoutRevision(page) && frame?.status === 'verified' && frame.stateVerified
        && record.scenarioId === (fig.scenarioId || defaultScenario(page)) && record.checkpointId === (fig.checkpointId || 'default')
        && record.validations?.some((v) => v.scope === 'scenario-state' && v.outcome === 'passed');
    });
    if (proven) links.push({ featureId: op.featureId, operationId: op.id, figureId: fig.id, sectionId: fig.sectionId, scope: 'outcome-observed' });
    else errors.push({ code: 'manual-outcome-unproven', operationId: op.id, featureId: op.featureId, message: `${op.id}: 结果说明缺少已复核的状态图 ${op.outcomeFigure}` });
  }
  const uncovered = errors.filter((e) => e.code === 'manual-operation-uncovered').length;
  return { ok: !errors.length, errors, links, total: required.length, verified: required.length - uncovered, percent: required.length ? (required.length - uncovered) / required.length * 100 : null };
}

// 正文与最终图的对应：步骤块的编号与顺序、图片所在小节、图上每个标注号等于对应操作的步骤号。
function validateRenderedLayout(pack, markdown) {
  if (!pack?.sections?.length) return [];
  const { parseManual } = require('../generate/merge');
  const { extractFacts, compareFacts } = require('../generate/facts');
  const { stepBlockId } = require('../generate/render');
  const actual = parseManual(markdown);
  const expected = parseManual(require('../generate/render').renderPage(pack));
  const steps = stepNumbers(pack);
  const numbers = (content) => [...String(content || '').matchAll(/^(\d+)\.\s/gm)].map(m => m[1]);
  const errors = [];
  for (const section of pack.sections) {
    const sectionId = `section.${section.id}`;
    const start = actual.order.indexOf(sectionId);
    const next = actual.order.findIndex((id, i) => i > start && id.startsWith('section.'));
    const inside = (at) => at > start && (next < 0 || at < next);
    if (start < 0) errors.push({ code: 'manual-layout-mismatch', message: `正文缺少分类小节 ${section.id}` });
    for (const feature of (pack.features || []).filter(f => section.featureRefs.includes(featureId(f)))) {
      const id = stepBlockId(feature);
      const block = actual.blocks.get(id);
      if (!expected.blocks.has(id)) continue;
      if (!block || !inside(actual.order.indexOf(id)) || JSON.stringify(numbers(block.content)) !== JSON.stringify(numbers(expected.blocks.get(id).content))) errors.push({ code: 'manual-layout-mismatch', message: `小节 ${section.id} 的步骤编号或顺序已变化（${id}）` });
    }
    for (const artifact of pack.artifacts.filter(a => section.figureRefs.includes(a.figureId))) {
      const id = `figure.${artifact.figureId}.${artifact.part || 1}`;
      const block = actual.blocks.get(id);
      if (!block || !inside(actual.order.indexOf(id)) || !compareFacts(extractFacts(expected.blocks.get(id).content), extractFacts(block.content)).ok) errors.push({ code: 'manual-layout-mismatch', message: `图片 ${artifact.figureId} 的小节或位置已变化` });
      const wrong = (artifact.annotationRefs || []).filter(r => r.operationId && String(steps.get(r.operationId)) !== String(r.label));
      if (wrong.length) errors.push({ code: 'manual-layout-mismatch', message: `图片 ${artifact.figureId} 的标注号与正文步骤号不一致（${wrong.map(r => `${r.operationId}=${r.label}`).join('、')}），重新派生或重新采集` });
    }
  }
  return errors;
}

module.exports = { validateRenderedLayout, bindingLayout, bindingRevision, featureId, operationsOf, sectionSteps, stepNumbers, layoutQuality, grouped, validateLayout, figuresFor, layoutPlan, captureLayout, layoutRevision, documentCoverage, defaultScenario };
