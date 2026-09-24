'use strict';

/*
 * 显式、可重复执行的项目迁移：v1 工作副本 → v2 模型（契约 C01 / C02 / C04）。
 *
 *   plan    只读。列出每个实体的版本变化、拟生成的 ID（projectId、旧截图的 legacy Capture id）、
 *           无法证明的验证项、仍被公开引用的原图、需要重新采集的对象、facts 与 Markdown 的冲突。
 *           计划里固定 ID 映射与输入 hash；apply 使用同一份计划，输入变了就拒绝（migration-input-changed）。
 *   apply   备份将被覆盖的定义 → 登记 legacy Capture → 经 Project Store 提交 v2 模型 →
 *           转换 facts → 最后把 config.version 改为 2（旧版工具据此拒绝写入）。每一步写 journal，
 *           中途失败再次 apply 会从 journal 继续；已完成的项目再次 apply 不做任何事、不重新生成 projectId。
 *   rollback 用完整备份恢复定义、配置与 current 指针。
 *
 * 迁移不伪造证据：旧截图的记录只说明"文件存在、hash 是多少"，身份与交互验证一律 inconclusive；
 * 旧任务的 verified 不升级为当前验证，只保留为 legacy 历史。认证缓存按原 cacheKey 继续使用，
 * 缓存内容不进入备份。
 */

const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');

const { revision } = require('../model/revision');
const { newUuid, isUuid } = require('../model/ids');
const { sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { listMarkdownImages, toMarkdownHref } = require('../publication/paths');
const { createCaptureStore, imageSize } = require('../evidence/store');
const { reportLegacyArtifacts } = require('../commands/migrate-artifacts');
const { SCHEMA_VERSIONS, isProjectRelativePath } = require('../model/schema');
const { createProjectStore, readWorkingCopy } = require('./project');
const snap = require('./snapshot');

const MIGRATION_SCHEMA_VERSION = 1;
const PHASES = ['planned', 'backed-up', 'captures-registered', 'model-committed', 'facts-converted', 'completed'];

class MigrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    Object.assign(this, details);
  }
}

const toPosix = (value) => value.replace(/\\/g, '/');

function listFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, predicate));
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out.sort();
}

function migrationsDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'migrations');
}

// ---------------------------------------------------------------- 输入

/** 迁移会读取或覆盖的全部输入文件（项目相对路径）。 */
function inputFiles(projectRoot, stateDirAbs) {
  const rel = (file) => toPosix(path.relative(projectRoot, file));
  return [
    path.join(stateDirAbs, 'config.yaml'),
    path.join(stateDirAbs, 'current.json'),
    ...listFiles(path.join(stateDirAbs, 'pages'), (f) => /\.ya?ml$/.test(f)),
    ...listFiles(path.join(stateDirAbs, 'tasks'), (f) => /\.ya?ml$/.test(f)),
    ...listFiles(path.join(stateDirAbs, 'artifacts', 'manifests'), (f) => f.endsWith('--evidence.json')),
    ...listFiles(path.join(stateDirAbs, 'drafts'), (f) => f.endsWith('.facts.json')),
  ].filter((file) => fs.existsSync(file)).map(rel);
}

