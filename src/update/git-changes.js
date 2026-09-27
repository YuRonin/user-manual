'use strict';

/*
 * 源码变更检测（P3-01）。
 *
 * Git 只是"哪些路径可能变了"的线索，最终以文件实际内容 hash 为准（impact.js 二次确认）。
 * 调用方式固定为 execFile('git', argv)：不经 shell 拼接，路径中的空格、中文、引号都原样传递；
 * 输出一律用 -z（NUL 分隔），rename 同时保留旧路径与新路径。
 *
 * 基线选择顺序：
 *   1. 显式 --base（必须是 Git 可解析的提交，否则报错，不静默降级）；
 *   2. 上次 release 记录的 sourceBaseline.gitCommit（提交已不存在时降级到内容快照）；
 *   3. 非 Git 项目 / 无可用提交：上次 release 的源码图快照（逐文件 hash 比较）；
 *   4. 都没有：full-rebuild-required —— 不能返回"零影响"。
 */

const { execFileSync } = require('child_process');

const { hashFile, GLOBAL_FILES } = require('../inspect/fingerprint');

class ChangeDetectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChangeDetectionError';
    this.code = code;
  }
}

// 默认不作为"业务源码变化"的目录：依赖包、构建产物、工具状态。docs 与 stateDir 由调用方按配置追加。
const DEFAULT_EXCLUDES = ['node_modules/', '.git/', '.next/', 'dist/', 'build/', 'out/', 'coverage/'];

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

/** 执行 git，返回 Buffer；失败抛出带 stderr 的错误。 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
}

function tryGit(cwd, args) {
  try { return git(cwd, args).toString('utf8'); } catch (_) { return null; }
}

/** 项目根是否位于 Git 工作树内（git 不可用时同样返回 false）。 */
function isGitWorkTree(projectRoot) {
  return (tryGit(projectRoot, ['rev-parse', '--is-inside-work-tree']) || '').trim() === 'true';
}

/** 解析为完整提交 id；不存在 / 不是提交时返回 null。 */
function resolveCommit(projectRoot, ref) {
  if (!ref || String(ref).startsWith('-')) return null;
  const out = tryGit(projectRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return out ? out.trim() : null;
}

function headCommit(projectRoot) {
  return resolveCommit(projectRoot, 'HEAD');
}

/**
 * 解析 `git diff --name-status -z` 输出。
 * 形状：STATUS\0path\0 或 R100\0old\0new\0（C 同理）。
 */
function parseNameStatus(output) {
  const parts = String(output).split('\0');
  const changes = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!status) continue;
    const kind = status[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = parts[i++];
      const newPath = parts[i++];
      changes.push({ status: kind, path: toPosix(newPath), oldPath: toPosix(oldPath), ...(status.length > 1 ? { score: Number(status.slice(1)) } : {}) });
    } else {
      changes.push({ status: kind, path: toPosix(parts[i++]) });
    }
  }
  return changes;
}

function parseNulList(output) {
  return String(output).split('\0').filter(Boolean).map(toPosix);
}

/**
 * 基线提交与当前工作树的差异：已提交 + staged + unstaged + untracked 全部计入。
 * 路径相对项目根（--relative），项目根之外的变化不计入。
 */
