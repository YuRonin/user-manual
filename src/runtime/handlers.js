'use strict';

/*
 * RuntimeTask handler（契约 C07：仅按 kind 注册，不建设插件系统）。
 *
 * handler(ctx, task) 直接调用应用用例（不 spawn 子 CLI），返回：
 *   { outputs: OutputRef[], warnings?: string[], actions?: number }   成功；runner 校验 outputs 后才记 succeeded
 *   { waiting: { code, message, request? } }                          需要用户 / 宿主输入
 * 失败直接抛带 code 的错误，由 runner 统一映射为 ErrorResult。
 *
 * ctx: { projectRoot, config, stateDirAbs, runId, runDir, mode, cacheStore, session(), outputsOf(taskId), plan }
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { createProjectStore } = require('../store/project');
const { approvalState, APPROVAL_STATES, approvalMessage } = require('../model/approval');
const { ANALYSIS } = require('../inspect/model');
const { createCaptureStore } = require('../evidence/store');
const { annotationSummary } = require('../evidence/integrity');
const { capturePage, pageProjection } = require('../evidence/capture-page');
const { rederiveCaptures } = require('../evidence/rederive');
const { captureTask, taskProjection } = require('../tasks/capture-usecase');
const { draftTask, prepareTaskFinal, publishTaskFinal } = require('../generate/task-usecase');
const { draftPage, preparePageFinal, publishPageFinal } = require('../generate/page-usecase');
const { manualIdFor } = require('../publication/release-store');
const { lookup, offlineMissError } = require('../cache/lookup');
const { collectPlanningInputs, imageInputsOf, subjectKey } = require('./planner');
const { RuntimeError } = require('./errors');
const { requestModel } = require('./model-request');
const { checkpoint, publicationHooks } = require('./faults');
const { copyFromResponse } = require('./model-response');
const { checkAuthOnline } = require('../auth/check');

const rel = (ctx, file) => path.relative(ctx.projectRoot, file).replace(/\\/g, '/');

function fileRef(ctx, file) {
  return { kind: 'file', ref: rel(ctx, file), sha256: sha256Hex(fs.readFileSync(file)) };
}

/** 把本次 Run 的中间产物写进 runs/<runId>/，返回文件引用。 */
function writeRunFile(ctx, relative, content) {
  const file = path.join(ctx.runDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content);
  return fileRef(ctx, file);
}

function loadModel(ctx) {
  return createProjectStore({ stateDirAbs: ctx.stateDirAbs, docsOutputDir: ctx.config.docs.outputDir });
}

function dependencyOutputs(ctx, task, kind) {
  const dep = task.dependsOn.map((id) => ctx.task(id)).find((t) => t && t.kind === kind);
  return dep ? dep.outputRefs : null;
}

/** 执行前重新确认计划时的输入仍然成立；不同则停止，交给 --replan。 */
function currentSubjectInputs(ctx, subject) {
  const base = loadModel(ctx).load();
  const snapshot = collectPlanningInputs({
    projectRoot: ctx.projectRoot, config: ctx.config, base, targets: [subject.scenarioId ? `scenario:${subject.scenarioId}` : `${subject.type}:${subject.id}`], mode: ctx.mode,
  });
  return snapshot.subjects[subjectKey(subject)];
}

// ---------------------------------------------------------------- fixture-setup / fixture-cleanup（P3-05）

function fixtureContext(ctx, task) {
  const { readFixture, namespaceFor } = require('../scenarios/fixtures');
  const { checkFixtureAllowed } = require('../scenarios/policy');
  const current = currentSubjectInputs(ctx, task.input.subject);
  const fixture = readFixture(ctx.stateDirAbs, task.input.fixture.id);
  // 执行前再过一次环境策略：规划之后 baseUrl / 环境登记可能被改过
  checkFixtureAllowed({ fixture, scenario: current.scenarioDefinition, config: ctx.config });
  return { fixture, namespace: namespaceFor(ctx.runId, fixture.id), current };
}

