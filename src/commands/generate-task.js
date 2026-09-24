'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProjectStore } = require('../store/project');
const { checkEvidenceUsable } = require('../model/approval');
const { buildTaskDraft, publishAtomic } = require('../generate/task-draft');
const { validateTaskFinal } = require('../generate/task-facts');
const { renderTask } = require('../generate/render');
const { diffPacks } = require('../generate/fact-pack');
const { validateCopy, checkPolishedMarkdown, formatFindings } = require('../generate/markdown-validate');
const { validatePublication, validateArtifact, summarizePrivacy, formatIssues } = require('../publication/validate');

const KNOWN_FLAGS = new Set(['projectRoot', 'finalize', 'copy', 'acceptReview', 'json', 'help']);
const HELP = `
manual generate-task <task-id> [--json]
    生成事实草稿（.manual/drafts/tasks/<id>.md）与事实包（<id>.facts.json）。
manual generate-task <task-id> --copy <文案.json> [--accept-review] [--json]
    推荐的定稿方式：文案 JSON 形如 { "intro": "...", "step.<stepId>": "..." }，只能填写事实包
    声明的文案块；动作、顺序、截图、完成声明由程序按事实包渲染，模型无法改写。
manual generate-task <task-id> --finalize <markdown> [--accept-review] [--json]
    兼容旧流程：校验润色后的整篇 Markdown（结构一致性检查，不证明自由文本的语义等价）。
新出现的数字 / 单位或业务承诺需要人工确认（review-required），确认无误后加 --accept-review。
`.trim();

function fail(e, j) {
  const a = Array.isArray(e) ? e : [e];
  if (j) process.stdout.write(JSON.stringify({ ok: false, errors: a }, null, 2) + '\n');
  else a.forEach((x) => process.stderr.write(`[manual generate-task] ${x}\n`));
  return 1;
}

function manualFileFor(root, config, taskId) {
  return path.join(root, config.docs.outputDir, 'tasks', `${taskId}.md`);
}

/** 读取定稿输入与草稿事实。 */
function loadFinalize({ factsFile, finalizeInput }) {
  if (!fs.existsSync(factsFile)) return { ok: false, errors: ['缺少任务事实文件，请先生成草稿。'] };
  const inputFile = path.resolve(finalizeInput);
  if (!fs.existsSync(inputFile)) return { ok: false, errors: [`--finalize 文件不存在: ${inputFile}`] };
  return { ok: true, final: fs.readFileSync(inputFile, 'utf8'), facts: JSON.parse(fs.readFileSync(factsFile, 'utf8')) };
}

/**
 * 写任何正式文件之前完成全部检查：状态流转、结构事实、发布门槛。
 * 任一项不通过都不触碰正式文档。
 */
function validateFinalize({ root, config, task, pages, final, facts }) {
  const usable = checkEvidenceUsable(task, pages);
  if (!usable.ok) return { ok: false, errors: usable.errors };
  // 草稿必须基于任务当前这次采集：之后重新采集过，草稿里的图与结论就不再对应。
  if (task.lastCapture && JSON.stringify(facts.evidence?.captureIds || null) !== JSON.stringify(task.lastCapture.captureIds || [])) {
    return { ok: false, errors: [`draft-stale: 草稿基于较早的采集，重新运行 manual generate-task ${task.id} 生成草稿后再定稿。`] };
  }
  // 定稿可以重复执行（重新生成已发布文档）；status 只记录最近完成的操作。
  const nextTask = { ...task, status: 'generated' };
  const checked = validateTaskFinal(final, facts);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  const manualFile = manualFileFor(root, config, task.id);
  const gate = validatePublication({ projectRoot: root, manualFile, markdown: final, images: facts.images, config });
  if (!gate.ok) return { ok: false, errors: formatIssues(gate.errors) };
  return { ok: true, nextTask, manualFile };
}

/**
 * 提交：先原子替换正式文档，再写任务状态。两者不是一个事务——
 * 文档已替换而状态写入失败时明确报告 partial-commit，交给后续对账（P1-07），不伪称成功。
 */
