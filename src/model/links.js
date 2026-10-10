'use strict';

/*
 * 跨实体引用校验（B2-10 / B2-11）。只用 ID 就能走完
 *   Section → captureRefs / annotationRefs / featureRefs → Capture（冻结的标注证明）→ Feature / Task / Step / Scenario
 * 任何一环指向不存在或不属于自己的对象，都给出确定的错误码：
 *   missing-reference         引用的页面 / 功能 / 状态 / Capture 不存在
 *   capture-subject-mismatch  章节引用的截图不是这个步骤 / 页面的截图
 *   section-ref-invalid       annotationRef / featureRef 不在所引用截图里实际画出的项中
 */

const { stepPageId } = require('../tasks/model');

const issue = (code, message) => ({ code, message });
const featureIdOf = (item) => item?.feature_id ?? item?.id;

/**
 * 模型提交时的引用检查：只检查本次改动的页面与任务，避免旧数据里与本次无关的问题挡住提交。
 * guide.featureId、step.feature_id 必须指向页面上声明过的功能；任务的页面 / 状态引用在批准时（approve-tasks）用 validateUserTask({ pages }) 检查。
 */
function validateModelLinks({ pages = [], tasks = [], changedPageIds = null, changedTaskIds = null }) {
  const errors = [];
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const featureIds = (page) => new Set((page?.features || []).map(featureIdOf));
  for (const page of pages) {
    if (changedPageIds && !changedPageIds.has(page.id)) continue;
    const known = featureIds(page);
    for (const guide of page.guide || []) {
      const ref = guide.featureId ?? guide.feature_id;
      if (ref && !known.has(ref)) errors.push(issue('missing-reference', `页面 ${page.id} 的 guide ${guide.id} 引用了不存在的功能 ${ref}`));
    }
  }
  for (const task of tasks) {
    if (changedTaskIds && !changedTaskIds.has(task.id)) continue;
    // 页面 / 状态的存在性依赖录入顺序（任务可能先于页面写入），在批准时检查；提交时只检查功能引用。
    for (const step of task.steps || []) {
      const page = pagesById.get(stepPageId(step));
      if (step.feature_id && page && !featureIds(page).has(step.feature_id)) errors.push(issue('missing-reference', `任务 ${task.id} 步骤 ${step.id} 引用了页面 ${page.id} 上不存在的功能 ${step.feature_id}`));
    }
  }
  return errors;
}

/** 截图里实际画出的项（来自冻结的标注证明）。 */
function drawnFeatures(record) {
  return new Set((record?.annotationProof?.rendered || []).filter((item) => item.drawn).map((item) => item.feature_id));
}

/**
 * 章节引用检查（发布前与 verify --artifacts）。
 * @param {object} p
 * @param {Array} p.sections
 * @param {string[]} p.captureIds   本手册图片与完成声明证据涉及的 Capture
 * @param {(id) => object|null} p.readRecord
 * @param {'task'|'page'} p.kind
 * @param {string} p.subjectId      任务 id / 页面 id
 */
function validateSectionLinks({ sections = [], captureIds = [], readRecord, kind, subjectId }) {
  const errors = [];
  const allowed = new Set(captureIds.filter(Boolean));
  for (const section of sections) {
    const records = new Map();
    for (const captureId of section.captureRefs || []) {
      let record = null;
      try { record = readRecord(captureId); } catch (_) { record = null; }
      if (!record) { errors.push(issue('missing-reference', `章节 ${section.id} 引用的 Capture ${captureId} 不存在`)); continue; }
      if (!allowed.has(captureId)) errors.push(issue('section-ref-invalid', `章节 ${section.id} 引用的 Capture ${captureId} 不属于本手册`));
      records.set(captureId, record);
      if (kind === 'task' && section.kind === 'step') {
        const stepId = section.id.slice('step.'.length);
        if (record.kind !== 'task-step' || record.subject?.taskId !== subjectId || record.subject?.stepId !== stepId) {
          errors.push(issue('capture-subject-mismatch', `章节 ${section.id} 引用的截图属于 ${record.subject?.taskId || record.subject?.pageId}/${record.subject?.stepId || '-'}，不是这个步骤`));
        }
      }
      if (kind === 'page' && record.kind === 'page' && record.subject?.pageId !== subjectId) {
        errors.push(issue('capture-subject-mismatch', `章节 ${section.id} 引用的截图属于页面 ${record.subject?.pageId}，不是 ${subjectId}`));
      }
    }
    const annotated = new Set();
    for (const ref of section.annotationRefs || []) {
      const [captureId, featureId] = String(ref).split('#');
      const record = records.get(captureId);
      if (!record || !featureId || !drawnFeatures(record).has(featureId)) { errors.push(issue('section-ref-invalid', `章节 ${section.id} 的标注引用 ${ref} 不是该截图上实际画出的项`)); continue; }
      annotated.add(featureId);
    }
    for (const featureId of section.featureRefs || []) {
      if (!annotated.has(featureId)) errors.push(issue('section-ref-invalid', `章节 ${section.id} 引用的功能 ${featureId} 没有对应的标注引用`));
    }
  }
  return errors;
}

/**
 * 发布用的章节：按冻结的标注证明补上 annotationRefs / featureRefs，再做引用检查。
 * @returns {{ sections, errors }}
 */
function checkedSections({ projectRoot, stateDirAbs, pack, captureIds = [], kind, subjectId, audience }) {
  if (!pack) return { sections: null, errors: [] };
  const { manualFromPack } = require('../generate/manual-model');
  const store = require('../evidence/store').createCaptureStore({ projectRoot, stateDirAbs });
  const readRecord = (id) => store.read(id);
  const ids = [...new Set([...captureIds, ...(pack.artifacts || []).map((a) => a.captureId)].filter(Boolean))];
  const proofs = new Map();
  for (const id of ids) {
    try { const record = store.read(id); if (record?.annotationProof) proofs.set(id, record.annotationProof); } catch (_) { /* 缺失由 validateSectionLinks 报告 */ }
  }
  const { sections } = manualFromPack(pack, { audience, proofs });
  return { sections, errors: validateSectionLinks({ sections, captureIds: ids, readRecord, kind, subjectId }) };
}

module.exports = { validateModelLinks, validateSectionLinks, checkedSections, drawnFeatures };
