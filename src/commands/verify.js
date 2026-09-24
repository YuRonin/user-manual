'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProjectStore } = require('../store/project');
const { readCurrentRelease, manualIdFor } = require('../publication/release-store');
const { fileHash } = require('../publication/publisher');
const { checkEvidenceUsable } = require('../model/approval');
const { validateTaskFinal } = require('../generate/task-facts');
const { validatePublication, formatIssues } = require('../publication/validate');

/** 读取任务、正式文档与事实文件。 */
function loadVerify(root, config, taskId) {
  const state = path.join(root, config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs: state, docsOutputDir: config.docs.outputDir });
  let base;
  try { base = projectStore.load(); } catch (error) { return { ok: false, errors: error.errors || [error.message] }; }
  const task = base.model.tasks.find((t) => t.id === taskId);
  if (!task) return { ok: false, errors: ['找不到任务。'] };
  const manual = path.join(root, config.docs.outputDir, 'tasks', `${task.id}.md`);
  // 以当前发布记录中的 facts 为准（草稿可变，可能已删除）；没有发布记录的旧项目才回退草稿 facts
  const release = readCurrentRelease(state, manualIdFor('task', task.id));
  const factsFile = path.join(state, 'drafts', 'tasks', `${task.id}.facts.json`);
  if (!fs.existsSync(manual)) return { ok: false, errors: ['正式文档不存在。'] };
  if (!release && !fs.existsSync(factsFile)) return { ok: false, errors: ['正式文档或事实文件不存在（也没有发布记录）。'] };
  const facts = release ? release.facts : JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  return { ok: true, state, projectStore, base, task, pages: base.model.pages, manual, release, markdown: fs.readFileSync(manual, 'utf8'), facts };
}

/** 只读检查（可重复执行，不改变任何文件）：审批与证据新鲜度、结构事实、发布门槛。 */
function prepareVerify({ root, config, task, pages = [], manual, markdown, facts, release = null }) {
  const usable = checkEvidenceUsable(task, pages);
  if (!usable.ok) return { ok: false, errors: usable.errors };
  const releaseErrors = [];
  if (release && fileHash(manual) !== release.documentHash) {
    releaseErrors.push(`document-modified: ${release.documentPath} 与当前发布记录 ${release.id} 不一致（发布后被修改），重新生成并定稿。`);
  }
  if (task.lastCapture && JSON.stringify(facts.evidence?.captureIds || null) !== JSON.stringify(task.lastCapture.captureIds || [])) {
    return { ok: false, errors: [`document-stale: 正式文档基于较早的采集，重新生成并定稿后再验证。`] };
  }
  // 验证可以重复执行；status 与 lastVerification 只记录最近一次结果。
  const nextTask = { ...task, status: 'verified', lastVerification: { at: new Date().toISOString(), result: 'passed' } };
  const checked = validateTaskFinal(markdown, facts);
  if (!checked.ok) return { ok: false, errors: [...releaseErrors, ...checked.errors] };
  // 图片按正式文档所在目录解析，核对产物位置、hash 与隐私记录（与 finalize 同一门槛）。
  const gate = validatePublication({ projectRoot: root, manualFile: manual, markdown, images: facts.images, config });
  if (!gate.ok) return { ok: false, errors: [...releaseErrors, ...formatIssues(gate.errors)] };
  if (releaseErrors.length) return { ok: false, errors: releaseErrors };
  return { ok: true, nextTask, releaseId: release?.id || null };
}

async function run(argv) {
  const { values, positional } = parseArgs(argv, { known: new Set(['projectRoot', 'json', 'help']) });
  const json = values.json === true;
  if (values.help) { process.stdout.write('manual verify <task-id> [--json]\n'); return 0; }
  const root = path.resolve(values.projectRoot || process.cwd());
  const fail = (e) => {
    const a = Array.isArray(e) ? e : [e];
    if (json) process.stdout.write(JSON.stringify({ ok: false, errors: a }, null, 2) + '\n');
    else a.forEach((x) => process.stderr.write(`[manual verify] ${x}\n`));
    return 1;
  };
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors);
  if (positional.length !== 1) return fail('需要一个 task-id。');
  const config = loaded.config;
  const input = loadVerify(root, config, positional[0]);
  if (!input.ok) return fail(input.errors);
  const prepared = prepareVerify({ root, config, ...input });
  if (!prepared.ok) return fail(prepared.errors);
  try {
    input.projectStore.commit({ base: input.base, kind: 'observation', changes: { tasks: [prepared.nextTask] } });
  } catch (error) {
    return fail(`${error.code || 'write-failed'}: 验证通过，但任务状态写入失败。${error.message}`);
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'verified', manual: input.manual, images: input.facts.images.map((image) => image.artifactPath) }, null, 2) + '\n');
  return 0;
}

module.exports = { run, prepareVerify };
