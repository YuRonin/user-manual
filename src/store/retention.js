'use strict';

/*
 * 产物保留策略与垃圾回收（P3-08）。
 *
 * 引用图的根（永不回收）：
 *   - 全部发布记录（当前与历史；发布记录元数据永久保留）及其 captureIds / artifacts / generatedBlob / 源码图快照
 *   - evidence/latest.json 的当前引用、页面模型 browser.latestCaptureId、任务 lastCapture / captureIds
 *   - 当前草稿 facts 引用的图片、当前源码图 graph.json
 *   - 未结束（pending / running / waiting_input / interrupted / failed）或租约仍在的 Run：整个 Run 目录与其 outputRefs
 *   - config.retention.pinnedCaptures 中固定的 Capture
 *
 * 可回收（全部需要"未被引用"且超过对应天数）：
 *   staging（默认 7 天）、diagnostics（7 天）、已结束 Run 的目录（30 天）、
 *   原图 raw / sanitized（30 天，被引用的 Capture 也适用——发布图与去敏元数据保留，但之后不能再重新标注，
 *   隐私 / 主题变化需要重新采集）、未被引用的 Capture 记录及其产物（30 天）、未被引用的正文 blob / 源码图快照。
 *
 * gc 默认 dry-run；--apply 在项目锁内重新计算计划，只删除与审阅时相同计划（planHash）中的对象，
 * 删除前逐个确认路径在允许的根目录内、不是指向外部的链接。
 */

const fs = require('fs');
const path = require('path');

const { revisionOf } = require('../util/hash');
const { isUuid } = require('../model/ids');

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION = { stagingDays: 7, diagnosticsDays: 7, runLogDays: 30, rawDays: 30, unreferencedCaptureDays: 30, pinnedCaptures: [] };
const FINISHED_RUN = new Set(['succeeded', 'cancelled']);

function retentionOf(config) {
  return { ...DEFAULT_RETENTION, ...(config.retention || {}) };
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function walkFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of listDir(d)) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function mtimeOf(file) {
  try { return fs.lstatSync(file).mtimeMs; } catch (_) { return 0; }
}

function sizeOf(target) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) return stat.size;
    return walkFiles(target).reduce((sum, f) => sum + (fs.lstatSync(f).size || 0), 0);
  } catch (_) { return 0; }
}

/** 收集引用图的根与可达对象。 */
function collectReferences({ projectRoot, config, now }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const captures = new Set();
  const files = new Set();        // 项目相对路径
  const blobs = new Set();
  const graphs = new Set();
  const activeRuns = new Set();
  const roots = [];

  // 发布记录（全部）
  const releasesDir = path.join(stateDirAbs, 'releases');
  for (const manual of listDir(releasesDir)) {
    if (!manual.isDirectory() || manual.name === 'blobs') continue;
    for (const entry of listDir(path.join(releasesDir, manual.name))) {
      if (!entry.name.endsWith('.json') || entry.name === 'current.json') continue;
      const release = readJson(path.join(releasesDir, manual.name, entry.name));
      if (!release) continue;
      roots.push(`release:${manual.name}/${release.id}`);
      for (const id of release.captureIds || []) captures.add(id);
      for (const artifact of release.artifacts || []) files.add(toPosix(artifact.path));
      for (const image of release.facts?.images || []) if (image.artifactPath) files.add(toPosix(image.artifactPath));
      if (release.generatedBlob) blobs.add(String(release.generatedBlob).replace(/^sha256:/, ''));
      if (release.sourceBaseline?.graphRevision) graphs.add(String(release.sourceBaseline.graphRevision).replace(/^sha256:/, ''));
    }
  }
  // 当前引用
  const latest = readJson(path.join(stateDirAbs, 'evidence', 'latest.json'));
  for (const id of Object.values(latest?.refs || {})) captures.add(id);
  // 模型投影（页面 / 任务 YAML 由 project store 物化；直接读取快照避免依赖加载）
  try {
    const { createProjectStore } = require('./project');
    const committed = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).readCommitted();
    for (const page of committed?.model?.pages || []) {
      if (page.browser?.latestCaptureId) captures.add(page.browser.latestCaptureId);
      if (page.browser?.published?.artifactPath) files.add(toPosix(page.browser.published.artifactPath));
    }
    for (const task of committed?.model?.tasks || []) {
      for (const id of [...(task.captureIds || []), ...(task.lastCapture?.captureIds || [])]) captures.add(id);
      if (task.evidenceManifest) files.add(toPosix(task.evidenceManifest));
    }
  } catch (_) { /* 模型不可读时只按其它根保守处理：见 plan 中的 modelUnreadable */ }
  // 草稿 facts
  for (const file of walkFiles(path.join(stateDirAbs, 'drafts')).filter((f) => f.endsWith('.facts.json'))) {
    const facts = readJson(file);
    for (const image of facts?.images || []) if (image.artifactPath) files.add(toPosix(image.artifactPath));
    for (const id of facts?.evidence?.captureIds || []) captures.add(id);
  }
  // 当前源码图
  const { readCurrentGraph, graphRevisionOf } = require('../inspect/index-store');
  const current = readCurrentGraph(stateDirAbs);
  if (current) graphs.add(graphRevisionOf(current).replace(/^sha256:/, ''));
  // 固定的 Capture
  for (const id of retentionOf(config).pinnedCaptures || []) captures.add(id);
  // 未结束或租约仍在的 Run
  const { createRunStore } = require('../runtime/store');
  const runStore = createRunStore({ projectRoot, stateDirAbs, now: () => now });
  for (const summary of runStore.list()) {
    let state = null;
    try { state = runStore.read(summary.id); } catch (_) { state = null; }
    const status = state?.run?.status || summary.status;
    if (!state || !FINISHED_RUN.has(status) || state.lease?.live) {
      activeRuns.add(summary.id);
      for (const task of state?.tasks || []) {
        for (const ref of task.outputRefs || []) {
          if (ref.kind === 'capture') captures.add(ref.ref);
          if (ref.kind === 'file' || ref.kind === 'request') files.add(toPosix(ref.ref));
        }
      }
    }
  }
  // Capture 记录引用的产物（被引用的 Capture 的发布图、衍生文件都保留；raw / sanitized 另按天数处理）
  const captureDir = path.join(stateDirAbs, 'evidence', 'captures');
  const records = new Map();
  for (const entry of listDir(captureDir)) {
    if (!entry.name.endsWith('.json')) continue;
    const record = readJson(path.join(captureDir, entry.name));
    if (record?.id) records.set(record.id, record);
  }
  for (const id of captures) {
    for (const artifact of records.get(id)?.artifacts || []) files.add(toPosix(artifact.path));
  }
  return { stateDirAbs, captures, files, blobs, graphs, activeRuns, records, roots };
}

