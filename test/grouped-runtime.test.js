'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const fx = require('./fixtures');
const { createProjectStore } = require('../src/store/project');
const { loadConfig } = require('../src/config/load');
const { submitModelResponse } = require('../src/runtime/model-response');

async function cli(root, args, statuses = [0]) {
  const child = spawn(process.execPath, [path.resolve(__dirname, '../bin/manual.js'), ...args, '--project-root', root, '--json']);
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert(statuses.includes(status), `${args.join(' ')}: ${status}\n${stdout}\n${stderr}`);
  return JSON.parse(stdout);
}
function request(root, result) {
  const dir = path.join(root, '.manual/runs', result.runId, 'model');
  const all = fs.readdirSync(dir).filter(n => n.endsWith('.request.json')).map(n => JSON.parse(fs.readFileSync(path.join(dir, n))));
  assert(all.length, JSON.stringify(result));
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}
(async () => {
  const root = fx.captureFixture();
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<h1>演示工作台</h1><div style="padding:60px"><button>NeoStar学校管理台账号登录</button><button>添加文件附件</button></div>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await cli(root, ['init', '--base-url', `http://127.0.0.1:${server.address().port}`, '--audience', 'internal']);
    await cli(root, ['inspect']);
    const input = path.join(root, 'input.json');
    fs.writeFileSync(input, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '选择登录方式并添加资料。', guide: [{ id: 'school', title: '学校登录', instruction: '点击学校登录入口。' }, { id: 'upload', title: '附件', instruction: '点击「添加文件附件」。' }] }] }));
    await cli(root, ['describe', '--input', input]);
    let result = await cli(root, ['generate', 'page:chat', '--copy-default'], [3]);
    const layout = request(root, result);
    assert.equal(layout.kind, 'layout');
    assert.equal(result.browser?.screenshots || 0, 0);
    const feature = (id, name) => ({ id: `page:chat:${id}`, guideId: id, label: id === 'school' ? '学校登录' : '附件', priority: 'required', contentKind: 'operation', operations: [{ id, instruction: id === 'school' ? '点击学校登录入口。' : '点击「添加文件附件」。', evidenceRequirement: 'entry', ...(name ? { bindingIntent: { role: 'button', name } } : {}) }] });
    const output = { features: [feature('school'), feature('upload', '添加文件附件')], sections: [{ id: 'school', title: '学校登录', goal: '选择学校账号。', featureRefs: ['page:chat:school'], figureRefs: ['school'] }, { id: 'materials', title: '添加资料', goal: '添加参考资料。', featureRefs: ['page:chat:upload'], figureRefs: ['upload'] }], figures: [{ id: 'school', sectionId: 'school', operationRefs: ['school'], caption: '学校登录入口', purpose: 'entry' }, { id: 'upload', sectionId: 'materials', operationRefs: ['upload'], caption: '附件入口', purpose: 'entry' }] };
    fs.writeFileSync(input, JSON.stringify({ requestId: layout.requestId, inputHash: layout.inputHash, output }));
    const originalRun = result.runId;
    result = await cli(root, ['resume', originalRun, '--request', layout.requestId, '--input', input], [3]);
    assert.notEqual(result.runId, originalRun, 'accepted layout must automatically replan');
    const binding = request(root, result);
    assert.equal(binding.kind, 'binding');
    const candidate = binding.facts.unresolved[0].candidates.find(c => c.name === 'NeoStar学校管理台账号登录');
    assert(candidate, 'browser candidate must include actual school entry');
    const response = { requestId: binding.requestId, inputHash: binding.inputHash, output: { choices: { 'school/school': { candidateId: candidate.id } } } };
    const { config } = loadConfig(root);
    assert.throws(() => submitModelResponse({ projectRoot: root, config, runId: result.runId, requestId: binding.requestId, response: { ...response, output: { choices: { 'school/school': { candidateId: 'invented' } } } } }), e => e.code === 'invalid-model-response');
    const accepted = submitModelResponse({ projectRoot: root, config, runId: result.runId, requestId: binding.requestId, response });
    assert(!accepted.idempotent);
    assert(submitModelResponse({ projectRoot: root, config, runId: result.runId, requestId: binding.requestId, response }).idempotent);
    result = await cli(root, ['resume', result.runId]);
    assert(fs.existsSync(path.join(root, 'docs/manual/chat.md')));
    const manualFile = path.join(root, 'docs/manual/chat.md');
    fs.writeFileSync(manualFile, fs.readFileSync(manualFile, 'utf8').replace('<!-- manual:block id=guide.school -->', '<!-- manual:block id=guide.school owner=human -->\n团队账号的登录说明由维护者补充。'));
    // Pure category order changes must not open a browser, even in offline mode.
    const store = createProjectStore({ stateDirAbs: path.join(root, '.manual'), docsOutputDir: config.docs.outputDir });
    const base = store.load();
    const page = base.model.pages.find(p => p.id === 'chat');
    store.commit({ base, kind: 'definition', changes: { pages: [{ ...page, sections: [...page.sections].reverse() }] } });
    const preview = await cli(root, ['generate', 'page:chat', '--offline', '--copy-default', '--plan']);
    assert.equal(preview.summary.browserScenarios, 0, JSON.stringify(preview));
    await cli(root, ['generate', 'page:chat', '--offline', '--copy-default']);
    assert(fs.readFileSync(manualFile, 'utf8').includes('团队账号的登录说明由维护者补充。'));
    const nextBase = store.load();
    const nextPage = nextBase.model.pages.find(p => p.id === 'chat');
    store.commit({ base: nextBase, kind: 'definition', changes: { pages: [{ ...nextPage, figures: [...nextPage.figures].reverse() }] } });
    const derivePlan = await cli(root, ['generate', 'page:chat', '--offline', '--copy-default', '--plan']);
    assert.equal(derivePlan.summary.browserScenarios, 0);
    assert(derivePlan.tasks.some(t => t.kind === 'derive-image'), 'figure ordering should rederive from existing geometry');
    await cli(root, ['generate', 'page:chat', '--offline', '--copy-default']);
    await cli(root, ['verify', 'page:chat', '--live']);
    console.log('grouped-runtime: layout handoff, binding, idempotent resume, offline reuse, live verification passed');
  } finally { await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); fx.cleanup(root); }
})().catch(e => { console.error(e); process.exitCode = 1; });
