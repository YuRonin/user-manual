'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { createCaptureStore, sanitizeUrl, imageSize } = require('../src/evidence/store');
const { verifyCaptureRecord, cacheCandidacy, scopePassed } = require('../src/evidence/integrity');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-capture-store-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function png(color) {
  return sharp({ create: { width: 4, height: 3, channels: 3, background: color } }).png().toBuffer();
}

function baseRecord() {
  return {
    kind: 'page',
    subject: { pageId: 'chat' },
    observedAt: new Date().toISOString(),
    inputHash: `sha256:${'1'.repeat(64)}`,
    modelRevision: `sha256:${'2'.repeat(64)}`,
    finalUrl: { origin: 'http://localhost:5173', pathname: '/chat' },
    spec: { viewport: { width: 1440, height: 900 }, dpr: 1, fullPage: false },
    validations: [{ scope: 'page-identity', check: 'http-status', outcome: 'passed' }],
    privacy: { status: 'passed' },
  };
}

async function stageAndCommit(store, root, color, { published = true } = {}) {
  const handle = store.begin();
  fs.writeFileSync(handle.file('raw.png'), await png(color));
  fs.writeFileSync(handle.file('published.png'), await png(color));
  const artifacts = [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw/pages', prefix: 'chat' }];
  if (published) artifacts.push({ kind: 'published', file: handle.file('published.png'), dir: 'docs/manual/images/annotated', prefix: 'page--chat' });
  return { handle, record: store.commit(handle, { record: baseRecord(), artifacts }) };
}

function snapshot(root, relPaths) {
  return Object.fromEntries(relPaths.map((p) => [p, fs.readFileSync(path.join(root, p)).toString('hex')]));
}

(async () => {
  console.log('capture store');

  await test('连续两次采集得到不同 captureId；旧记录和旧图片字节不变', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const first = (await stageAndCommit(store, root, '#ff0000')).record;
    const firstRecordText = fs.readFileSync(path.join(root, '.manual/evidence/captures', `${first.id}.json`), 'utf8');
    const firstFiles = snapshot(root, first.artifacts.map((a) => a.path));
    const second = (await stageAndCommit(store, root, '#0000ff')).record;
    assert.notStrictEqual(second.id, first.id);
    assert.notStrictEqual(second.artifacts[0].path, first.artifacts[0].path, '新内容写到新文件，不覆盖同名 PNG');
    assert.strictEqual(fs.readFileSync(path.join(root, '.manual/evidence/captures', `${first.id}.json`), 'utf8'), firstRecordText);
    assert.deepStrictEqual(snapshot(root, first.artifacts.map((a) => a.path)), firstFiles);
    assert.deepStrictEqual(store.list().sort(), [first.id, second.id].sort());
    assert.match(first.artifacts[0].path, /^\.manual\/artifacts\/raw\/pages\/chat--[0-9a-f]{16}\.png$/);
    assert.match(first.artifacts[1].path, /^docs\/manual\/images\/annotated\/page--chat--[0-9a-f]{16}\.png$/);
    assert.deepStrictEqual([first.artifacts[0].width, first.artifacts[0].height], [4, 3]);
    assert.strictEqual(first.schemaVersion, 1);
  });

  await test('相同内容复用已安装文件（校验字节），同名不同内容报 immutable-conflict', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const first = (await stageAndCommit(store, root, '#00ff00')).record;
    const again = (await stageAndCommit(store, root, '#00ff00')).record;
    assert.notStrictEqual(again.id, first.id, '复用文件不等于复用观察：新观察有新 ID');
    assert.strictEqual(again.artifacts[0].path, first.artifacts[0].path);
    assert.strictEqual(again.artifacts[0].reused, true);

    fs.writeFileSync(path.join(root, first.artifacts[0].path), await png('#123456'));
    const handle = store.begin();
    fs.writeFileSync(handle.file('raw.png'), await png('#00ff00'));
    assert.throws(() => store.commit(handle, { record: baseRecord(), artifacts: [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw/pages', prefix: 'chat' }] }), (e) => e.code === 'immutable-conflict');
    assert.strictEqual(fs.existsSync(path.join(root, '.manual/evidence/captures', `${handle.captureId}.json`)), false);
  });

  await test('写到一半的 staging 不可见：缺文件/空文件/坏 PNG 均不产生记录', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const cases = [
      [(h) => {}, 'capture-incomplete'],
      [(h) => fs.writeFileSync(h.file('raw.png'), Buffer.alloc(0)), 'capture-incomplete'],
      [(h) => fs.writeFileSync(h.file('raw.png'), Buffer.from('not a png')), 'capture-incomplete'],
    ];
    for (const [prepare, code] of cases) {
      const handle = store.begin();
      prepare(handle);
      assert.throws(() => store.commit(handle, { record: baseRecord(), artifacts: [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw/pages', prefix: 'chat' }] }), (e) => e.code === code);
      assert.strictEqual(store.read(handle.captureId), null);
    }
    assert.deepStrictEqual(store.list(), []);
    assert.throws(() => store.setLatest({ 'page:chat': store.begin().captureId }), (e) => e.code === 'capture-not-committed');
  });

  await test('记录不完整（缺 privacy / 带查询参数）时拒绝提交；staging 外的文件不能被提交', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const handle = store.begin();
    fs.writeFileSync(handle.file('raw.png'), await png('#ff00ff'));
    const artifacts = [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw/pages', prefix: 'chat' }];
    const { privacy, ...noPrivacy } = baseRecord();
    assert.throws(() => store.commit(handle, { record: noPrivacy, artifacts }), (e) => e.code === 'invalid-capture-record');
    assert.throws(() => store.commit(handle, { record: { ...baseRecord(), finalUrl: { origin: 'x', pathname: '/', search: '?t=1' } }, artifacts }), (e) => e.code === 'invalid-capture-record');
    const outside = path.join(root, 'outside.png');
    fs.writeFileSync(outside, await png('#ff00ff'));
    assert.throws(() => store.commit(handle, { record: baseRecord(), artifacts: [{ kind: 'raw', file: outside, dir: 'x', prefix: 'y' }] }), (e) => e.code === 'invalid-artifact-path');
    assert.throws(() => store.commit(handle, { record: baseRecord(), artifacts: [{ kind: 'raw', file: handle.file('raw.png'), dir: '../escape', prefix: 'y' }] }), (e) => e.code === 'invalid-artifact-path');
  });

  await test('latest 只能在记录提交后更新，且可随新观察移动', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const a = (await stageAndCommit(store, root, '#111111')).record;
    store.setLatest({ 'page:chat': a.id });
    const b = (await stageAndCommit(store, root, '#222222')).record;
    store.setLatest({ 'page:chat': b.id });
    assert.deepStrictEqual(store.readLatest(), { 'page:chat': b.id });
    assert.ok(store.read(a.id), '旧记录仍在');
  });

  await test('完整性：图片被替换（路径不变）→ hash-mismatch；删除 → artifact-missing；报告不含内容', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const record = (await stageAndCommit(store, root, '#abcdef')).record;
    assert.deepStrictEqual(verifyCaptureRecord(root, record), { ok: true, problems: [] });
    const published = record.artifacts.find((a) => a.kind === 'published');
    const replacement = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#fedcba' } }).png().toBuffer();
    fs.writeFileSync(path.join(root, published.path), replacement);
    const replaced = verifyCaptureRecord(root, record);
    assert.deepStrictEqual(replaced.problems, [{ kind: 'published', path: published.path, code: 'hash-mismatch' }]);
    fs.rmSync(path.join(root, published.path));
    assert.strictEqual(verifyCaptureRecord(root, record).problems[0].code, 'artifact-missing');
    assert.strictEqual(verifyCaptureRecord(root, record, { kinds: ['raw'] }).ok, true);
  });

  await test('cache candidate 需要关键字段；scope 通过不互相推导', async (root) => {
    const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') });
    const record = (await stageAndCommit(store, root, '#010203')).record;
    assert.strictEqual(cacheCandidacy(record).ok, true);
    const { inputHash, ...partial } = record;
    assert.deepStrictEqual(cacheCandidacy(partial).missing, ['inputHash']);
    assert.strictEqual(scopePassed(record, 'page-identity'), true);
    assert.strictEqual(scopePassed(record, 'scenario-state'), false);
  });

  await test('URL 去敏：只保留 origin 与 pathname；PNG 尺寸读取', async () => {
    assert.deepStrictEqual(sanitizeUrl('http://localhost:5173/chat?token=abc#x'), { origin: 'http://localhost:5173', pathname: '/chat' });
    assert.strictEqual(sanitizeUrl('not a url'), null);
    assert.deepStrictEqual(imageSize(await png('#000000')), { width: 4, height: 3 });
    assert.strictEqual(imageSize(Buffer.from('jpeg?')), null);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exitCode = 1;
})();
