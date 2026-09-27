'use strict';

/*
 * 模型交接请求（P2-06）。
 *
 * CLI 没有内置模型：需要语义分析或文案时写一个请求文件，任务记 waiting_input，由宿主 Agent
 * 按 Skill 处理后通过 `manual run-submit` 提交响应。请求只包含完成这件事所需的最少内容：
 *   - 允许读取的文件及其内容 hash（不塞整个仓库，不含浏览器凭据）
 *   - 必要事实（受保护的动作 / UI 名称 / 文案块默认值）
 *   - 输出 schema 与大小限制、响应应写到哪里
 * inputHash 绑定请求所依据的事实：事实变了，旧响应不能套到新事实上。
 *
 * 请求与响应可能包含业务文案，保存在 runs/<runId>/model/（本地私有，已被 gitignore）。
 */

const fs = require('fs');
const path = require('path');

const { sha256Hex, revisionOf } = require('../util/hash');
const { newUuid } = require('../model/ids');
const { writeFileAtomic } = require('../util/atomic-write');
const { createProjectStore } = require('../store/project');
const { RuntimeError } = require('./errors');
const { checkpoint } = require('./faults');

const REQUEST_SCHEMA_VERSION = 1;
const STYLE_GUIDE = 'references/manual-writing-style.md';
const LIMITS = { maxResponseBytes: 64 * 1024, maxBlockChars: 2000, maxFiles: 20 };

function modelDirFor(runDir) {
  return path.join(runDir, 'model');
}

function requestFileFor(runDir, requestId) {
  return path.join(modelDirFor(runDir), `${requestId}.request.json`);
}

function responseFileFor(runDir, requestId) {
  return path.join(modelDirFor(runDir), `${requestId}.response.json`);
}

const rel = (root, file) => path.relative(root, file).replace(/\\/g, '/');

function fileEntry(projectRoot, relative) {
  const file = path.join(projectRoot, relative);
  if (!fs.existsSync(file)) return null;
  return { path: relative.replace(/\\/g, '/'), sha256: sha256Hex(fs.readFileSync(file)) };
}

/** 文案请求：事实包的文案块及其默认文字；动作、顺序、截图、完成声明受保护。 */
function rewriteContent(ctx, task) {
  const draftRefs = task.dependsOn.map((id) => ctx.task(id)).find((t) => t?.kind === 'draft')?.outputRefs || [];
  const factsRef = draftRefs.find((r) => r.ref.endsWith('.facts.json'));
  const draftRef = draftRefs.find((r) => r.ref.endsWith('.md'));
  if (!factsRef) throw new RuntimeError('draft-missing', `${task.id} 缺少草稿事实，无法生成文案请求。`);
  const facts = JSON.parse(fs.readFileSync(path.join(ctx.projectRoot, factsRef.ref), 'utf8'));
  const pack = facts.factPack;
  if (!pack) throw new RuntimeError('draft-legacy', '旧版草稿没有事实包，无法按文案块交接。');
  const blocks = Object.fromEntries(Object.entries(pack.blocks).map(([id, block]) => [id, block.default]));
  const files = [draftRef, factsRef].filter(Boolean).map((r) => ({ path: r.ref, sha256: r.sha256 }));
  const styleGuide = path.resolve(__dirname, '..', '..', STYLE_GUIDE);
  if (fs.existsSync(styleGuide)) files.push({ path: STYLE_GUIDE, sha256: sha256Hex(fs.readFileSync(styleGuide)), root: 'tool' });
  return {
    inputHash: revisionOf({ task: task.inputHash, factsHash: pack.factsHash }),
    files,
    facts: { factsHash: pack.factsHash, language: pack.language || null, copyBlocks: blocks, protected: { uiTerms: facts.uiTexts || [], images: (facts.images || []).map((i) => i.artifactPath) } },
    output: { type: 'copy', allowedBlocks: Object.keys(blocks), shape: '{ "copy": { "<blockId>": "文案" } }' },
    instructions: `只填写 allowedBlocks 中的文案块；按 ${STYLE_GUIDE} 改写，不改 UI 名称、操作顺序、数字与完成条件。`,
  };
}

/** 页面语义分析请求：页面入口与依赖源码（带 hash），输出标题 / 用途 / 可见操作。 */
function analyzeContent(ctx, task) {
  const subject = task.input.subject;
  const base = createProjectStore({ stateDirAbs: ctx.stateDirAbs, docsOutputDir: ctx.config.docs.outputDir }).load();
  const page = base.model.pages.find((p) => p.id === subject.id);
  if (!page) throw new RuntimeError('unknown-target', `页面 ${subject.id} 已不存在。`);
  const candidates = [page.entry, ...(page.source || []), ...(page.dependencies?.files || [])].filter(Boolean);
  const files = [...new Set(candidates)].slice(0, LIMITS.maxFiles).map((f) => fileEntry(ctx.projectRoot, f)).filter(Boolean);
  return {
    inputHash: revisionOf({ task: task.inputHash, sourceRevision: page.analysis?.sourceRevision || null }),
    files,
    facts: { pageId: page.id, route: page.route, title: page.title || null, purpose: page.purpose || null, detectedActions: page.detectedActions || [] },
    output: { type: 'page-analysis', allowedFields: ['title', 'purpose', 'detectedActions'], shape: '{ "title": "...", "purpose": "...", "detectedActions": ["..."] }' },
    instructions: '只根据列出的源码文件判断页面标题、用途与可见操作；不确定就不写，不编造业务规则。',
  };
}

/**
 * 为等待中的模型任务取得请求：同一任务、同一 inputHash 的未完成请求直接复用（resume 不产生新请求）。
 * @returns {{ waiting: { code, message, request } }}
 */
function requestModel(ctx, kind, task) {
  const content = kind === 'rewrite' ? rewriteContent(ctx, task) : analyzeContent(ctx, task);
  const dir = modelDirFor(ctx.runDir);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.request.json')).sort()) {
      const existing = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (existing.taskId === task.id && existing.inputHash === content.inputHash) {
        return waitingFor(ctx, existing);
      }
    }
  }
  const requestId = newUuid();
  const request = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    requestId,
    runId: ctx.runId,
    taskId: task.id,
    kind,
    subject: task.input.subject,
    inputHash: content.inputHash,
    createdAt: new Date(ctx.now()).toISOString(),
    files: content.files,
    facts: content.facts,
    output: content.output,
    instructions: content.instructions,
    limits: LIMITS,
    responsePath: rel(ctx.projectRoot, responseFileFor(ctx.runDir, requestId)),
  };
  fs.mkdirSync(dir, { recursive: true });
  writeFileAtomic(requestFileFor(ctx.runDir, requestId), JSON.stringify(request, null, 2) + '\n');
  if (kind === 'rewrite') checkpoint('rewrite-requested');
  return waitingFor(ctx, request);
}

function waitingFor(ctx, request) {
  const requestPath = rel(ctx.projectRoot, requestFileFor(ctx.runDir, request.requestId));
  return {
    waiting: {
      code: 'model-input-required',
      message: `等待宿主模型处理 ${request.kind} 请求 ${requestPath}，完成后运行 manual run-submit ${ctx.runId} --request ${request.requestId} --input <响应.json>。`,
      request: request.requestId,
    },
  };
}

module.exports = { REQUEST_SCHEMA_VERSION, LIMITS, requestModel, requestFileFor, responseFileFor, modelDirFor };
