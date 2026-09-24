'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildTaskFactPack, buildPageFactPack, diffPacks } = require('../src/generate/fact-pack');
const { renderTask, renderPage, templateFor } = require('../src/generate/render');
const { validateTaskFinal } = require('../src/generate/task-facts');
const taskStore = require('../src/tasks/store');
const { loadConfig } = require('../src/config/load');
const { buildPrivacyRecord } = require('../src/publication/validate');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-factpack-'));
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function task(overrides = {}) {
  return {
    id: 'edit-profile', title: '修改个人资料', goal: '更新昵称', entryPage: 'profile', preconditions: ['已登录'], risk: 'local',
    steps: [
      { id: 'open', instruction: '在右上角点击「编辑资料」按钮', page: 'profile', action: { type: 'click', target: { role: 'button', name: '编辑资料' } } },
      { id: 'nickname', instruction: '在「昵称」输入框填写新昵称', page: 'profile', action: { type: 'fill', target: { label: '昵称' }, valueRef: 'fixtures.nickname' } },
      { id: 'save', instruction: '点击「保存」', page: 'profile', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存' } } },
    ],
    completion: { description: '完成' },
    ...overrides,
  };
}

const evidence = { canonicalCaptureRefs: ['c1'], steps: [{ id: 'open', status: 'verified' }, { id: 'nickname', status: 'verified' }, { id: 'save', status: 'not-executed' }] };
const images = [{ artifactPath: 'docs/manual/images/annotated/a.png', markdownHref: '../images/annotated/a.png', sha256: 'a'.repeat(64), privacy: { status: 'passed' }, stepId: 'open' }];
const claims = [
  { id: 'editor-opened', text: '编辑面板已打开。', status: 'verified', assertionRefs: ['editor-visible'], checkpoint: null, evidence: [] },
  { id: 'saved', text: '资料已保存。', status: 'not_run', assertionRefs: ['saved-toast'], checkpoint: null, evidence: [] },
];
const pack = (overrides = {}) => buildTaskFactPack({ task: task(), evidence, images, claims, language: 'zh-CN', ...overrides });

process.stdout.write('\nfact pack\n');

test('动作句由结构化动作确定性生成；说明文字是可润色的文案块', () => {
  const p = pack();
  assert.deepStrictEqual(p.steps.map((s) => s.sentence), ['点击「编辑资料」', '在「昵称」中填写内容', '点击「保存」']);
  assert.deepStrictEqual(Object.keys(p.blocks), ['intro', 'step.open', 'step.nickname', 'step.save']);
  const md = renderTask(p);
  assert.match(md, /<!-- step:open -->\n1\. 点击「编辑资料」\n\n {3}在右上角点击「编辑资料」按钮/);
  assert.match(md, /<!-- claim:editor-opened -->\n已验证界面结果：编辑面板已打开。/);
  assert.match(md, /<!-- claim:saved -->\n预期业务结果：资料已保存。/);
  assert.match(md, /验证范围：只实际执行到第 2 步/);
  assert.strictEqual(validateTaskFinal(md, { title: p.title, stepIds: p.steps.map((s) => s.id), images, uiTexts: [...md.matchAll(/「([^」]+)」/g)].map((m) => m[1]), claims: p.claims, factPack: p }).ok, true);
});

test('没有可见名称的目标回退到已批准的步骤说明，不编造名称', () => {
  const p = pack({ task: task({ steps: [{ id: 'x', instruction: '点击右下角的悬浮按钮', page: 'profile', action: { type: 'click', target: { testId: 'fab' } } }] }), evidence: { steps: [] }, images: [] });
  assert.strictEqual(p.steps[0].sentence, '点击右下角的悬浮按钮');
  assert.strictEqual(p.steps[0].sentenceSource, 'instruction');
});

test('重复 stepId 与证据中多出的步骤直接拒绝；文档遗漏步骤无法通过校验', () => {
  const dup = task();
  dup.steps = [dup.steps[0], { ...dup.steps[1], id: 'open' }];
  assert.throws(() => pack({ task: dup }), (e) => e.code === 'duplicate-step');
  assert.throws(() => pack({ evidence: { steps: [{ id: 'ghost' }] } }), (e) => e.code === 'unknown-step');
  const p = pack();
  const md = renderTask(p).replace(/<!-- step:nickname -->\n2\. [^\n]*\n\n {3}[^\n]*\n/, '');
  const result = validateTaskFinal(md, { title: p.title, stepIds: p.steps.map((s) => s.id), images, uiTexts: [], claims: p.claims, factPack: p });
  assert.ok(result.errors.includes('step.id 或步骤顺序发生变化。'));
});

test('factsHash：图片内容、任务定义、证据、模板语言变化都会改变；相同输入稳定', () => {
  const base = pack();
  assert.strictEqual(pack().factsHash, base.factsHash);
  const variants = [
    pack({ images: [{ ...images[0], sha256: 'b'.repeat(64) }] }),
    pack({ task: task({ title: '编辑资料' }) }),
    pack({ evidence: { ...evidence, canonicalCaptureRefs: ['c2'] } }),
    pack({ language: 'en-US' }),
  ];
  for (const variant of variants) assert.notStrictEqual(variant.factsHash, base.factsHash);
  assert.deepStrictEqual(diffPacks(base, variants[0]), ['artifacts']);
});

test('语言由模板决定：en-US 输出英文结构，未知语言 unsupported-template（不静默输出中文）', () => {
  const md = renderTask(pack({ language: 'en-US' }));
  assert.match(md, /## Steps/);
  assert.match(md, /1\. Click 「编辑资料」/);
  assert.match(md, /Verified in the UI: 编辑面板已打开。/);
  assert.doesNotMatch(md, /操作步骤|完成标志/);
  assert.throws(() => pack({ language: 'ja-JP' }), (e) => e.code === 'unsupported-template');
  assert.throws(() => templateFor('fr-FR'), /unsupported-template/);
});

test('页面：detectedActions 一律标为源码推断，截图不能把它们提升为已验证', () => {
  const page = { id: 'chat', title: '工作台', purpose: '与助手对话。', route: '/chat', detectedActions: ['点击「新对话」创建会话'] };
  const withShot = buildPageFactPack({ page, image: { artifactPath: 'docs/manual/images/annotated/p.png', markdownHref: 'images/annotated/p.png', sha256: 'c'.repeat(64), captureId: 'x' }, language: 'zh-CN' });
  assert.deepStrictEqual(withShot.actions.map((a) => a.status), ['inferred']);
  const md = renderPage(withShot);
  assert.match(md, /## 主要操作（根据源码推断，尚未在浏览器中逐项验证）/);
  assert.match(md, /!\[工作台\]\(images\/annotated\/p\.png\)/);
  assert.doesNotMatch(md, /<!--/, '正式文档不含草稿注释');
});

// ------------------------------------------------------------ CLI：--copy 定稿
function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), json: (() => { try { return JSON.parse(r.stdout); } catch (_) { return null; } })() };
}

