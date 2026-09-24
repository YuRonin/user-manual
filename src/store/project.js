'use strict';

/*
 * Project Store（契约 C02）：已提交快照是权威，根目录 YAML 是可编辑的工作副本。
 *
 * 读：
 *   - current.json 标记 materialized=false（上次提交写到一半）→ 先按快照修复工作副本；
 *   - 工作副本与 current 不同（用户手改了 YAML）→ 校验后导入为新快照，并重建索引；
 *   - 否则直接使用。
 * 写（commit）：
 *   命令先 load() 得到 base，在锁外完成耗时工作，然后 commit({ base, kind, changes })。
 *   锁内重新读取最新模型：
 *     - kind=definition：定义 revision 与 base 不同 → model-conflict，不覆盖别人的修改；
 *     - kind=observation：只允许改观察投影（截图、采集结果），不改变定义 revision。
 *   字段级三方合并：本次没改动的字段取最新值，所以 capture 不会覆盖 describe 的修改，反之亦然。
 *   提交顺序：不可变快照 → current.json（materialized=false）→ 工作副本与索引 → materialized=true。
 *   任一步失败，读者看到的都是一个完整的已提交模型（旧的或新的）。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const pageStore = require('../inspect/store');
const taskStore = require('../tasks/store');
const { normalizePage } = require('../inspect/model');
const { validateTask } = require('../tasks/model');
const { checkSchemaVersion } = require('../model/schema');
const { writeText } = require('../util/fsx');
const { sha256Hex } = require('../util/hash');
const { withLock } = require('./lock');
const snap = require('./snapshot');

const INDEX_SCHEMA_VERSION = 1;
const GENERATED_BY = `manual@${require('../../package.json').version}`;

class ProjectStoreError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectStoreError';
    this.code = code;
    Object.assign(this, details);
  }
}

function deepEqual(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

// ---------------------------------------------------------------- 工作副本

function readMeta(stateDirAbs) {
  const file = pageStore.projectFileFor(stateDirAbs);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'));
    return parsed?.project ? { ...parsed.project, generatedAt: parsed.generatedAt ?? null } : {};
  } catch (_) {
    return {}; // project.yaml 是派生索引，坏了可以由页面重建
  }
}

function readWorkingCopy(stateDirAbs) {
  const pages = pageStore.readExistingPages(stateDirAbs);
  const tasks = taskStore.readTasks(stateDirAbs);
  const errors = [...pages.errors, ...tasks.errors];
  if (errors.length) return { ok: false, errors };
  return { ok: true, model: snap.toJson({ meta: readMeta(stateDirAbs), pages: pages.pages, tasks: tasks.tasks }) };
}

/** 经过一次"渲染 → 解析"，保证写出的文件再读回来与快照完全一致。 */
function canonicalPage(page) {
  return snap.toJson(normalizePage(yaml.load(pageStore.renderPageYaml(page))));
}

function canonicalTask(task) {
  const checked = validateTask(yaml.load(taskStore.renderTaskYaml(task)));
  if (!checked.ok) throw new ProjectStoreError('invalid-model', `任务 ${task.id} 无效: ${checked.errors.join('；')}`);
  return snap.toJson(checked.task);
}

// ---------------------------------------------------------------- 索引信封

function indexMetaFileFor(stateDirAbs) {
  return path.join(pageStore.indexDirFor(stateDirAbs), 'meta.json');
}

const INDEX_FILES = {
  forward: pageStore.forwardIndexFileFor,
  reverse: pageStore.reverseIndexFileFor,
  taskForward: pageStore.taskForwardIndexFileFor,
  taskReverse: pageStore.taskReverseIndexFileFor,
};

/** 索引由指定 revision 派生：写入 meta.json 记录 revision 与各文件 hash。 */
function writeIndexesFor(stateDirAbs, model, { revision, modelRevision, docsOutputDir }) {
  pageStore.writeIndexes(stateDirAbs, model.pages, { docsOutputDir, tasks: model.tasks });
  const files = {};
  for (const [name, fileFor] of Object.entries(INDEX_FILES)) files[name] = sha256Hex(fs.readFileSync(fileFor(stateDirAbs)));
  writeText(indexMetaFileFor(stateDirAbs), JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION, revision, modelRevision, generatedBy: GENERATED_BY, generatedAt: new Date().toISOString(), files,
  }, null, 2) + '\n');
}

