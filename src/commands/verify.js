'use strict';
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const store = require('../tasks/store');
const { transitionTask } = require('../tasks/model');
const { validateTaskFinal } = require('../generate/task-facts');
const { validatePublication, formatIssues } = require('../publication/validate');

async function run(argv) {
  const { values, positional } = parseArgs(argv, { known: new Set(['projectRoot', 'json', 'help']) });
  const json = values.json === true;
  if (values.help) { process.stdout.write('manual verify <task-id> [--json]\n'); return 0; }
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  const fail = (e) => {
    const a = Array.isArray(e) ? e : [e];
    if (json) process.stdout.write(JSON.stringify({ ok: false, errors: a }, null, 2) + '\n');
    else a.forEach((x) => process.stderr.write(`[manual verify] ${x}\n`));
    return 1;
  };
  if (!loaded.ok) return fail(loaded.errors);
  if (positional.length !== 1) return fail('需要一个 task-id。');
  const config = loaded.config;
  const state = path.join(root, config.artifacts.stateDir);
  const task = store.readTask(state, positional[0]);
  if (!task) return fail('找不到任务。');
  if (task.status !== 'generated') return fail(`任务必须是 generated，当前是 ${task.status}。`);
  const manual = path.join(root, config.docs.outputDir, 'tasks', `${task.id}.md`);
  const factsFile = path.join(state, 'drafts', 'tasks', `${task.id}.facts.json`);
  if (!fs.existsSync(manual) || !fs.existsSync(factsFile)) return fail('正式文档或事实文件不存在。');
  const markdown = fs.readFileSync(manual, 'utf8');
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  const checked = validateTaskFinal(markdown, facts);
  if (!checked.ok) return fail(checked.errors);
  // 图片按正式文档所在目录解析，核对产物位置、hash 与隐私记录（与 finalize 同一门槛）。
  const gate = validatePublication({ projectRoot: root, manualFile: manual, markdown, images: facts.images, config });
  if (!gate.ok) return fail(formatIssues(gate.errors));
  store.writeTask(state, transitionTask(task, 'verified'));
  if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'verified', manual, images: facts.images.map((image) => image.artifactPath) }, null, 2) + '\n');
  return 0;
}

module.exports = { run };
