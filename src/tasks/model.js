'use strict';

const RISKS = ['read', 'local', 'write', 'destructive'];
const STATUSES = ['candidate', 'approved', 'captured', 'generated', 'verified', 'stale'];
const COMPLETION_VERIFICATIONS = ['expected', 'verified'];
const FORWARD_STATUS = {
  candidate: 'approved',
  approved: 'captured',
  captured: 'generated',
  generated: 'verified',
};

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function effectiveRisk(task, step) {
  return RISKS.includes(step?.risk) ? step.risk : task?.risk;
}

function executionFor(risk) {
  if (risk === 'destructive') return 'never';
  if (risk === 'write') return 'stop-before-action';
  return 'auto';
}

function normalizeStep(step, taskRisk) {
  const normalized = {
    ...step,
    id: typeof step?.id === 'string' ? step.id.trim() : step?.id,
    instruction: typeof step?.instruction === 'string' ? step.instruction.trim() : step?.instruction,
    page: typeof step?.page === 'string' ? step.page.trim() : step?.page,
  };
  const risk = RISKS.includes(step?.risk) ? step.risk : taskRisk;
  normalized.execution = executionFor(risk);
  return normalized;
}

function normalizeTask(input) {
  const task = {
    ...input,
    id: typeof input?.id === 'string' ? input.id.trim() : input?.id,
    title: typeof input?.title === 'string' ? input.title.trim() : input?.title,
    goal: typeof input?.goal === 'string' ? input.goal.trim() : input?.goal,
    entryPage: typeof input?.entryPage === 'string' ? input.entryPage.trim() : input?.entryPage,
    priority: input?.priority || 'normal',
    preconditions: Array.isArray(input?.preconditions) ? input.preconditions : [],
    status: input?.status || 'candidate',
    steps: Array.isArray(input?.steps)
      ? input.steps.map((step) => normalizeStep(step, input?.risk))
      : [],
    branches: Array.isArray(input?.branches) ? input.branches : [],
    relatedTasks: Array.isArray(input?.relatedTasks) ? input.relatedTasks : [],
  };
  return task;
}

function validateTask(input) {
  const task = normalizeTask(input || {});
  const errors = [];

  for (const field of ['id', 'title', 'goal', 'entryPage']) {
    if (!nonEmpty(task[field])) errors.push(`${field} 需要是非空字符串。`);
  }
  if (nonEmpty(task.id) && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id)) {
    errors.push('id 只能使用小写字母、数字和连字符。');
  }
  if (!Array.isArray(input?.preconditions)) errors.push('preconditions 需要是字符串数组。');
  else if (input.preconditions.some((item) => !nonEmpty(item))) errors.push('preconditions 只能包含非空字符串。');
  if (!RISKS.includes(task.risk)) errors.push(`risk 需要是 ${RISKS.join(' / ')} 之一。`);
  if (!STATUSES.includes(task.status)) errors.push(`status 需要是 ${STATUSES.join(' / ')} 之一。`);

  if (!Array.isArray(input?.steps) || input.steps.length === 0) {
    errors.push('steps 至少需要一个步骤。');
  } else {
    const ids = new Set();
    task.steps.forEach((step, index) => {
      const where = `steps[${index}]`;
      if (!nonEmpty(step.id)) errors.push(`${where}.id 需要是非空字符串。`);
      else if (ids.has(step.id)) errors.push(`${where}.step.id 重复: ${step.id}`);
      else ids.add(step.id);
      if (!nonEmpty(step.instruction)) errors.push(`${where}.instruction 需要是非空字符串。`);
      if (!nonEmpty(step.page)) errors.push(`${where}.page 需要是非空字符串。`);
      if (!step.action || typeof step.action !== 'object' || !nonEmpty(step.action.type)) {
        errors.push(`${where}.action.type 需要是非空字符串。`);
      }
      if (step.risk !== undefined && !RISKS.includes(step.risk)) {
        errors.push(`${where}.risk 需要是 ${RISKS.join(' / ')} 之一。`);
      }
    });
  }

  if (!input?.completion || typeof input.completion !== 'object') {
    errors.push('completion 是必填对象。');
  } else {
    if (!nonEmpty(input.completion.description)) errors.push('completion.description 需要是非空字符串。');
    if (!COMPLETION_VERIFICATIONS.includes(input.completion.verification)) {
      errors.push('completion.verification 需要是 expected 或 verified。');
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, task };
}

function transitionTask(input, nextStatus, { humanConfirmed = false } = {}) {
  const current = input?.status;
  if (!STATUSES.includes(nextStatus)) throw new Error(`未知任务状态: ${nextStatus}`);
  if (nextStatus === 'stale' && STATUSES.includes(current) && current !== 'stale') {
    return { ...input, status: 'stale' };
  }
  if (current === 'candidate' && nextStatus === 'approved' && !humanConfirmed) {
    throw new Error('candidate 进入 approved 需要人工确认。');
  }
  if (FORWARD_STATUS[current] !== nextStatus) {
    throw new Error(`不能从 ${current} 直接进入 ${nextStatus}。`);
  }
  return { ...input, status: nextStatus };
}

module.exports = {
  RISKS,
  STATUSES,
  COMPLETION_VERIFICATIONS,
  effectiveRisk,
  normalizeTask,
  validateTask,
  transitionTask,
};
