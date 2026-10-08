'use strict';

const { buildDiscoveryWorklist } = require('./discovery');

function terms(value) {
  const text = String(value || '').toLowerCase();
  const latin = text.match(/[a-z0-9]{2,}/g) || [];
  const han = (text.match(/[\p{Script=Han}]+/gu) || []).flatMap(word =>
    word.length === 1 ? [word] : [...word].slice(0, -1).map((letter, index) => letter + word[index + 1]));
  return new Set([...latin, ...han]);
}

function rankPages(goal, pages) {
  const sought = terms(goal);
  return pages.filter(page => page.includeInManual !== false).map(page => {
    const title = terms(page.title);
    const purpose = terms(page.purpose);
    const actions = terms((page.detectedActions || []).join(' '));
    const overlap = (values) => [...sought].filter(term => values.has(term)).length;
    return { id: page.id, title: page.title || page.id, route: page.route,
      score: overlap(title) * 3 + overlap(purpose) * 2 + overlap(actions),
      browserVerified: page.browser?.verified === true };
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function taskWorksheet(goal, page, tasks) {
  const evidence = buildDiscoveryWorklist([page], tasks)[0];
  const primaryFiles = [...new Set([page.entry, ...(page.source || [])].filter(Boolean))].slice(0, 12);
  return {
    goal, entryPage: page.id, entryRoute: page.route,
    suggestions: {
      steps: evidence.stepHints,
      assertions: evidence.assertionHints,
      preconditions: evidence.preconditionHints,
      existingTasks: evidence.existingTasks,
      browserObservation: evidence.page.browserObservation,
    },
    decisions: [
      '确认任务名称、适用读者和入口页面',
      ...(!evidence.page.browserObservation ? ['入口页尚无浏览器观察；批准前核对当前站点的按钮名称和位置，源码文案可能与线上不同'] : []),
      '逐步确认动作、前提与风险；只选与目标有关的步骤',
      '分别写出有断言证明的界面结果，以及读者仍须核对的业务结果',
      '检查截图时机、标注目标与常见异常',
    ],
    sourceFiles: primaryFiles,
    additionalSourceFileCount: Math.max(0, evidence.read.length - primaryFiles.length),
    next: '审阅后用 discover-tasks --input 保存 candidate，再由 approve-tasks 确认。建议不是执行授权。',
  };
}

module.exports = { rankPages, taskWorksheet };