/**
 * 计算回收计划（只读）。
 * @returns {{ planHash, items: Array<{ path, kind, reason, bytes, references: 0 }>, summary, roots }}
 */
function planRetention({ projectRoot, config, now = Date.now() }) {
  const policy = retentionOf(config);
  const refs = collectReferences({ projectRoot, config, now });
  const { stateDirAbs } = refs;
  const items = [];
  const rel = (abs) => toPosix(path.relative(projectRoot, abs));
  const add = (abs, kind, reason) => items.push({ path: rel(abs), kind, reason, bytes: sizeOf(abs), references: 0 });
  const olderThan = (abs, days) => now - mtimeOf(abs) > days * DAY;

  // staging：未被进程持有且超过天数
  for (const entry of listDir(path.join(stateDirAbs, 'evidence', 'staging'))) {
    const dir = path.join(stateDirAbs, 'evidence', 'staging', entry.name);
    if (olderThan(dir, policy.stagingDays)) add(dir, 'staging', `未提交的采集临时目录，超过 ${policy.stagingDays} 天`);
  }
  // diagnostics
  for (const file of walkFiles(path.join(projectRoot, config.artifacts.diagnosticsDir))) {
    if (olderThan(file, policy.diagnosticsDays)) add(file, 'diagnostics', `私有诊断截图，超过 ${policy.diagnosticsDays} 天`);
  }
  // 已结束的 Run
  for (const entry of listDir(path.join(stateDirAbs, 'runs'))) {
    if (!isUuid(entry.name) || refs.activeRuns.has(entry.name)) continue;
    const dir = path.join(stateDirAbs, 'runs', entry.name);
    const run = readJson(path.join(dir, 'run.json'));
    const finishedAt = Date.parse(run?.updatedAt || '') || mtimeOf(dir);
    if (now - finishedAt > policy.runLogDays * DAY) add(dir, 'run', `已结束的 Run（事件日志、模型交接、暂存文档），超过 ${policy.runLogDays} 天`);
  }
  // Capture：未被引用的整条记录；被引用的只清原图
  for (const [id, record] of refs.records) {
    const recordFile = path.join(stateDirAbs, 'evidence', 'captures', `${id}.json`);
    const observed = Date.parse(record.observedAt || '') || mtimeOf(recordFile);
    const old = (days) => now - observed > days * DAY;
    if (!refs.captures.has(id)) {
      if (!old(policy.unreferencedCaptureDays)) continue;
      add(recordFile, 'capture-record', `未被任何发布、当前引用、活动 Run 或固定项引用的 Capture，超过 ${policy.unreferencedCaptureDays} 天`);
      for (const artifact of record.artifacts || []) {
        const file = path.join(projectRoot, artifact.path);
        if (fs.existsSync(file) && !refs.files.has(toPosix(artifact.path)) && !items.some((i) => i.path === toPosix(artifact.path))) add(file, `capture-${artifact.kind}`, `随未引用的 Capture ${id} 回收`);
      }
      continue;
    }
    if (!old(policy.rawDays)) continue;
    for (const artifact of record.artifacts || []) {
      if (!['raw', 'sanitized'].includes(artifact.kind)) continue;
      const file = path.join(projectRoot, artifact.path);
      if (fs.existsSync(file) && !items.some((i) => i.path === toPosix(artifact.path))) {
        add(file, `capture-${artifact.kind}`, `原图保留 ${policy.rawDays} 天；发布图与记录保留，之后隐私 / 主题变化需要重新采集`);
      }
    }
  }
  // 未被引用的正文 blob 与源码图快照
  for (const entry of listDir(path.join(stateDirAbs, 'releases', 'blobs'))) {
    const hex = entry.name.replace(/\.md$/, '');
    if (!refs.blobs.has(hex)) add(path.join(stateDirAbs, 'releases', 'blobs', entry.name), 'generated-blob', '没有发布记录引用的生成正文');
  }
  for (const entry of listDir(path.join(stateDirAbs, 'index', 'graphs'))) {
    const hex = entry.name.replace(/\.json$/, '');
    const file = path.join(stateDirAbs, 'index', 'graphs', entry.name);
    if (!refs.graphs.has(hex) && olderThan(file, policy.unreferencedCaptureDays)) add(file, 'graph-snapshot', '没有发布记录引用的源码图快照');
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  const body = items.map(({ path: p, kind }) => ({ path: p, kind }));
  return {
    planHash: revisionOf(body),
    items,
    summary: { objects: items.length, bytes: items.reduce((s, i) => s + i.bytes, 0), byKind: items.reduce((m, i) => ({ ...m, [i.kind]: (m[i.kind] || 0) + 1 }), {}) },
    policy,
    roots: { releases: refs.roots.length, captures: refs.captures.size, activeRuns: [...refs.activeRuns] },
  };
}

/** 允许删除的根目录（项目内）：状态目录与各产物目录。 */
function allowedRoots(projectRoot, config) {
  const list = [config.artifacts.stateDir, config.artifacts.rawDir, config.artifacts.taskRawDir, config.artifacts.sanitizedDir, config.artifacts.diagnosticsDir, config.artifacts.annotatedDir]
    .filter(Boolean).map((dir) => path.resolve(projectRoot, dir));
  return [...new Set(list)];
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** 删除前的路径安全检查：在允许的根内；真实路径（跟随链接后）也在根内；不跟随链接删除外部内容。 */
function safeTarget(projectRoot, config, relative) {
  const target = path.resolve(projectRoot, relative);
  const roots = allowedRoots(projectRoot, config);
  if (!roots.some((root) => within(root, target))) return { ok: false, reason: 'outside-allowed-roots' };
  let stat;
  try { stat = fs.lstatSync(target); } catch (_) { return { ok: false, reason: 'missing' }; }
  if (stat.isSymbolicLink()) {
    // 链接本身在根内时只删链接，不跟随；指向根外的链接照样只删链接（不会删到外部）
    return { ok: true, target, link: true };
  }
  let real;
  try { real = fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target); } catch (_) { return { ok: false, reason: 'unresolvable' }; }
  const realRoots = roots.map((root) => { try { return fs.realpathSync(root); } catch (_) { return root; } });
  if (!realRoots.some((root) => within(root, real))) return { ok: false, reason: 'escapes-allowed-roots' };
  return { ok: true, target, directory: stat.isDirectory() };
}

/**
 * 执行回收：在项目锁内重新计算计划；给了 expectedPlanHash 时必须一致（审阅之后状态变了就拒绝）。
 * @returns {{ removed, skipped, planHash }}
 */
function applyRetention({ projectRoot, config, expectedPlanHash = null, now = Date.now(), lockOptions = {} }) {
  const { withLock } = require('./lock');
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  return withLock(stateDirAbs, () => {
    const plan = planRetention({ projectRoot, config, now });
    if (expectedPlanHash && plan.planHash !== expectedPlanHash) {
      const error = new Error(`回收计划在审阅之后发生了变化（${expectedPlanHash.slice(7, 19)} → ${plan.planHash.slice(7, 19)}），没有删除任何对象；重新运行 manual gc 审阅新计划。`);
      error.code = 'gc-plan-changed';
      error.planHash = plan.planHash;
      throw error;
    }
    const removed = [];
    const skipped = [];
    for (const item of plan.items) {
      const safe = safeTarget(projectRoot, config, item.path);
      if (!safe.ok) { skipped.push({ path: item.path, reason: safe.reason }); continue; }
      if (safe.link) fs.unlinkSync(safe.target);
      else fs.rmSync(safe.target, { recursive: !!safe.directory, force: true });
      removed.push(item);
    }
    return { removed, skipped, planHash: plan.planHash, summary: plan.summary };
  }, { name: 'project', ...lockOptions });
}

module.exports = { DEFAULT_RETENTION, retentionOf, collectReferences, planRetention, applyRetention, safeTarget, allowedRoots };
