'use strict';

/*
 * 离线产物验证 verify --artifacts（默认模式，P3-03）。
 *
 * 范围：artifact-integrity / publication —— 正式文档与当前发布记录一致、图片存在且 hash 相符、
 * 隐私与发布门槛通过、结构化事实与证据一致。它不访问浏览器，通过只说明"文档与发布时的证据一致"，
 * 不代表当前网页行为未变（那是 verify --live 的范围）。
 */

const fs = require('fs');
const path = require('path');

const { createProjectStore } = require('../store/project');
const { readCurrentRelease, manualIdFor } = require('../publication/release-store');
const { fileHash } = require('../publication/publisher');
const { checkEvidenceUsable } = require('../model/approval');
const { validateTaskFinal } = require('../generate/task-facts');
const { validatePublication, formatIssues } = require('../publication/validate');

/** 读取任务、正式文档与事实文件。 */
function loadVerify(root, config, taskId) {
  const state = path.join(root, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs: state, docsOutputDir: config.docs.outputDir });
  let base;
  try { base = projectStore.load(); } catch (error) { return { ok: false, errors: error.errors || [error.message] }; }
  const task = base.model.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, errors: ['找不到任务。'] };
  const manual = path.join(root, config.docs.outputDir, 'tasks', `${task.id}.md`);
  // 以当前发布记录中的 facts 为准（草稿可变，可能已删除）；没有发布记录的旧项目才回退草稿 facts
  const release = readCurrentRelease(state, manualIdFor('task', task.id));
  const factsFile = path.join(state, 'drafts', 'tasks', `${task.id}.facts.json`);
  if (!fs.existsSync(manual)) return { ok: false, errors: ['正式文档不存在。'] };
  if (!release && !fs.existsSync(factsFile)) return { ok: false, errors: ['正式文档或事实文件不存在（也没有发布记录）。'] };
  const facts = release ? release.facts : JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  return { ok: true, state, projectStore, base, task, pages: base.model.pages, manual, release, markdown: fs.readFileSync(manual, 'utf8'), facts };
}

/** 只读检查（可重复执行，不改变任何文件）：审批与证据新鲜度、结构事实、发布门槛。 */
function prepareVerify({ root, config, task, pages = [], manual, markdown, facts, release = null }) {
  const usable = checkEvidenceUsable(task, pages);
  if (!usable.ok) return { ok: false, errors: usable.errors };
  const releaseErrors = [];
  if (release && fileHash(manual) !== release.documentHash) {
    releaseErrors.push(`document-modified: ${release.documentPath} 与当前发布记录 ${release.id} 不一致（发布后被修改），重新生成并定稿。`);
  }
  if (task.lastCapture && JSON.stringify(facts.evidence?.captureIds || null) !== JSON.stringify(task.lastCapture.captureIds || [])) {
    return { ok: false, errors: [`document-stale: 正式文档基于较早的采集，重新生成并定稿后再验证。`] };
  }
  // 验证可以重复执行；status 与 lastVerification 只记录最近一次结果（兼容投影，不是验证的前置条件）。
  const nextTask = { ...task, status: 'verified', lastVerification: { at: new Date().toISOString(), result: 'passed', scope: 'artifacts' } };
  const checked = validateTaskFinal(markdown, facts);
  if (!checked.ok) return { ok: false, errors: [...releaseErrors, ...checked.errors] };
  // 图片按正式文档所在目录解析，核对产物位置、hash 与隐私记录（与 finalize 同一门槛）。
  const gate = validatePublication({ projectRoot: root, manualFile: manual, markdown, images: facts.images, config });
  if (!gate.ok) return { ok: false, errors: [...releaseErrors, ...formatIssues(gate.errors)] };
  if (releaseErrors.length) return { ok: false, errors: releaseErrors };
  return { ok: true, nextTask, releaseId: release?.id || null };
}

/** 页面手册的产物验证：发布记录、文档 hash、图片与隐私门槛。 */
function verifyPageArtifacts({ root, config, pageId }) {
  const state = path.join(root, config.artifacts.stateDir);
  const release = readCurrentRelease(state, manualIdFor('page', pageId));
  if (!release) return { ok: false, errors: [`not-published: 页面 ${pageId} 还没有发布记录。`] };
  const manual = path.join(root, release.documentPath);
  if (!fs.existsSync(manual)) return { ok: false, errors: [`document-missing: ${release.documentPath} 不存在。`], release };
  const errors = [];
  if (fileHash(manual) !== release.documentHash) errors.push(`document-modified: ${release.documentPath} 与当前发布记录 ${release.id} 不一致（发布后被修改）。`);
  const markdown = fs.readFileSync(manual, 'utf8');
  const gate = validatePublication({ projectRoot: root, manualFile: manual, markdown, images: release.facts?.images || [], config });
  if (!gate.ok) errors.push(...formatIssues(gate.errors));
  return errors.length ? { ok: false, errors, release, manual } : { ok: true, release, manual, images: (release.facts?.images || []).map((i) => i.artifactPath) };
}

/** 错误列表 → 报告检查项。 */
function checksFromErrors(errors) {
  if (!errors.length) return [{ id: 'artifacts', scope: 'artifact-integrity', outcome: 'passed', checkedAt: new Date().toISOString() }];
  return errors.map((message, index) => {
    const code = /^([a-z][a-z0-9-]+):/.exec(String(message))?.[1] || 'artifact-check-failed';
    return { id: `artifacts#${index}`, scope: /privacy|publication|raw|unsafe/.test(code) ? 'publication' : 'artifact-integrity', outcome: 'failed', code, message: String(message).slice(0, 300), checkedAt: new Date().toISOString() };
  });
}

module.exports = { loadVerify, prepareVerify, verifyPageArtifacts, checksFromErrors };
