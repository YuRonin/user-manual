'use strict';

/*
 * 生成内容存档与定稿前的人工编辑对账（P3-06，契约 C10 / C11）。
 *
 *   .manual/releases/blobs/<sha256>.md     发布时"纯生成"的正文（不含人工内容），内容寻址、不可变
 *
 * 发布记录的 generatedBlob 指向它；下次生成时以它为三方合并的"旧生成"基准：
 *   旧生成（blob）/ 当前文档（可能被人改过）/ 新生成（本次渲染）。
 * 旧发布记录没有 blob：文档与上次发布一致时，当前文档即旧生成；不一致则无法三方比较 → 冲突。
 * 冲突不写正式文档：proposed.md / conflicts.txt 放在 runs/<runId>/merge/<manualId>/（无 Run 时 .manual/merge/），
 * 调用方得到 merge-conflict（等待输入）。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const releases = require('../publication/release-store');
const { RuntimeError } = require('../runtime/errors');
const { mergeManual, describeConflicts, MergeParseError } = require('./merge');

function blobsDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'releases', 'blobs');
}

function blobFileFor(stateDirAbs, hash) {
  const hex = String(hash || '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`invalid-blob-hash: ${hash}`);
  return path.join(blobsDirFor(stateDirAbs), `${hex}.md`);
}

/** 写入生成正文 blob（已存在则不重写）。返回 hex hash。 */
function writeGeneratedBlob(stateDirAbs, markdown) {
  const hex = sha256Hex(markdown);
  const file = blobFileFor(stateDirAbs, hex);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, markdown);
  }
  return hex;
}

/** 读取 blob 并校验 hash；缺失或被篡改返回 null（调用方按"无基准"处理）。 */
function readGeneratedBlob(stateDirAbs, hash) {
  if (!hash) return null;
  let file;
  try { file = blobFileFor(stateDirAbs, hash); } catch (_) { return null; }
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return sha256Hex(text) === String(hash).replace(/^sha256:/, '') ? text : null;
}

function mergeDirFor(stateDirAbs, manualId, runId) {
  return runId ? path.join(stateDirAbs, 'runs', runId, 'merge', manualId) : path.join(stateDirAbs, 'merge', manualId);
}

function hexOf(hash) {
  return String(hash || '').replace(/^sha256:/, '');
}

/**
 * 定稿前对账：决定要写入的正文。
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {string} p.stateDirAbs
 * @param {string} p.manualId
 * @param {string} p.documentFile     正式文档绝对路径
 * @param {string} p.generated        本次渲染的纯生成正文
 * @param {boolean} [p.force]         覆盖人工修改（旧版本仍在发布记录与 blob 中）
 * @param {string} [p.runId]
 * @returns {{ markdown, generated, baseDocHash, acceptedEdits, mode, previousReleaseId }}
 */
function reconcileDocument({ projectRoot, stateDirAbs, manualId, documentFile, generated, force = false, runId = null }) {
  const previous = releases.readCurrentRelease(stateDirAbs, manualId);
  const exists = fs.existsSync(documentFile);
  const documentPath = path.relative(projectRoot, documentFile).replace(/\\/g, '/');
  const plain = (mode, extra = {}) => ({ markdown: generated, generated, baseDocHash: null, acceptedEdits: [], mode, previousReleaseId: previous?.id || null, ...extra });
  if (!previous) return plain(exists ? 'untracked' : 'new');
  if (!exists) {
    if (force) return plain('recreated');
    throw new RuntimeError('document-missing', `${documentPath} 已发布过，但现在不存在（被删除或移动）。不会自动重建：确认要重新生成请加 --force；要下线该文档请把对应页面 / 任务标为 retired。`, {
      errors: [`document-missing: ${documentPath} 在上次发布（${previous.id}）之后被删除或移动。`],
      choices: ['--force 重新生成', '标记 retired'],
    });
  }
  const bytes = fs.readFileSync(documentFile);
  const current = bytes.toString('utf8');
  const currentHash = sha256Hex(bytes);
  if (force) return plain('forced', { baseDocHash: `sha256:${currentHash}` });
  const unchangedSincePublish = currentHash === hexOf(previous.documentHash);
  // 旧生成：优先 blob；旧发布记录没有 blob 且文档未被改过 → 当前文档就是上次的生成结果
  const base = readGeneratedBlob(stateDirAbs, previous.generatedBlob) ?? (unchangedSincePublish ? current : null);
  let merged;
  try {
    merged = mergeManual({ base, current, next: generated });
  } catch (error) {
    if (!(error instanceof MergeParseError)) throw error;
    merged = { ok: false, proposed: generated, conflicts: [{ blockId: '(document)', kind: 'structure-invalid', current, next: generated, message: error.message }], acceptedEdits: [], mode: 'conflict' };
  }
  if (merged.ok) {
    return { markdown: merged.markdown, generated, baseDocHash: `sha256:${currentHash}`, acceptedEdits: merged.acceptedEdits, mode: merged.mode, previousReleaseId: previous.id };
  }
  const dir = mergeDirFor(stateDirAbs, manualId, runId);
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(path.join(dir, 'proposed.md'), merged.proposed);
  writeFileAtomic(path.join(dir, 'conflicts.txt'), describeConflicts(merged.conflicts));
  writeFileAtomic(path.join(dir, 'conflicts.json'), JSON.stringify({
    manualId, documentPath, currentHash, baseReleaseId: previous.id, generatedHash: sha256Hex(generated),
    conflicts: merged.conflicts.map(({ blockId, kind }) => ({ blockId, kind })),
  }, null, 2) + '\n');
  const rel = (file) => path.relative(projectRoot, path.join(dir, file)).replace(/\\/g, '/');
  const blocks = merged.conflicts.map((c) => `${c.blockId}（${c.kind}）`).join('、');
  throw new RuntimeError('merge-conflict', `${documentPath} 的人工修改与新生成内容冲突：${blocks}。`, {
    errors: [
      `merge-conflict: ${documentPath} 的人工修改与新生成内容冲突：${blocks}。`,
      `提案：${rel('proposed.md')}；逐块对照：${rel('conflicts.txt')}。`,
      '处理方式：把提案内容合入正式文档后 resume；或把要保留的块头改为 owner=human 后 resume；或加 --force 用新生成覆盖。',
    ],
    proposed: rel('proposed.md'),
    conflicts: merged.conflicts.map(({ blockId, kind }) => ({ blockId, kind })),
  });
}

module.exports = { blobsDirFor, blobFileFor, writeGeneratedBlob, readGeneratedBlob, mergeDirFor, reconcileDocument };
