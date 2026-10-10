'use strict';

/*
 * 任务文档用例：`manual generate-task` 与 Runtime 的 draft / validate / publish handler 共用。
 *
 *   draftTask        事实草稿 + 事实包（drafts/tasks/<id>.md / .facts.json）
 *   prepareTaskFinal 写任何正式文件之前完成全部检查：草稿新鲜度、文案审查、结构事实、发布门槛
 *   publishTaskFinal 发布事务（文档 + 发布记录 + current 指针）后提交任务状态投影
 *
 * 不做输出；失败抛 RuntimeError（code + errors 列表），调用方决定展示方式。
 */

const fs = require('fs');
const path = require('path');

const { createProjectStore } = require('../store/project');
const { checkEvidenceUsable } = require('../model/approval');
const { buildTaskDraft } = require('./task-draft');
const { publish } = require('../publication/publisher');
const { manualIdFor } = require('../publication/release-store');
const { definitionRevision } = require('../model/revision');
const { validateTaskFinal } = require('./task-facts');
const { renderTask } = require('./render');
const { diffPacks } = require('./fact-pack');
const { validateCopy, checkPolishedMarkdown, formatFindings } = require('./markdown-validate');
const { validatePublication, validateCaptureCoverage, validateArtifact, summarizePrivacy, formatIssues } = require('../publication/validate');
const { RuntimeError } = require('../runtime/errors');
const { reconcileDocument } = require('./manual-store');
const { checkedSections } = require('../model/links');

function failure(code, errors, extra = {}) {
  const list = Array.isArray(errors) ? errors : [errors];
  return new RuntimeError(code, list.join(' '), { errors: list, ...extra });
}

/** errors 里的第一条通常以 "<code>: " 开头；取出来作为分类码。 */
function codeOf(errors, fallback) {
  const match = /^([a-z][a-z0-9-]+):/.exec(String(errors?.[0] || ''));
  return match ? match[1] : fallback;
}

function manualFileFor(root, config, taskId) {
  return path.join(root, config.docs.outputDir, 'tasks', `${taskId}.md`);
}

function draftPaths(root, config, taskId) {
  const draftDir = path.join(root, config.artifacts.stateDir, 'drafts', 'tasks');
  return { draftDir, draftFile: path.join(draftDir, `${taskId}.md`), factsFile: path.join(draftDir, `${taskId}.facts.json`) };
}

function loadTask({ projectRoot, config, taskId }) {
  const state = path.join(projectRoot, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs: state, docsOutputDir: config.docs.outputDir });
  let base;
  try { base = projectStore.load(); } catch (error) { throw failure('invalid-model', error.errors || [error.message]); }
  const task = base.model.tasks.find((t) => t.id === taskId);
  if (!task) throw failure('unknown-target', `找不到任务: ${taskId}`);
  return { projectStore, base, task, pages: base.model.pages, tasks: base.model.tasks };
}

