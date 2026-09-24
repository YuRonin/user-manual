'use strict';

/*
 * inspect 发现页面或源文件变化时，给受影响的任务打上 stale 标记。
 *
 * 标记只说明"已有证据可能过期"，不改写 status，也不阻止重新执行：
 * 下一次 capture-task 成功后标记被清除（stale 不是死路）。
 * 候选任务还没有证据，不需要标记。
 */

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function markAffectedTasks(tasks, { pageIds = [], files = [], at = new Date().toISOString() } = {}) {
  const pages = new Set(pageIds);
  const changed = new Set(files.map(toPosix));
  const staleIds = [];
  const updated = tasks.map((task) => {
    if (task.status === 'candidate') return task;
    const taskPages = [task.entryPage, ...(task.steps || []).map((step) => step.pageId ?? step.page)];
    const taskFiles = (task.evidence || []).map((entry) => toPosix(entry.file));
    const reasons = [
      ...taskPages.filter((pageId) => pages.has(pageId)).map((pageId) => `page-changed:${pageId}`),
      ...taskFiles.filter((file) => changed.has(file)).map((file) => `source-changed:${file}`),
    ];
    if (reasons.length === 0) return task;
    staleIds.push(task.id);
    const previous = task.stale?.reasons || [];
    return { ...task, stale: { reasons: [...new Set([...previous, ...reasons])], detectedAt: at } };
  });
  return { tasks: updated, staleIds };
}

module.exports = { markAffectedTasks };
