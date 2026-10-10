'use strict';

/*
 * 页面文档用例：`manual generate <page>` 与 Runtime 的 draft / validate / publish handler 共用。
 *
 *   draftPage         事实草稿（drafts/<id>.md）+ 发布事实（drafts/<id>.facts.json）
 *   preparePageFinal  写正式文件之前完成全部检查：草稿新鲜度、文案审查、事实比对、发布门槛
 *   publishPageFinal  发布事务（文档 + 不可变发布记录 + current 指针）
 *
 * 不做输出；失败抛 RuntimeError（code + errors 列表）。
 */

const fs = require('fs');
const path = require('path');

const { ANALYSIS, normalizePage, isActivePage } = require('../inspect/model');
const store = require('../inspect/store');
const { readIndexes, findForwardPage } = require('../inspect/index-store');
const { buildDraft } = require('./draft');
const { extractFacts, compareFacts } = require('./facts');
const { buildPageFactPack } = require('./fact-pack');
const { renderPage } = require('./render');
const { publish } = require('../publication/publisher');
const { manualIdFor } = require('../publication/release-store');
const { definitionRevision } = require('../model/revision');
const { validateCopy, checkPolishedMarkdown, formatFindings } = require('./markdown-validate');
const { writeText, displayPath } = require('../util/fsx');
const { toMarkdownHref } = require('../publication/paths');
const { validateArtifact, validatePublication, validateCaptureCoverage, formatIssues } = require('../publication/validate');
const { createCaptureStore } = require('../evidence/store');
const { verifyCaptureRecord, describeProblems } = require('../evidence/integrity');
const { RuntimeError } = require('../runtime/errors');
const { reconcileDocument } = require('./manual-store');
const { manualFromPack } = require('./manual-model');

function failure(code, errors, extra = {}) {
  const list = Array.isArray(errors) ? errors : [errors];
  return new RuntimeError(code, list.join(' '), { errors: list, ...extra });
}

function draftPathsFor(stateDirAbs, pageId) {
  return { draftPath: path.join(stateDirAbs, 'drafts', `${pageId}.md`), factsFile: path.join(stateDirAbs, 'drafts', `${pageId}.facts.json`) };
}

/** 读取页面模型并做 generate 需要的前置检查。 */
function loadPage(projectRoot, config, pageId) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const existing = store.readExistingPages(stateDirAbs);
  if (existing.errors.length > 0) throw failure('invalid-model', ['已有的页面文件解析失败：', ...existing.errors.map((e) => `  ${e}`)]);
  if (existing.pages.length === 0) throw failure('no-pages', ['.manual/pages/ 里还没有页面。先运行 `manual inspect` 扫描项目。']);
  const found = existing.pages.find((p) => p.id === pageId);
  if (!found) throw failure('unknown-target', [`找不到页面 "${pageId}"。已有: ${existing.pages.map((p) => p.id).join(', ')}`]);
  const page = normalizePage(found);
  const indexes = readIndexes(stateDirAbs);
  const indexContext = indexes.ok ? findForwardPage(indexes.forward, { id: page.id, route: page.route }) : null;
  return { page, stateDirAbs, indexContext };
}

/** 从已提交的 Capture 记录取页面发布图；记录缺失、无发布图或产物被改动都拒绝。 */
function publishedFromRecord({ projectRoot, stateDirAbs, captureId, sourceRevision = null }) {
  let record;
  try {
    record = createCaptureStore({ projectRoot, stateDirAbs }).read(captureId);
  } catch (error) {
    return { ok: false, errors: [`${error.code || 'invalid-capture-record'}: ${error.message}`] };
  }
  if (!record) return { ok: false, errors: [`capture-record-missing: 页面引用的 Capture ${captureId} 不存在。`] };
  const artifact = (record.artifacts || []).find((a) => a.kind === 'published');
  if (!artifact) return { ok: false, errors: [record.annotationCoverage && !record.annotationCoverage.ok
    ? `annotation-coverage-failed: ${record.annotationCoverage.failures.map((item) => `${item.feature_id}:${item.reason}`).join('、')}`
    : `unsafe-page-artifact: Capture ${captureId} 没有通过隐私检测的发布图。`] };
  // 截图之后源码变了：记录仍是真实的历史观察，但不再适用于当前页面
  if (record.sourceFingerprint && sourceRevision && record.sourceFingerprint !== sourceRevision) {
    return { ok: false, errors: [`evidence-stale: 页面源码在截图（${record.observedAt}）之后发生了变化，截图不再适用。`] };
  }
  const integrity = verifyCaptureRecord(projectRoot, record, { kinds: ['published'] });
  if (!integrity.ok) return { ok: false, errors: describeProblems(integrity.problems) };
  return { ok: true, artifactPath: artifact.path, sha256: artifact.sha256, privacy: record.privacy, captureId: record.id };
}

