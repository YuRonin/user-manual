'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  toMarkdownHref, resolvePublishedImage, listMarkdownImages, checkDocumentImages,
} = require('../src/publication/paths');

let passed = 0;
let skipped = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-paths-'));
  try {
    const result = fn(root);
    if (result === 'skip') { skipped++; process.stdout.write(`  - ${name}（跳过：当前环境无法创建链接）\n`); return; }
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const PUBLISH = 'docs/manual';
const MANUAL = 'docs/manual/tasks/edit.md';

function writeImage(root, rel) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('png'));
  return file;
}

process.stdout.write('\npublication paths\n');

test('任务文档引用 annotated 图片时输出 ../images/annotated 并能按文档目录解析', (root) => {
  const image = writeImage(root, 'docs/manual/images/annotated/a.png');
  const href = toMarkdownHref({ manualFile: path.join(root, MANUAL), artifactFile: image });
  assert.strictEqual(href, '../images/annotated/a.png');
  const ref = resolvePublishedImage({ projectRoot: root, manualFile: MANUAL, href, publishRoot: PUBLISH });
  assert.strictEqual(ref.ok, true, ref.message);
  assert.strictEqual(ref.artifactPath, 'docs/manual/images/annotated/a.png');
});

test('项目根相对的旧写法在文档目录下解析不到，报 missing 而不是放行', (root) => {
  writeImage(root, 'docs/manual/images/annotated/a.png');
  const ref = resolvePublishedImage({ projectRoot: root, manualFile: MANUAL, href: 'docs/manual/images/annotated/a.png', publishRoot: PUBLISH });
  assert.strictEqual(ref.ok, false);
  assert.strictEqual(ref.code, 'missing');
});

test('越界、绝对路径、远程/data URL、盘符都返回 invalid-artifact-path', (root) => {
  writeImage(root, 'outside.png');
  for (const href of [
    '../../../../outside.png', '../../../outside.png', '/etc/passwd.png', '\\\\server\\share\\a.png',
    'https://example.com/a.png', 'data:image/png;base64,AAAA', 'C:/Windows/a.png', 'c:\\a.png', 'file:///a.png',
    '../images/annotated/a.png?x=1',
  ]) {
    const ref = resolvePublishedImage({ projectRoot: root, manualFile: MANUAL, href, publishRoot: PUBLISH });
    assert.strictEqual(ref.ok, false, href);
    assert.strictEqual(ref.code, 'invalid-artifact-path', `${href}: ${ref.code}`);
  }
});

test('发布目录内的链接指向外部时，按真实路径拒绝', (root) => {
  const outside = path.join(root, 'secret');
  writeImage(root, 'secret/raw.png');
  fs.mkdirSync(path.join(root, 'docs/manual/images'), { recursive: true });
  try {
    fs.symlinkSync(outside, path.join(root, 'docs/manual/images/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return 'skip';
    throw error;
  }
  const ref = resolvePublishedImage({ projectRoot: root, manualFile: MANUAL, href: '../images/linked/raw.png', publishRoot: PUBLISH });
  assert.strictEqual(ref.ok, false);
  assert.strictEqual(ref.code, 'invalid-artifact-path');
});

test('非图片扩展名与目录被拒绝', (root) => {
  writeImage(root, 'docs/manual/images/notes.txt');
  let ref = resolvePublishedImage({ projectRoot: root, manualFile: MANUAL, href: '../images/notes.txt', publishRoot: PUBLISH });
  assert.strictEqual(ref.code, 'invalid-artifact-type');
  fs.mkdirSync(path.join(root, 'docs/manual/images/dir.png'), { recursive: true });
  ref = resolvePublishedImage({ projectRoot: root, manualFile: MANUAL, href: '../images/dir.png', publishRoot: PUBLISH });
  assert.strictEqual(ref.code, 'invalid-artifact-type');
});

test('AST 枚举图片：忽略代码块，包含原始 HTML <img>', () => {
  const markdown = [
    '# 标题', '', '![a](one.png)', '', '```md', '![not](code.png)', '```', '',
    '段落里 ![b](two.png "t") 继续', '', '<p><img src="three.png"></p>', '',
    '行内 <img alt=x src=\'four.png\'> 结束',
  ].join('\n');
  const images = listMarkdownImages(markdown);
  assert.deepStrictEqual(images.map((i) => [i.src, i.kind]), [
    ['one.png', 'markdown'], ['two.png', 'markdown'], ['three.png', 'html'], ['four.png', 'html'],
  ]);
});

test('checkDocumentImages：与 facts 对照，拒绝 HTML 图片与旧版字符串 facts', (root) => {
  writeImage(root, 'docs/manual/images/annotated/a.png');
  const facts = [{ artifactPath: 'docs/manual/images/annotated/a.png', markdownHref: '../images/annotated/a.png' }];
  let result = checkDocumentImages({ projectRoot: root, manualFile: MANUAL, markdown: '![s](../images/annotated/a.png)', publishRoot: PUBLISH, expected: facts });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));

  result = checkDocumentImages({ projectRoot: root, manualFile: MANUAL, markdown: '![s](../images/annotated/a.png)\n\n<img src="../images/annotated/a.png">', publishRoot: PUBLISH, expected: facts });
  assert.strictEqual(result.ok, false);

  result = checkDocumentImages({ projectRoot: root, manualFile: MANUAL, markdown: '![s](../images/annotated/a.png)', publishRoot: PUBLISH, expected: ['docs/manual/images/annotated/a.png'] });
  assert.deepStrictEqual(result.errors.map((e) => e.code), ['legacy-image-facts']);
});

test('历史保留快照（临时副本）：已发布文档的 ../images 引用有效，旧 facts 要求迁移', (root) => {
  const source = path.resolve(__dirname, '..', 'preserved-from-neoagent-worktree-2026-09-18', 'demo', 'website');
  if (!fs.existsSync(source)) return 'skip';
  const copy = path.join(root, 'website');
  fs.cpSync(path.join(source, 'docs'), path.join(copy, 'docs'), { recursive: true });
  fs.cpSync(path.join(source, '.manual', 'drafts', 'tasks'), path.join(copy, '.manual', 'drafts', 'tasks'), { recursive: true });
  const tasksDir = path.join(copy, 'docs', 'manual', 'tasks');
  let checked = 0;
  for (const name of fs.readdirSync(tasksDir).filter((file) => file.endsWith('.md'))) {
    const manualFile = path.join('docs', 'manual', 'tasks', name);
    const markdown = fs.readFileSync(path.join(copy, manualFile), 'utf8');
    const refs = checkDocumentImages({ projectRoot: copy, manualFile, markdown, publishRoot: PUBLISH });
    assert.strictEqual(refs.ok, true, `${name}: ${JSON.stringify(refs.errors)}`);
    const facts = JSON.parse(fs.readFileSync(path.join(copy, '.manual', 'drafts', 'tasks', name.replace(/\.md$/, '.facts.json')), 'utf8'));
    const withFacts = checkDocumentImages({ projectRoot: copy, manualFile, markdown, publishRoot: PUBLISH, expected: facts.images });
    assert.ok(withFacts.errors.some((e) => e.code === 'legacy-image-facts'), name);
    checked++;
  }
  assert.ok(checked > 0);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
if (failures.length) process.exitCode = 1;
