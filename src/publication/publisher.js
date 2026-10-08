'use strict';

/*
 * 发布事务（契约 C10）。
 *
 *   prepared → assets-installed → document-installed → release-committed → completed
 *
 * prepared 之前完成全部检查（调用方负责审批 / 事实 / 发布门槛），并在这里再检查用户编辑冲突：
 * 正式文档当前内容既不是上次发布的版本、也不是本次要写的版本 → publication-conflict。
 * 图片由 Capture Store 按内容寻址安装，本阶段只核对存在性与 hash；文档用同目录唯一 temp + rename；
 * 发布记录写在文档之后，current 指针最后更新。每个状态边界都原子写 journal，中断后由
 * reconcile.js 继续或报告冲突。普通 docs 路径存在文档已换、记录未写的短暂窗口：
 * 恢复协议保证最终一致，但这不是多文件瞬时原子事务。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { newUuid } = require('../model/ids');
const releases = require('./release-store');
const { validateRelease } = require('../model/schema');
const { currentSourceBaseline } = require('../update/baseline');
const { writeGeneratedBlob, readGeneratedBlob } = require('../generate/manual-store');

const STATES = ['prepared', 'assets-installed', 'document-installed', 'release-committed', 'completed'];

class PublicationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PublicationError';
    this.code = code;
    Object.assign(this, details);
  }
}

const toPosix = (value) => value.replace(/\\/g, '/');
const hashOf = (text) => `sha256:${sha256Hex(Buffer.from(text, 'utf8'))}`;

function fileHash(file) {
  return fs.existsSync(file) ? `sha256:${sha256Hex(fs.readFileSync(file))}` : null;
}

/*
 * 事务目录（契约 C10）：Run 内的发布放在 runs/<runId>/publication/<transactionId>/；
 * 没有 Run 的发布（兼容命令）与 Phase 1 旧事务在 .manual/publication/<transactionId>/。两处都会被读取。
 */
function journalRoots(stateDirAbs) {
  const roots = [path.join(stateDirAbs, 'publication')];
  const runs = path.join(stateDirAbs, 'runs');
  if (fs.existsSync(runs)) {
    for (const runId of fs.readdirSync(runs).sort()) {
      const dir = path.join(runs, runId, 'publication');
      if (fs.existsSync(dir)) roots.push(dir);
    }
  }
  return roots;
}

function publicationDirFor(stateDirAbs, transactionId, runId = null) {
  for (const root of journalRoots(stateDirAbs)) {
    const dir = path.join(root, transactionId);
    if (fs.existsSync(dir)) return dir;
  }
  return runId ? path.join(stateDirAbs, 'runs', runId, 'publication', transactionId) : path.join(stateDirAbs, 'publication', transactionId);
}