async function fixtureSetup(ctx, task) {
  const { runHook, writeFixtureState, fixtureRevision } = require('../scenarios/fixtures');
  const { fixture, namespace } = fixtureContext(ctx, task);
  const revision = fixtureRevision(fixture);
  if (revision !== task.input.fixture.revision) throw new RuntimeError('run-input-changed', `Fixture ${fixture.id} 在规划之后被修改，需要重新规划。`);
  writeFixtureState(ctx.stateDirAbs, ctx.runId, fixture.id, { fixtureId: fixture.id, revision, namespace, status: 'setting-up' });
  let token;
  try {
    token = await runHook(fixture, 'setup', { namespace, baseUrl: ctx.config.project.baseUrl });
  } catch (error) {
    writeFixtureState(ctx.stateDirAbs, ctx.runId, fixture.id, { fixtureId: fixture.id, revision, namespace, status: 'setup-failed', error: String(error.code || 'fixture-setup-failed') });
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('fixture-setup-failed', `Fixture ${fixture.id} 的 setup 失败：${error.message}（测试数据可能已部分写入命名空间 ${namespace}，稍后的 cleanup 会按命名空间清理）。`);
  }
  writeFixtureState(ctx.stateDirAbs, ctx.runId, fixture.id, { fixtureId: fixture.id, revision, namespace, status: 'active', token });
  return { outputs: [{ kind: 'value', sha256: sha256Hex(JSON.stringify({ fixture: fixture.id, revision, namespace })), value: { fixture: fixture.id, namespace, status: 'active' } }] };
}

async function fixtureCleanup(ctx, task) {
  const { runHook, readFixtureState, writeFixtureState, readFixture, namespaceFor } = require('../scenarios/fixtures');
  const fixture = readFixture(ctx.stateDirAbs, task.input.fixture.id);
  const namespace = namespaceFor(ctx.runId, fixture.id);
  const state = readFixtureState(ctx.stateDirAbs, ctx.runId, fixture.id);
  const value = (status) => ({ outputs: [{ kind: 'value', sha256: sha256Hex(JSON.stringify({ fixture: fixture.id, namespace, status })), value: { fixture: fixture.id, namespace, status } }] });
  // 幂等：已清理 / 从未开始 setup 的直接结束
  if (state?.status === 'cleaned') return value('cleaned');
  if (!state) return value('nothing-to-clean');
  try {
    await runHook(fixture, 'cleanup', { namespace, baseUrl: ctx.config.project.baseUrl, token: state.token || null });
  } catch (error) {
    writeFixtureState(ctx.stateDirAbs, ctx.runId, fixture.id, { ...state, status: 'cleanup-failed', error: String(error.code || error.message).slice(0, 200) });
    throw new RuntimeError('fixture-cleanup-required', `Fixture ${fixture.id} 的测试数据清理失败（命名空间 ${namespace}）：${error.message}。数据仍留在测试环境中，处理后 manual resume ${ctx.runId} 重试清理。`);
  }
  writeFixtureState(ctx.stateDirAbs, ctx.runId, fixture.id, { ...state, status: 'cleaned', token: null });
  return value('cleaned');
}

// ---------------------------------------------------------------- validate（审批 gate 与发布门槛）

function approvalGate(ctx, task) {
  const base = loadModel(ctx).load();
  const subject = task.input.subject;
  const entity = base.model.tasks.find((t) => t.id === subject.id);
  if (!entity) throw new RuntimeError('unknown-target', `任务 ${subject.id} 已不存在。`);
  const state = approvalState(entity, base.model.pages);
  if (state === APPROVAL_STATES.APPROVED) {
    return { outputs: [{ kind: 'value', sha256: sha256Hex(entity.approval.scopeHash), value: { approval: 'approved' } }] };
  }
  if (state === APPROVAL_STATES.REJECTED) throw new RuntimeError('approval-rejected', approvalMessage(state, subject.id));
  return { waiting: { code: state === APPROVAL_STATES.SCOPE_CHANGED ? 'scope-changed' : 'approval-required', message: approvalMessage(state, subject.id) } };
}

