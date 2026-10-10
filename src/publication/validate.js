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
const { createCaptureStore } = require('../evidence/store');
const { verifyCaptureRecord } = require('../evidence/integrity');
const { verifyCoverage, verifyExplanations } = require('../annotations/coverage');
const { currentScope, staleness } = require('../annotations/proof');
const { createProjectStore } = require('../store/project');

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
function buildPrivacyRecord({ redactions = [], config, demo = null }) {
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
    coverage: demo ? 'demo-gate' : 'declared-dom',
    unresolved,
    maskStyles,
    // Demo 门禁结论（只有通过的截图才会走到这里）：数据来源、无法审计的区域数量；不含任何页面文本
    ...(demo ? { demo: { status: demo.status, sources: demo.sources, network: demo.network || null, surfaces: demo.surfaces || null, hiddenMatches: demo.hiddenMatches || 0 } } : {}),
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

function validateCaptureCoverage({ projectRoot, config, captureIds = [] }) {
  const store = createCaptureStore({ projectRoot, stateDirAbs: path.join(projectRoot, config.artifacts.stateDir) });
  const errors = [];
  for (const captureId of [...new Set(captureIds.filter(Boolean))]) {
    let record;
    try { record = store.read(captureId); }
    catch (error) { errors.push(issue('annotation-record-invalid', `${captureId}: ${error.message}`)); continue; }
    // 记录缺失是证据完整性问题，沿用 capture-record-missing，不改写成标注问题
    if (!record) { errors.push(issue('capture-record-missing', `Capture ${captureId} 不存在。`)); continue; }
    if (record?.annotationCoverage && !record.annotationCoverage.ok) {
      errors.push(issue('annotation-coverage-failed', `Capture ${captureId}: ${record.annotationCoverage.failures.map((item) => `${item.feature_id}:${item.reason}`).join(', ')}`));
    }
  }
  return errors;
}

/**
 * 标注门禁（B2-12 / B2-13 / B2-14）。真值来源：Capture 记录内嵌的精简证明（随仓库提交）；
 * 没有证明的旧记录退回读 annotations.json。artifacts 被删除时 annotations.json 只是可重建资源，不判失败。
 * frozen=true（verify 已发布的手册）：定义变化只提示证据过期，不改写历史截图的结论；发布前则必须重采。
 * 未确认的候选功能：public 阻断，internal 警告。
 */
function checkAnnotations({ projectRoot, config, record, captureId, markdown, audience, frozen, warnings, stage }) {
  const errors = [];
  const proof = record.annotationProof || null;
  const metadata = record.artifacts?.find((item) => item.kind === 'annotations');
  let data = proof;
  if (metadata && fs.existsSync(path.join(projectRoot, metadata.path))) {
    const integrity = verifyCaptureRecord(projectRoot, record, { kinds: ['annotations'] });
    if (!integrity.ok) return [issue('annotation-metadata-invalid', `Capture ${captureId} annotations.json failed integrity verification`)];
    if (!proof) {
      try {
        data = JSON.parse(fs.readFileSync(path.join(projectRoot, metadata.path), 'utf8'));
        if (data.version !== 1 || !Array.isArray(data.inventory) || !Array.isArray(data.plan) || !Array.isArray(data.rendered)) throw new Error('invalid annotations.json structure');
      } catch (error) { return [issue('annotation-metadata-invalid', `Capture ${captureId}: ${error.message}`)]; }
    }
  } else if (!proof && metadata) {
    return [issue('annotation-metadata-invalid', `Capture ${captureId}: annotations.json 缺失且记录里没有内嵌标注证明（旧证据），需要重新采集`)];
  }
  if (!data) {
    if (record.annotationCoverage) return [issue('annotation-metadata-missing', `Capture ${captureId} lacks annotations.json`)];
    // 旧证据没有覆盖结果：public 不能当作通过（T27），internal 只提示
    const unknown = issue('annotation-coverage-unknown', `Capture ${captureId} 没有标注覆盖记录（旧证据），覆盖度未知；重新采集后可发布。`);
    if (audience === 'public') return [unknown];
    warnings.push(unknown);
    return [];
  }
  const coverage = verifyCoverage({ inventory: data.inventory, plan: data.plan, rendered: data.rendered, candidates: data.candidates || [] });
  if (record.annotationCoverage && JSON.stringify(record.annotationCoverage.failures) !== JSON.stringify(coverage.failures)) {
    return [issue('annotation-metadata-invalid', `Capture ${captureId}: 标注证明与记录的覆盖结果不一致`)];
  }
  if (!coverage.ok) errors.push(issue('annotation-coverage-failed', `Capture ${captureId}: ${coverage.failures.map((item) => `${item.feature_id}:${item.reason}`).join(', ')}`));
  if (proof) {
    let scope;
    try { scope = currentScope(createProjectStore({ stateDirAbs: path.join(projectRoot, config.artifacts.stateDir), docsOutputDir: config.docs.outputDir }).load().model, record); }
    catch (error) { scope = { missing: `无法读取当前模型：${error.message}` }; }
    for (const problem of staleness(proof, scope, record)) {
      const found = issue(problem.code, `Capture ${captureId}: ${problem.message}`, { hint: '重新采集（manual generate --refresh 或 manual capture）后再发布' });
      if (frozen) warnings.push(found); else errors.push(found);
    }
  }
  const review = [...coverage.pending.map((item) => item.label), ...(coverage.unresolvedCandidates || []).map((item) => `${item.label}（页面发现）`)];
  if (review.length) {
    const found = issue('inventory-review-required', `Capture ${captureId}: ${review.length} 个功能待确认是否需要标注与说明：${review.slice(0, 10).join('、')}${review.length > 10 ? ' 等' : ''}`,
      { hint: '用 manual describe --input 在页面 features 里把它们确认为 required / optional / skip' });
    // 正式发布才阻断；草稿阶段只提示，便于先看到文案再补确认
    if (audience === 'public' && stage !== 'draft') errors.push(found); else warnings.push(found);
  }
  if (markdown !== null) for (const failure of verifyExplanations(markdown, data.inventory)) errors.push(issue('annotation-explanation-missing', `${failure.feature_id}: ${failure.reason}`));
  return errors;
}

/**
 * 检查一个产物条目本身（不含文档引用）：位置、hash、privacy。
 * @param entry { artifactPath, sha256, privacy }
 */
function validateArtifact(entry, { projectRoot, config, markdown = null, frozen = false, warnings = [], stage = 'publish' }) {
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
  if (entry.captureId) {
    const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
    let record;
    try { record = createCaptureStore({ projectRoot, stateDirAbs }).read(entry.captureId); }
    catch (error) { errors.push(issue('annotation-record-invalid', error.message)); }
    if (record && !record.artifacts?.some((item) => item.kind === 'published' && item.path === artifactPath)) errors.push(issue('annotation-capture-mismatch', `Capture ${entry.captureId} does not publish ${artifactPath}`));
    if (record) errors.push(...checkAnnotations({ projectRoot, config, record, captureId: entry.captureId, markdown, audience, frozen, warnings, stage }));
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
 * @param {boolean} [p.frozen]  核对已发布手册（verify）：定义变化只作提示
 * @returns {{ ok: boolean, errors: Array<{code, message}>, warnings: Array<{code, message}> }}
 */
function validatePublication({ projectRoot, manualFile, markdown, images = [], config, frozen = false }) {
  const errors = [];
  const warnings = [];
  const refs = checkDocumentImages({
    projectRoot, manualFile, markdown, publishRoot: config.docs.outputDir, expected: images,
  });
  errors.push(...refs.errors);
  for (const entry of images) {
    const fact = normalizeImageFact(entry);
    if (fact.legacy) continue; // checkDocumentImages 已报告 legacy-image-facts
    errors.push(...validateArtifact({ ...entry, artifactPath: fact.artifactPath }, { projectRoot, config, markdown, frozen, warnings }));
  }
  return { ok: errors.length === 0, errors, warnings };
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
  validateCaptureCoverage,
  formatIssues,
  legacyRawPrefixes,
};