/**
 * 阶段一：事实草稿。
 * @returns {{ page, draftPath, factsFile, finalPath, markdown, facts, pack, image, indexContext }}
 */
function draftPage({ projectRoot, config, pageId, noScreenshot = false }) {
  const { page, stateDirAbs, indexContext } = loadPage(projectRoot, config, pageId);
  const coverageErrors = validateCaptureCoverage({ projectRoot, config, captureIds: [page.browser?.latestCaptureId] });
  if (coverageErrors.length) throw failure(coverageErrors[0].code, formatIssues(coverageErrors));
  const errors = [];
  // 事实优先级第一条：没有真实截图就没有可信的手册
  if (!page.browser?.screenshot && !noScreenshot) {
    errors.push(
      `"${page.id}" 还没有截图，生成的手册会缺少界面。先运行 \`manual capture ${page.id}\`。`,
      '确实要出纯文字版的话，加 --no-screenshot。'
    );
  }
  if (page.status?.sourceAnalysis !== ANALYSIS.COMPLETED) {
    errors.push(
      `"${page.id}" 还没完成源码分析（当前 ${page.status?.sourceAnalysis || '未知'}），缺少标题或用途。`,
      `先用 \`manual describe --id ${page.id} --title ... --purpose ...\` 补上。`
    );
  }
  if (!isActivePage(page)) errors.push(`page-not-active: "${page.id}" 当前是 ${page.lifecycle}，不能生成当前手册（历史发布仍保留）。`);
  if (page.includeInManual === false) errors.push(`"${page.id}" 标记为 includeInManual: false，不在手册范围内。`);
  if (errors.length > 0) throw failure(page.status?.sourceAnalysis !== ANALYSIS.COMPLETED ? 'analysis-required' : 'draft-precondition', errors);

  const finalPath = path.join(projectRoot, config.docs.outputDir, `${page.id}.md`);
  // 手册只能引用经过发布门槛的页面发布图（page.browser.published）；原图不能直接进文档。
  let image = null;
  if (!noScreenshot) {
    const published = page.browser?.published;
    if (!published) {
      throw failure('unsafe-page-artifact', [
        `unsafe-page-artifact: "${page.id}" 只有未经隐私处理的原始截图（${page.browser.screenshot}），不能进入手册。`,
        '当前版本尚未为页面截图生成经隐私检测的发布图；需要文字版手册可以加 --no-screenshot。',
      ]);
    }
    // 有 Capture 记录时以记录为准（页面 browser 块只是投影）；旧项目没有记录时沿用投影并由发布门槛核对 hash。
    const source = page.browser?.latestCaptureId
      ? publishedFromRecord({ projectRoot, stateDirAbs, captureId: page.browser.latestCaptureId, sourceRevision: page.analysis?.sourceRevision || null })
      : { ok: true, artifactPath: published.artifactPath, sha256: published.sha256 || null, privacy: published.privacy || null, captureId: null };
    if (!source.ok) throw failure(/^([a-z-]+):/.exec(source.errors[0])?.[1] || 'evidence-unusable', [...source.errors, `重新截一张: \`manual capture ${page.id}\``]);
    const artifactFile = path.resolve(projectRoot, source.artifactPath);
    // 截图记录在模型里但文件被删了——这属于事实缺失，必须说出来而不是生成一个坏链接
    if (!fs.existsSync(artifactFile)) throw failure('artifact-missing', [`页面模型记录的截图不存在: ${source.artifactPath}`, `重新截一张: \`manual capture ${page.id}\``]);
    image = {
      artifactPath: source.artifactPath,
      markdownHref: toMarkdownHref({ manualFile: finalPath, artifactFile }),
      sha256: source.sha256,
      privacy: source.privacy,
      ...(source.captureId ? { captureId: source.captureId } : {}),
    };
    const issues = validateArtifact(image, { projectRoot, config });
    if (issues.length > 0) throw failure(issues[0].code || 'publication-gate', formatIssues(issues));
  }

  let built;
  try {
    built = buildDraft(page, {
      docsOutputDir: config.docs.outputDir,
      pageFilePath: `.manual/pages/${page.id}.yaml`,
      includeScreenshot: !noScreenshot,
      indexContext,
      image,
      language: config.docs.language,
    });
  } catch (error) {
    throw failure('draft-failed', [error.message]);
  }
  const { markdown, facts, pack } = built;
  const { draftPath, factsFile } = draftPathsFor(stateDirAbs, page.id);
  writeText(draftPath, markdown);
  // 发布事实与草稿一起落盘：finalize 用它核对图片 hash 与隐私记录，而不是信任润色稿。
  writeText(factsFile, JSON.stringify({ pageId: page.id, images: image ? [image] : [], factPack: pack, factsHash: pack.factsHash }, null, 2) + '\n');
  return { page, draftPath, factsFile, finalPath, markdown, facts, pack, image, indexContext };
}