function inputHashOf(projectRoot, files) {
  return revision(Object.fromEntries(files.map((file) => [file, sha256Hex(fs.readFileSync(path.join(projectRoot, file)))])));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function artifactRef(projectRoot, kind, relative) {
  if (!relative || !isProjectRelativePath(relative)) return { missing: { kind, path: relative || null, reason: 'invalid-path' } };
  const file = path.join(projectRoot, relative);
  if (!fs.existsSync(file)) return { missing: { kind, path: relative, reason: 'file-missing' } };
  const bytes = fs.readFileSync(file);
  const size = imageSize(bytes);
  return { artifact: { kind, path: toPosix(relative), sha256: sha256Hex(bytes), bytes: bytes.length, ...(size || {}) } };
}

/** 旧观察一律不可证明：文件完整性可查，身份 / 状态 / 交互验证都是 inconclusive。 */
function isoOrEpoch(value) {
  const time = value ? new Date(value) : null;
  return time && !Number.isNaN(time.getTime()) ? time.toISOString() : new Date(0).toISOString();
}

function legacyValidations(observedAt) {
  return [
    { scope: 'artifact-integrity', check: 'legacy-file-hash', outcome: 'passed', checkedAt: new Date().toISOString() },
    { scope: 'page-identity', check: 'legacy-unknown', outcome: 'inconclusive', checkedAt: observedAt },
  ];
}

// ---------------------------------------------------------------- facts

function manualFileFor(projectRoot, config, facts, file) {
  const docs = config.docs.outputDir;
  const isTask = toPosix(file).includes('/drafts/tasks/');
  const id = path.basename(file).replace(/\.facts\.json$/, '');
  return path.join(projectRoot, docs, ...(isTask ? ['tasks', `${id}.md`] : [`${id}.md`]));
}

function planFacts(projectRoot, config, stateDirAbs) {
  const out = [];
  for (const file of listFiles(path.join(stateDirAbs, 'drafts'), (f) => f.endsWith('.facts.json'))) {
    const facts = readJson(file);
    const rel = toPosix(path.relative(projectRoot, file));
    if (!facts || !Array.isArray(facts.images)) { out.push({ file: rel, action: 'skip', reason: 'no-images' }); continue; }
    if (!facts.images.some((image) => typeof image === 'string')) { out.push({ file: rel, action: 'ok' }); continue; }
    const manualFile = manualFileFor(projectRoot, config, facts, file);
    const docHrefs = fs.existsSync(manualFile) ? listMarkdownImages(fs.readFileSync(manualFile, 'utf8')).map((image) => image.src) : null;
    const conflicts = [];
    const images = facts.images.map((image) => {
      if (typeof image !== 'string') return image;
      const asProject = path.resolve(projectRoot, image);
      const asDoc = path.resolve(path.dirname(manualFile), image);
      let artifactFile = null;
      if (isProjectRelativePath(image) && fs.existsSync(asProject)) artifactFile = asProject;
      else if (fs.existsSync(asDoc)) artifactFile = asDoc;
      if (!artifactFile) { conflicts.push({ image, reason: 'image-missing' }); return image; }
      const converted = {
        artifactPath: toPosix(path.relative(projectRoot, artifactFile)),
        markdownHref: toMarkdownHref({ manualFile, artifactFile }),
        // 旧 facts 没有 hash 与隐私记录：不用当前文件"补"出来，定稿 / 验证前必须重新生成
        sha256: null,
        privacy: null,
        legacy: true,
      };
      if (docHrefs && !docHrefs.includes(converted.markdownHref) && !docHrefs.includes(image)) {
        conflicts.push({ image, reason: 'markdown-sidecar-mismatch', manual: toPosix(path.relative(projectRoot, manualFile)) });
      }
      return converted;
    });
    out.push(conflicts.length ? { file: rel, action: 'conflict', conflicts } : { file: rel, action: 'convert', images });
  }
  return out;
}

// ---------------------------------------------------------------- 计划

function planMigration(projectRoot, config, rawConfig) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const working = readWorkingCopy(stateDirAbs);
  if (!working.ok) throw new MigrationError('invalid-model', `工作副本无法读取: ${working.errors.join('；')}`, { errors: working.errors });
  const files = inputFiles(projectRoot, stateDirAbs);
  const entities = [];
  const legacyCaptures = [];
  const unverifiable = [];
  const recapture = [];

  entities.push({ entity: 'config', id: 'config', file: toPosix(path.relative(projectRoot, path.join(stateDirAbs, 'config.yaml'))), oldVersion: rawConfig.version, newVersion: SCHEMA_VERSIONS.config });

  for (const page of working.model.pages) {
    entities.push({ entity: 'page', id: page.id, file: `${config.artifacts.stateDir}/pages/${page.id}.yaml`, oldVersion: page.schemaVersion || 1, newVersion: SCHEMA_VERSIONS.page });
    const browser = page.browser || {};
    if (browser.verified || page.confidence === 'verified') unverifiable.push({ entity: 'page', id: page.id, claim: 'browser.verified', becomes: 'legacy-unknown' });
    if (!browser.screenshot || browser.latestCaptureId) continue;
    const raw = artifactRef(projectRoot, 'raw', browser.screenshot);
    const published = browser.published?.artifactPath ? artifactRef(projectRoot, 'published', browser.published.artifactPath) : null;
    const artifacts = [raw.artifact, published?.artifact].filter(Boolean);
    const missing = [raw.missing, published?.missing].filter(Boolean);
    if (artifacts.length === 0) { recapture.push({ entity: 'page', id: page.id, reason: 'screenshot-missing', missing }); continue; }
    legacyCaptures.push({
      id: newUuid(), kind: 'page', subject: { pageId: page.id },
      observedAt: isoOrEpoch(browser.lastCapture),
      artifacts, missing, privacy: published?.artifact ? (browser.published.privacy || { status: 'unknown' }) : { status: 'unknown' },
    });
    if (missing.length) recapture.push({ entity: 'page', id: page.id, reason: 'artifact-missing', missing });
  }

  for (const task of working.model.tasks) {
    entities.push({ entity: 'task', id: task.id, file: `${config.artifacts.stateDir}/tasks/${task.id}.yaml`, oldVersion: task.schemaVersion || 1, newVersion: SCHEMA_VERSIONS.userTask, status: task.status });
    if (['verified', 'generated', 'captured'].includes(task.status)) {
      unverifiable.push({ entity: 'task', id: task.id, claim: `status=${task.status}`, becomes: 'approval: legacy-status（执行前需 approve-tasks 重新确认）' });
    }
    if (!task.evidenceManifest || (task.captureIds || []).length) continue;
    const manifest = readJson(path.join(projectRoot, task.evidenceManifest));
    if (!manifest) { recapture.push({ entity: 'task', id: task.id, reason: 'evidence-manifest-missing' }); continue; }
    for (const step of manifest.steps || []) {
      for (const shot of step.screenshots || []) {
        const rawPath = shot.raw ? toPosix(path.isAbsolute(shot.raw) ? path.relative(projectRoot, shot.raw) : shot.raw) : null;
        const raw = rawPath ? artifactRef(projectRoot, 'raw', rawPath) : null;
        const published = shot.annotated ? artifactRef(projectRoot, 'published', shot.annotated) : null;
        const artifacts = [raw?.artifact, published?.artifact].filter(Boolean);
        const missing = [raw?.missing, published?.missing].filter(Boolean);
        if (artifacts.length === 0) { recapture.push({ entity: 'task', id: task.id, step: step.id, reason: 'screenshot-missing', missing }); continue; }
        legacyCaptures.push({
          id: newUuid(), kind: 'task-step', subject: { taskId: task.id, stepId: step.id, timing: shot.timing || 'after' },
          observedAt: isoOrEpoch(manifest.capturedAt),
          artifacts, missing, privacy: shot.privacy || { status: 'unknown' },
        });
        if (missing.length) recapture.push({ entity: 'task', id: task.id, step: step.id, reason: 'artifact-missing', missing });
      }
    }
  }

  const artifactsReport = reportLegacyArtifacts(projectRoot, config);
  return {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    id: newUuid(),
    createdAt: new Date().toISOString(),
    inputHash: inputHashOf(projectRoot, files),
    inputFiles: files,
    projectId: isUuid(rawConfig.project?.id) ? rawConfig.project.id : newUuid(),
    config: { from: rawConfig.version, to: SCHEMA_VERSIONS.config },
    entities,
    legacyCaptures,
    unverifiable,
    recapture,
    rawPublicRefs: artifactsReport.ok ? artifactsReport.pending : [],
    facts: planFacts(projectRoot, config, stateDirAbs),
    // 认证缓存按原 cacheKey 继续使用：只记录别名，缓存内容不复制、不备份
    auth: { cacheKey: config.auth.cacheKey, action: 'keep-alias' },
  };
}