function commitFinalize({ root, projectStore, base, manualFile, final, nextTask }) {
  try {
    publishAtomic(manualFile, final);
  } catch (error) {
    return { ok: false, code: error.code || 'write-failed', errors: [`${error.code || 'write-failed'}: 正式文档未改变。${error.message}`] };
  }
  try {
    projectStore.commit({ base, kind: 'observation', changes: { tasks: [nextTask] } });
  } catch (error) {
    return {
      ok: false,
      code: 'partial-commit',
      committed: [path.relative(root, manualFile).replace(/\\/g, '/')],
      errors: [`partial-commit: 正式文档已更新，但任务状态写入失败（${error.code || error.message}）。重新运行 finalize 前请确认文档内容。`],
    };
  }
  return { ok: true };
}

/** 按当前任务与证据重新构建事实包（草稿与定稿共用）。 */
function buildCurrent({ root, config, task }) {
  if (!task.evidenceManifest) return { ok: false, errors: ['任务缺少 evidenceManifest。'] };
  const evidenceFile = path.join(root, task.evidenceManifest);
  if (!fs.existsSync(evidenceFile)) return { ok: false, errors: [`证据清单不存在: ${evidenceFile}`] };
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  try {
    return buildTaskDraft(task, evidence, {
      projectRoot: root, stateDir: path.join(root, config.artifacts.stateDir), finalPath: manualFileFor(root, config, task.id), language: config.docs.language,
    });
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

/** 草稿之后事实（任务定义、证据、图片内容、模板）变了：旧草稿不能再发布。 */
function checkDraftFresh({ root, config, task, facts }) {
  if (!facts.factPack) return { ok: true, legacy: true };
  const current = buildCurrent({ root, config, task });
  if (!current.ok) return current;
  if (current.pack.factsHash !== facts.factsHash) {
    return { ok: false, errors: [`draft-stale: 草稿之后事实发生变化（${diffPacks(facts.factPack, current.pack).join(', ')}），重新运行 manual generate-task ${task.id} 生成草稿。`] };
  }
  return { ok: true };
}

/** 文案审查结论：blocked 直接拒绝；review-required 需要 --accept-review。 */
function reviewGate(findings, acceptReview) {
  if (findings.blocked.length) return { ok: false, code: 'copy-blocked', errors: formatFindings(findings.blocked, '拒绝') };
  if (findings.review.length && !acceptReview) {
    return { ok: false, code: 'review-required', errors: [...formatFindings(findings.review, '需确认'), '确认这些内容属实后加 --accept-review 重新运行。'] };
  }
  return { ok: true, accepted: findings.review };
}

function runFinalize({ root, config, projectStore, base, task, pages, factsFile, draftFile, finalizeInput, copyInput, acceptReview, json }) {
  if (!fs.existsSync(factsFile)) return fail('缺少任务事实文件，请先生成草稿。', json);
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const fresh = checkDraftFresh({ root, config, task, facts });
  if (!fresh.ok) return fail(fresh.errors, json);
  let final;
  let review;
  if (copyInput) {
    if (!facts.factPack) return fail('旧版草稿没有事实包，重新运行 generate-task 生成草稿后再用 --copy。', json);
    const copyFile = path.resolve(copyInput);
    if (!fs.existsSync(copyFile)) return fail(`--copy 文件不存在: ${copyFile}`, json);
    let copy;
    try { copy = JSON.parse(fs.readFileSync(copyFile, 'utf8')); } catch (error) { return fail(`--copy 不是合法 JSON: ${error.message}`, json); }
    review = reviewGate(validateCopy(facts.factPack, copy), acceptReview);
    final = renderTask(facts.factPack, copy);
  } else {
    const loaded = loadFinalize({ factsFile, finalizeInput });
    if (!loaded.ok) return fail(loaded.errors, json);
    final = loaded.final;
    const draftMarkdown = fs.existsSync(draftFile) ? fs.readFileSync(draftFile, 'utf8') : '';
    review = reviewGate(checkPolishedMarkdown(draftMarkdown, final, facts.factPack), acceptReview);
  }
  if (!review.ok) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, code: review.code, errors: review.errors }, null, 2) + '\n');
    else review.errors.forEach((x) => process.stderr.write(`[manual generate-task] ${x}\n`));
    return 1;
  }
  const loaded = { final, facts };
  const checked = validateFinalize({ root, config, task, pages, final: loaded.final, facts: loaded.facts });
  if (!checked.ok) return fail(checked.errors, json);
  const committed = commitFinalize({ root, projectStore, base, manualFile: checked.manualFile, final: loaded.final, nextTask: checked.nextTask });
  if (!committed.ok) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, code: committed.code, committed: committed.committed || [], errors: committed.errors }, null, 2) + '\n');
    else committed.errors.forEach((x) => process.stderr.write(`[manual generate-task] ${x}\n`));
    return 1;
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'generated', manual: checked.manualFile }, null, 2) + '\n');
  return 0;
}