/** 草稿之后页面定义、源码指纹、截图记录或模板变了：旧草稿不能再发布。 */
function pageDraftStale(page, pack, language) {
  if (!pack) return null;
  const current = buildPageFactPack({ page, image: pack.artifacts[0] ? { ...pack.artifacts[0], captureId: page.browser?.latestCaptureId ?? pack.artifacts[0].captureId ?? null } : null, language, headerComments: pack.headerComments });
  const changed = ['inputRevision', 'templateRevision', 'language'].filter((key) => current[key] !== pack[key]);
  return changed.length ? `draft-stale: 草稿之后事实发生变化（${changed.join(', ')}），重新运行 \`manual generate ${page.id}\` 生成草稿。` : null;
}

function reviewFailure(findings, acceptReview) {
  if (findings.blocked.length) return { code: 'copy-blocked', errors: formatFindings(findings.blocked, '拒绝') };
  if (findings.review.length && !acceptReview) return { code: 'review-required', errors: ['review-required:', ...formatFindings(findings.review, '需确认'), '确认这些内容属实后加 --accept-review 重新运行。'] };
  return null;
}

/**
 * 写正式文件之前的全部检查。copy（文案块）与 markdown（润色稿）二选一；都不给时使用默认文案块。
 * 事实比对不通过：默认拒绝（fact-mismatch，附 violations）；fallbackDraft 时用草稿原文。
 * @returns {{ page, body, finalPath, draftPath, draftFacts, factCheck, violations }}
 */
