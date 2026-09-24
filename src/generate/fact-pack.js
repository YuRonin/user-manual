'use strict';

/*
 * 统一事实包 FactPack（契约 C11）。
 *
 * 页面与任务两条生成入口都先把"文档可以说什么"整理成一个结构化、可 hash 的事实包：
 *   steps（动作、目标、顺序、是否执行、截图位置）、claims（验证等级来自证据）、
 *   artifactRefs（图片与 Capture 归属、hash、隐私记录）、allowedCopyBlocks（模型唯一可写的文案块），
 *   以及语言 / 模板 revision 与输入 revision。
 * factsHash 是规范化事实包的 hash：图片换了内容、步骤或声明变了、模板变了，它就变——
 * 草稿与定稿据此判断是否仍基于同一份事实。
 */

const { revision, definitionRevision } = require('../model/revision');
const { templateFor, templateRevision, actionSentence } = require('./render');

const FACT_PACK_SCHEMA_VERSION = 1;

class FactPackError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FactPackError';
    this.code = code;
  }
}

function uiTerms(text) {
  return [...String(text || '').matchAll(/「([^」]+)」/g)].map((m) => m[1]);
}

function seal(pack) {
  const { factsHash: _ignored, ...body } = pack;
  return { ...body, factsHash: revision(JSON.parse(JSON.stringify(body))) };
}

/**
 * @param {object} p
 * @param {object} p.task
 * @param {object} p.evidence       evidence manifest（兼容视图）
 * @param {Array}  p.images         [{ artifactPath, markdownHref, sha256, privacy, captureId?, stepId }] 已通过产物门槛
 * @param {Array}  p.claims         computeClaims 的结果
 * @param {string} p.language
 */
function buildTaskFactPack({ task, evidence, images, claims, language }) {
  const template = templateFor(language);
  const seen = new Set();
  for (const step of task.steps || []) {
    if (!step.id) throw new FactPackError('invalid-step', '步骤缺少 id。');
    if (seen.has(step.id)) throw new FactPackError('duplicate-step', `步骤 id 重复: ${step.id}`);
    seen.add(step.id);
  }
  const records = new Map((evidence?.steps || []).map((record) => [record.id, record]));
  for (const id of records.keys()) {
    if (!seen.has(id)) throw new FactPackError('unknown-step', `证据中出现任务里不存在的步骤: ${id}`);
  }
  const artifacts = images.map((image, index) => ({ id: `img-${index + 1}`, ...image }));
  const steps = task.steps.map((step, index) => {
    const record = records.get(step.id);
    const sentence = actionSentence(step, template);
    return {
      id: step.id,
      order: index + 1,
      pageId: step.pageId ?? step.page ?? null,
      action: { type: step.action?.type ?? null, target: step.action?.target ?? null },
      sentence: sentence.text,
      sentenceSource: sentence.source,
      uiTerms: uiTerms(sentence.text),
      executed: record ? record.status !== 'not-executed' : null,
      artifactRefs: artifacts.filter((a) => a.stepId === step.id).map((a) => a.id),
    };
  });
  const firstSkipped = steps.findIndex((step) => step.executed === false);
  const blocks = { intro: { kind: 'intro', default: task.goal || '' } };
  for (const step of task.steps) blocks[`step.${step.id}`] = { kind: 'step-note', default: step.instruction || '' };
  return seal({
    schemaVersion: FACT_PACK_SCHEMA_VERSION,
    kind: 'task',
    manualId: task.id,
    language,
    templateRevision: templateRevision(language),
    inputRevision: revision({
      definition: definitionRevision('userTask', task),
      captureIds: evidence?.canonicalCaptureRefs || task.lastCapture?.captureIds || null,
    }),
    title: task.title,
    preconditions: task.preconditions || [],
    steps,
    claims: claims.map(({ id, text, status, assertionRefs, checkpoint, evidence: refs }) => ({ id, text, status, assertionRefs, checkpoint: checkpoint ?? null, evidence: refs })),
    artifacts: artifacts.map(({ stepId, ...rest }) => ({ ...rest, stepId })),
    scope: { firstSkipped },
    branches: task.branches || [],
    relatedTasks: task.relatedTasks || [],
    blocks,
    // 文案块里允许出现的界面名称：只能是事实中已有的
    allowedUiTerms: [...new Set([...steps.flatMap((s) => s.uiTerms), ...task.steps.flatMap((s) => uiTerms(s.instruction)), ...uiTerms(task.goal)])],
  });
}

/**
 * 页面事实包。detectedActions 来自源码分析：没有逐项的浏览器交互证据，一律标为 inferred。
 * @param {{ page, image, language, headerComments, captureId }} p
 */
function buildPageFactPack({ page, image = null, language, headerComments = [] }) {
  templateFor(language);
  const artifacts = image ? [{ id: 'img-1', ...image }] : [];
  const actions = (Array.isArray(page.detectedActions) ? page.detectedActions : []).filter(Boolean)
    .map((text, index) => ({ id: `action-${index + 1}`, text, status: 'inferred' }));
  return seal({
    schemaVersion: FACT_PACK_SCHEMA_VERSION,
    kind: 'page',
    manualId: page.id,
    language,
    templateRevision: templateRevision(language),
    inputRevision: revision({ definition: definitionRevision('page', page), sourceRevision: page.analysis?.sourceRevision ?? null, captureId: image?.captureId ?? null }),
    title: page.title,
    route: page.route,
    actions,
    artifacts,
    headerComments,
    blocks: { intro: { kind: 'intro', default: page.purpose || '' } },
    allowedUiTerms: [...new Set([...actions.flatMap((a) => uiTerms(a.text)), ...uiTerms(page.purpose)])],
  });
}

/** 两个事实包哪些顶层部分不同（用于 draft-stale 提示重建范围）。 */
function diffPacks(a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  return [...keys].filter((key) => key !== 'factsHash' && JSON.stringify(a?.[key]) !== JSON.stringify(b?.[key])).sort();
}

module.exports = { FACT_PACK_SCHEMA_VERSION, FactPackError, buildTaskFactPack, buildPageFactPack, diffPacks, uiTerms };