function readCopy(ctx, task) {
  const refs = dependencyOutputs(ctx, task, 'rewrite');
  if (!refs) return null;
  const ref = refs.find((r) => r.kind === 'file' || r.kind === 'request');
  const file = path.join(ctx.projectRoot, ref.ref);
  // 模型响应带 requestId / inputHash 信封；文案文件就是文案块本身。
  return ref.kind === 'request' ? copyFromResponse(file) : JSON.parse(fs.readFileSync(file, 'utf8'));
}

function prepareFinal(ctx, task, copy) {
  const subject = task.input.subject;
  // --force 由 publish 节点携带：覆盖人工修改；未指定时由三方合并保护人工修改（P3-06）
  const force = !!ctx.plan.tasks.find((t) => t.kind === 'publish')?.input?.force;
  const common = { projectRoot: ctx.projectRoot, config: ctx.config, copy, acceptReview: !!task.input.acceptReview, force, runId: ctx.runId };
  if (subject.type === 'task') return prepareTaskFinal({ ...common, taskId: subject.id });
  return preparePageFinal({ ...common, pageId: subject.id });
}

function publicationGate(ctx, task) {
  const copy = readCopy(ctx, task);
  let prepared;
  try {
    prepared = prepareFinal(ctx, task, copy);
  } catch (error) {
    if (error.code === 'review-required') return { waiting: { code: 'review-required', message: (error.errors || [error.message]).join(' ') } };
    throw error;
  }
  const subject = task.input.subject;
  const body = subject.type === 'task' ? prepared.final : prepared.body;
  return {
    outputs: [
      writeRunFile(ctx, `staged/${subject.type}-${subject.id}.md`, body),
      writeRunFile(ctx, `staged/${subject.type}-${subject.id}.copy.json`, JSON.stringify(copy || {}, null, 2) + '\n'),
    ],
  };
}

// ---------------------------------------------------------------- capture / derive-image

async function authCheck(ctx, task) {
  const current = currentSubjectInputs(ctx, task.input.subject);
  if (current.captureKey !== task.input.captureKey) throw new RuntimeError('run-input-changed', '认证预检对应的采集输入已变化，需要重新规划。');
  const profile = task.input.authProfile;
  const checked = (status) => ({ outputs: [{ kind: 'value', sha256: sha256Hex(JSON.stringify({ profile, status })), value: { profile, status } }] });
  if (!ctx.mode.browserAllowed) return checked('offline');
  if (ctx.mode.read && ctx.cacheStore) {
    const found = lookup({
      store: ctx.cacheStore, keyInfo: { kind: 'capture', key: current.captureKey, input: current.captureKeyInput, uncertainty: current.captureUncertainty },
      subject: `capture:${subjectKey(task.input.subject)}`, mode: ctx.mode, projectRoot: ctx.projectRoot, stateDirAbs: ctx.stateDirAbs,
      requiredScopes: ['page-identity'], privacy: { audience: ctx.config.privacy?.audience || 'public' }, cachePolicy: ctx.config.cache, requireAnnotation: true, now: ctx.now,
    });
    if (found.hit) return checked('cache-hit');
  }
  if (!ctx.authChecks.has(profile)) {
    const result = await checkAuthOnline({ config: ctx.config, profile, sessionFactory: () => ctx.session(), closeSession: false });
    ctx.authChecks.set(profile, result);
  }
  return checked(ctx.authChecks.get(profile).status);
}

function scopesPassed(records) {
  const all = records.flatMap((r) => r.validations || []);
  const scopes = [...new Set(all.map((v) => v.scope))];
  return scopes.filter((scope) => all.filter((v) => v.scope === scope).every((v) => v.outcome === 'passed'));
}