function preparePageFinal({ projectRoot, config, pageId, copy = null, markdown = null, acceptReview = false, fallbackDraft = false, force = false, runId = null }) {
  const { page, stateDirAbs } = loadPage(projectRoot, config, pageId);
  const { draftPath, factsFile } = draftPathsFor(stateDirAbs, page.id);
  if (!fs.existsSync(draftPath)) throw failure('draft-missing', [`找不到事实草稿: ${displayPath(draftPath, projectRoot)}`, `先运行 \`manual generate ${page.id}\`。`]);
  const draftFactsEarly = fs.existsSync(factsFile) ? JSON.parse(fs.readFileSync(factsFile, 'utf8')) : {};
  const pack = draftFactsEarly.factPack || null;
  let stale;
  try { stale = pageDraftStale(page, pack, config.docs.language); } catch (error) { throw failure('draft-stale', [error.message]); }
  if (stale) throw failure('draft-stale', [stale]);

  const fromPack = markdown === null;
  let polished;
  if (fromPack) {
    // 推荐路径：只接收文案块，正文由事实包确定性渲染
    if (!pack) throw failure('draft-legacy', ['旧版草稿没有事实包，重新运行 `manual generate` 生成草稿后再用 --copy。']);
    const blocks = copy || {};
    const failed = reviewFailure(validateCopy(pack, blocks), acceptReview);
    if (failed) throw failure(failed.code, failed.errors);
    polished = renderPage(pack, blocks);
  } else {
    polished = markdown;
  }
  if (!polished.trim()) throw failure('empty-input', ['润色后的内容是空的。']);

  const draftMarkdown = fs.readFileSync(draftPath, 'utf8');
  // --copy：正文由事实包渲染、文案已由 validateCopy 检查，不再做草稿逐项比对
  const result = fromPack ? { ok: true, violations: [] } : compareFacts(extractFacts(draftMarkdown), extractFacts(polished));
  if (!fromPack && result.ok) {
    // 结构之外的正文检查：否定事实动作直接拒绝；新数字 / 单位与业务承诺需要人确认
    const failed = reviewFailure(checkPolishedMarkdown(draftMarkdown, polished, pack), acceptReview);
    if (failed) throw failure(failed.code, failed.errors);
  }

  const finalPath = path.join(projectRoot, config.docs.outputDir, `${page.id}.md`);
  // 事实校验没过：默认拒绝落盘；--fallback-draft 则按「事实优先」用草稿原文。
  if (!result.ok && !fallbackDraft) throw failure('fact-mismatch', ['事实校验未通过。'], { violations: result.violations, draftPath, pageId: page.id });

  const content = result.ok ? polished : draftMarkdown;
  const generated = content.replace(/\s*$/, '') + '\n';
  // 人工编辑保护：已发布文档的手改与新生成三方合并；从未发布过、却已存在的文档仍需 --force
  const merge = reconcileDocument({ projectRoot, stateDirAbs, manualId: manualIdFor('page', page.id), documentFile: finalPath, generated, force, runId });
  if (merge.mode === 'untracked' && !force) throw failure('document-exists', [`正式文档已存在: ${displayPath(finalPath, projectRoot)}`, '加 --force 覆盖。']);
  const body = merge.markdown;
  // 统一发布门槛（含 --fallback-draft）：图片引用、hash、产物位置与隐私记录都以草稿 facts 为准。
  if (!fs.existsSync(factsFile)) throw failure('draft-missing', [`缺少草稿事实文件: ${displayPath(factsFile, projectRoot)}`, `重新运行 \`manual generate ${page.id}\`。`]);
  const draftFacts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const coverageErrors = validateCaptureCoverage({ projectRoot, config, captureIds: [page.browser?.latestCaptureId] });
  if (coverageErrors.length) throw failure(coverageErrors[0].code, formatIssues(coverageErrors));
  const gate = validatePublication({ projectRoot, manualFile: finalPath, markdown: body, images: draftFacts.images || [], config });
  if (!gate.ok) throw failure(gate.errors[0]?.code || 'publication-gate', formatIssues(gate.errors));
  return { page, body, generated, merge, finalPath, draftPath, draftFacts, factCheck: result.ok ? 'passed' : 'failed-used-draft', violations: result.violations };
}

/** 发布事务；原子替换失败（如文件被占用）时旧文档保持不变。 */
function publishPageFinal({ projectRoot, config, prepared, force = false, runId = null, hooks = {} }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const { page, body, finalPath, draftFacts, generated = null, merge = {} } = prepared;
  try {
    const published = publish({
      projectRoot,
      stateDirAbs,
      manualId: manualIdFor('page', page.id),
      documentFile: finalPath,
      markdown: body,
      facts: draftFacts,
      captureIds: (draftFacts.images || []).map((image) => image.captureId).filter(Boolean),
      definitionRevisions: { [page.id]: definitionRevision('page', page) },
      force,
      runId,
      hooks,
      generated,
      baseDocHash: merge.baseDocHash || null,
      acceptedEdits: merge.acceptedEdits || [],
      sections: draftFacts.factPack ? manualFromPack(draftFacts.factPack).sections : null,
    });
    return { finalPath, release: published.release };
  } catch (error) {
    const hint = error.transactionId && !['file-busy', 'write-failed'].includes(error.code)
      ? `（事务 ${error.transactionId}，运行 manual publication repair 对账）`
      : '正式文档未改变。';
    throw failure(error.code || 'write-failed', [`${error.code || 'write-failed'}: ${error.message}${hint}`], { transactionId: error.transactionId || null });
  }
}

module.exports = { draftPage, preparePageFinal, publishPageFinal, loadPage, draftPathsFor, pageDraftStale };