function runDraft({ root, config, task, pages, draftDir, draftFile, factsFile, json }) {
  const usable = checkEvidenceUsable(task, pages);
  if (!usable.ok) return fail(usable.errors, json);
  const built = buildCurrent({ root, config, task });
  if (!built.ok) return fail(built.errors, json);
  // 草稿阶段就执行同一产物门槛：隐私未知或位置非法时不给出可定稿的草稿。
  const issues = built.facts.images.flatMap((image) => validateArtifact(image, { projectRoot: root, config }));
  if (issues.length) return fail(formatIssues(issues), json);
  // 草稿绑定的采集：定稿时据此判断草稿是否已被更新的采集取代。
  built.facts.evidence = task.lastCapture
    ? { captureIds: task.lastCapture.captureIds || [], scopeHash: task.lastCapture.scopeHash, capturedAt: task.lastCapture.capturedAt }
    : { captureIds: null, legacy: true };
  built.facts.publication = { audience: config.privacy?.audience || 'public', ...summarizePrivacy(built.facts.images.map((image) => image.privacy)) };
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(draftFile, built.markdown, 'utf8');
  fs.writeFileSync(factsFile, JSON.stringify(built.facts, null, 2) + '\n', 'utf8');
  if (json) {
    process.stdout.write(JSON.stringify({
      ok: true, status: 'draft', draftFile, factsFile, factsHash: built.pack.factsHash,
      // 模型可以填写的文案块及其默认文字；其余内容由程序渲染
      copyBlocks: Object.fromEntries(Object.entries(built.pack.blocks).map(([id, block]) => [id, block.default])),
      protected: built.facts,
    }, null, 2) + '\n');
  }
  return 0;
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['acceptReview'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (values.finalize && values.copy) return fail('--finalize 与 --copy 只能选一个。', json);
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (positional.length !== 1) return fail('需要一个 task-id。', json);
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors, json);
  const config = loaded.config;
  const state = path.join(root, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs: state, docsOutputDir: config.docs.outputDir });
  let base;
  try { base = projectStore.load(); } catch (error) { return fail(error.errors || [error.message], json); }
  const task = base.model.tasks.find((t) => t.id === positional[0]);
  if (!task) return fail(`找不到任务: ${positional[0]}`, json);
  const pages = base.model.pages;
  const draftDir = path.join(state, 'drafts', 'tasks');
  const draftFile = path.join(draftDir, `${task.id}.md`);
  const factsFile = path.join(draftDir, `${task.id}.facts.json`);
  if (values.finalize || values.copy) {
    return runFinalize({
      root, config, projectStore, base, task, pages, factsFile, draftFile,
      finalizeInput: values.finalize, copyInput: values.copy, acceptReview: values.acceptReview === true, json,
    });
  }
  return runDraft({ root, config, task, pages, draftDir, draftFile, factsFile, json });
}

module.exports = { run, KNOWN_FLAGS };