function writeJournal(stateDirAbs, journal) {
  const file = path.join(publicationDirFor(stateDirAbs, journal.transactionId, journal.runId || null), 'journal.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

function readJournal(stateDirAbs, transactionId) {
  const file = path.join(publicationDirFor(stateDirAbs, transactionId), 'journal.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function listJournals(stateDirAbs) {
  const out = [];
  for (const root of journalRoots(stateDirAbs)) {
    if (!fs.existsSync(root)) continue;
    for (const id of fs.readdirSync(root)) {
      const file = path.join(root, id, 'journal.json');
      if (fs.existsSync(file)) out.push(JSON.parse(fs.readFileSync(file, 'utf8')));
    }
  }
  return out;
}

/** 本次发布引用的图片：必须已按内容安装且 hash 与 facts 一致。 */
function checkAssets(projectRoot, artifacts) {
  const problems = [];
  for (const artifact of artifacts) {
    const file = path.join(projectRoot, artifact.path);
    const hash = fs.existsSync(file) ? sha256Hex(fs.readFileSync(file)) : null;
    if (!hash) problems.push(`artifact-missing: ${artifact.path}`);
    else if (hash !== String(artifact.sha256).replace(/^sha256:/, '')) problems.push(`hash-mismatch: ${artifact.path}`);
  }
  return problems;
}

/** 相同文档、证据和基线重复生成时复用当前发布记录。 */
function samePublication(previous, candidate) {
  if (!previous) return false;
  const fields = ['manualId', 'documentPath', 'documentHash', 'factsHash', 'captureIds', 'definitionRevisions',
    'language', 'templateRevision', 'artifacts', 'sourceBaseline', 'generatedBlob', 'acceptedEdits', 'sections', 'facts'];
  return fields.every((field) => JSON.stringify(previous[field] ?? null) === JSON.stringify(candidate[field] ?? null));
}

/** 按 journal 从当前状态推进到 completed。publish 与 reconcile 共用。 */
function advance(projectRoot, stateDirAbs, journal, hooks = {}) {
  const documentFile = path.join(projectRoot, journal.documentPath);
  const staged = fs.readFileSync(path.join(publicationDirFor(stateDirAbs, journal.transactionId), 'document.md'), 'utf8');
  const release = JSON.parse(fs.readFileSync(path.join(publicationDirFor(stateDirAbs, journal.transactionId), 'release.json'), 'utf8'));
  const move = (state) => {
    journal = { ...journal, state };
    writeJournal(stateDirAbs, journal);
    hooks[`after:${state}`]?.();
  };
  if (journal.state === 'prepared') {
    const problems = checkAssets(projectRoot, release.artifacts || []);
    if (problems.length) throw new PublicationError('publication-assets-invalid', `发布图不完整：${problems.join('；')}`, { transactionId: journal.transactionId });
    move('assets-installed');
  }
  if (journal.state === 'assets-installed') {
    const current = fileHash(documentFile);
    if (current !== journal.newDocHash) {
      if (current !== journal.oldDocHash) {
        throw new PublicationError('publication-conflict', `${journal.documentPath} 在发布过程中被修改过，保留该修改，不覆盖。`, { transactionId: journal.transactionId });
      }
      fs.mkdirSync(path.dirname(documentFile), { recursive: true });
      writeFileAtomic(documentFile, staged);
    }
    move('document-installed');
  }
  if (journal.state === 'document-installed') {
    if (fileHash(documentFile) !== journal.newDocHash) {
      throw new PublicationError('publication-conflict', `${journal.documentPath} 已被修改，发布记录不会指向与之不符的内容。`, { transactionId: journal.transactionId });
    }
    releases.writeRelease(stateDirAbs, release);
    move('release-committed');
  }
  if (journal.state === 'release-committed') {
    releases.setCurrent(stateDirAbs, release);
    move('completed');
    pruneHistory(stateDirAbs, release.manualId);
  }
  return { journal, release };
}

/**
 * 发布完成后清理：被取代的发布记录，以及只被它们引用的生成正文 blob。
 * 进行中事务暂存的 release.json 也算引用（它的 blob 已写、记录还没落盘）。
 * 清理是尽力而为：失败不影响已完成的发布，残留由 manual gc 回收。
 */
function pruneHistory(stateDirAbs, manualId) {
  try {
    const removed = releases.pruneSuperseded(stateDirAbs, manualId);
    const candidates = new Set(removed.map((r) => String(r.generatedBlob || '').replace(/^sha256:/, '')).filter(Boolean));
    if (!candidates.size) return;
    const keep = releases.referencedBlobs(stateDirAbs);
    for (const journal of listJournals(stateDirAbs)) {
      if (['completed', 'aborted'].includes(journal.state)) continue;
      try {
        const staged = JSON.parse(fs.readFileSync(path.join(publicationDirFor(stateDirAbs, journal.transactionId), 'release.json'), 'utf8'));
        if (staged.generatedBlob) keep.add(String(staged.generatedBlob).replace(/^sha256:/, ''));
      } catch (_) { return; } // 读不到进行中事务的引用：保守起见不删 blob
    }
    for (const hex of candidates) {
      if (keep.has(hex) || !/^[a-f0-9]{64}$/.test(hex)) continue;
      try { fs.unlinkSync(path.join(stateDirAbs, 'releases', 'blobs', `${hex}.md`)); } catch (_) { /* 已不存在 */ }
    }
  } catch (_) { /* 尽力而为 */ }
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {string} p.stateDirAbs
 * @param {string} p.manualId          release-store.manualIdFor(kind, id)
 * @param {string} p.documentFile      正式文档绝对路径
 * @param {string} p.markdown
 * @param {object} p.facts             定稿所依据的 facts（含 factPack），写入发布记录
 * @param {string[]} p.captureIds
 * @param {object} p.definitionRevisions
 * @param {boolean} [p.force]          覆盖上次发布之后的手工修改
 * @param {object} [p.hooks]           故障注入：after:<state>
 * @param {string} [p.runId]           Run 内发布时事务目录放在 runs/<runId>/publication/
 */
function publish({ projectRoot, stateDirAbs, manualId, documentFile, markdown, facts, captureIds = [], definitionRevisions = {}, force = false, hooks = {}, runId = null, sourceBaseline = null, generated = null, baseDocHash = null, acceptedEdits = [], sections = null }) {
  const documentPath = toPosix(path.relative(projectRoot, documentFile));
  const oldDocHash = fileHash(documentFile);
  const newDocHash = hashOf(markdown);
  // 用户编辑冲突：文档与上次发布的版本不同（被手改过），不能静默覆盖
  const previous = releases.readCurrentRelease(stateDirAbs, manualId);
  // baseDocHash：定稿前已把当前文档（含人工修改）三方合并进 markdown（P3-06）；只接受合并时看到的那个版本
  if (!force && previous && oldDocHash && oldDocHash !== previous.documentHash && oldDocHash !== newDocHash && oldDocHash !== baseDocHash) {
    throw new PublicationError('publication-conflict', `${documentPath} 在上次发布之后被手工修改过；确认要覆盖请加 --force（覆盖前的版本可从 Git 历史找回）。`);
  }
  for (const journal of listJournals(stateDirAbs)) {
    if (journal.documentPath === documentPath && !['completed', 'conflict', 'aborted'].includes(journal.state)) {
      throw new PublicationError('publication-in-progress', `${documentPath} 有未完成的发布事务 ${journal.transactionId}，先运行 manual publication repair。`);
    }
  }
  const transactionId = newUuid();
  const release = {
    schemaVersion: 1,
    id: newUuid(),
    manualId,
    documentPath,
    documentHash: newDocHash,
    factsHash: facts.factsHash || hashOf(JSON.stringify(facts)),
    captureIds: captureIds.filter(Boolean),
    definitionRevisions,
    language: facts.factPack?.language || null,
    templateRevision: facts.factPack?.templateRevision || null,
    artifacts: (facts.images || []).map((image) => ({ kind: 'published', path: image.artifactPath, sha256: String(image.sha256).replace(/^sha256:/, '') })),
    previousReleaseId: previous?.id || null,
    createdAt: new Date().toISOString(),
    // 源码基线：update 据此找出"发布之后改了什么"（P3-01）
    sourceBaseline: sourceBaseline || currentSourceBaseline(projectRoot, stateDirAbs),
    // 纯生成正文（不含人工内容）的 blob：下次生成时作为三方合并的"旧生成"
    generatedBlob: hashOf(generated ?? markdown),
    ...(acceptedEdits.length ? { acceptedEdits } : {}),
    ...(sections ? { sections } : {}),
    facts,
  };
  // 记录不完整（如旧 facts 没有图片 hash）必须在写任何文件之前发现
  const checked = validateRelease(release);
  if (!checked.ok) {
    throw new PublicationError('invalid-release', `发布记录不完整，未写入任何文件: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('；')}`);
  }
  if (oldDocHash === newDocHash && samePublication(previous, release) && readGeneratedBlob(stateDirAbs, release.generatedBlob) !== null) {
    const problems = checkAssets(projectRoot, release.artifacts);
    if (problems.length) throw new PublicationError('publication-assets-invalid', `发布图不完整：${problems.join('；')}`);
    return { transactionId: null, release: previous, reused: true };
  }
  writeGeneratedBlob(stateDirAbs, generated ?? markdown);
  const dir = publicationDirFor(stateDirAbs, transactionId, runId);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'document.md'), markdown);
  writeFileAtomic(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  const journal = { transactionId, manualId, documentPath, oldDocHash, newDocHash, releaseId: release.id, factsHash: release.factsHash, runId, state: 'prepared', createdAt: new Date().toISOString() };
  writeJournal(stateDirAbs, journal);
  hooks['after:prepared']?.();
  try {
    return { transactionId, ...advance(projectRoot, stateDirAbs, journal, hooks) };
  } catch (error) {
    // 文档还没换（仍是旧内容）就失败：事务作废，不阻塞下一次发布；已换文档的交给 repair 对账
    const latest = readJournal(stateDirAbs, transactionId);
    if (latest && ['prepared', 'assets-installed'].includes(latest.state) && fileHash(documentFile) === oldDocHash) {
      writeJournal(stateDirAbs, { ...latest, state: 'aborted', error: error.code || error.message });
    }
    error.transactionId = transactionId;
    throw error;
  }
}

module.exports = { STATES, PublicationError, publish, advance, listJournals, readJournal, writeJournal, fileHash, publicationDirFor };
