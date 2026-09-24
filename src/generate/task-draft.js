'use strict';
const fs = require('fs');
const path = require('path');
const { toMarkdownHref, toPosix } = require('../publication/paths');
const { fileSha256 } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { computeClaims, claimLabel } = require('../evidence/claims');
const { createCaptureStore } = require('../evidence/store');
const { verifyCaptureRecord, describeProblems } = require('../evidence/integrity');

function publishedFromCapture(projectRoot, stateDir, captureId, artifactPath) {
  let captureRecord;
  try {
    captureRecord = createCaptureStore({ projectRoot, stateDirAbs: stateDir }).read(captureId);
  } catch (error) {
    return { ok: false, error: `${error.code || 'invalid-capture-record'}: ${error.message}` };
  }
  if (!captureRecord) return { ok: false, error: `capture-record-missing: ${captureId}` };
  const artifact = (captureRecord.artifacts || []).find((a) => a.kind === 'published');
  if (!artifact || artifact.path !== artifactPath) return { ok: false, error: `证据清单与 Capture ${captureId} 的发布图不一致。` };
  const integrity = verifyCaptureRecord(projectRoot, captureRecord, { kinds: ['published'] });
  if (!integrity.ok) return { ok: false, error: describeProblems(integrity.problems).join('；') };
  return { ok: true, sha256: artifact.sha256, privacy: captureRecord.privacy };
}

function uiTexts(text) { return [...String(text || '').matchAll(/「([^」]+)」/g)].map((m) => m[1]); }

/**
 * 生成任务草稿。
 * @param {object} context { projectRoot, finalPath }：finalPath 是正式文档的绝对路径，
 *   图片 href 必须相对它计算，而不是相对项目根。
 */
function buildTaskDraft(task, evidence, context = {}) {
  const { projectRoot, finalPath } = context;
  if (!projectRoot || !finalPath) return { ok: false, errors: ['生成任务草稿需要 projectRoot 与正式文档路径。'] };
  const errors = [];
  const byId = new Map((evidence?.steps || []).map((s) => [s.id, s]));
  const images = [];
  const hrefByShot = new Map();
  for (const record of evidence?.steps || []) {
    for (const shot of record.screenshots || []) {
      const artifactPath = toPosix(shot.annotated);
      if (!shot.annotated || !artifactPath.includes('/images/annotated/')) {
        errors.push(`步骤 ${record.id} 的正式图片必须来自 annotated 目录。`);
        continue;
      }
      const artifactFile = path.resolve(projectRoot, artifactPath);
      if (!fs.existsSync(artifactFile)) {
        errors.push(`步骤 ${record.id} 的发布图不存在: ${artifactPath}`);
        continue;
      }
      // 有 Capture 记录时 hash 与 privacy 以记录为准，且文件必须仍与记录一致；
      // 旧 manifest（无 captureId）退回为按当前文件计算 hash。
      let sha256 = fileSha256(artifactFile);
      let privacy = shot.privacy || null;
      if (shot.captureId && context.stateDir) {
        const fromRecord = publishedFromCapture(projectRoot, context.stateDir, shot.captureId, artifactPath);
        if (!fromRecord.ok) { errors.push(`步骤 ${record.id}: ${fromRecord.error}`); continue; }
        ({ sha256, privacy } = fromRecord);
      }
      const markdownHref = toMarkdownHref({ manualFile: finalPath, artifactFile });
      hrefByShot.set(shot, markdownHref);
      // sha256 固定草稿时的图片内容；privacy 只能来自采集时实际执行的检测记录，缺失即 unknown。
      images.push({ artifactPath, markdownHref, sha256, privacy, ...(shot.captureId ? { captureId: shot.captureId } : {}) });
    }
  }
  if (images.length === 0) errors.push('任务指南至少需要一张 annotated 关键状态截图。');
  if (errors.length) return { ok: false, errors };

  const L = [`# ${task.title}`, '', task.goal, '', '## 开始前', ''];
  for (const item of task.preconditions || []) L.push(`- ${item}`);
  L.push('', '## 操作步骤', '');
  task.steps.forEach((step, index) => {
    const record = byId.get(step.id);
    L.push(`<!-- step:${step.id} -->`, `${index + 1}. ${step.instruction}`);
    for (const shot of record?.screenshots || []) L.push('', `   ![步骤 ${index + 1}](${hrefByShot.get(shot)})`);
    if (record?.status === 'not-executed') L.push('', '   > 此操作未执行，指南停在提交前。');
    L.push('');
  });
  // 完成声明的等级由证据计算：只有对应断言在本次采集中 passed 才能写"已验证界面结果"。
  const claims = computeClaims(task, evidence);
  L.push('## 完成标志', '');
  const firstSkipped = task.steps.findIndex((step) => byId.get(step.id)?.status === 'not-executed');
  if (firstSkipped === 0) L.push('> 验证范围：本指南的步骤均未实际执行。', '');
  else if (firstSkipped > 0) L.push(`> 验证范围：只实际执行到第 ${firstSkipped} 步，之后的步骤未执行。`, '');
  for (const claim of claims) L.push(`<!-- claim:${claim.id} -->`, `${claimLabel(claim.status)}${claim.text}`, '');
  if ((task.branches || []).length) {
    L.push('## 条件分支', '');
    for (const b of task.branches) L.push(`- **${b.condition}**：${b.effect}`);
    L.push('');
  }
  if ((task.relatedTasks || []).length) {
    L.push('## 相关任务', '');
    for (const id of task.relatedTasks) L.push(`- ${id}`);
    L.push('');
  }
  const markdown = L.join('\n');
  return {
    ok: true,
    markdown,
    facts: {
      title: task.title,
      stepIds: task.steps.map((s) => s.id),
      images,
      uiTexts: task.steps.flatMap((s) => uiTexts(s.instruction)),
      claims: claims.map(({ id, text, status, assertionRefs, checkpoint, evidence: refs }) => ({ id, text, status, assertionRefs, checkpoint, evidence: refs })),
    },
  };
}

/** 兼容旧调用：委托给共享的原子写入（唯一 temp、fsync、rename）。 */
function publishAtomic(file, content) { return writeFileAtomic(file, content); }

module.exports = { buildTaskDraft, publishAtomic };