function privacySummary(records) {
  if (records.length === 0) return { status: 'passed' };
  const statuses = records.map((r) => r.privacy?.status || 'unknown');
  const status = statuses.every((s) => s === 'passed') ? 'passed' : (statuses.includes('unknown') || statuses.includes('not-run') ? 'unknown' : 'failed');
  return { status, revision: records[0].privacy?.policyRevision || null };
}

/** 只有真实（live）采集能成为页面默认投影；fixture / 模拟数据只作独立证据（与 capture-page 一致）。 */
function isLiveRecord(record, ctx) {
  const mode = record?.provenance?.mode;
  // 重新派生的记录沿用原始观察：按它派生自的那条记录判断
  if (mode === 'rederived' && ctx && record.provenance.derivedFrom) return isLiveRecord(readRecords(ctx, [record.provenance.derivedFrom])[0], ctx);
  return !mode || mode === 'live';
}

function readRecords(ctx, captureIds) {
  const store = createCaptureStore({ projectRoot: ctx.projectRoot, stateDirAbs: ctx.stateDirAbs });
  return captureIds.map((id) => store.read(id)).filter(Boolean);
}

function writeCaptureCache(ctx, task, current, outputs, records, observedAt) {
  if (!ctx.mode.write || !ctx.cacheStore) return;
  ctx.cacheStore.put({
    kind: 'capture', key: current.captureKey, input: current.captureKeyInput, uncertainty: current.captureUncertainty,
    subject: `capture:${subjectKey(task.input.subject)}`, outputRefs: outputs, observedAt,
    validationScopes: scopesPassed(records), privacy: privacySummary(records), annotation: annotationSummary(records),
    meta: { imageInputs: imageInputsOf(ctx.config) },
  });
}

/** 复用时把任务 / 页面投影指回缓存中的证据（例如期间用旧命令重新采集过）。 */
function restoreProjection(ctx, subject, outputs, observedAt, current) {
  // 变体证据不是默认投影：缓存命中时同样不能改写页面 / 任务的默认截图指针
  if (subject.scenarioId) return;
  const projectStore = loadModel(ctx);
  const base = projectStore.load();
  const captureIds = outputs.filter((r) => r.kind === 'capture').map((r) => r.ref);
  if (subject.type === 'page') {
    const page = base.model.pages.find((p) => p.id === subject.id);
    if (page.browser?.latestCaptureId === captureIds[0]) return;
    const [record] = readRecords(ctx, captureIds);
    if (!isLiveRecord(record, ctx)) return;
    projectStore.commit({ base, kind: 'observation', changes: { pages: [pageProjection(page, record)] } });
    return;
  }
  const entity = base.model.tasks.find((t) => t.id === subject.id);
  if (JSON.stringify(entity.lastCapture?.captureIds || null) === JSON.stringify(captureIds)) return;
  const manifest = outputs.find((r) => r.kind === 'file');
  const updated = taskProjection(entity, base.model.pages, {
    capturedAt: observedAt, captureIds, manifestRelative: manifest.ref,
    scenario: { id: current.scenario.id, revision: current.scenario.revision }, modelRevision: current.definitionRevision,
  });
  projectStore.commit({ base, kind: 'observation', changes: { tasks: [updated] } });
}