function gitChanges(projectRoot, baseCommit) {
  const diff = parseNameStatus(git(projectRoot, ['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '-M', '--relative', '--no-ext-diff', baseCommit, '--']).toString('utf8'));
  const staged = parseNulList(tryGit(projectRoot, ['diff', '--cached', '--name-only', '-z', '--relative', '--no-ext-diff']) || '');
  const unstaged = parseNulList(tryGit(projectRoot, ['diff', '--name-only', '-z', '--relative', '--no-ext-diff']) || '');
  const untracked = parseNulList(git(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8'));
  const seen = new Set(diff.map((c) => c.path));
  const changes = [...diff];
  for (const file of untracked) if (!seen.has(file)) changes.push({ status: '?', path: file });
  return { mode: 'git', base: baseCommit, head: headCommit(projectRoot), changes: sortChanges(changes), staged, unstaged, untracked };
}

/** 源码图中登记过的所有文件（页面依赖 + 全局配置）→ 基线 hash。 */
function graphFileHashes(graph) {
  const out = {};
  for (const node of Object.values(graph?.pages || {})) {
    for (const [file, hash] of Object.entries(node.files || {})) out[file] = hash;
  }
  for (const [file, hash] of Object.entries(graph?.globals || {})) out[file] = hash;
  return out;
}

/**
 * 非 Git 项目：用基线源码图逐文件比较实际内容。
 * 只能发现"基线登记过的文件"的修改与删除；新增依赖由新旧图的 union 在 impact 中发现。
 * 新增的全局配置文件（基线时不存在）也检查一遍。
 */
function snapshotChanges(projectRoot, baseGraph) {
  const baseline = graphFileHashes(baseGraph);
  const changes = [];
  for (const [file, hash] of Object.entries(baseline)) {
    const current = hashFile(projectRoot, file);
    if (current === hash) continue;
    changes.push({ status: current === 'missing' ? 'D' : (hash === 'missing' ? 'A' : 'M'), path: file });
  }
  for (const file of GLOBAL_FILES) {
    if (baseline[file] === undefined && hashFile(projectRoot, file) !== 'missing') changes.push({ status: 'A', path: file });
  }
  return { mode: 'snapshot', base: null, head: null, changes: sortChanges(changes) };
}

function sortChanges(changes) {
  return changes.sort((a, b) => a.path.localeCompare(b.path) || String(a.oldPath || '').localeCompare(String(b.oldPath || '')));
}

/**
 * 默认排除生成物 / 文档 / 工具状态目录；显式登记为依赖的文件（keep）除外。
 * rename 的新旧路径任一需要保留，整条变更就保留。
 */
function filterChanges(changes, { excludes = [], keep = new Set() } = {}) {
  const prefixes = [...DEFAULT_EXCLUDES, ...excludes.map((p) => toPosix(p).replace(/^\.\//, '').replace(/\/?$/, '/'))];
  const excluded = (file) => file && !keep.has(file) && prefixes.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix));
  const kept = [];
  const dropped = [];
  for (const change of changes) {
    const paths = [change.path, change.oldPath].filter(Boolean);
    if (paths.every(excluded)) dropped.push(change); else kept.push(change);
  }
  return { changes: kept, excluded: dropped };
}

/**
 * 选择基线并收集变更。
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {string} [p.base]                      显式 --base
 * @param {{ gitCommit?, graph? }} [p.baseline]   上次 release 的源码基线（graph 已按 graphRevision 读出）
 * @returns {{ mode:'git'|'snapshot'|'none', base, head, changes, fallback?, reason?, warnings }}
 */
function detectChanges({ projectRoot, base = null, baseline = {} }) {
  const warnings = [];
  const inGit = isGitWorkTree(projectRoot);
  if (base) {
    if (!inGit) throw new ChangeDetectionError('git-unavailable', `--base ${base} 需要 Git 工作树，但 ${projectRoot} 不在 Git 仓库中（或未安装 git）。`);
    const commit = resolveCommit(projectRoot, base);
    if (!commit) throw new ChangeDetectionError('git-base-invalid', `--base ${base} 不是可解析的提交。`);
    return { ...withSnapshot(gitChanges(projectRoot, commit), projectRoot, baseline.graph), requestedBase: base, warnings };
  }
  if (inGit && baseline.gitCommit) {
    const commit = resolveCommit(projectRoot, baseline.gitCommit);
    if (commit) return { ...withSnapshot(gitChanges(projectRoot, commit), projectRoot, baseline.graph), warnings };
    warnings.push(`上次发布记录的提交 ${String(baseline.gitCommit).slice(0, 12)} 已不存在（可能被 rebase），改用内容快照比较。`);
  }
  if (baseline.graph) return { ...snapshotChanges(projectRoot, baseline.graph), warnings };
  return {
    mode: 'none', base: null, head: inGit ? headCommit(projectRoot) : null, changes: [],
    fallback: 'full-rebuild-required',
    reason: baseline.gitCommit ? 'baseline-unavailable' : 'no-baseline',
    warnings,
  };
}

/**
 * 基线提交之后的工作区可能在发布时就是 dirty 的：Git diff 之外，再用基线源码图的内容 hash 补一遍，
 * 避免"发布时未提交的修改后来被还原"之类的情况被漏掉。
 */
function withSnapshot(result, projectRoot, graph) {
  if (!graph) return result;
  const known = new Set(result.changes.flatMap((c) => [c.path, c.oldPath].filter(Boolean)));
  const extra = snapshotChanges(projectRoot, graph).changes.filter((c) => !known.has(c.path));
  if (extra.length === 0) return result;
  return { ...result, changes: sortChanges([...result.changes, ...extra.map((c) => ({ ...c, via: 'snapshot' }))]) };
}

/** 发布时的 Git 状态（记录进 release.sourceBaseline）；非 Git 项目返回 null 字段。 */
function gitState(projectRoot) {
  if (!isGitWorkTree(projectRoot)) return { gitCommit: null, gitDirty: null };
  const status = tryGit(projectRoot, ['status', '--porcelain', '-z', '--untracked-files=normal', '--', '.']);
  return { gitCommit: headCommit(projectRoot), gitDirty: status === null ? null : status.length > 0 };
}

module.exports = {
  ChangeDetectionError, DEFAULT_EXCLUDES,
  git, isGitWorkTree, resolveCommit, headCommit, gitState,
  parseNameStatus, parseNulList, gitChanges, snapshotChanges, graphFileHashes, filterChanges, detectChanges,
  toPosix,
};
