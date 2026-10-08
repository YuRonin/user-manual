'use strict';

/*
 * 模型交接响应（P2-06）。
 *
 * 响应形状：{ "requestId": "...", "inputHash": "...", "output": { ... } }
 *   rewrite  output.copy = { "<blockId>": "文案" }，只能包含请求列出的 allowedBlocks
 *   analyze  output = { title, purpose, detectedActions? }，不能改 lifecycle / 入口 / 手册范围等决定
 *
 * 校验顺序：请求存在且属于该 Run → requestId / inputHash 一致 → 任务仍在等待这份输入 →
 * 字段白名单与大小限制 → 文案不能改写受保护的事实 → 事实自请求以来未变（CAS）。
 * 任一不通过都不改模型、不推进任务。同一响应重复提交是幂等的。
 * 语义分析结果标 origin=model 与所依据的源码文件，不会因此变成已验证或已批准。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex, revisionOf, canonical } = require('../util/hash');
const { writeFileAtomic } = require('../util/atomic-write');
const { isUuid } = require('../model/ids');
const { createProjectStore } = require('../store/project');
const { validateEntry, applyPatch } = require('../commands/describe');
const { validateCopy, formatFindings } = require('../generate/markdown-validate');
const { checkDraftFresh } = require('../generate/task-usecase');
const { pageDraftStale, loadPage } = require('../generate/page-usecase');
const { createRunStore } = require('./store');
const { requestFileFor, responseFileFor } = require('./model-request');
const { RuntimeError } = require('./errors');

function invalid(message, extra = {}) {
  return new RuntimeError('invalid-model-response', message, extra);
}

function checkCopy(request, output) {
  const copy = output?.copy;
  if (!copy || typeof copy !== 'object' || Array.isArray(copy)) throw invalid('响应缺少 output.copy 对象。');
  const allowed = new Set(request.output.allowedBlocks);
  const unauthorized = Object.keys(copy).filter((id) => !allowed.has(id));
  if (unauthorized.length) throw invalid(`响应包含未授权的文案块: ${unauthorized.join(', ')}`, { unauthorized });
  for (const [id, text] of Object.entries(copy)) {
    if (typeof text !== 'string' || text.trim() === '') throw invalid(`文案块 ${id} 需要是非空字符串。`);
    if (text.length > request.limits.maxBlockChars) throw invalid(`文案块 ${id} 超过 ${request.limits.maxBlockChars} 字。`);
  }
  return copy;
}

function checkAnalysis(request, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) throw invalid('响应缺少 output 对象。');
  const allowed = new Set(request.output.allowedFields);
  const unauthorized = Object.keys(output).filter((field) => !allowed.has(field));
  if (unauthorized.length) throw invalid(`响应包含未授权的字段: ${unauthorized.join(', ')}（只能填写 ${[...allowed].join(' / ')}）`, { unauthorized });
  if (!output.title || !output.purpose) throw invalid('语义分析响应需要 title 与 purpose。');
  return output;
}

/** 请求所依据的事实是否仍然成立。 */
function checkStillCurrent({ projectRoot, config, request, facts }) {
  for (const file of request.files.filter((f) => f.root !== 'tool')) {
    const abs = path.join(projectRoot, file.path);
    if (!fs.existsSync(abs) || sha256Hex(fs.readFileSync(abs)) !== file.sha256) {
      throw new RuntimeError('run-input-changed', `请求依据的文件 ${file.path} 已变化，旧响应不能用于新事实；运行 manual resume <runId> --replan。`);
    }
  }
  const subject = request.subject;
  if (request.kind === 'rewrite') {
    if (subject.type === 'task') {
      const base = createProjectStore({ stateDirAbs: path.join(projectRoot, config.artifacts.stateDir), docsOutputDir: config.docs.outputDir }).load();
      const task = base.model.tasks.find((t) => t.id === subject.id);
      const fresh = task ? checkDraftFresh({ root: projectRoot, config, task, pages: base.model.pages, tasks: base.model.tasks, facts }) : { ok: false, errors: ['任务已不存在'] };
      if (!fresh.ok) throw new RuntimeError('run-input-changed', `${fresh.errors.join(' ')}；运行 manual resume <runId> --replan。`);
    } else {
      const { page } = loadPage(projectRoot, config, subject.id);
      const stale = pageDraftStale(page, facts.factPack, config.docs.language);
      if (stale) throw new RuntimeError('run-input-changed', `${stale}；运行 manual resume <runId> --replan。`);
    }
  }
}