async function capture(ctx, task) {
  const subject = task.input.subject;
  const current = currentSubjectInputs(ctx, subject);
  if (current.captureKey !== task.input.captureKey) {
    throw new RuntimeError('run-input-changed', `${subjectKey(subject)} 的采集输入在规划之后发生了变化，需要重新规划（resume --replan）。`);
  }
  const warnings = [];
  if (task.reuse && ctx.mode.read && ctx.cacheStore) {
    const found = lookup({
      store: ctx.cacheStore, keyInfo: { kind: 'capture', key: current.captureKey, input: current.captureKeyInput, uncertainty: current.captureUncertainty },
      mode: ctx.mode, projectRoot: ctx.projectRoot, stateDirAbs: ctx.stateDirAbs, requiredScopes: ['page-identity'],
      privacy: { audience: ctx.config.privacy?.audience || 'public' }, cachePolicy: ctx.config.cache, requireAnnotation: true, now: ctx.now,
    });
    if (found.hit) {
      restoreProjection(ctx, subject, found.outputRefs, found.observedAt, current);
      return { outputs: found.outputRefs, warnings, reused: { from: found.reusedFrom, observedAt: found.observedAt, stale: found.stale } };
    }
    if (!ctx.mode.browserAllowed) throw offlineMissError(found, subjectKey(subject));
    warnings.push(`缓存在执行前失效（${found.reason}），重新采集。`);
  } else if (!ctx.mode.browserAllowed) {
    throw offlineMissError({ reason: 'not-found' }, subjectKey(subject));
  }

  // 规划时缓存可用、执行时失效：采集前补做在线认证检查。
  const authProfile = current.scenario.authProfile;
  if (ctx.config.auth?.enabled !== false && authProfile !== 'anonymous' && ctx.config.auth?.verifyPath &&
      ctx.config.auth?.identityAssertions?.length && !ctx.authChecks.has(authProfile)) {
    await authCheck(ctx, { input: { subject, authProfile, captureKey: current.captureKey } });
  }

  if (subject.type === 'page') {
    const result = await capturePage({
      projectRoot: ctx.projectRoot, config: ctx.config, pageId: subject.id, session: ctx.session(), runId: ctx.runId,
      options: subject.scenarioId ? { scenario: current.scenarioDefinition } : {},
    });
    checkpoint('capture-committed');
    const outputs = [{ kind: 'capture', ref: result.record.id }];
    writeCaptureCache(ctx, task, current, outputs, [result.record], result.record.observedAt);
    return { outputs, warnings: [...warnings, ...result.ready.warnings], actions: 1 };
  }
  const result = await captureTask({ projectRoot: ctx.projectRoot, config: ctx.config, taskId: subject.id, session: ctx.session(), runId: ctx.runId,
    ...(subject.scenarioId ? { scenario: current.scenarioDefinition } : {}) });
  checkpoint('capture-committed');
  const captureIds = result.updatedTask.lastCapture.captureIds;
  const outputs = [
    ...captureIds.map((id) => ({ kind: 'capture', ref: id })),
    fileRef(ctx, path.join(ctx.projectRoot, result.updatedTask.evidenceManifest)),
  ];
  writeCaptureCache(ctx, task, current, outputs, readRecords(ctx, captureIds), result.evidence.capturedAt);
  const actions = result.evidence.steps.filter((s) => s.status !== 'not-executed').length;
  return { outputs, warnings: [...warnings, ...(result.evidence.warnings || [])], actions };
}

/** 任务证据清单中的截图条目改指向重新派生的记录。 */
function remapManifest(ctx, manifestRef, mapping, records) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ctx.projectRoot, manifestRef), 'utf8'));
  const byId = new Map(records.map(({ record, safe }) => [record.id, { record, safe }]));
  for (const step of manifest.steps || []) {
    for (const shot of step.screenshots || []) {
      const nextId = mapping[shot.captureId];
      if (!nextId) continue;
      const { record, safe } = byId.get(nextId);
      const artifactOf = (kind) => record.artifacts.find((a) => a.kind === kind) || null;
      Object.assign(shot, {
        captureId: nextId,
        sanitized: artifactOf('sanitized') ? path.join(ctx.projectRoot, artifactOf('sanitized').path) : null,
        annotated: artifactOf('published')?.path || null,
        sha256: artifactOf('published')?.sha256 || null,
        privacy: record.privacy,
        redactions: safe.redactions,
        annotations: safe.annotations,
        derivedFromRawHash: safe.derived.rawHash,
        geometryHash: safe.derived.geometryHash,
        rendererVersion: safe.derived.rendererVersion,
      });
    }
  }
  manifest.canonicalCaptureRefs = (manifest.canonicalCaptureRefs || []).map((id) => mapping[id] || id);
  const text = JSON.stringify(manifest, null, 2) + '\n';
  const file = path.join(ctx.stateDirAbs, 'artifacts', 'manifests', `${manifest.taskId}--evidence--${sha256Hex(text).slice(0, 16)}.json`);
  if (!fs.existsSync(file)) writeFileAtomic(file, text);
  return { file, manifest };
}

