'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const sharp = require('sharp');
const fx = require('./fixtures');
const { loadConfig } = require('../src/config/load');
const { capturePage } = require('../src/evidence/capture-page');
const { draftPage, preparePageFinal, publishPageFinal } = require('../src/generate/page-usecase');
const { rederiveCaptures } = require('../src/evidence/rederive');
const { applyLayouts, prepareLayouts, rollbackLayout } = require('../src/annotations/layout-migration');

const cli = (root, args) => {
  const r = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/manual.js'), ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout);
};

(async () => {
  const root = fx.captureFixture();
  const html = `<!doctype html><html><body style="font-family:Arial;padding:40px"><h1>演示工作台</h1>
    <section aria-label="对话输入区" style="margin-top:80px;border:1px solid #ccc;padding:40px;width:500px">
    <label>教学需求<textarea aria-label="教学需求"></textarea></label><button>发送</button><button>添加文件附件</button><label>资料文件<input type="file" id="file-upload"></label></section>
    <section aria-label="登录方式" style="margin:40px;padding:30px"><button aria-label="NeoStar学校管理台账号登录">学校图标</button></section>
    <button onclick="document.getElementById('menu').hidden=false">技能与组合技</button>
    <section aria-label="个人模板"><button>选择模板</button></section><section aria-label="学校模板"><button>选择模板</button></section>
    <section id="menu" hidden role="dialog" aria-label="教学能力"><button>组合技</button></section><div id="drop-zone" style="margin:30px;padding:30px;border:1px solid gray">拖到这里</div></body></html>`;
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    cli(root, ['init', '--base-url', `http://127.0.0.1:${server.address().port}`, '--audience', 'internal']);
    cli(root, ['inspect']);
    const { config } = loadConfig(root);
    const state = path.join(root, '.manual');
    const op = (id, instruction, name, requirement = 'entry') => ({ id, instruction, evidenceRequirement: requirement, bindingIntent: { role: 'button', name } });
    const feature = (id, label, operation) => ({ id, label, priority: 'required', contentKind: 'operation', operations: [operation] });
    const page = { id: 'chat', title: 'AI 对话', purpose: '描述需求，选择教学能力。',
      features: [feature('send', '发送', op('send-request', '点击「发送」。', '发送')), feature('upload', '附件', op('attach-file', '点击「添加文件附件」。', '添加文件附件')), feature('school', '学校登录', op('school-login', '点击学校账号登录入口。', 'NeoStar学校管理台账号登录')), feature('combo', '组合技', op('choose-combo', '点击「组合技」。', '组合技', 'state'))],
      sections: [{ id: 'conversation', title: '开始对话', goal: '描述需求并发送。', featureRefs: ['send'], figureRefs: ['input'] }, { id: 'materials', title: '添加资料', goal: '添加参考资料。', featureRefs: ['upload'], figureRefs: ['attachments'] }, { id: 'school', title: '学校账号登录', goal: '找到学校登录入口。', featureRefs: ['school'], figureRefs: ['school-entry'] }, { id: 'abilities', title: '使用教学能力', goal: '选择组合技。', featureRefs: ['combo'], figureRefs: ['combo-menu'] }],
      figures: [{ id: 'input', sectionId: 'conversation', operationRefs: ['send-request'], caption: '发送需求的入口', purpose: 'entry', frame: { mode: 'region', target: { role: 'region', name: '对话输入区' } } }, { id: 'attachments', sectionId: 'materials', operationRefs: ['attach-file'], caption: '添加附件', purpose: 'entry', frame: { mode: 'auto' } }, { id: 'school-entry', sectionId: 'school', operationRefs: ['school-login'], caption: '学校登录入口', purpose: 'entry', frame: { mode: 'auto' } }, { id: 'combo-menu', sectionId: 'abilities', operationRefs: ['choose-combo'], caption: '展开后的组合技菜单', purpose: 'state', scenarioId: 'chat-abilities', frame: { mode: 'region', target: { role: 'dialog', name: '教学能力' } } }],
    };
    const scenario = { schemaVersion: 1, id: 'chat-abilities', userTaskId: null, environment: 'local', authProfile: 'anonymous', data: { mode: 'live' }, entry: { pageId: 'chat' }, expected: { httpStatuses: [200], state: 'normal' }, setup: [{ type: 'click', target: { role: 'button', name: '技能与组合技' }, risk: 'read' }], checkpoints: [{ id: 'default', pageId: 'chat', afterStepId: null, assertions: [{ id: 'menu-visible', type: 'visible', target: { role: 'dialog', name: '教学能力' } }], capture: { mode: 'viewport', annotations: [] } }] };
    const payload = { pages: [page], scenarios: [scenario] };
    assert(prepareLayouts({ projectRoot: root, config, payload }).report.length);
    const migration = applyLayouts({ projectRoot: root, config, payload });
    assert(applyLayouts({ projectRoot: root, config, payload }).idempotent);
    const initial = await capturePage({ projectRoot: root, config, pageId: 'chat' });
    assert.equal(initial.record.annotationProof.figures.length, 3);
    assert(initial.record.annotationProof.bindings.every(b => b.status === 'verified'));
    assert(initial.record.semantic.items.some(i => i.role === 'textbox' && i.name === '教学需求' && i.resolution === 'unique'));
    assert(initial.record.semantic.items.some(i => i.role === 'fileinput' && i.name === '资料文件' && i.resolution === 'unique'));
    const templates = require('../src/annotations/binding').candidatesOf(initial.record.semantic).filter(c => c.name === '选择模板');
    assert.equal(templates.length, 2);
    assert(templates.every(c => c.target.within), 'duplicate names must be scoped to their observed region');
    const ambiguous = await require('../src/annotations/binding').bindOperation({}, { operation_id: 'template', figure_id: 'template', bindingIntent: { role: 'button', name: '选择模板' } }, initial.record.semantic);
    assert.equal(ambiguous.status, 'ambiguous');
    assert.equal(ambiguous.candidates.length, 2);
    const provider = require('../src/browser').createProvider({ id: 'binding-hints', providerConfig: { type: 'playwright', headless: true, channel: 'chromium' }, profile: { kind: 'desktop', viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 } });
    try {
      await provider.open(`http://127.0.0.1:${server.address().port}`);
      const semantic = await provider.semanticSnapshot();
      const bind = (target, intent, choice) => require('../src/annotations/binding').bindOperation(provider, { target, operation_id: 'send', figure_id: 'input', bindingIntent: intent }, semantic, choice);
      const intent = { role: 'button', name: '发送' };
      const wrong = await bind({ selector: 'textarea' }, intent);
      assert.equal(wrong.status, 'unresolved', 'a visible textbox cannot verify a button operation');
      assert.equal(wrong.reason, 'binding-identity-mismatch');
      const correct = await bind({ selector: 'section[aria-label="对话输入区"] button:first-of-type' }, intent);
      assert.equal(correct.status, 'verified');
      assert.equal(correct.name, '发送');
      assert.equal(correct.role, 'button');
      const sendCandidate = require('../src/annotations/binding').candidatesOf(semantic).find(c => c.name === '发送');
      const repaired = await bind({ role: 'textbox', name: '教学需求' }, intent, { candidateId: sendCandidate.id });
      assert.equal(repaired.status, 'verified', 'an accepted candidate must override a mismatched old hint');
      const differentName = await bind({ selector: 'section[aria-label="对话输入区"] button:first-of-type' }, { role: 'button', name: '发送需求' });
      assert.equal(differentName.status, 'unresolved', 'semantic name differences require an explicit candidate choice');
      const unnamed = await bind({ selector: '#drop-zone' }, null);
      assert.equal(unnamed.status, 'verified', 'a source-backed unnamed region still supports explicit hints');
      assert(unnamed.found.rect && unnamed.source === 'explicit-hint');
    } finally { await provider.close(); }
    if (process.env.MANUAL_QA_IMAGE) fs.copyFileSync(path.join(root, initial.record.artifacts.find(a => a.kind === 'published').path), process.env.MANUAL_QA_IMAGE);
    for (const image of initial.record.artifacts.filter(a => a.kind === 'published')) {
      const meta = await sharp(path.join(root, image.path)).metadata();
      assert(meta.width < initial.record.spec.viewport.width * initial.record.spec.dpr, 'category figure should be cropped');
    }
    const draftMissing = draftPage({ projectRoot: root, config, pageId: 'chat' });
    assert.equal(draftMissing.pack.evidenceCoverage.total, 4);
    assert.throws(() => preparePageFinal({ projectRoot: root, config, pageId: 'chat' }), e => e.code === 'manual-operation-uncovered');
    const resolved = require('../src/scenarios/store').readScenario(state, scenario.id).scenario;
    const menu = await capturePage({ projectRoot: root, config, pageId: 'chat', options: { scenario: resolved } });
    assert(menu.record.annotationProof.figures[0].stateVerified);
    const draft = draftPage({ projectRoot: root, config, pageId: 'chat' });
    assert(draft.pack.evidenceCoverage.ok);
    assert.equal(draft.pack.artifacts.length, 4);
    const store = require('../src/store/project').createProjectStore({ stateDirAbs: state, docsOutputDir: config.docs.outputDir });
    const savedPage = store.load().model.pages.find(p => p.id === 'chat');
    const newInstruction = '填写需求后点击「发送」。';
    const updatedText = { ...savedPage, features: savedPage.features.map(f => f.id === 'send' ? { ...f, operations: f.operations.map(o => ({ ...o, instruction: newInstruction })) } : f) };
    const reused = require('../src/generate/grouped-page').groupedImages({ projectRoot: root, config, page: updatedText });
    assert.equal(reused.images.find(i => i.figureId === 'input').captureId, initial.record.id, 'prose-only changes reuse the observed image');
    assert.equal(reused.images.find(i => i.figureId === 'input').annotationRefs[0].description, newInstruction, 'local legends must use current operation prose with the frozen binding and label');
    assert(draft.markdown.indexOf('## 添加资料') < draft.markdown.indexOf('![添加附件]'));
    const prepared = preparePageFinal({ projectRoot: root, config, pageId: 'chat' });
    publishPageFinal({ projectRoot: root, config, prepared });
    cli(root, ['verify', 'page:chat']);
    require('../src/generate/handbook').updateHandbook({ projectRoot: root, config });
    cli(root, ['site']);
    const session = require('../src/browser/session').createBrowserSession();
    try {
      const live = await require('../src/verify/live').verifyLive({ projectRoot: root, config, target: { type: 'page', id: 'chat' }, session, drift: false });
      assert.equal(live.result, 'passed', JSON.stringify(live.checks));
      assert(live.checks.some(c => c.id.includes('choose-combo') && c.outcome === 'passed'), 'live verify must check expanded menu binding');
    } finally { await session.close(); }
    const derived = await rederiveCaptures({ projectRoot: root, config, captureIds: [initial.record.id] });
    assert.equal(derived.records[0].record.annotationProof.figures.length, 3);
    fs.appendFileSync(path.join(root, 'app/chat/page.tsx'), '\n// Source changed after the grouped captures.\n');
    cli(root, ['inspect']);
    cli(root, ['describe', '--id', 'chat', '--title', 'AI 对话', '--purpose', '描述需求，选择教学能力。']);
    assert.throws(() => draftPage({ projectRoot: root, config, pageId: 'chat' }), e => e.code === 'evidence-stale', 'grouped drafts must reject screenshots from an older source revision');
    assert.throws(() => preparePageFinal({ projectRoot: root, config, pageId: 'chat' }), e => e.code === 'draft-stale', 'existing grouped drafts cannot publish after source reanalysis');
    rollbackLayout({ projectRoot: root, config, id: migration.migrationId });
    assert(!fs.existsSync(path.join(state, 'scenarios/chat-abilities.yaml')));
    console.log('grouped-manual-browser: capture, crop, state, publication, site, rederive, rollback passed');
  } finally {
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    fx.cleanup(root);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
