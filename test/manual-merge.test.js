'use strict';

/*
 * P3-06：ManualSection 与人工编辑保护。
 * 单元：块解析、三方合并（人工块外内容、同块冲突、owner=human、删除块、无标记文档）。
 * 集成：任务 --copy 定稿 → 手改 → 再定稿（保留 / 冲突 / --force / 文档被删除 / 旧发布记录无 blob）。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const { parseManual, mergeManual } = require('../src/generate/merge');
const { manualFromPack, pageSectionIndex } = require('../src/generate/manual-model');
const { readGeneratedBlob } = require('../src/generate/manual-store');
const releases = require('../src/publication/release-store');
const taskStore = require('../src/tasks/store');
const { loadConfig } = require('../src/config/load');
const { buildPrivacyRecord } = require('../src/publication/validate');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fx.makeTempDir('manual-merge-');
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fx.cleanup(root); }
}

const doc = (blocks, extra = {}) => Object.entries(blocks)
  .map(([id, body]) => [`<!-- manual:block id=${id}${extra[id] ? ` owner=${extra[id]}` : ''} -->`, body, '<!-- /manual:block -->'].join('\n'))
  .join('\n\n') + '\n';

process.stdout.write('\nmanual merge\n');

// ------------------------------------------------------------ 单元：解析与合并

test('parseManual：块、块外人工内容锚点、代码块里的同形标记不算', () => {
  const md = '前言\n\n' + doc({ a: 'A', b: 'B' }).replace('<!-- /manual:block -->\n\n<!-- manual:block id=b', '<!-- /manual:block -->\n\n我的补充\n\n```\n<!-- manual:block id=fake -->\n```\n\n<!-- manual:block id=b');
  const parsed = parseManual(md);
  assert.deepStrictEqual(parsed.order, ['a', 'b']);
  assert.deepStrictEqual(parsed.human.map((h) => h.anchor), [null, 'a']);
  assert.match(parsed.human[1].text, /我的补充[\s\S]*fake/);
});

test('无人工修改：直接用新生成；生成没变：保留当前原文（字节不变）', () => {
  const base = doc({ a: 'A1', b: 'B1' });
  const next = doc({ a: 'A2', b: 'B1' });
  assert.strictEqual(mergeManual({ base, current: base, next }).markdown, next);
  const edited = base.replace('B1', 'B1 手改').replace(/\n$/, '\n\n补充\n');
  const kept = mergeManual({ base, current: edited, next: base });
  assert.strictEqual(kept.mode, 'kept');
  assert.strictEqual(kept.markdown, edited);
});

test('不重叠修改合并：人改 b 块 + 块外补充，生成器改 a 块', () => {
  const base = doc({ a: 'A1', b: 'B1' });
  const current = doc({ a: 'A1', b: 'B1 手改' }).replace(/\n$/, '\n\n人工结尾\n');
  const next = doc({ a: 'A2', b: 'B1', c: 'C 新增' });
  const merged = mergeManual({ base, current, next });
  assert.ok(merged.ok, JSON.stringify(merged.conflicts));
  const parsed = parseManual(merged.markdown);
  assert.deepStrictEqual(parsed.order, ['a', 'b', 'c']);
  assert.strictEqual(parsed.blocks.get('a').content, 'A2');
  assert.strictEqual(parsed.blocks.get('b').content, 'B1 手改');
  assert.strictEqual(parsed.human[0].anchor, 'b');
  assert.deepStrictEqual(merged.acceptedEdits.map((e) => e.kind).sort(), ['edited-block', 'human-text']);
});

test('同一块两边都改：冲突，提案取新生成并保留人工块外内容', () => {
  const base = doc({ a: 'A1' });
  const current = doc({ a: 'A 手改' }).replace(/\n$/, '\n\n人工说明\n');
  const next = doc({ a: 'A2' });
  const merged = mergeManual({ base, current, next });
  assert.strictEqual(merged.ok, false);
  assert.deepStrictEqual(merged.conflicts.map((c) => [c.blockId, c.kind]), [['a', 'both-modified']]);
  assert.match(merged.proposed, /A2/);
  assert.match(merged.proposed, /人工说明/);
});

test('owner=human 的块由人接管：生成器不覆盖也不报冲突；新生成删掉的块也保留', () => {
  const base = doc({ a: 'A1', b: 'B1' });
  const current = doc({ a: 'A 我的版本', b: 'B1' }, { a: 'human' });
  const next = doc({ a: 'A2', b: 'B2' });
  const merged = mergeManual({ base, current, next });
  assert.ok(merged.ok);
  assert.match(merged.markdown, /<!-- manual:block id=a owner=human -->\nA 我的版本/);
  assert.match(merged.markdown, /B2/);
  const dropped = mergeManual({ base, current, next: doc({ b: 'B2' }) });
  assert.ok(dropped.ok);
  assert.deepStrictEqual(parseManual(dropped.markdown).order, ['a', 'b']);
});

test('人删了生成块 / 新生成删了人改过的块：都是冲突', () => {
  const base = doc({ a: 'A1', b: 'B1' });
  const deleted = mergeManual({ base, current: doc({ b: 'B1' }), next: doc({ a: 'A1', b: 'B2' }) });
  assert.deepStrictEqual(deleted.conflicts.map((c) => c.kind), ['deleted-by-user']);
  const removed = mergeManual({ base, current: doc({ a: 'A 手改', b: 'B1' }), next: doc({ b: 'B1' }) });
  assert.deepStrictEqual(removed.conflicts.map((c) => c.kind), ['removed-but-edited']);
});

test('块外内容两边都改（生成器也写块外文字）：冲突；无基准：整篇冲突', () => {
  const base = doc({ a: 'A' }) + '\n生成的尾注\n';
  const both = mergeManual({ base, current: base.replace('生成的尾注', '人改的尾注'), next: base.replace('生成的尾注', '新尾注') });
  assert.deepStrictEqual(both.conflicts.map((c) => c.kind), ['both-modified-text']);
  const noBase = mergeManual({ base: null, current: doc({ a: 'X' }), next: doc({ a: 'Y' }) });
  assert.deepStrictEqual(noBase.conflicts.map((c) => c.kind), ['base-missing']);
});

test('ManualSection：任务章节引用步骤页面与 Capture；同一页面参与多个任务章节', () => {
  const pack = {
    kind: 'task', manualId: 't', language: 'zh-CN',
    steps: [{ id: 'open', pageId: 'home', artifactRefs: ['img-1'] }, { id: 'save', pageId: 'settings', artifactRefs: [] }],
    artifacts: [{ id: 'img-1', captureId: 'c-1' }],
    claims: [{ id: 'done', evidence: [{ captureId: 'c-1' }] }], branches: [], relatedTasks: [],
  };
  const manual = manualFromPack(pack, { documentPath: 'docs/manual/tasks/t.md' });
  assert.strictEqual(manual.id, 'task-t');
  assert.strictEqual(manual.kind, 'task-guide');
  const step = manual.sections.find((s) => s.id === 'step.open');
  assert.deepStrictEqual([step.pageRefs, step.captureRefs, step.ownership], [['home'], ['c-1'], 'generated']);
  assert.deepStrictEqual(manual.sections.find((s) => s.id === 'completion').claimRefs, ['done']);
});

// ------------------------------------------------------------ 集成：任务定稿

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), json: (() => { try { return JSON.parse(r.stdout); } catch (_) { return null; } })() };
}

const DOC = 'docs/manual/tasks/t.md';

function publishTask(root, copy = {}, extra = []) {
  const file = path.join(root, 'copy.json');
  fs.writeFileSync(file, JSON.stringify(copy));
  return cli(root, ['generate-task', 't', '--copy', file, '--json', ...extra]);
}

function setup(root) {
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  const config = loadConfig(root).config;
  const artifactPath = 'docs/manual/images/annotated/t--open--after.png';
  fs.mkdirSync(path.join(root, path.dirname(artifactPath)), { recursive: true });
  fs.writeFileSync(path.join(root, artifactPath), 'png');
  const manifest = '.manual/artifacts/manifests/t--evidence.json';
  fs.mkdirSync(path.join(root, path.dirname(manifest)), { recursive: true });
  fs.writeFileSync(path.join(root, manifest), JSON.stringify({ version: 1, taskId: 't', steps: [
    { id: 'open', status: 'verified', screenshots: [{ timing: 'after', annotated: artifactPath, redactions: [], privacy: buildPrivacyRecord({ redactions: [], config }) }], validations: [] },
    { id: 'close', status: 'verified', screenshots: [], validations: [] },
  ] }));
  taskStore.writeTask(path.join(root, '.manual'), {
    id: 't', title: '打开设置', goal: '打开设置面板', entryPage: 'home', preconditions: [], branches: [], relatedTasks: [], risk: 'read', status: 'captured',
    steps: [
      { id: 'open', instruction: '点击右上角的「设置」', page: 'home', action: { type: 'click', target: { role: 'button', name: '设置' } } },
      { id: 'close', instruction: '点击「关闭」', page: 'home', action: { type: 'click', target: { role: 'button', name: '关闭' } } },
    ],
    completion: { description: '设置面板打开' }, evidenceManifest: manifest,
  });
  assert.strictEqual(cli(root, ['generate-task', 't', '--json']).status, 0);
  const r = publishTask(root, { intro: '第一版简介。' });
  assert.strictEqual(r.status, 0, r.out);
  return path.join(root, DOC);
}

function current(root) {
  return releases.readCurrentRelease(path.join(root, '.manual'), 'task-t');
}

test('发布记录保存纯生成 blob 与章节；重复定稿无手改时正文不变', (root) => {
  const file = setup(root);
  const release = current(root);
  assert.strictEqual(readGeneratedBlob(path.join(root, '.manual'), release.generatedBlob), fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(release.sections.map((s) => s.id), ['overview', 'before', 'steps', 'step.open', 'step.close', 'completion']);
  const index = pageSectionIndex(path.join(root, '.manual'), ['task-t']);
  assert.deepStrictEqual(index.get('home').map((s) => s.sectionId), ['overview', 'step.open', 'step.close', 'completion']);
  const before = fs.readFileSync(file, 'utf8');
  assert.strictEqual(publishTask(root, { intro: '第一版简介。' }).status, 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
});

test('人工块外说明 + 生成器改简介：两者都保留，新发布记录 acceptedEdits 记录人工内容', (root) => {
  const file = setup(root);
  const first = current(root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- manual:block id=step.close -->', '> 提示：团队版在左侧菜单。\n\n<!-- manual:block id=step.close -->'));
  const r = publishTask(root, { intro: '第二版简介。' });
  assert.strictEqual(r.status, 0, r.out);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /第二版简介。/);
  assert.match(text, /> 提示：团队版在左侧菜单。\n\n<!-- manual:block id=step.close -->/);
  const second = current(root);
  assert.notStrictEqual(second.id, first.id);
  assert.strictEqual(first.documentHash, releases.readRelease(path.join(root, '.manual'), 'task-t', first.id).documentHash, '旧发布记录不被改写');
  assert.deepStrictEqual(second.acceptedEdits, [{ kind: 'human-text', anchor: 'step.open' }]);
  assert.doesNotMatch(readGeneratedBlob(path.join(root, '.manual'), second.generatedBlob), /团队版/, 'blob 只含生成内容');
});

test('同一事实块两边都改：merge-conflict（退出码 4），正式文档不变，写出提案；--force 覆盖', (root) => {
  const file = setup(root);
  const edited = fs.readFileSync(file, 'utf8').replace('第一版简介。', '我改过的简介。');
  fs.writeFileSync(file, edited);
  let r = publishTask(root, { intro: '第二版简介。' });
  assert.strictEqual(r.status, 4, r.out);
  assert.match(r.out, /merge-conflict/);
  assert.match(r.out, /overview/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), edited);
  const proposed = path.join(root, '.manual', 'merge', 'task-t', 'proposed.md');
  assert.match(fs.readFileSync(proposed, 'utf8'), /第二版简介。/);
  assert.match(fs.readFileSync(path.join(root, '.manual', 'merge', 'task-t', 'conflicts.txt'), 'utf8'), /我改过的简介。/);

  // 采用提案后再定稿：不再冲突
  fs.copyFileSync(proposed, file);
  r = publishTask(root, { intro: '第二版简介。' });
  assert.strictEqual(r.status, 0, r.out);

  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('第二版简介。', '又改了。'));
  r = publishTask(root, { intro: '第三版简介。' }, ['--force']);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(fs.readFileSync(file, 'utf8'), /第三版简介。/);
});

test('把块改为 owner=human 保留自己的版本', (root) => {
  const file = setup(root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
    .replace('<!-- manual:block id=overview -->', '<!-- manual:block id=overview owner=human -->')
    .replace('第一版简介。', '我维护的简介。'));
  const r = publishTask(root, { intro: '第二版简介。' });
  assert.strictEqual(r.status, 0, r.out);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /我维护的简介。/);
  assert.doesNotMatch(text, /第二版简介。/);
});

test('已发布文档被删除：document-missing，不静默重建；--force 才重新生成', (root) => {
  const file = setup(root);
  fs.rmSync(file);
  let r = publishTask(root, { intro: '第二版简介。' });
  assert.strictEqual(r.status, 4, r.out);
  assert.match(r.out, /document-missing/);
  assert.ok(!fs.existsSync(file));
  r = publishTask(root, { intro: '第二版简介。' }, ['--force']);
  assert.strictEqual(r.status, 0, r.out);
  assert.ok(fs.existsSync(file));
});

test('旧发布记录没有 blob：文档未改 → 以当前文档为基准；手改过 → 无法三方比较，冲突', (root) => {
  const file = setup(root);
  // 模拟 P3-06 之前的发布记录：没有 generatedBlob
  const stateDir = path.join(root, '.manual');
  const legacy = { ...current(root), id: require('../src/model/ids').newUuid() };
  delete legacy.generatedBlob;
  releases.writeRelease(stateDir, legacy);
  releases.setCurrent(stateDir, legacy);
  assert.strictEqual(publishTask(root, { intro: '第二版简介。' }).status, 0);

  const legacy2 = { ...current(root), id: require('../src/model/ids').newUuid() };
  delete legacy2.generatedBlob;
  releases.writeRelease(stateDir, legacy2);
  releases.setCurrent(stateDir, legacy2);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n手工尾注\n');
  const r = publishTask(root, { intro: '第三版简介。' });
  assert.strictEqual(r.status, 4, r.out);
  assert.match(r.out, /base-missing/);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