async function deriveImage(ctx, task) {
  const subject = task.input.subject;
  const current = currentSubjectInputs(ctx, subject);
  const source = dependencyOutputs(ctx, task, 'capture');
  const captureIds = source.filter((r) => r.kind === 'capture').map((r) => r.ref);
  const { records, mapping } = await rederiveCaptures({ projectRoot: ctx.projectRoot, config: ctx.config, captureIds, runId: ctx.runId });
  const projectStore = loadModel(ctx);
  const base = projectStore.load();
  let outputs;
  if (subject.type === 'page') {
    const page = base.model.pages.find((p) => p.id === subject.id);
    const record = records[0].record;
    if (!subject.scenarioId && isLiveRecord(record, ctx)) projectStore.commit({ base, kind: 'observation', changes: { pages: [pageProjection(page, record)] } });
    outputs = [{ kind: 'capture', ref: record.id }];
  } else {
    const manifestRef = source.find((r) => r.kind === 'file').ref;
    const { file } = remapManifest(ctx, manifestRef, mapping, records);
    const entity = base.model.tasks.find((t) => t.id === subject.id);
    const captureIds2 = captureIds.map((id) => mapping[id] || id);
    const updated = taskProjection(entity, base.model.pages, {
      capturedAt: entity.lastCapture?.capturedAt || records[0]?.record.observedAt, captureIds: captureIds2, manifestRelative: rel(ctx, file),
      scenario: { id: current.scenario.id, revision: current.scenario.revision }, modelRevision: current.definitionRevision,
    });
    if (!subject.scenarioId) projectStore.commit({ base, kind: 'observation', changes: { tasks: [updated] } });
    outputs = [...captureIds2.map((id) => ({ kind: 'capture', ref: id })), fileRef(ctx, file)];
  }
  const newRecords = readRecords(ctx, outputs.filter((r) => r.kind === 'capture').map((r) => r.ref));
  writeCaptureCache(ctx, { input: { subject } }, current, outputs, newRecords, newRecords[0]?.observedAt || new Date(ctx.now()).toISOString());
  return { outputs };
}

// ---------------------------------------------------------------- analyze / draft / rewrite / publish

function analyze(ctx, task) {
  const subject = task.input.subject;
  const page = loadModel(ctx).load().model.pages.find((p) => p.id === subject.id);
  if (page?.status?.sourceAnalysis === ANALYSIS.COMPLETED) {
    return { outputs: [{ kind: 'value', sha256: sha256Hex(JSON.stringify({ title: page.title, purpose: page.purpose })), value: { analysis: 'completed' } }] };
  }
  // 兼容入口：用户也可以直接运行 manual describe 补充标题与用途，resume 时这里会看到分析已完成。
  return requestModel(ctx, 'analyze', task);
}

function draft(ctx, task) {
  const subject = task.input.subject;
  if (subject.type === 'task') {
    const built = draftTask({ projectRoot: ctx.projectRoot, config: ctx.config, taskId: subject.id });
    for (const warning of built.pack.quality?.warnings || []) process.stderr.write(`[manual quality] ${warning}\n`);
    return { outputs: [fileRef(ctx, built.draftFile), fileRef(ctx, built.factsFile)], copyBlocks: built.copyBlocks };
  }
  const built = draftPage({ projectRoot: ctx.projectRoot, config: ctx.config, pageId: subject.id });
  for (const warning of built.pack.quality?.warnings || []) process.stderr.write(`[manual quality] ${warning}\n`);
  return { outputs: [fileRef(ctx, built.draftPath), fileRef(ctx, built.factsFile)] };
}

