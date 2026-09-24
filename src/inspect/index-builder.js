'use strict';

const path = require('path');

function normalizePath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(normalizePath))].sort();
}

function isComponent(file) {
  return /(^|\/)components?\//i.test(file);
}

function isHook(file) {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  return /(^|\/)hooks?\//i.test(file) || /^use[A-Z0-9]/.test(base);
}

function buildForwardIndex(pages, { docsOutputDir = 'docs/manual', tasks } = {}) {
  const forward = {};
  const taskIdsByPage = new Map();
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      const pagesForTask = new Set([task.entryPage, ...(task.steps || []).map((step) => step.page)]);
      for (const pageId of pagesForTask) {
        if (!taskIdsByPage.has(pageId)) taskIdsByPage.set(pageId, new Set());
        taskIdsByPage.get(pageId).add(task.id);
      }
    }
  }
  const orderedPages = [...pages].sort((a, b) => String(a.route).localeCompare(String(b.route)));
  for (const page of orderedPages) {
    const entry = uniqueSorted([page.entry]);
    const files = uniqueSorted([...entry, ...(page.dependencies?.files || [])]);
    const info = {
      id: page.id,
      route: page.route,
      entry,
      files,
      // 被引用的样式 / 翻译 / 图片等资源：变化同样影响页面
      assets: uniqueSorted(page.dependencies?.assets || []),
      components: files.filter(isComponent),
      hooks: files.filter(isHook),
      apis: [],
      scenarios: [],
      screenshot: page.browser?.screenshot ?? null,
      manual: path.posix.join(normalizePath(docsOutputDir), `${page.id}.md`),
      includeInManual: page.includeInManual !== false,
    };
    if (Array.isArray(tasks)) info.tasks = [...(taskIdsByPage.get(page.id) || [])].sort();
    forward[page.route] = info;
  }
  return forward;
}

function buildReverseIndex(forward) {
  const routesByFile = new Map();
  for (const [route, info] of Object.entries(forward)) {
    for (const file of [...(info.files || []), ...(info.assets || [])]) {
      if (!routesByFile.has(file)) routesByFile.set(file, new Set());
      routesByFile.get(file).add(route);
    }
  }

  const reverse = {};
  for (const file of [...routesByFile.keys()].sort()) {
    reverse[file] = [...routesByFile.get(file)].sort();
  }
  return reverse;
}

function buildTaskIndexes(tasks, pages, forward, { docsOutputDir = 'docs/manual' } = {}) {
  const pageById = new Map(pages.map((page) => [page.id, page]));
  const taskForward = {};
  const tasksByFile = new Map();

  for (const task of [...tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const pageIds = uniqueSorted([task.entryPage, ...(task.steps || []).map((step) => step.page)]);
    const files = uniqueSorted(pageIds.flatMap((pageId) => {
      const page = pageById.get(pageId);
      return page ? (forward[page.route]?.files || []) : [];
    }).concat((task.evidence || []).map((item) => item?.file)));
    const steps = (task.steps || []).map((step) => ({
      id: step.id,
      page: step.page,
      stateBefore: step.stateBefore ?? null,
      stateAfter: step.stateAfter ?? null,
      screenshots: Array.isArray(step.screenshots) ? step.screenshots : [],
    }));
    taskForward[task.id] = {
      id: task.id,
      title: task.title,
      status: task.status,
      entryPage: task.entryPage,
      pages: pageIds,
      files,
      steps,
      manual: path.posix.join(normalizePath(docsOutputDir), 'tasks', `${task.id}.md`),
    };
    for (const file of files) {
      if (!tasksByFile.has(file)) tasksByFile.set(file, new Set());
      tasksByFile.get(file).add(task.id);
    }
  }

  const taskReverse = {};
  for (const file of [...tasksByFile.keys()].sort()) {
    taskReverse[file] = [...tasksByFile.get(file)].sort();
  }
  return { taskForward, taskReverse };
}

function buildIndexes(pages, options = {}) {
  const forward = buildForwardIndex(pages, options);
  const result = { forward, reverse: buildReverseIndex(forward) };
  if (Array.isArray(options.tasks)) {
    Object.assign(result, buildTaskIndexes(options.tasks, pages, forward, options));
  }
  return result;
}

module.exports = {
  buildForwardIndex,
  buildReverseIndex,
  buildIndexes,
  buildTaskIndexes,
  normalizePath,
};
