'use strict';

const assert = require('assert');
const { validateModelLinks, validateSectionLinks } = require('../src/model/links');
const { manualFromPack } = require('../src/generate/manual-model');
const { annotationArtifacts } = require('../src/annotations/proof');
const { pageInventory, buildPlan, stepInventory, verifyCoverage } = require('../src/annotations/coverage');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const upload = { role: 'button', name: '上传附件' };
const page = {
  id: 'workspace', route: '/workspace', states: { default: { assertions: [{ type: 'url', value: '/workspace' }] } },
  features: [{ id: 'upload', label: '上传附件', priority: 'required', description: '上传资料', target: upload, taskIds: ['upload-task'] }],
  guide: [{ id: 'intro', title: '了解工作台', instruction: '工作台汇总了资料。' }, { id: 'upload', title: '上传附件', instruction: '点击上传附件。', target: upload, featureId: 'upload' }],
};
const task = { id: 'upload-task', title: '上传资料', goal: '上传', entryPage: 'workspace', risk: 'read', steps: [{ id: 'attach', page: 'workspace', number: 1, instruction: '点击「上传附件」。', action: { type: 'click', target: upload }, feature_id: 'upload', capture: {} }], completion: { description: '已上传', verification: 'expected' } };

/** 带冻结证明的记录：drawn 指定画出的功能。 */
function pageRecord(id, drawn = ['upload']) {
  const inventory = pageInventory({ page, scenarioId: 'page-workspace' });
  const plan = buildPlan({ inventory, page });
  const rendered = plan.map((item) => ({ feature_id: item.feature_id, located: true, outlined: drawn.includes(item.feature_id), intersects: drawn.includes(item.feature_id), drawn: drawn.includes(item.feature_id) }));
  return { id, kind: 'page', subject: { pageId: 'workspace' }, scenarioId: 'page-workspace', annotationProof: annotationArtifacts({ inventory, plan, rendered, coverage: verifyCoverage({ inventory, plan, rendered }) }).proof };
}
function stepRecord(id, stepId = 'attach') {
  const step = task.steps[0];
  const inventory = stepInventory({ page, task, step });
  const plan = buildPlan({ inventory, page, task, step });
  const rendered = plan.map((item) => ({ feature_id: item.feature_id, located: true, outlined: true, intersects: true, drawn: true }));
  return { id, kind: 'task-step', subject: { taskId: 'upload-task', stepId, timing: 'after' }, annotationProof: annotationArtifacts({ inventory, plan, rendered, coverage: verifyCoverage({ inventory, plan, rendered }) }).proof };
}
const reader = (records) => (id) => records.find((record) => record.id === id) || null;
const codes = (errors) => errors.map((error) => error.code);

process.stdout.write('\nmodel links\n');

test('模型提交：guide.featureId / step.feature_id 必须指向页面上声明的功能', () => {
  assert.deepStrictEqual(validateModelLinks({ pages: [page], tasks: [task] }), []);
  const broken = { ...page, guide: [{ ...page.guide[1], featureId: 'gone' }] };
  assert.deepStrictEqual(codes(validateModelLinks({ pages: [broken], tasks: [] })), ['missing-reference']);
  const badStep = { ...task, steps: [{ ...task.steps[0], feature_id: 'gone' }] };
  assert.deepStrictEqual(codes(validateModelLinks({ pages: [page], tasks: [badStep] })), ['missing-reference']);
  assert.deepStrictEqual(validateModelLinks({ pages: [broken], tasks: [], changedPageIds: new Set(['other']) }), [], '只检查本次改动的页面');
});

test('AC-07 页面手册：guide 小节经 annotationRef 走到截图上实际画出的功能；说明性 guide 不带引用', () => {
  const record = pageRecord('cap-page');
  const pack = { kind: 'page', manualId: 'workspace', language: 'zh-CN', artifacts: [{ id: 'img-1', captureId: 'cap-page' }], guide: page.guide, actions: [] };
  const { sections } = manualFromPack(pack, { proofs: new Map([['cap-page', record.annotationProof]]) });
  const upload = sections.find((section) => section.id === 'guide.upload');
  assert.deepStrictEqual(upload.captureRefs, ['cap-page']);
  assert.deepStrictEqual(upload.annotationRefs, ['cap-page#upload']);
  assert.deepStrictEqual(upload.featureRefs, ['upload']);
  assert.ok(!sections.find((section) => section.id === 'guide.intro').annotationRefs);
  assert.deepStrictEqual(validateSectionLinks({ sections, captureIds: ['cap-page'], readRecord: reader([record]), kind: 'page', subjectId: 'workspace' }), []);
  // 没有证明（旧数据）时章节保持原形状
  assert.deepStrictEqual(Object.keys(manualFromPack(pack).sections.find((section) => section.id === 'guide.upload')).sort(), ['captureRefs', 'claimRefs', 'id', 'kind', 'ownership', 'pageRefs', 'taskRefs'].sort());
});

