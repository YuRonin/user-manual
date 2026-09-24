'use strict';

/*
 * 统一发布门槛：页面 finalize、任务 finalize、verify 都经过这里。
 *
 * 顺序（契约 C05）：引用解析 → 文件存在 → hash → 产物位置 → privacy 结果。
 * 缺少 privacy 记录不等于"没有风险"，而是 unknown；public 模式下 unknown 阻止发布。
 */

const fs = require('fs');
const path = require('path');

const { checkDocumentImages, normalizeImageFact, toPosix } = require('./paths');
const { fileSha256, revisionOf } = require('../util/hash');

const DETECTOR_VERSION = '1';
const SAFE_MASK_STYLES = ['neutral-mosaic', 'soft-solid'];

function policyRevision(config) {
  const privacy = config.privacy || {};
  return revisionOf({
    audience: privacy.audience || 'public',
    redaction: privacy.redaction || null,
    maskStyle: privacy.maskStyle || null,
    rules: privacy.rules || { redact: [], preserve: [] },
  });
}

/**
 * 由一次实际执行的检测结果构造 PrivacyResult。
 * 强制遮罩但没有可用几何的高风险项进入 unresolved——不能被静默过滤后当作安全。
 */
function buildPrivacyRecord({ redactions = [], config }) {
  const unresolved = [];
  const applied = [];
  for (const item of redactions) {
    const rect = item.rect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) unresolved.push({ kind: item.kind, confidence: item.confidence || null });
    else applied.push(item);
  }
  const maskStyles = [...new Set(applied.map((item) => item.result).filter(Boolean))].sort();
  const unsafe = maskStyles.filter((style) => !SAFE_MASK_STYLES.includes(style));
  return {
    status: unresolved.length === 0 && unsafe.length === 0 ? 'passed' : 'failed',
    policyRevision: policyRevision(config),
    detectorVersion: DETECTOR_VERSION,
    coverage: 'declared-dom',
    unresolved,
    maskStyles,
  };
}

/** 多张图的 privacy 汇总；任何一张缺记录都使汇总为 unknown。 */
function summarizePrivacy(records) {
  if (!records.length) return { status: 'passed', unresolved: [], maskStyles: [] };
  if (records.some((record) => !record)) return { status: 'unknown', unresolved: [], maskStyles: [] };
  return {
    status: records.every((record) => record.status === 'passed') ? 'passed' : 'failed',
    unresolved: records.flatMap((record) => record.unresolved || []),
    maskStyles: [...new Set(records.flatMap((record) => record.maskStyles || []))].sort(),
  };
}

function dirPrefix(dir) {
  return path.posix.normalize(toPosix(dir)).replace(/\/$/, '') + '/';
}

/** 任何受众都不能发布的本地产物目录。 */
function forbiddenPrefixes(config) {
  const a = config.artifacts || {};
  const state = a.stateDir || '.manual';
  return [
    `${state}/artifacts/`, a.taskRawDir, a.sanitizedDir, a.diagnosticsDir, a.manifestsDir, a.rawDir,
  ].filter(Boolean).map(dirPrefix);
}

/** 旧版默认把页面原图放在文档目录下；这些引用给出重新采集建议。 */
function legacyRawPrefixes(config) {
  const docs = dirPrefix(config.docs?.outputDir || 'docs/manual');
  return [...new Set([config.artifacts?.rawDir, `${docs}images/raw`].filter(Boolean).map(dirPrefix))]
    .filter((prefix) => prefix.startsWith(docs));
}

function issue(code, message, extra = {}) {
  return { code, message, ...extra };
}

/**
 * 检查一个产物条目本身（不含文档引用）：位置、hash、privacy。
 * @param entry { artifactPath, sha256, privacy }
 */
