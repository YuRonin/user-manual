'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const store = require('../tasks/store');
const { transitionTask } = require('../tasks/model');
const { buildTaskDraft, publishAtomic } = require('../generate/task-draft');
const { validateTaskFinal } = require('../generate/task-facts');
const { checkDocumentImages } = require('../publication/paths');
const { validateEvidence, validatePublishedImages, validatePublicationFacts } = require('../privacy/publication');

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

function runFinalize({ root, config, state, task, factsFile, finalizeInput, json }) {
  if (!fs.existsSync(factsFile)) return fail('缺少任务事实文件，请先生成草稿。', json);
  const final = fs.readFileSync(path.resolve(finalizeInput), 'utf8');
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const checked = validateTaskFinal(final, facts);
  if (!checked.ok) return fail(checked.errors, json);
  const out = manualFileFor(root, config, task.id);
  const refs = checkDocumentImages({ projectRoot: root, manualFile: out, markdown: final, publishRoot: config.docs.outputDir, expected: facts.images });
  if (!refs.ok) return fail(refs.errors.map((e) => e.message), json);
  const images = validatePublishedImages(facts.images, config);
  const publication = validatePublicationFacts(facts.publication, config);
  if (!images.ok || !publication.ok) return fail([...images.errors, ...publication.errors], json);
  publishAtomic(out, final);
  store.writeTask(state, transitionTask(task, 'generated'));
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'generated', manual: out }, null, 2) + '\n');
  return 0;
}

function runDraft({ root, config, task, draftDir, draftFile, factsFile, json }) {
  if (task.status !== 'captured') return fail(`任务必须是 captured，当前是 ${task.status}。`, json);
  if (!task.evidenceManifest) return fail('任务缺少 evidenceManifest。', json);
  const evidenceFile = path.join(root, task.evidenceManifest);
  if (!fs.existsSync(evidenceFile)) return fail(`证据清单不存在: ${evidenceFile}`, json);
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  const privacy = validateEvidence(evidence, config);
  if (!privacy.ok) return fail(privacy.errors, json);
  const built = buildTaskDraft(task, evidence, { projectRoot: root, finalPath: manualFileFor(root, config, task.id) });
  if (!built.ok) return fail(built.errors, json);
  built.facts.publication = privacy.summary;
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
