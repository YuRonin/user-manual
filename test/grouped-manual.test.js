'use strict';

const assert = require('assert');
const { validatePage } = require('../src/model/schema');
const { buildPageFactPack } = require('../src/generate/fact-pack');
const { renderPage } = require('../src/generate/render');
const { documentCoverage, layoutRevision } = require('../src/annotations/section-plan');

const page = {
  id: 'chat', route: '/chat', title: 'AI 对话', purpose: '描述教学需求。',
  features: [{ id: 'send', label: '发送需求', priority: 'required', contentKind: 'operation', operations: [{ id: 'send-request', instruction: '点击「发送」。', evidenceRequirement: 'entry', bindingIntent: { role: 'button', name: '发送' } }] }],
  sections: [{ id: 'start', title: '开始对话', goal: '描述需求并开始对话。', featureRefs: ['send'], figureRefs: ['input'] }],
  figures: [{ id: 'input', sectionId: 'start', operationRefs: ['send-request'], caption: '输入需求并发送', purpose: 'entry', frame: { mode: 'auto' } }],
};

assert(validatePage(page).ok);
assert(!validatePage({ ...page, figures: [{ ...page.figures[0], operationRefs: ['missing'] }] }).ok, 'unknown operations must fail schema validation');
for (const patch of [{ figures: [null] }, { sections: [{ ...page.sections[0], figureRefs: 1 }] }, { sections: [{ ...page.sections[0], featureRefs: 1 }] }, { figures: [{ ...page.figures[0], operationRefs: 7 }] }, { features: [null] }]) assert(!validatePage({ ...page, ...patch }).ok, 'malformed layout should return errors, not throw');
const image = { figureId: 'input', part: 1, artifactPath: 'docs/manual/images/annotated/input.png', markdownHref: 'images/annotated/input.png', captureId: 'capture', sha256: 'test' };
assert(!documentCoverage(page, [image], []).ok, 'ten prose entries cannot be certified by three unrelated annotations');
const record = { id: 'capture', scenarioId: 'page-chat', checkpointId: 'default', layoutRevision: layoutRevision(page), annotationProof: {
  figures: [{ figureId: 'input', part: 1, purpose: 'entry', status: 'verified' }],
  bindings: [{ operationId: 'send-request', figureId: 'input', status: 'verified' }],
  rendered: [{ operation_id: 'send-request', figure_id: 'input', part: 1, label: '1', located: true, outlined: true, intersects: true, drawn: true, visible: true }],
} };
assert(documentCoverage(page, [image], [record]).ok);
assert(!documentCoverage(page, [{ ...image, part: 2 }], [record]).ok, 'a different part cannot prove the annotation');
const pack = buildPageFactPack({ page, images: [image], language: 'zh-CN' });
const markdown = renderPage(pack);
assert(markdown.includes('## 开始对话'));
assert(markdown.indexOf('## 开始对话') < markdown.indexOf('![输入需求并发送]'), 'figure must be adjacent to its section');
assert(markdown.includes('点击「发送」。'));
const { validateRenderedLayout } = require('../src/annotations/section-plan');
const numberedPack = buildPageFactPack({ page, images: [{ ...image, annotationRefs: [{ label: '1', description: '点击「发送」。' }] }], language: 'zh-CN' });
assert(!validateRenderedLayout(numberedPack, renderPage(numberedPack)).length);
assert(validateRenderedLayout(numberedPack, renderPage(numberedPack).replace('1. 点击', '2. 点击')).length, 'final local numbering must be protected');
console.log('grouped-manual: passed');

require('../src/annotations/binding').bindOperation({}, { target: { role: 'textbox', name: '发送' }, bindingIntent: { role: 'button', name: '发送' } }, { items: [] })
  .then(result => assert.equal(result.reason, 'binding-role-mismatch'))
  .catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { page };
