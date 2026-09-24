'use strict';
const fs = require('fs');
const path = require('path');
const { toMarkdownHref, toPosix } = require('../publication/paths');
const { fileSha256 } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { computeClaims } = require('../evidence/claims');
const { buildTaskFactPack } = require('./fact-pack');
const { renderTask } = require('./render');
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
  const images = [];
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
      // sha256 固定草稿时的图片内容；privacy 只能来自采集时实际执行的检测记录，缺失即 unknown。
      images.push({ artifactPath, markdownHref, sha256, privacy, ...(shot.captureId ? { captureId: shot.captureId } : {}), stepId: record.id });
    }
  }
  if (images.length === 0) errors.push('任务指南至少需要一张 annotated 关键状态截图。');
  if (errors.length) return { ok: false, errors };

  // 事实包 → 确定性渲染：动作句、顺序、截图位置、完成声明都来自结构化数据；
  // 草稿里的说明段落是事实包声明的文案块，润色只能改这些块。
  const claims = computeClaims(task, evidence);
  let pack;
  try {
    pack = buildTaskFactPack({ task, evidence, images, claims, language: context.language || 'zh-CN' });
  } catch (error) {
    return { ok: false, errors: [`${error.code}: ${error.message}`] };
  }
  const markdown = renderTask(pack);
  return {
    ok: true,
    markdown,
    pack,
    facts: {
      // 旧 finalize 路径使用的结构化摘要（由事实包派生，不单独维护）
      title: pack.title,
      stepIds: pack.steps.map((s) => s.id),
      images: images.map(({ stepId, ...image }) => image),
      uiTexts: uiTexts(markdown.replace(/<!--[\s\S]*?-->/g, '')),
      claims: pack.claims,
      factPack: pack,
      factsHash: pack.factsHash,
    },
  };
}

/** 兼容旧调用：委托给共享的原子写入（唯一 temp、fsync、rename）。 */
function publishAtomic(file, content) { return writeFileAtomic(file, content); }

module.exports = { buildTaskDraft, publishAtomic };