function prepared(root) {
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  const config = loadConfig(root).config;
  const artifactPath = 'docs/manual/images/annotated/t--open--after.png';
  fs.mkdirSync(path.join(root, path.dirname(artifactPath)), { recursive: true });
  fs.writeFileSync(path.join(root, artifactPath), 'png');
  const manifest = '.manual/artifacts/manifests/t--evidence.json';
  fs.mkdirSync(path.join(root, path.dirname(manifest)), { recursive: true });
  fs.writeFileSync(path.join(root, manifest), JSON.stringify({ version: 1, taskId: 't', steps: [{ id: 'open', status: 'verified', screenshots: [{ timing: 'after', annotated: artifactPath, redactions: [], privacy: buildPrivacyRecord({ redactions: [], config }) }], validations: [] }] }));
  taskStore.writeTask(path.join(root, '.manual'), {
    id: 't', title: '打开设置', goal: '打开设置面板', entryPage: 'home', preconditions: [], branches: [], relatedTasks: [], risk: 'read', status: 'captured',
    steps: [{ id: 'open', instruction: '点击右上角的「设置」', page: 'home', action: { type: 'click', target: { role: 'button', name: '设置' } } }],
    completion: { description: '设置面板打开' }, evidenceManifest: manifest,
  });
  const draft = cli(root, ['generate-task', 't', '--json']);
  assert.strictEqual(draft.status, 0, draft.out);
  assert.deepStrictEqual(draft.json.copyBlocks, { intro: '打开设置面板', 'step.open': '点击右上角的「设置」' });
  return root;
}

function copyFile(root, copy) {
  const file = path.join(root, 'copy.json');
  fs.writeFileSync(file, JSON.stringify(copy));
  return file;
}

test('--copy 定稿：只写文案块，动作句由程序渲染', (root) => {
  prepared(root);
  const r = cli(root, ['generate-task', 't', '--copy', copyFile(root, { intro: '在这里调整个人偏好。', 'step.open': '「设置」位于页面右上角。' }), '--json']);
  assert.strictEqual(r.status, 0, r.out);
  const doc = fs.readFileSync(path.join(root, 'docs/manual/tasks/t.md'), 'utf8');
  assert.match(doc, /1\. 点击「设置」\n\n {3}「设置」位于页面右上角。/);
  assert.match(doc, /在这里调整个人偏好。/);
});

for (const [name, copy, code] of [
  ['覆盖动作块', { 'steps.open.action': '点击「删除」' }, /copy-blocked|unknown-block/],
  ['否定事实动作', { 'step.open': '不要点击「设置」，直接关闭页面。' }, /negated-action/],
  ['编造界面名称', { 'step.open': '也可以点击「高级设置」。' }, /ui-term-unknown/],
  ['在文案里塞结构', { intro: '![偷换](x.png)' }, /structure-in-copy/],
]) {
  test(`--copy 硬拦截：${name}`, (root) => {
    prepared(root);
    const r = cli(root, ['generate-task', 't', '--copy', copyFile(root, copy), '--json']);
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, code);
    assert.ok(!fs.existsSync(path.join(root, 'docs/manual/tasks/t.md')));
  });
}

test('--copy 需审阅：同数字换单位、业务承诺 → review-required；--accept-review 后放行', (root) => {
  prepared(root);
  const file = copyFile(root, { intro: '设置会在 3 分钟内自动保存，保证不丢失。' });
  let r = cli(root, ['generate-task', 't', '--copy', file, '--json']);
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.code, 'review-required');
  assert.match(r.out, /number-unit.*3 分钟/);
  assert.match(r.out, /business-claim/);
  r = cli(root, ['generate-task', 't', '--copy', file, '--accept-review', '--json']);
  assert.strictEqual(r.status, 0, r.out);
});

test('草稿之后任务定义变化：draft-stale，并指出变化的事实部分', (root) => {
  prepared(root);
  const state = path.join(root, '.manual');
  taskStore.writeTask(state, { ...taskStore.readTask(state, 't'), steps: [{ id: 'open', instruction: '点击「偏好」', page: 'home', action: { type: 'click', target: { role: 'button', name: '偏好' } } }] });
  const r = cli(root, ['generate-task', 't', '--copy', copyFile(root, {}), '--json']);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /draft-stale.*(inputRevision|steps)/);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
