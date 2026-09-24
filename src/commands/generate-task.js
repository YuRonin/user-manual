'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const store = require('../tasks/store');
const { transitionTask } = require('../tasks/model');
const { buildTaskDraft, publishAtomic } = require('../generate/task-draft');
const { validateTaskFinal } = require('../generate/task-facts');
const { validatePublication, validateArtifact, summarizePrivacy, formatIssues } = require('../publication/validate');

const KNOWN_FLAGS = new Set(['projectRoot', 'finalize', 'json', 'help']);

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
function validateFinalize({ root, config, task, final, facts }) {
  let nextTask;
  try {
    nextTask = transitionTask(task, 'generated');
  } catch (error) {
    return { ok: false, errors: [`任务状态不允许定稿：${error.message}（需要 captured）`] };
  }
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
function commitFinalize({ root, state, manualFile, final, nextTask }) {
  try {
    publishAtomic(manualFile, final);
  } catch (error) {
    return { ok: false, code: error.code || 'write-failed', errors: [`${error.code || 'write-failed'}: 正式文档未改变。${error.message}`] };
  }
  try {
    store.writeTask(state, nextTask);
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

function runFinalize({ root, config, state, task, factsFile, finalizeInput, json }) {
  const loaded = loadFinalize({ factsFile, finalizeInput });
  if (!loaded.ok) return fail(loaded.errors, json);
  const checked = validateFinalize({ root, config, task, final: loaded.final, facts: loaded.facts });
  if (!checked.ok) return fail(checked.errors, json);
  const committed = commitFinalize({ root, state, manualFile: checked.manualFile, final: loaded.final, nextTask: checked.nextTask });
  if (!committed.ok) {
    if (json) process.stdout.write(JSON.stringify({ ok: false, code: committed.code, committed: committed.committed || [], errors: committed.errors }, null, 2) + '\n');
    else committed.errors.forEach((x) => process.stderr.write(`[manual generate-task] ${x}\n`));
    return 1;
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'generated', manual: checked.manualFile }, null, 2) + '\n');
  return 0;
}

function runDraft({ root, config, task, draftDir, draftFile, factsFile, json }) {
  if (task.status !== 'captured') return fail(`任务必须是 captured，当前是 ${task.status}。`, json);
  if (!task.evidenceManifest) return fail('任务缺少 evidenceManifest。', json);
  const evidenceFile = path.join(root, task.evidenceManifest);
  if (!fs.existsSync(evidenceFile)) return fail(`证据清单不存在: ${evidenceFile}`, json);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  const built = buildTaskDraft(task, evidence, { projectRoot: root, stateDir: path.join(root, config.artifacts.stateDir), finalPath: manualFileFor(root, config, task.id) });
  if (!built.ok) return fail(built.errors, json);
  // 草稿阶段就执行同一产物门槛：隐私未知或位置非法时不给出可定稿的草稿。
  const issues = built.facts.images.flatMap((image) => validateArtifact(image, { projectRoot: root, config }));
  if (issues.length) return fail(formatIssues(issues), json);
  built.facts.publication = { audience: config.privacy?.audience || 'public', ...summarizePrivacy(built.facts.images.map((image) => image.privacy)) };
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(draftFile, built.markdown, 'utf8');
  fs.writeFileSync(factsFile, JSON.stringify(built.facts, null, 2) + '\n', 'utf8');
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'draft', draftFile, factsFile, protected: built.facts }, null, 2) + '\n');
  return 0;
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write('manual generate-task <task-id> [--finalize <markdown>] [--json]\n'); return 0; }
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (positional.length !== 1) return fail('需要一个 task-id。', json);
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors, json);
  const config = loaded.config;
  const state = path.join(root, config.artifacts.stateDir);
  const task = store.readTask(state, positional[0]);
  if (!task) return fail(`找不到任务: ${positional[0]}`, json);
  const draftDir = path.join(state, 'drafts', 'tasks');
  const draftFile = path.join(draftDir, `${task.id}.md`);
  const factsFile = path.join(draftDir, `${task.id}.facts.json`);
  if (values.finalize) return runFinalize({ root, config, state, task, factsFile, finalizeInput: values.finalize, json });
  return runDraft({ root, config, task, draftDir, draftFile, factsFile, json });
}

module.exports = { run, KNOWN_FLAGS };
