'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rankPages, taskWorksheet } = require('../src/tasks/worksheet');
const { reviewTask, renderPreview } = require('../src/commands/review-task');
const { taskQuality } = require('../src/generate/quality');
const { validateTask } = require('../src/tasks/model');
const { definitionRevision } = require('../src/model/revision');

test('目标只提供页面排序线索，不把推断提升为已验证', () => {
  const pages = [
    { id: 'chat', title: 'AI 对话', route: '/chat', purpose: '向助手提问' },
    { id: 'credits', title: '积分中心', route: '/credits', purpose: '查看积分余额与消耗明细', browser: { verified: true } },
    { id: 'hidden', title: '积分后台', route: '/admin', includeInManual: false },
  ];
  const ranked = rankPages('查看积分余额', pages);
  assert.equal(ranked[0].id, 'credits');
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].browserVerified, true);
  assert.equal(ranked[1].browserVerified, false);
});

test('工作表只读汇总来源，不自动批准或补造动作类型', () => {
  const page = { id: 'credits', route: '/credits', title: '积分中心', entry: 'app/credits/page.tsx',
    guide: [{ id: 'filter', instruction: '点击「消耗」', target: { role: 'button', name: '消耗' } }],
    states: { filtered: { assertions: [{ id: 'filtered', type: 'visible', target: { text: '消耗明细' } }] } },
    dependencies: { files: Array.from({ length: 40 }, (_, index) => `lib/${index}.ts`) },
  };
  const task = { id: 'existing', entryPage: 'credits', title: '查看消耗', status: 'approved', preconditions: ['已登录'] };
  const before = JSON.stringify({ page, task });
  const result = taskWorksheet('查看积分消耗', page, [task]);
  assert.equal(result.suggestions.steps[0].verified, false);
  assert.equal(result.suggestions.steps[0].target.name, '消耗');
  assert.equal(result.suggestions.assertions[0].verified, false);
  assert.equal(result.suggestions.preconditions[0].verified, false);
  assert.equal(result.suggestions.existingTasks[0].id, 'existing');
  assert.match(result.decisions.join('；'), /尚无浏览器观察.*按钮名称和位置/);
  assert.ok(result.additionalSourceFileCount > 0);
  assert.equal(JSON.stringify({ page, task }), before);
  page.browser = { verified: true, latestCaptureId: 'capture-1' };
  assert.doesNotMatch(taskWorksheet('查看积分消耗', page, [task]).decisions.join('；'), /尚无浏览器观察/);
});

test('目标覆盖引用已存在的声明或读者核对项，并区分两种状态', () => {
  const task = { id: 'sample', title: '查看结果', goal: '查看结果', entryPage: 'page', risk: 'read', preconditions: ['已登录'],
    steps: [{ id: 'view', page: 'page', instruction: '查看结果', action: { type: 'inspect' } }],
    completion: { description: '结果可见', claims: [{ id: 'visible', text: '结果可见', assertionRefs: ['visible'], checkpoint: 'view' }],
      readerChecks: ['核对结果内容。'], goalChecks: [
        { id: 'screen', text: '界面显示结果', claimIds: ['visible'] },
        { id: 'content', text: '内容符合需求', readerChecks: ['核对结果内容。'] },
      ] } };
  assert.equal(validateTask(task).ok, true);
  const oldRevision = definitionRevision('userTask', { ...task, completion: { ...task.completion, goalChecks: undefined } });
  assert.equal(definitionRevision('userTask', task), oldRevision, '仅加目标映射不应让浏览器证据过期');
  const report = reviewTask(task, [{ id: 'page', title: '页面', route: '/page' }], { steps: [] });
  assert.equal(report.quality.goalCoverage[0].status, 'not-verified');
  assert.equal(report.quality.goalCoverage[1].status, 'reader-check-required');
  task.completion.goalChecks[1].claimIds = ['visible'];
  assert.equal(reviewTask(task, [{ id: 'page', route: '/page' }], { steps: [] }).quality.goalCoverage[1].status, 'not-verified');
  assert.equal(validateTask({ ...task, completion: { ...task.completion, goalChecks: [{ id: 'bad', text: '未知', claimIds: ['missing'] }] } }).ok, false);
});

test('操作前截图标错目标或截图时机不符会进入审阅警告', () => {
  const task = { id: 'sample', title: '点保存', goal: '保存', entryPage: 'page', risk: 'local', preconditions: ['已登录'],
    steps: [{ id: 'save', page: 'page', instruction: '在右上角点击「保存」', action: { type: 'click', target: { role: 'button', name: '保存' } },
      capture: { timing: 'before', readerCaption: '保存按钮在右上角。', annotations: [{ target: { role: 'button', name: '删除' } }] } }],
    completion: { description: '完成' } };
  const evidence = { steps: [{ id: 'save', status: 'observed', screenshots: [{ annotated: 'docs/manual/images/annotated/x.png', timing: 'after' }] }] };
  const warnings = taskQuality(task, evidence).warnings.join('\n');
  assert.match(warnings, /before-image-target-mismatch:save/);
  assert.match(warnings, /image-timing-mismatch:save/);
  assert.match(reviewTask(task, [{ id: 'page', route: '/page' }], evidence).steps[0].screenshot.reviewQuestions[0], /标注是否指向/);
  task.steps[0].capture.annotations[0].target = 'action.target';
  task.steps[0].capture.timing = 'after';
  assert.doesNotMatch(taskQuality(task, evidence).warnings.join('\n'), /before-image-target-mismatch|image-timing-mismatch/);
  assert.match(reviewTask(task, [{ id: 'page', route: '/page' }], evidence).steps[0].screenshot.reviewQuestions[0], /图注所说的界面变化/);
  task.steps[0].capture.timing = 'before';
  task.steps[0].capture.annotations[0].target = { name: '保存', role: 'button' };
  evidence.steps[0].screenshots[0].timing = 'before';
  assert.doesNotMatch(taskQuality(task, evidence).warnings.join('\n'), /before-image-target-mismatch|image-timing-mismatch/);
});

test('读者预览隐藏维护标记，并保留图片和完成段', () => {
  const markdown = '<!-- manual:block id=overview -->\n# 标题\n<!-- /manual:block -->\n\n1. 点击按钮\n\n![步骤图](../images/annotated/one.png)\n\n## 如何确认已完成\n\n核对内容。';
  const html = renderPreview(markdown, { title: '标题', quality: { warnings: ['需要复核图注'] } }, '../../docs/manual/tasks/');
  assert.match(html, /<h1>标题<\/h1>/);
  assert.match(html, /src="\.\.\/images\/annotated\/one\.png"/);
  assert.match(html, /如何确认已完成/);
  assert.doesNotMatch(html, /manual:block/);
  assert.match(html, /审阅提示（不属于读者正文）/);
});