/** 按当前任务与证据重新构建事实包（草稿与定稿共用）。 */
function buildCurrent({ root, config, task, pages = [], tasks = [] }) {
  if (!task.evidenceManifest) return { ok: false, errors: ['任务缺少 evidenceManifest。'] };
  const evidenceFile = path.join(root, task.evidenceManifest);
  if (!fs.existsSync(evidenceFile)) return { ok: false, errors: [`证据清单不存在: ${evidenceFile}`] };
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  try {
    return buildTaskDraft(task, evidence, {
      projectRoot: root, stateDir: path.join(root, config.artifacts.stateDir), finalPath: manualFileFor(root, config, task.id), language: config.docs.language,
      entryPage: pages.find((page) => page.id === task.entryPage),
      taskTitles: new Map(tasks.map((item) => [item.id, item.title])),
    });
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

/** 草稿之后事实（任务定义、证据、图片内容、模板）变了：旧草稿不能再发布。 */
function checkDraftFresh({ root, config, task, pages, tasks, facts }) {
  if (!facts.factPack) return { ok: true, legacy: true };
  const current = buildCurrent({ root, config, task, pages, tasks });
  if (!current.ok) return current;
  if (current.pack.factsHash !== facts.factsHash) {
    return { ok: false, errors: [`draft-stale: 草稿之后事实发生变化（${diffPacks(facts.factPack, current.pack).join(', ')}），重新运行 manual generate-task ${task.id} 生成草稿。`] };
  }
  return { ok: true };
}

/** 文案审查结论：blocked 直接拒绝；review-required 需要 --accept-review。 */
function reviewGate(findings, acceptReview) {
  if (findings.blocked.length) return { ok: false, code: 'copy-blocked', errors: formatFindings(findings.blocked, '拒绝') };
  if (findings.review.length && !acceptReview) {
    return { ok: false, code: 'review-required', errors: [...formatFindings(findings.review, '需确认'), '确认这些内容属实后加 --accept-review 重新运行。'] };
  }
  return { ok: true, accepted: findings.review };
}

/** 生成事实草稿。返回文案块（模型可填写）与受保护事实。 */
function draftTask({ projectRoot, config, taskId }) {
  const { task, pages, tasks } = loadTask({ projectRoot, config, taskId });
  const coverageErrors = validateCaptureCoverage({ projectRoot, config, captureIds: task.lastCapture?.captureIds || [] });
  if (coverageErrors.length) throw failure(coverageErrors[0].code, formatIssues(coverageErrors));
  const usable = checkEvidenceUsable(task, pages);
  if (!usable.ok) throw failure(usable.code || codeOf(usable.errors, 'evidence-unusable'), usable.errors);
  const built = buildCurrent({ root: projectRoot, config, task, pages, tasks });
  if (!built.ok) throw failure('draft-failed', built.errors);
  // 草稿阶段就执行同一产物门槛：隐私未知或位置非法时不给出可定稿的草稿。
  const draftWarnings = [];
  const issues = built.facts.images.flatMap((image) => validateArtifact(image, { projectRoot, config, stage: 'draft', warnings: draftWarnings }));
  for (const warning of formatIssues(draftWarnings)) process.stderr.write(`[manual gate] ${warning}\n`);
  if (issues.length) throw failure(issues[0].code || 'publication-gate', formatIssues(issues));
  // 草稿绑定的采集：定稿时据此判断草稿是否已被更新的采集取代。
  built.facts.evidence = task.lastCapture
    ? { captureIds: task.lastCapture.captureIds || [], scopeHash: task.lastCapture.scopeHash, capturedAt: task.lastCapture.capturedAt }
    : { captureIds: null, legacy: true };
  built.facts.publication = { audience: config.privacy?.audience || 'public', ...summarizePrivacy(built.facts.images.map((image) => image.privacy)) };
  const { draftDir, draftFile, factsFile } = draftPaths(projectRoot, config, taskId);
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(draftFile, built.markdown, 'utf8');
  fs.writeFileSync(factsFile, JSON.stringify(built.facts, null, 2) + '\n', 'utf8');
  return {
    task, draftFile, factsFile, factsHash: built.pack.factsHash, facts: built.facts, pack: built.pack, markdown: built.markdown,
    copyBlocks: Object.fromEntries(Object.entries(built.pack.blocks).map(([id, block]) => [id, block.default])),
  };
}

/**
 * 写任何正式文件之前完成全部检查。copy（文案块对象）与 markdown（润色稿）二选一；都不给时使用默认文案块。
 * @returns {{ final, facts, manualFile, accepted }}
 */
function prepareTaskFinal({ projectRoot, config, taskId, copy = null, markdown = null, acceptReview = false, force = false, runId = null }) {
  const { task, pages, tasks } = loadTask({ projectRoot, config, taskId });
  const coverageErrors = validateCaptureCoverage({ projectRoot, config, captureIds: task.lastCapture?.captureIds || [] });
  if (coverageErrors.length) throw failure(coverageErrors[0].code, formatIssues(coverageErrors));
  const { draftFile, factsFile } = draftPaths(projectRoot, config, taskId);
  if (!fs.existsSync(factsFile)) throw failure('draft-missing', '缺少任务事实文件，请先生成草稿。');
  let facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const fresh = checkDraftFresh({ root: projectRoot, config, task, pages, tasks, facts });
  if (!fresh.ok) throw failure(codeOf(fresh.errors, 'draft-stale'), fresh.errors);
  let final;
  let review;
  const fromPack = markdown === null;
  if (fromPack) {
    if (!facts.factPack) throw failure('draft-legacy', '旧版草稿没有事实包，重新运行 generate-task 生成草稿后再用 --copy。');
    const blocks = copy || {};
    review = reviewGate(validateCopy(facts.factPack, blocks), acceptReview);
    final = renderTask(facts.factPack, blocks);
    // 发布记录中的 facts 描述实际发布的文档：UI 名称序列取自渲染结果，并记录采用的文案
    facts = { ...facts, uiTexts: [...final.matchAll(/「([^」]+)」/g)].map((m) => m[1]), copy: blocks };
  } else {
    final = markdown;
    const draftMarkdown = fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8') : '';
    review = reviewGate(checkPolishedMarkdown(draftMarkdown, final, facts.factPack), acceptReview);
  }
  if (!review.ok) throw failure(review.code, review.errors);
  const usable = checkEvidenceUsable(task, pages);
  if (!usable.ok) throw failure(usable.code || codeOf(usable.errors, 'evidence-unusable'), usable.errors);
  // 草稿必须基于任务当前这次采集：之后重新采集过，草稿里的图与结论就不再对应。
  if (task.lastCapture && JSON.stringify(facts.evidence?.captureIds || null) !== JSON.stringify(task.lastCapture.captureIds || [])) {
    throw failure('draft-stale', `draft-stale: 草稿基于较早的采集，重新运行 manual generate-task ${task.id} 生成草稿后再定稿。`);
  }
  const manualFile = manualFileFor(projectRoot, config, task.id);
  // 人工编辑保护：上次发布之后的手改与新生成三方合并；冲突不写正式文档（merge-conflict，等待输入）
  const generated = final;
  const reconciled = reconcileDocument({
    projectRoot, stateDirAbs: path.join(projectRoot, config.artifacts.stateDir), manualId: manualIdFor('task', task.id),
    documentFile: manualFile, generated, force, runId,
  });
  final = reconciled.markdown;
  const checked = validateTaskFinal(final, facts, { renderedFromPack: fromPack });
  if (!checked.ok) throw failure(codeOf(checked.errors, 'fact-mismatch'), checked.errors);
  const gate = validatePublication({ projectRoot, manualFile, markdown: final, images: facts.images, config });
  if (!gate.ok) throw failure(gate.errors[0]?.code || 'publication-gate', formatIssues(gate.errors));
  // internal 受众的待确认功能、旧证据覆盖度未知等：放行但必须说出来
  for (const warning of formatIssues(gate.warnings || [])) process.stderr.write(`[manual gate] ${warning}\n`);
  // 定稿可以重复执行（重新生成已发布文档）；status 只记录最近完成的操作。
  return { final, generated, facts, manualFile, accepted: review.accepted || [], merge: reconciled };
}

/**
 * 提交：发布事务（文档、发布记录、current 指针，按 journal 推进、可对账）→ 任务状态投影。
 * 两者不是一个事务：文档已替换而状态写入失败时报告 partial-commit，不伪称成功。
 */
function publishTaskFinal({ projectRoot, config, taskId, prepared, force = false, runId = null, hooks = {} }) {
  const { projectStore, base, task } = loadTask({ projectRoot, config, taskId });
  const { final, facts, manualFile, generated = null, merge = {} } = prepared;
  let published;
  const linked = checkedSections({ projectRoot, stateDirAbs: path.join(projectRoot, config.artifacts.stateDir), pack: facts.factPack,
    captureIds: task.lastCapture?.captureIds || task.captureIds || (facts.images || []).map((image) => image.captureId), kind: 'task', subjectId: task.id, audience: config.privacy?.audience });
  if (linked.errors.length) throw failure(linked.errors[0].code, formatIssues(linked.errors));
  try {
    published = publish({
      projectRoot,
      stateDirAbs: path.join(projectRoot, config.artifacts.stateDir),
      manualId: manualIdFor('task', task.id),
      documentFile: manualFile,
      markdown: final,
      facts,
      captureIds: task.lastCapture?.captureIds || task.captureIds || (facts.images || []).map((image) => image.captureId),
      definitionRevisions: { [task.id]: definitionRevision('userTask', task) },
      force,
      runId,
      hooks,
      generated,
      baseDocHash: merge.baseDocHash || null,
      acceptedEdits: merge.acceptedEdits || [],
      sections: linked.sections,
    });
  } catch (error) {
    if (error.transactionId && error.code !== 'publication-conflict' && !['file-busy', 'write-failed'].includes(error.code)) {
      throw failure(error.code || 'publication-failed', `${error.code || 'publication-failed'}: ${error.message}（事务 ${error.transactionId}，运行 manual publication repair 对账）`, { transactionId: error.transactionId });
    }
    throw failure(error.code || 'write-failed', `${error.code || 'write-failed'}: 正式文档未改变。${error.message}`);
  }
  try {
    // 以提交时的最新任务为基础只改 status，不覆盖并发采集写入的投影。
    projectStore.commit({ base, kind: 'observation', changes: { tasks: [{ ...task, status: 'generated' }] } });
  } catch (error) {
    throw failure('partial-commit', `partial-commit: 正式文档已更新，但任务状态写入失败（${error.code || error.message}）。重新运行 finalize 前请确认文档内容。`, {
      committed: [path.relative(projectRoot, manualFile).replace(/\\/g, '/')],
      release: published.release,
    });
  }
  return { manualFile, release: published.release };
}

module.exports = { draftTask, prepareTaskFinal, publishTaskFinal, manualFileFor, draftPaths, reviewGate, buildCurrent, checkDraftFresh };