function validateArtifact(entry, { projectRoot, config }) {
  const errors = [];
  const audience = config.privacy?.audience === 'internal' ? 'internal' : 'public';
  const artifactPath = path.posix.normalize(toPosix(entry.artifactPath));
  const shown = artifactPath;

  if (!entry.artifactPath || artifactPath.startsWith('../') || path.posix.isAbsolute(artifactPath)) {
    return [issue('invalid-artifact-path', `产物路径无效: ${shown}`)];
  }
  if (legacyRawPrefixes(config).some((prefix) => artifactPath.startsWith(prefix))) {
    errors.push(issue('legacy-raw-reference', `引用了未经隐私处理的页面原图: ${shown}`, {
      hint: '原图不能直接发布：把 artifacts.rawDir 改到 .manual/artifacts/raw/pages 后重新 `manual capture`，再重新 generate。',
    }));
  } else if (forbiddenPrefixes(config).some((prefix) => artifactPath.startsWith(prefix)) || /auth-cache/i.test(artifactPath)) {
    errors.push(issue('forbidden-artifact', `手册引用了本地原图/诊断/认证产物: ${shown}`));
  }
  if (audience === 'public' && !artifactPath.startsWith(dirPrefix(config.artifacts.annotatedDir))) {
    errors.push(issue('unpublishable-artifact', `公开手册只能引用 annotated 发布图: ${shown}`));
  }

  const absolute = path.resolve(projectRoot, artifactPath);
  if (!fs.existsSync(absolute)) {
    errors.push(issue('missing', `发布图不存在: ${shown}`));
  } else if (!entry.sha256) {
    errors.push(issue('integrity-unknown', `发布图缺少 sha256 记录，无法确认未被替换: ${shown}`));
  } else if (fileSha256(absolute) !== entry.sha256) {
    errors.push(issue('hash-mismatch', `发布图内容与生成草稿时不一致（可能被替换）: ${shown}`));
  }

  const privacy = entry.privacy;
  if (!privacy) {
    if (audience === 'public') errors.push(issue('privacy-unknown', `发布图没有隐私检测记录，不能公开发布: ${shown}`));
  } else {
    if (privacy.status !== 'passed') errors.push(issue('privacy-failed', `发布图隐私检测未通过（${privacy.status}）: ${shown}`));
    if ((privacy.unresolved || []).length) errors.push(issue('privacy-unresolved', `存在无法可靠定位的高风险隐私内容: ${shown}`));
    const unsafe = (privacy.maskStyles || []).filter((style) => !SAFE_MASK_STYLES.includes(style));
    if (unsafe.length) errors.push(issue('unsafe-mask-style', `使用了不安全的遮罩样式 ${unsafe.join(', ')}: ${shown}`));
    if (privacy.policyRevision && privacy.policyRevision !== policyRevision(config) && audience === 'public') {
      errors.push(issue('privacy-policy-changed', `隐私策略已变更，需要重新采集: ${shown}`));
    }
  }
  return errors;
}

/**
 * 发布前的完整检查。
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {string} p.manualFile   正式文档路径（绝对或项目根相对）
 * @param {string} p.markdown     将要写入/已写入的内容
 * @param {Array}  p.images       facts 中的图片条目 { artifactPath, markdownHref, sha256, privacy }
 * @param {object} p.config
 * @returns {{ ok: boolean, errors: Array<{code, message}> }}
 */
function validatePublication({ projectRoot, manualFile, markdown, images = [], config }) {
  const errors = [];
  const refs = checkDocumentImages({
    projectRoot, manualFile, markdown, publishRoot: config.docs.outputDir, expected: images,
  });
  errors.push(...refs.errors);
  for (const entry of images) {
    const fact = normalizeImageFact(entry);
    if (fact.legacy) continue; // checkDocumentImages 已报告 legacy-image-facts
    errors.push(...validateArtifact({ ...entry, artifactPath: fact.artifactPath }, { projectRoot, config }));
  }
  return { ok: errors.length === 0, errors };
}

function formatIssues(errors) {
  return errors.map((e) => (e.hint ? `${e.code}: ${e.message}（${e.hint}）` : `${e.code}: ${e.message}`));
}

module.exports = {
  DETECTOR_VERSION,
  SAFE_MASK_STYLES,
  policyRevision,
  buildPrivacyRecord,
  summarizePrivacy,
  validateArtifact,
  validatePublication,
  formatIssues,
  legacyRawPrefixes,
};