test('伪造引用：不存在的 Capture、别人的 Capture、没画出的标注、无标注的功能各报确定错误', () => {
  const record = pageRecord('cap-page', []);
  const sections = [{ id: 'guide.upload', kind: 'instructions', captureRefs: ['cap-page', 'cap-gone'], annotationRefs: ['cap-page#upload'], featureRefs: ['upload'] }];
  const errors = validateSectionLinks({ sections, captureIds: ['cap-page'], readRecord: reader([record]), kind: 'page', subjectId: 'workspace' });
  assert.deepStrictEqual(codes(errors).sort(), ['missing-reference', 'section-ref-invalid', 'section-ref-invalid'].sort());
  const foreign = validateSectionLinks({ sections: [{ id: 'location', kind: 'location', captureRefs: ['cap-page'] }], captureIds: [], readRecord: reader([record]), kind: 'page', subjectId: 'workspace' });
  assert.deepStrictEqual(codes(foreign), ['section-ref-invalid']);
});

test('T14 任务步骤章节引用了别的步骤的截图：capture-subject-mismatch', () => {
  const ok = stepRecord('cap-step');
  const pack = { kind: 'task', manualId: 'upload-task', language: 'zh-CN', artifacts: [{ id: 'img-1', captureId: 'cap-step' }], steps: [{ id: 'attach', pageId: 'workspace', artifactRefs: ['img-1'] }], claims: [], branches: [], relatedTasks: [] };
  const { sections } = manualFromPack(pack, { proofs: new Map([['cap-step', ok.annotationProof]]) });
  assert.deepStrictEqual(sections.find((section) => section.id === 'step.attach').annotationRefs, ['cap-step#upload']);
  assert.deepStrictEqual(validateSectionLinks({ sections, captureIds: ['cap-step'], readRecord: reader([ok]), kind: 'task', subjectId: 'upload-task' }), []);
  const wrong = { ...stepRecord('cap-step'), subject: { taskId: 'upload-task', stepId: 'other', timing: 'after' } };
  assert.ok(codes(validateSectionLinks({ sections, captureIds: ['cap-step'], readRecord: reader([wrong]), kind: 'task', subjectId: 'upload-task' })).includes('capture-subject-mismatch'));
});

test('B2-11 Capture 写入：主体缺字段、计划引用清单外功能、覆盖结论与证明不一致都拒绝', () => {
  const { validateCaptureLinks } = require('../src/model/links');
  const ok = { ...stepRecord('cap-ok'), annotationCoverage: null };
  assert.deepStrictEqual(validateCaptureLinks(ok), []);
  assert.deepStrictEqual(codes(validateCaptureLinks({ ...ok, subject: { taskId: 'upload-task' } })), ['capture-subject-mismatch']);
  const forged = JSON.parse(JSON.stringify(ok));
  forged.annotationProof.plan.push({ feature_id: 'ghost', label: '9', priority: 'required' });
  assert.ok(codes(validateCaptureLinks(forged)).includes('missing-reference'));
  const record = pageRecord('cap-page', []);
  const lying = { ...record, annotationCoverage: { ok: true, failures: [] } };
  assert.deepStrictEqual(codes(validateCaptureLinks(lying)), ['annotation-metadata-invalid'], '证明里 upload 没画出，记录却声称通过');
});

test('B2-06 任务级联合覆盖：必标功能在任一张任务截图里画出即可；一张都没有报 missing-from-task-plan', () => {
  const { validateTaskFeatureCoverage } = require('../src/model/links');
  const drawnProof = stepRecord('cap-step').annotationProof;
  assert.deepStrictEqual(validateTaskFeatureCoverage({ task, pages: [page], proofs: new Map([['other', { rendered: [] }], ['cap-step', drawnProof]]) }), []);
  const orphan = { ...page, features: [...page.features, { id: 'export', label: '导出', priority: 'required', taskIds: ['upload-task'] }] };
  assert.deepStrictEqual(codes(validateTaskFeatureCoverage({ task, pages: [orphan], proofs: new Map([['cap-step', drawnProof]]) })), ['missing-from-task-plan']);
  assert.deepStrictEqual(validateTaskFeatureCoverage({ task: { id: 'other-task' }, pages: [orphan], proofs: new Map() }), [], '不属于这个任务的功能不计');
});

test('B2-07 渲染结果记录实际命中的定位（主目标 / 备选 / 声明矩形）', () => {
  const { renderAnnotationResults } = require('../src/evidence/image-pipeline');
  const item = (resolution) => ({ feature_id: 'f', label: '1', sourceRect: { x: 10, y: 10, width: 20, height: 20 }, target: { x: 8, y: 8, width: 24, height: 24 }, marker: { x: 40, y: 40, size: 20 }, resolution });
  const [fallback, rect] = renderAnnotationResults([item({ strategyIndex: 1, fallback: true }), item({ source: 'declared-rect' })], { width: 100, height: 100, dpr: 1 });
  assert.deepStrictEqual(fallback.locator, { strategyIndex: 1, fallback: true });
  assert.deepStrictEqual(rect.locator, { source: 'declared-rect' });
  const proof = annotationArtifacts({ inventory: [{ feature_id: 'f', priority: 'optional' }], plan: [{ feature_id: 'f' }], rendered: [fallback], coverage: null }).proof;
  assert.deepStrictEqual(proof.rendered[0].locator, { strategyIndex: 1, fallback: true }, '定位结果随证明入库');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
