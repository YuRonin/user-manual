'use strict';

/*
 * P1-07：发布 journal / release manifest / 恢复。
 * 在每个状态边界让子进程直接退出（模拟被杀），再用 manual publication repair 恢复。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { publish, listJournals } = require('../src/publication/publisher');
const { readCurrentRelease, listReleases } = require('../src/publication/release-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const PUBLISHER = path.resolve(__dirname, '..', 'src', 'publication', 'publisher.js');
const IMAGE = 'docs/manual/images/annotated/t--open--after--0123456789abcdef.png';

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-publication-'));
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const sha = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const doc = (root) => path.join(root, 'docs', 'manual', 'tasks', 't.md');
const state = (root) => path.join(root, '.manual');

function setup(root) {
  assert.strictEqual(spawnSync(process.execPath, [CLI, 'init', '--base-url', 'http://localhost:3000', '--project-root', root]).status, 0);
  fs.mkdirSync(path.dirname(path.join(root, IMAGE)), { recursive: true });
  fs.writeFileSync(path.join(root, IMAGE), 'png-bytes');
  fs.mkdirSync(path.dirname(doc(root)), { recursive: true });
  fs.writeFileSync(doc(root), 'OLD\n');
}

function input(root, markdown = 'NEW\n') {
  return {
    projectRoot: root,
    stateDirAbs: state(root),
    manualId: 'task-t',
    documentFile: doc(root),
    markdown,
    facts: { factsHash: `sha256:${'f'.repeat(64)}`, images: [{ artifactPath: IMAGE, markdownHref: '../images/annotated/x.png', sha256: sha(Buffer.from('png-bytes')), privacy: { status: 'passed' } }] },
    captureIds: [crypto.randomUUID()],
    definitionRevisions: { t: `sha256:${'d'.repeat(64)}` },
  };
}

/** 子进程里发布，在指定状态边界直接退出（不做任何清理）。 */
function crashAt(root, boundary) {
  const params = input(root);
  const script = `
    const { publish } = require(${JSON.stringify(PUBLISHER)});
    const params = ${JSON.stringify(params)};
    publish({ ...params, hooks: { ${JSON.stringify(`after:${boundary}`)}: () => process.exit(137) } });
  `;
  const r = spawnSync(process.execPath, ['-e', script]);
  assert.strictEqual(r.status, 137, String(r.stderr));
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
  return { status: r.status, json: JSON.parse(r.stdout || '{}'), out: r.stdout + r.stderr };
}

process.stdout.write('\npublication recovery\n');

test('正常发布：文档、不可变发布记录、current 指针；旧发布保留', (root) => {
  setup(root);
  const first = publish(input(root, 'V1\n'));
  const second = publish(input(root, 'V2\n'));
  assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'V2\n');
  assert.strictEqual(readCurrentRelease(state(root), 'task-t').id, second.release.id);
  assert.strictEqual(second.release.previousReleaseId, first.release.id);
  assert.deepStrictEqual(listReleases(state(root), 'task-t').sort(), [first.release.id, second.release.id].sort());
  assert.ok(listJournals(state(root)).every((j) => j.state === 'completed'));
  assert.strictEqual(second.release.facts.factsHash, `sha256:${'f'.repeat(64)}`, '发布记录自带 facts，verify 不依赖草稿');
});