// ---------------------------------------------------------------- journal

function journalFileFor(stateDirAbs, id) {
  return path.join(migrationsDirFor(stateDirAbs), id, 'journal.json');
}

function writeJournal(stateDirAbs, id, journal) {
  const file = journalFileFor(stateDirAbs, id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ ...journal, updatedAt: new Date().toISOString() }, null, 2) + '\n');
}

function readJournals(stateDirAbs) {
  const dir = migrationsDirFor(stateDirAbs);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((id) => readJson(journalFileFor(stateDirAbs, id))).filter(Boolean);
}

// ---------------------------------------------------------------- apply

function backupFiles(projectRoot, stateDirAbs, plan) {
  const backupDir = path.join(migrationsDirFor(stateDirAbs), plan.id, 'backup');
  const convert = plan.facts.filter((f) => f.action === 'convert').map((f) => f.file);
  const files = [...new Set([...plan.inputFiles.filter((f) => /\.ya?ml$|current\.json$/.test(f)), ...convert])];
  for (const rel of files) {
    const target = path.join(backupDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, rel), target);
  }
  return { backupDir: toPosix(path.relative(projectRoot, backupDir)), files, hadPointer: plan.inputFiles.some((f) => f.endsWith('current.json')) };
}

/** 在原文上改版本号并补 project.id，保留用户注释与格式。 */
function migratedConfigText(text, projectId) {
  const hasId = isUuid(yaml.load(text)?.project?.id);
  const lines = text.split('\n').map((line) => (/^version:/.test(line) ? `version: ${SCHEMA_VERSIONS.config}` : line));
  if (!hasId) {
    const at = lines.findIndex((line) => /^project:/.test(line));
    if (at === -1) throw new MigrationError('invalid-config', 'config.yaml 缺少 project 块。');
    lines.splice(at + 1, 0, '  # 项目身份（UUID），由 manual migrate 写入。', `  id: ${projectId}`);
  }
  return lines.join('\n');
}