function rewrite(ctx, task) {
  const subject = task.input.subject;
  const copy = task.input.copy;
  if (copy.mode === 'file') {
    const file = path.resolve(ctx.projectRoot, copy.path);
    if (!fs.existsSync(file)) throw new RuntimeError('copy-missing', `文案文件不存在: ${copy.path}`);
    const bytes = fs.readFileSync(file);
    if (copy.sha256 && sha256Hex(bytes) !== copy.sha256) throw new RuntimeError('run-input-changed', `文案文件 ${copy.path} 在规划之后被修改，需要重新规划。`);
    try { JSON.parse(bytes.toString('utf8')); } catch (error) { throw new RuntimeError('invalid-copy', `文案文件不是合法 JSON: ${error.message}`); }
    return { outputs: [writeRunFile(ctx, `copy/${subject.type}-${subject.id}.json`, bytes)] };
  }
  return requestModel(ctx, 'rewrite', task);
}

function publishDoc(ctx, task) {
  const subject = task.input.subject;
  const staged = dependencyOutputs(ctx, task, 'validate');
  const stagedDoc = staged.find((r) => r.ref.endsWith('.md'));
  const stagedCopy = staged.find((r) => r.ref.endsWith('.copy.json'));
  const copy = JSON.parse(fs.readFileSync(path.join(ctx.projectRoot, stagedCopy.ref), 'utf8'));
  // 发布前按当前事实重新检查一次；结果必须与 validate 阶段逐字节一致，否则说明输入在两步之间变了。
  const prepared = prepareFinal(ctx, ctx.task(task.dependsOn[0]), copy);
  const body = subject.type === 'task' ? prepared.final : prepared.body;
  if (sha256Hex(body) !== stagedDoc.sha256) throw new RuntimeError('run-input-changed', `${subjectKey(subject)} 的文档在校验之后发生了变化，需要重新规划。`);
  const force = !!task.input.force;
  const common = { projectRoot: ctx.projectRoot, config: ctx.config, prepared, force, runId: ctx.runId, hooks: publicationHooks() };
  const published = subject.type === 'task' ? publishTaskFinal({ ...common, taskId: subject.id }) : publishPageFinal(common);
  try {
    const catalog = require('../generate/handbook').updateHandbook({ projectRoot: ctx.projectRoot, config: ctx.config });
    if (catalog.warning) process.stderr.write(`[manual quality] ${catalog.warning}\n`);
  } catch (error) { process.stderr.write(`[manual quality] catalog-update-failed: ${error.message}\n`); }
  // meta.json（更新时间 + 相关文章）同样尽力而为：失败只告警，不影响本次发布。
  try {
    require('../generate/doc-meta').updateDocMeta({ projectRoot: ctx.projectRoot, config: ctx.config });
  } catch (error) { process.stderr.write(`[manual quality] doc-meta-update-failed: ${error.message}\n`); }
  return { outputs: [{ kind: 'release', ref: `${manualIdFor(subject.type, subject.id)}/${published.release.id}` }] };
}

function validate(ctx, task) {
  return task.input.gate === 'approval' ? approvalGate(ctx, task) : publicationGate(ctx, task);
}

const HANDLERS = {
  'auth-check': authCheck,
  'fixture-setup': fixtureSetup,
  'fixture-cleanup': fixtureCleanup,
  analyze,
  capture,
  'derive-image': deriveImage,
  draft,
  rewrite,
  validate,
  publish: publishDoc,
};

module.exports = { HANDLERS, fileRef, writeRunFile, writeCaptureCache, readRecords, currentSubjectInputs };