for (const boundary of ['prepared', 'assets-installed', 'document-installed', 'release-committed']) {
  test(`在 ${boundary} 之后被杀：读者看到完整的旧版或新版；repair 完成且重复恢复不产生第二条记录`, (root) => {
    setup(root);
    crashAt(root, boundary);
    const content = fs.readFileSync(doc(root), 'utf8');
    assert.ok(['OLD\n', 'NEW\n'].includes(content), `中间状态不能出现半个文档: ${JSON.stringify(content)}`);
    const before = cli(root, ['publication', 'status']);
    assert.strictEqual(before.json.transactions.length, 1);
    assert.strictEqual(before.json.transactions[0].next, 'resume');
    const dry = cli(root, ['publication', 'repair', '--dry-run']);
    assert.strictEqual(dry.json.results[0].dryRun, true);
    assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), content, 'dry-run 不写文件');

    const repaired = cli(root, ['publication', 'repair']);
    assert.strictEqual(repaired.status, 0, repaired.out);
    assert.strictEqual(repaired.json.results[0].result, 'completed');
    assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'NEW\n');
    const release = readCurrentRelease(state(root), 'task-t');
    assert.strictEqual(release.documentHash, `sha256:${sha(Buffer.from('NEW\n'))}`);
    assert.strictEqual(listReleases(state(root), 'task-t').length, 1);
    const again = cli(root, ['publication', 'repair']);
    assert.deepStrictEqual(again.json.results, []);
    assert.strictEqual(listReleases(state(root), 'task-t').length, 1, '重复恢复不产生第二条发布记录');
  });
}

for (const boundary of ['prepared', 'document-installed']) {
  test(`在 ${boundary} 之后用户手改了文档：repair 标为 conflict，保留用户修改，不回滚也不覆盖`, (root) => {
    setup(root);
    crashAt(root, boundary);
    fs.writeFileSync(doc(root), 'USER EDIT\n');
    const status = cli(root, ['publication', 'status']);
    assert.strictEqual(status.json.transactions[0].document, 'modified');
    assert.strictEqual(status.json.transactions[0].next, 'conflict');
    const repaired = cli(root, ['publication', 'repair']);
    assert.strictEqual(repaired.json.results[0].result, 'conflict');
    assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'USER EDIT\n');
    assert.strictEqual(readCurrentRelease(state(root), 'task-t'), null, '冲突时不写发布指针');
    assert.strictEqual(cli(root, ['publication', 'status']).json.transactions[0].next, 'manual-resolution');
  });
}

test('发布之后手工修改正式文档：再次发布返回 publication-conflict；--force 覆盖且旧发布仍保留', (root) => {
  setup(root);
  const first = publish(input(root, 'V1\n'));
  fs.writeFileSync(doc(root), 'V1 + 手改\n');
  assert.throws(() => publish(input(root, 'V2\n')), (e) => e.code === 'publication-conflict');
  assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'V1 + 手改\n');
  const forced = publish({ ...input(root, 'V2\n'), force: true });
  assert.strictEqual(forced.release.previousReleaseId, first.release.id);
  assert.ok(fs.existsSync(path.join(state(root), 'releases', 'task-t', `${first.release.id}.json`)));
});

test('发布图缺失或被替换：事务作废，文档不变，也不阻塞下一次发布', (root) => {
  setup(root);
  fs.writeFileSync(path.join(root, IMAGE), 'swapped');
  assert.throws(() => publish(input(root)), (e) => e.code === 'publication-assets-invalid');
  assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'OLD\n');
  assert.deepStrictEqual(cli(root, ['publication', 'status']).json.transactions, []);
  fs.writeFileSync(path.join(root, IMAGE), 'png-bytes');
  publish(input(root));
  assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'NEW\n');
});

test('发布记录不完整（旧 facts 没有图片 hash）：写入任何文件之前拒绝', (root) => {
  setup(root);
  const params = input(root);
  params.facts.images[0].sha256 = null;
  assert.throws(() => publish(params), (e) => e.code === 'invalid-release');
  assert.strictEqual(fs.readFileSync(doc(root), 'utf8'), 'OLD\n');
  assert.ok(!fs.existsSync(path.join(state(root), 'publication')));
});

test('未完成事务存在时同一文档的新发布被拒绝，提示先 repair', (root) => {
  setup(root);
  crashAt(root, 'assets-installed');
  assert.throws(() => publish(input(root, 'OTHER\n')), (e) => e.code === 'publication-in-progress');
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
