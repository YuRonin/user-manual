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

function publicationDirFor(stateDirAbs, transactionId) {
  return path.join(stateDirAbs, 'publication', transactionId);
}

function writeJournal(stateDirAbs, journal) {
  const file = path.join(publicationDirFor(stateDirAbs, journal.transactionId), 'journal.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

function readJournal(stateDirAbs, transactionId) {
  const file = path.join(publicationDirFor(stateDirAbs, transactionId), 'journal.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function listJournals(stateDirAbs) {
  const dir = path.join(stateDirAbs, 'publication');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((id) => readJournal(stateDirAbs, id)).filter(Boolean);
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
  }
  return { journal, release };
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
 */
function publish({ projectRoot, stateDirAbs, manualId, documentFile, markdown, facts, captureIds = [], definitionRevisions = {}, force = false, hooks = {} }) {
  const documentPath = toPosix(path.relative(projectRoot, documentFile));
  const oldDocHash = fileHash(documentFile);
  const newDocHash = hashOf(markdown);
  // 用户编辑冲突：文档与上次发布的版本不同（被手改过），不能静默覆盖
  const previous = releases.readCurrentRelease(stateDirAbs, manualId);
  if (!force && previous && oldDocHash && oldDocHash !== previous.documentHash && oldDocHash !== newDocHash) {
    throw new PublicationError('publication-conflict', `${documentPath} 在上次发布之后被手工修改过；确认要覆盖请加 --force（旧版本仍保留在发布记录中）。`);
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
    facts,
  };
  // 记录不完整（如旧 facts 没有图片 hash）必须在写任何文件之前发现
  const checked = validateRelease(release);
  if (!checked.ok) {
    throw new PublicationError('invalid-release', `发布记录不完整，未写入任何文件: ${checked.errors.map((e) => `${e.path} ${e.message}`).join('；')}`);
  }
  const dir = publicationDirFor(stateDirAbs, transactionId);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'document.md'), markdown);
  writeFileAtomic(path.join(dir, 'release.json'), JSON.stringify(release, null, 2) + '\n');
  const journal = { transactionId, manualId, documentPath, oldDocHash, newDocHash, releaseId: release.id, factsHash: release.factsHash, state: 'prepared', createdAt: new Date().toISOString() };
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