/** 索引是否对应当前提交：只能解析为 JSON 不够，revision 与文件 hash 都要对上。 */
function indexStatus(stateDirAbs) {
  const pointer = snap.readPointer(stateDirAbs);
  if (!pointer) return { ok: false, reason: 'no-committed-model' };
  let meta;
  try { meta = JSON.parse(fs.readFileSync(indexMetaFileFor(stateDirAbs), 'utf8')); } catch (_) { return { ok: false, reason: 'index-meta-missing' }; }
  if (meta.schemaVersion !== INDEX_SCHEMA_VERSION) return { ok: false, reason: 'index-schema-mismatch' };
  if (meta.revision !== pointer.revision) return { ok: false, reason: 'index-revision-mismatch' };
  for (const [name, fileFor] of Object.entries(INDEX_FILES)) {
    let hash;
    try { hash = sha256Hex(fs.readFileSync(fileFor(stateDirAbs))); } catch (_) { return { ok: false, reason: `index-missing:${name}` }; }
    if (meta.files?.[name] !== hash) return { ok: false, reason: `index-modified:${name}` };
  }
  return { ok: true, revision: pointer.revision };
}

// ---------------------------------------------------------------- 物化

function materialize(stateDirAbs, previous, next, { docsOutputDir, revision, modelRevision, hooks = {} }) {
  const prevPages = new Map((previous?.pages || []).map((p) => [p.id, p]));
  const prevTasks = new Map((previous?.tasks || []).map((t) => [t.id, t]));
  const nextPageIds = new Set(next.pages.map((p) => p.id));
  const nextTaskIds = new Set(next.tasks.map((t) => t.id));
  let written = 0;
  for (const page of next.pages) {
    if (previous && deepEqual(prevPages.get(page.id), page)) continue;
    writeText(pageStore.pageFileFor(stateDirAbs, page.id), pageStore.renderPageYaml(page));
    written++;
    hooks.afterEntity?.(written);
  }
  for (const id of prevPages.keys()) if (!nextPageIds.has(id)) pageStore.removePageFiles(stateDirAbs, [id]);
  for (const task of next.tasks) {
    if (previous && deepEqual(prevTasks.get(task.id), task)) continue;
    taskStore.writeTask(stateDirAbs, task);
    written++;
    hooks.afterEntity?.(written);
  }
  for (const id of prevTasks.keys()) if (!nextTaskIds.has(id)) taskStore.removeTask(stateDirAbs, id);
  writeText(pageStore.projectFileFor(stateDirAbs), pageStore.renderProjectYaml(next.meta || {}, next.pages));
  if (docsOutputDir) writeIndexesFor(stateDirAbs, next, { revision, modelRevision, docsOutputDir });
}

// ---------------------------------------------------------------- 合并

function mergeEntity(base, change, fresh) {
  if (!base) return change;
  const out = { ...fresh };
  for (const key of new Set([...Object.keys(base), ...Object.keys(change)])) {
    if (deepEqual(change[key], base[key])) continue; // 本次没改：保留最新值
    if (change[key] === undefined) delete out[key];
    else out[key] = change[key];
  }
  return out;
}

function mergeList(kind, baseList, freshList, upserts = [], removals = []) {
  const base = new Map((baseList || []).map((e) => [e.id, e]));
  const out = new Map((freshList || []).map((e) => [e.id, e]));
  for (const id of removals) out.delete(id);
  for (const change of upserts) {
    const b = base.get(change.id);
    const f = out.get(change.id);
    if (b && !f) throw new ProjectStoreError('model-conflict', `${kind} ${change.id} 已被其他命令删除。`);
    if (!b && f && !deepEqual(f, change)) throw new ProjectStoreError('model-conflict', `${kind} ${change.id} 已被其他命令创建。`);
    out.set(change.id, mergeEntity(b, change, f));
  }
  return [...out.values()];
}

// ---------------------------------------------------------------- Store

