'use strict';

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { validateTask } = require('../tasks/model');
const { approve, approvalState, APPROVAL_STATES } = require('../model/approval');
const { createProjectStore } = require('../store/project');

const KNOWN_FLAGS = new Set(['projectRoot', 'input', 'json', 'help']);
const HELP = `
manual approve-tasks —— 人工确认、调整或拒绝候选任务

用法:
  manual approve-tasks --input <决策.json> [--project-root <路径>] [--json]

输入格式:
  { "decisions": [
    { "id": "edit-profile", "decision": "approve", "title": "修改个人资料", "goal": "...", "priority": "high" },
    { "id": "unused-task", "decision": "reject" }
  ] }

candidate 可以被批准或拒绝。已批准任务的动作、断言或风险变化后（或来自旧版本、没有审批范围时），
用 approve 重新确认一次；只改标题、目标描述、优先级不需要重新确认。
可选 "actor" / "decisionRef" 作为审计信息写入审批记录（不是认证）。
全部决策校验通过后才会一次性落盘。
`.trim();

function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else for (const error of list) process.stderr.write(`[manual approve-tasks] ${error}\n`);
  return 1;
}

function readJson(file, errors) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) {
    errors.push(`--input 文件不存在: ${full}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    errors.push(`--input 不是合法 JSON: ${error.message}`);
    return null;
  }
}

function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (!values.input) return fail('需要 --input <决策.json>。', json);

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const stateDir = path.join(projectRoot, loaded.config.artifacts.stateDir);
  const projectStore = createProjectStore({ stateDirAbs: stateDir, docsOutputDir: loaded.config.docs.outputDir });
  let base;
  try { base = projectStore.load(); } catch (error) { return fail(error.errors || [error.message], json); }
  const existing = { tasks: base.model.tasks };
  const pages = { pages: base.model.pages };

  const inputErrors = [];
  const payload = readJson(values.input, inputErrors);
  if (inputErrors.length > 0) return fail(inputErrors, json);
  if (!payload || !Array.isArray(payload.decisions) || payload.decisions.length === 0) {
    return fail('输入需要形如 { "decisions": [ ... ] }，且不能为空。', json);
  }

  const byId = new Map(existing.tasks.map((task) => [task.id, task]));
  const seen = new Set();
  const operations = [];
  const errors = [];

  payload.decisions.forEach((decision, index) => {
    const where = `decisions[${index}]`;
    if (!decision || typeof decision !== 'object' || typeof decision.id !== 'string') {
      errors.push(`${where} 缺少 id。`);
      return;
    }
    if (seen.has(decision.id)) {
      errors.push(`${where} 的 id 重复: ${decision.id}`);
      return;
    }
    seen.add(decision.id);
    const task = byId.get(decision.id);
    if (!task) {
      errors.push(`${where} 的任务不存在: ${decision.id}`);
      return;
    }
    if (!['approve', 'reject'].includes(decision.decision)) {
      errors.push(`${where}.decision 需要是 approve 或 reject。`);
      return;
    }
    const state = approvalState(task, pages.pages);
    if (decision.decision === 'reject') {
      if (state !== APPROVAL_STATES.PENDING) errors.push(`${where}: 只有候选任务可以拒绝，${decision.id} 当前审批状态是 ${state}。`);
      else operations.push({ type: 'reject', task });
      return;
    }
    if (state === APPROVAL_STATES.REJECTED) {
      errors.push(`${where}: ${decision.id} 已被拒绝，不能直接批准。`);
      return;
    }

    const editable = {};
    for (const field of ['title', 'goal', 'priority']) {
      if (decision[field] !== undefined) editable[field] = decision[field];
    }
    const edited = { ...task, ...editable };
    // 审批范围按确认时刻的定义计算；status 只作兼容投影（候选 → approved，其余保持）。
    const next = {
      ...edited,
      status: task.status === 'candidate' ? 'approved' : task.status,
      approval: approve(edited, pages.pages, {
        actor: typeof decision.actor === 'string' ? decision.actor : null,
        decisionRef: typeof decision.decisionRef === 'string' ? decision.decisionRef : null,
      }),
    };
    const checked = validateTask(next);
    if (!checked.ok) errors.push(...checked.errors.map((error) => `${where}: ${error}`));
    else operations.push({ type: 'approve', task: checked.task });
  });

  if (errors.length > 0) return fail(errors, json);

  const approved = operations.filter((op) => op.type === 'approve').map((op) => op.task);
  const rejected = operations.filter((op) => op.type === 'reject').map((op) => op.task.id);
  // 审批是决策：基于读取时的 revision 做 CAS，全部决策一次提交
  try {
    projectStore.commit({ base, kind: 'definition', changes: { tasks: approved, removeTasks: rejected } });
  } catch (error) {
    return fail(`${error.code || 'model-commit-failed'}: ${error.message}`, json);
  }

  const output = { ok: true, approved: approved.map((task) => task.id), rejected };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else process.stdout.write(`[manual approve-tasks] 已批准 ${approved.length} 个，拒绝 ${rejected.length} 个候选任务。\n`);
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