function migrateEntities(model, plan) {
  const capturesBySubject = new Map();
  for (const capture of plan.legacyCaptures) {
    const key = capture.kind === 'page' ? `page:${capture.subject.pageId}` : `task:${capture.subject.taskId}`;
    if (!capturesBySubject.has(key)) capturesBySubject.set(key, []);
    capturesBySubject.get(key).push(capture.id);
  }
  const pages = model.pages.map((page) => {
    const ids = capturesBySubject.get(`page:${page.id}`) || [];
    const browser = { ...(page.browser || {}) };
    if (ids.length) browser.latestCaptureId = ids[ids.length - 1];
    // 旧的"已验证"无法证明：降为明确的 legacy-unknown，而不是保留成当前验证
    if (browser.verified) { browser.verified = false; browser.identity = 'legacy-unknown'; }
    return {
      ...page,
      schemaVersion: SCHEMA_VERSIONS.page,
      lifecycle: page.lifecycle || 'active',
      confidence: page.confidence === 'verified' ? 'inferred' : page.confidence,
      browser,
    };
  });
  const tasks = model.tasks.map((task) => {
    const ids = capturesBySubject.get(`task:${task.id}`) || [];
    const approval = task.approval && typeof task.approval === 'object'
      ? task.approval
      : (task.status && task.status !== 'candidate'
        ? { status: 'approved', scopeHash: null, provenance: 'legacy-status', migratedFrom: task.status }
        : { status: 'pending', scopeHash: null });
    const next = { ...task, schemaVersion: SCHEMA_VERSIONS.userTask, approval };
    if (ids.length) next.captureIds = ids;
    if (task.status === 'verified') {
      // 旧 verified 不升级为当前验证：投影回 generated，并保留历史说明
      next.status = 'generated';
      next.lastVerification = { at: null, result: 'legacy-unknown', legacyStatus: 'verified' };
    }
    return next;
  });
  return { pages, tasks };
}

/**
 * @param {{ manifest?: object, hooks?: object }} options  manifest 为 dry-run 输出的计划
 */