function createProjectStore({ stateDirAbs, docsOutputDir = null, lockOptions = {} }) {
  function repairLocked() {
    const pointer = snap.readPointer(stateDirAbs);
    if (!pointer || pointer.materialized !== false) return false;
    const body = snap.readSnapshot(stateDirAbs, pointer.revision);
    const working = readWorkingCopy(stateDirAbs);
    materialize(stateDirAbs, working.ok ? working.model : null, body.model, { docsOutputDir, revision: pointer.revision, modelRevision: pointer.modelRevision });
    snap.writePointer(stateDirAbs, { ...pointer, materialized: true, repairedAt: new Date().toISOString() });
    return true;
  }

  /** 锁内读取：修复半写入、导入手工修改，返回当前已提交模型。 */
  function loadLocked() {
    repairLocked();
    const working = readWorkingCopy(stateDirAbs);
    if (!working.ok) throw new ProjectStoreError('invalid-model', working.errors.join('；'), { errors: working.errors });
    const pointer = snap.readPointer(stateDirAbs);
    const rev = snap.contentRevisionOf(working.model);
    if (pointer && pointer.revision === rev) {
      return { model: working.model, revision: rev, modelRevision: pointer.modelRevision, imported: false };
    }
    for (const page of working.model.pages) {
      const version = checkSchemaVersion('page', page);
      if (!version.ok) throw new ProjectStoreError(version.code, version.message);
    }
    const written = snap.writeSnapshot(stateDirAbs, working.model, { parent: pointer?.revision || null });
    snap.writePointer(stateDirAbs, { revision: written.revision, modelRevision: written.modelRevision, parent: pointer?.revision || null, updatedAt: new Date().toISOString(), materialized: true, source: 'working-copy-import' });
    if (docsOutputDir) writeIndexesFor(stateDirAbs, working.model, { revision: written.revision, modelRevision: written.modelRevision, docsOutputDir });
    return { model: working.model, revision: written.revision, modelRevision: written.modelRevision, imported: true };
  }

  function load() {
    const pointer = snap.readPointer(stateDirAbs);
    if (pointer && pointer.materialized !== false) {
      const working = readWorkingCopy(stateDirAbs);
      if (!working.ok) throw new ProjectStoreError('invalid-model', working.errors.join('；'), { errors: working.errors });
      if (snap.contentRevisionOf(working.model) === pointer.revision) {
        return { model: working.model, revision: pointer.revision, modelRevision: pointer.modelRevision, imported: false };
      }
    }
    return withLock(stateDirAbs, () => loadLocked(), lockOptions);
  }

  /**
   * @param {{ base, kind: 'definition'|'observation', changes: { pages?, removePages?, tasks?, removeTasks?, meta? }, hooks? }} p
   */
  function commit({ base, kind = 'definition', changes = {}, hooks = {} }) {
    if (!base || !base.model) throw new ProjectStoreError('invalid-commit', 'commit 需要 load() 返回的 base。');
    return withLock(stateDirAbs, () => {
      const fresh = loadLocked();
      if (kind === 'definition' && fresh.modelRevision !== base.modelRevision) {
        throw new ProjectStoreError('model-conflict', '项目模型在本命令读取之后被其他命令修改过；为避免覆盖，本次提交被拒绝。请重新运行。', {
          expected: base.modelRevision, actual: fresh.modelRevision,
        });
      }
      const next = {
        meta: changes.meta ? { ...fresh.model.meta, ...changes.meta } : fresh.model.meta,
        pages: mergeList('页面', base.model.pages, fresh.model.pages, (changes.pages || []).map(canonicalPage), changes.removePages)
          .sort((a, b) => String(a.route).localeCompare(String(b.route))),
        tasks: mergeList('任务', base.model.tasks, fresh.model.tasks, (changes.tasks || []).map(canonicalTask), changes.removeTasks)
          .sort((a, b) => String(a.id).localeCompare(String(b.id))),
      };
      const nextModel = snap.toJson(next);
      const modelRevision = snap.modelRevisionOf(nextModel);
      if (kind === 'observation' && modelRevision !== fresh.modelRevision) {
        throw new ProjectStoreError('observation-changed-definition', '观察提交不能修改页面 / 任务定义。');
      }
      const revision = snap.contentRevisionOf(nextModel);
      if (revision === fresh.revision) return { revision, modelRevision, changed: false };
      const written = snap.writeSnapshot(stateDirAbs, nextModel, { parent: fresh.revision });
      hooks.afterSnapshot?.();
      snap.writePointer(stateDirAbs, { revision, modelRevision, parent: fresh.revision, updatedAt: new Date().toISOString(), materialized: false, kind });
      hooks.afterPointer?.();
      materialize(stateDirAbs, fresh.model, nextModel, { docsOutputDir, revision, modelRevision, hooks });
      snap.writePointer(stateDirAbs, { revision, modelRevision, parent: fresh.revision, updatedAt: new Date().toISOString(), materialized: true, kind });
      return { revision: written.revision, modelRevision, changed: true, model: nextModel };
    }, lockOptions);
  }

  /** Runtime 固定读取已提交快照（不受工作副本中未导入修改的影响）。 */
  function readCommitted() {
    const pointer = snap.readPointer(stateDirAbs);
    if (!pointer) return null;
    const body = snap.readSnapshot(stateDirAbs, pointer.revision);
    return { model: body.model, revision: body.revision, modelRevision: body.modelRevision };
  }

  /** 索引缺失或过期时按当前提交重建。 */
  function ensureIndexes() {
    const status = indexStatus(stateDirAbs);
    if (status.ok) return { rebuilt: false };
    const current = load();
    withLock(stateDirAbs, () => writeIndexesFor(stateDirAbs, current.model, { revision: current.revision, modelRevision: current.modelRevision, docsOutputDir }), lockOptions);
    return { rebuilt: true, reason: status.reason };
  }

  return { load, commit, readCommitted, ensureIndexes, indexStatus: () => indexStatus(stateDirAbs) };
}

module.exports = { createProjectStore, ProjectStoreError, indexStatus, readWorkingCopy, INDEX_SCHEMA_VERSION };
