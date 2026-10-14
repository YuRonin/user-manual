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
// ---- 任务式分类页面：一组连续编号的步骤 + 截图，不重复；结果、提示、常见问题；子流程分节提示
const { sectionSteps, layoutPlan, layoutQuality } = require('../src/annotations/section-plan');
const flowOp = (id, instruction, extra = {}) => ({ id, instruction, evidenceRequirement: 'entry', bindingIntent: { role: 'button', name: id }, ...extra });
const flow = {
  id: 'login', route: '/login', title: '登录与注册', purpose: '登录留仙。',
  features: [
    { id: 'code-tab', label: '切到验证码登录', priority: 'required', contentKind: 'operation', guideId: 'code-login', operations: [flowOp('switch-code', '点击「验证码登录」。')] },
    { id: 'code-send', label: '获取验证码', priority: 'required', contentKind: 'operation', operations: [flowOp('send-code', '输入手机号，点击「下一步」。', { outcome: '页面切换到验证码输入，并提示验证码已发送。', outcomeFigure: 'code-sent' })] },
    { id: 'resend', label: '重新发送', priority: 'optional', contentKind: 'reference', sourceRefs: ['app/login.tsx'], operations: [{ id: 'resend-code', instruction: '倒计时结束后可以重新发送。', evidenceRequirement: 'none', noImageReason: '倒计时状态', sourceRefs: ['app/login.tsx'] }] },
    { id: 'password', label: '密码登录', priority: 'required', contentKind: 'operation', operations: [flowOp('submit-password', '输入手机号和密码，点击「登录」。')] },
  ],
  sections: [
    { id: 'code', title: '使用短信验证码登录', goal: '不想输入密码时，用短信验证码登录。', featureRefs: ['code-tab', 'code-send', 'resend'], figureRefs: ['code-entry', 'code-sent'], tips: ['号码填错时，点击「修改手机号」重新输入。'] },
    { id: 'password', title: '使用密码登录', goal: '已经设置过密码时，用手机号和密码登录。', featureRefs: ['password'], figureRefs: ['password-card'] },
  ],
  figures: [
    { id: 'code-entry', sectionId: 'code', operationRefs: ['switch-code', 'send-code'], caption: '验证码登录入口', purpose: 'entry' },
    { id: 'code-sent', sectionId: 'code', operationRefs: [], caption: '验证码已发送', purpose: 'state', scenarioId: 'login-code-sent' },
    { id: 'password-card', sectionId: 'password', operationRefs: ['submit-password'], caption: '密码登录卡片', purpose: 'entry' },
  ],
  faq: [{ id: 'no-sms', question: '收不到短信验证码怎么办？', answer: '确认号码无误，等倒计时结束后重新发送。' }],
};
assert(validatePage(flow).ok, JSON.stringify(validatePage(flow).errors));
assert.deepStrictEqual(sectionSteps(flow, flow.sections[0]).map((s) => [s.op.id, s.step]), [['switch-code', 1], ['send-code', 2], ['resend-code', null]], 'operation features number continuously; reference notes are not steps');
assert.deepStrictEqual(layoutPlan(flow, 'page-login').map((p) => [p.operation_id, p.label]), [['switch-code', '1'], ['send-code', '2'], ['submit-password', '1']], 'annotation labels are the step numbers within each section');
const flowImages = [
  { figureId: 'code-entry', part: 1, markdownHref: 'images/annotated/code-entry.png', captureId: 'c1', annotationRefs: [{ operationId: 'switch-code', label: '1' }, { operationId: 'send-code', label: '2' }] },
  { figureId: 'code-sent', part: 1, markdownHref: 'images/annotated/code-sent.png', captureId: 'c2', annotationRefs: [] },
  { figureId: 'password-card', part: 1, markdownHref: 'images/annotated/password-card.png', captureId: 'c1', annotationRefs: [{ operationId: 'submit-password', label: '1' }] },
];
const flowPack = buildPageFactPack({ page: flow, images: flowImages, language: 'zh-CN' });
const flowMd = renderPage(flowPack);
const once = (text) => flowMd.split(text).length - 1;
assert.equal(once('点击「验证码登录」。'), 1, 'each instruction is written once (no legend under the figure)');
assert.equal(once('输入手机号，点击「下一步」。'), 1);
assert(/^1\. 点击「验证码登录」。$/m.test(flowMd) && /^2\. 输入手机号，点击「下一步」。$/m.test(flowMd), 'steps continue numbering across feature blocks');
assert(/^2\. 输入手机号，点击「下一步」。\n\n {3}页面切换到验证码输入，并提示验证码已发送。$/m.test(flowMd), 'outcome is indented under its step');
assert(flowMd.indexOf('2. 输入手机号') < flowMd.indexOf('![验证码登录入口]'), 'figure follows the last step it annotates');
assert(flowMd.indexOf('![验证码已发送]') < flowMd.indexOf('倒计时结束后可以重新发送。'), 'outcome figure follows its step, before notes of later features');
assert(!/^\d+\. 倒计时/m.test(flowMd), 'reference notes are plain paragraphs');
assert(flowMd.includes('> 提示：号码填错时，点击「修改手机号」重新输入。'));
assert(flowMd.indexOf('> 提示：') < flowMd.indexOf('## 使用密码登录'), 'tips stay inside their section');
assert(/## 常见问题\n\n\*\*收不到短信验证码怎么办？\*\*\n\n确认号码无误/.test(flowMd), 'faq renders at the end');
assert(flowPack.allowedUiTerms.includes('修改手机号'), 'tip ui terms are declared facts');
assert(flowPack.results.includes('页面切换到验证码输入，并提示验证码已发送。'), 'outcomes are support text for copy');
assert.deepStrictEqual(validateRenderedLayout(flowPack, flowMd), []);
assert(validateRenderedLayout(flowPack, flowMd.replace('2. 输入手机号', '3. 输入手机号')).length, 'step numbering is protected');
const misLabeled = buildPageFactPack({ page: flow, images: flowImages.map((i) => i.figureId === 'code-entry' ? { ...i, annotationRefs: [{ operationId: 'switch-code', label: '2' }, { operationId: 'send-code', label: '1' }] } : i), language: 'zh-CN' });
assert(validateRenderedLayout(misLabeled, renderPage(misLabeled)).some((e) => /标注号/.test(e.message)), 'image labels must equal step numbers');
const reordered = { ...flow, sections: [{ ...flow.sections[0], featureRefs: ['code-send', 'code-tab', 'resend'] }, flow.sections[1]] };
assert.notEqual(layoutRevision(reordered), layoutRevision(flow), 'step order is part of the capture layout');
// outcome 必须由同一小节的状态图证明
const withOutcome = (patch) => ({ ...flow, features: flow.features.map((f) => f.id === 'code-send' ? { ...f, operations: [{ ...f.operations[0], ...patch }] } : f) });
const dropFigure = withOutcome({});
delete dropFigure.features[1].operations[0].outcomeFigure;
assert(!validatePage(dropFigure).ok, 'outcome needs outcomeFigure');
assert(!validatePage(withOutcome({ outcomeFigure: 'code-entry' })).ok, 'outcomeFigure must be a state figure');
assert(!validatePage(withOutcome({ outcomeFigure: 'password-card' })).ok, 'outcomeFigure must be in the same section');
assert(!validatePage({ ...flow, faq: [{ id: 'x', question: '' }] }).ok, 'faq needs question and answer');
assert(!validatePage({ ...flow, sections: [{ ...flow.sections[0], tips: [''] }, flow.sections[1]] }).ok, 'tips must be non-empty strings');
// 结果证据
const stateRecord = { id: 'c2', scenarioId: 'login-code-sent', checkpointId: 'default', layoutRevision: layoutRevision(flow), validations: [{ scope: 'scenario-state', outcome: 'passed' }], annotationProof: { figures: [{ figureId: 'code-sent', part: 1, purpose: 'state', status: 'verified', stateVerified: true }], bindings: [], rendered: [] } };
const outcomeErrors = (records) => documentCoverage(flow, flowImages, records).errors.filter((e) => e.code === 'manual-outcome-unproven');
assert.equal(outcomeErrors([]).length, 1, 'missing outcome figure blocks publication');
assert.equal(outcomeErrors([stateRecord]).length, 0, 'verified state figure proves the outcome');
assert.equal(outcomeErrors([{ ...stateRecord, validations: [] }]).length, 1, 'state must be re-asserted');
// 子流程分节提示
assert.deepStrictEqual(layoutQuality(flow), ['section-outcome-missing:password'], 'sections whose last step has no outcome are flagged');
const extras = ['a', 'b'].map((k) => ({ id: `extra-${k}`, label: k, priority: 'optional', contentKind: 'operation', operations: [flowOp(`extra-${k}`, `点击「${k}」。`)] }));
const broad = {
  ...flow,
  features: [...flow.features, ...extras],
  sections: [{ ...flow.sections[0], featureRefs: [...flow.sections[0].featureRefs, 'password', 'extra-a', 'extra-b'], figureRefs: [...flow.sections[0].figureRefs, 'password-card', 'extra'] }],
  figures: [...flow.figures.map((f) => ({ ...f, sectionId: 'code' })), { id: 'extra', sectionId: 'code', operationRefs: ['extra-a', 'extra-b'], caption: '更多', purpose: 'entry' }],
};
assert(validatePage(broad).ok, JSON.stringify(validatePage(broad).errors));
assert(layoutQuality(broad).includes('section-too-broad:code'), 'a section mixing many operation features is flagged');
assert(flowPack.quality.warnings.includes('section-outcome-missing:password'), 'layout warnings reach the fact pack');
// 分类计划文字的风格检查
const { layoutStyle } = require('../src/annotations/layout-migration');
assert.deepStrictEqual(layoutStyle(flow), []);
assert(layoutStyle({ ...flow, faq: [{ id: 'x', question: '您收不到验证码吗？', answer: '值得注意的是要等一会儿。' }] }).length >= 2, 'faq prose is style-checked');
// 页面 Scenario 的模拟写操作
const { validateScenario } = require('../src/model/schema');
const scenario = (patch) => ({ schemaVersion: 1, id: 'login-code-sent', userTaskId: null, environment: 'local', authProfile: 'anonymous', data: { mode: 'fixture', fixture: 'login-sms' }, entry: { pageId: 'login' }, expected: { httpStatuses: [200], state: 'normal' },
  setup: [{ type: 'click', target: { role: 'button', name: '确认发送' }, risk: 'write', mocked: true }], checkpoints: [{ id: 'default', pageId: 'login', afterStepId: null, assertions: [{ type: 'visible', target: { role: 'textbox', name: '验证码' } }] }], ...patch });
assert(validateScenario(scenario({})).ok, JSON.stringify(validateScenario(scenario({})).errors));
assert(validateScenario(scenario({ data: { mode: 'live' } })).errors.some((e) => e.code === 'mock-write-unbacked'), 'mocked writes need a mock fixture');
assert(validateScenario(scenario({ setup: [{ type: 'click', target: { role: 'button', name: '确认发送' } }] })).errors.some((e) => e.code === 'setup-write-risk'), 'unmarked risky setup is still rejected');
assert(!validateScenario(scenario({ setup: [{ type: 'click', target: { role: 'button', name: '下一步' }, mocked: 'yes' }] })).ok, 'mocked must be true');
console.log('grouped-manual: passed');

require('../src/annotations/binding').bindOperation({}, { target: { role: 'textbox', name: '发送' }, bindingIntent: { role: 'button', name: '发送' } }, { items: [] })
  .then(result => assert.equal(result.reason, 'binding-role-mismatch'))
  .catch(error => { console.error(error); process.exitCode = 1; });

module.exports = { page };