function applyMigration(projectRoot, config, rawConfig, { manifest = null, hooks = {} } = {}) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const journals = readJournals(stateDirAbs);
  const done = journals.find((j) => j.phase === 'completed');
  if (rawConfig.version >= SCHEMA_VERSIONS.config && done) {
    return { ok: true, alreadyMigrated: true, migrationId: done.id, projectId: done.projectId };
  }
  // 未完成的迁移：从 journal 继续，使用它固定的计划（同一 projectId 与 Capture id）
  const resumable = journals.find((j) => j.phase !== 'completed' && j.phase !== 'rolled-back');
  let plan;
  let journal;
  if (resumable) {
    plan = readJson(path.join(migrationsDirFor(stateDirAbs), resumable.id, 'manifest.json'));
    if (manifest && manifest.id !== plan.id) throw new MigrationError('migration-in-progress', `迁移 ${plan.id} 尚未完成，先完成或回滚它。`);
    journal = resumable;
  } else {
    plan = manifest || planMigration(projectRoot, config, rawConfig);
    const current = inputHashOf(projectRoot, inputFiles(projectRoot, stateDirAbs));
    if (current !== plan.inputHash) {
      throw new MigrationError('migration-input-changed', '计划生成之后项目文件发生了变化，重新运行 manual migrate --dry-run 生成新计划。', { expected: plan.inputHash, actual: current });
    }
    const dir = path.join(migrationsDirFor(stateDirAbs), plan.id);
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomic(path.join(dir, 'manifest.json'), JSON.stringify(plan, null, 2) + '\n');
    journal = { id: plan.id, projectId: plan.projectId, phase: 'planned', inputHash: plan.inputHash, startedAt: new Date().toISOString() };
    writeJournal(stateDirAbs, plan.id, journal);
  }
  const step = (phase, fn) => {
    if (PHASES.indexOf(journal.phase) >= PHASES.indexOf(phase)) return;
    const extra = fn() || {};
    journal = { ...journal, ...extra, phase };
    writeJournal(stateDirAbs, plan.id, journal);
    hooks[`after:${phase}`]?.();
  };

  step('backed-up', () => ({ backup: backupFiles(projectRoot, stateDirAbs, plan) }));

  step('captures-registered', () => {
    const store = createCaptureStore({ projectRoot, stateDirAbs });
    for (const capture of plan.legacyCaptures) {
      store.importRecord({
        id: capture.id, kind: capture.kind, subject: capture.subject, runId: null, scenarioId: null, checkpointId: null,
        inputHash: null, modelRevision: null, sourceFingerprint: null, observedAt: capture.observedAt, finalUrl: null,
        spec: null, validations: legacyValidations(capture.observedAt), privacy: capture.privacy, artifacts: capture.artifacts,
        provenance: { mode: 'legacy', migrationId: plan.id, missing: capture.missing },
      });
    }
  });

  step('model-committed', () => {
    const projectStore = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
    const base = projectStore.load();
    const migrated = migrateEntities(base.model, plan);
    const result = projectStore.commit({ base, kind: 'definition', changes: migrated });
    return { modelRevision: result.modelRevision, revision: result.revision };
  });

  step('facts-converted', () => {
    for (const item of plan.facts.filter((f) => f.action === 'convert')) {
      const file = path.join(projectRoot, item.file);
      const facts = readJson(file);
      writeFileAtomic(file, JSON.stringify({ ...facts, images: item.images }, null, 2) + '\n');
    }
  });

  step('completed', () => {
    const file = path.join(stateDirAbs, 'config.yaml');
    const text = fs.readFileSync(file, 'utf8');
    writeFileAtomic(file, migratedConfigText(text, plan.projectId));
    return { completedAt: new Date().toISOString() };
  });

  return {
    ok: true, alreadyMigrated: false, migrationId: plan.id, projectId: plan.projectId,
    legacyCaptures: plan.legacyCaptures.map((c) => c.id), conflicts: plan.facts.filter((f) => f.action === 'conflict'),
    recapture: plan.recapture, unverifiable: plan.unverifiable, backup: journal.backup,
  };
}

/** 完整备份恢复：定义、配置、current 指针回到迁移前；登记的 legacy Capture 记录保留（不可变，无害）。 */
function rollbackMigration(projectRoot, config, migrationId) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const journal = readJson(journalFileFor(stateDirAbs, migrationId));
  if (!journal) throw new MigrationError('migration-not-found', `找不到迁移 ${migrationId}。`);
  if (!journal.backup) throw new MigrationError('migration-not-backed-up', '该迁移尚未完成备份，没有需要恢复的内容。');
  const backupDir = path.join(projectRoot, journal.backup.backupDir);
  const plan = readJson(path.join(migrationsDirFor(stateDirAbs), migrationId, 'manifest.json'));
  // 迁移前不存在的页面 / 任务文件不会被迁移创建；这里按备份逐个恢复
  for (const rel of journal.backup.files) fs.copyFileSync(path.join(backupDir, rel), path.join(projectRoot, rel));
  if (!journal.backup.hadPointer) fs.rmSync(snap.pointerFileFor(stateDirAbs), { force: true });
  writeJournal(stateDirAbs, migrationId, { ...journal, phase: 'rolled-back', rolledBackAt: new Date().toISOString(), planId: plan?.id });
  return { ok: true, restored: journal.backup.files };
}

module.exports = { planMigration, applyMigration, rollbackMigration, MigrationError, inputFiles, inputHashOf, PHASES };