/**
 * 提交并应用一份模型响应。
 * @returns {{ ok: true, taskId, requestId, idempotent: boolean }}
 */
function submitModelResponse({ projectRoot, config, runId, requestId, response }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const runStore = createRunStore({ projectRoot, stateDirAbs });
  const state = runStore.read(runId);
  if (!state) throw new RuntimeError('run-not-found', `找不到 Run ${runId}。`);
  if (!isUuid(requestId)) throw invalid(`requestId 非法: ${requestId}`);
  const runDir = runStore.runDirFor(runId);
  const requestFile = requestFileFor(runDir, requestId);
  if (!fs.existsSync(requestFile)) throw invalid(`Run ${runId} 中没有请求 ${requestId}（跨 Run 或已过期的请求不能提交）。`);
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  if (!response || typeof response !== 'object') throw invalid('响应需要是 JSON 对象。');
  if (response.requestId !== requestId) throw invalid('响应的 requestId 与请求不一致。');
  if (response.inputHash !== request.inputHash) throw invalid('响应的 inputHash 与请求不一致：它对应的是另一份（可能较旧的）事实。');
  const bytes = Buffer.byteLength(canonical(response));
  if (bytes > request.limits.maxResponseBytes) throw invalid(`响应超过 ${request.limits.maxResponseBytes} 字节。`);

  const task = state.tasks.find((t) => t.id === request.taskId);
  if (!task) throw invalid(`请求对应的任务 ${request.taskId} 不在 Run 中。`);
  const responseFile = responseFileFor(runDir, requestId);
  const text = JSON.stringify(response, null, 2) + '\n';
  if (task.status === 'succeeded') {
    // 幂等：同一响应重复提交直接返回；不同内容不能覆盖已接受的结果。
    if (fs.existsSync(responseFile) && revisionOf(JSON.parse(fs.readFileSync(responseFile, 'utf8'))) === revisionOf(response)) {
      return { ok: true, taskId: task.id, requestId, idempotent: true };
    }
    throw invalid(`任务 ${task.id} 已接受过另一份响应，不能覆盖。`);
  }
  if (task.status !== 'waiting_input') throw invalid(`任务 ${task.id} 当前是 ${task.status}，没有在等待这份输入。`);

  let facts = null;
  if (request.kind === 'rewrite') {
    const factsFile = request.files.find((f) => f.path.endsWith('.facts.json'));
    facts = JSON.parse(fs.readFileSync(path.join(projectRoot, factsFile.path), 'utf8'));
    const copy = checkCopy(request, response.output);
    const findings = validateCopy(facts.factPack, copy);
    if (findings.blocked.length) throw invalid(`文案改写了受保护的事实：${formatFindings(findings.blocked, '拒绝').join('；')}`);
  } else {
    checkAnalysis(request, response.output);
  }
  checkStillCurrent({ projectRoot, config, request, facts });

  const { lease } = runStore.open(runId);
  try {
    if (request.kind === 'analyze') {
      const projectStore = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
      const base = projectStore.load();
      const page = base.model.pages.find((p) => p.id === request.subject.id);
      const errors = [];
      const patch = validateEntry({ id: page.id, ...response.output }, 0, new Set([page.id]), errors);
      if (!patch) throw invalid(errors.join('；'));
      const next = applyPatch(page, patch);
      // 语义来源：模型根据列出的源码推断；不是浏览器验证，也不是人工批准。
      next.analysis = { ...(page.analysis || {}), semantic: { origin: 'model', requestId, evidenceRefs: request.files.map((f) => ({ path: f.path, sha256: f.sha256 })) } };
      projectStore.commit({ base, kind: 'definition', changes: { pages: [next] } });
    }
    fs.mkdirSync(path.dirname(responseFile), { recursive: true });
    writeFileAtomic(responseFile, text);
    runStore.transition(runId, task.id, 'succeeded', {
      lease,
      outputRefs: [{ kind: 'request', ref: path.relative(projectRoot, responseFile).replace(/\\/g, '/'), sha256: sha256Hex(text) }],
      reason: `model-response:${requestId}`,
    });
  } finally {
    lease.release();
  }
  return { ok: true, taskId: task.id, requestId, idempotent: false };
}

/** rewrite 的响应中取出文案块（validate 阶段读取）。 */
function copyFromResponse(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return parsed.output?.copy || parsed;
}

module.exports = { submitModelResponse, copyFromResponse };
