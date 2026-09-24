'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pageStore = require('../src/inspect/store');
const taskStore = require('../src/tasks/store');
const { createProjectStore } = require('../src/store/project');
const snap = require('../src/store/snapshot');
const { readIndexes } = require('../src/inspect/index-store');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-project-store-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function page(id, route) {
  return {
    id, route, dynamic: false, params: [], title: null, purpose: null, detectedActions: [], entry: `app${route}/page.tsx`,
    source: [`app${route}/page.tsx`], dependencies: { files: [], unresolved: [] }, includeInManual: true, confidence: 'none',
    browser: { verified: false }, states: { default: { assertions: [{ type: 'url', value: route }] } }, status: { router: 'app', sourceAnalysis: 'pending' },
  };
}

function seed(root) {
  const state = path.join(root, '.manual');
  pageStore.writeModel(state, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: '2026-09-24T00:00:00.000Z' }, [page('chat', '/chat'), page('profile', '/profile')]);
  taskStore.writeTask(state, {
    id: 'edit-profile', title: '修改资料', goal: '修改', entryPage: 'profile', preconditions: [], risk: 'read', status: 'candidate',
    steps: [{ id: 'open', instruction: '打开', page: 'profile', action: { type: 'inspect' } }], completion: { description: '完成' },
  });
  return state;
}

const storeFor = (state) => createProjectStore({ stateDirAbs: state, docsOutputDir: 'docs/manual' });
const pageOf = (model, id) => model.pages.find((p) => p.id === id);
const yamlPage = (state, id) => pageStore.readPage(state, id);

(async () => {
  process.stdout.write('\nproject store\n');

  await test('首次读取导入工作副本为不可变快照；无变化时不再导入', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const first = store.load();
    assert.strictEqual(first.imported, true);
    assert.ok(fs.existsSync(snap.snapshotFileFor(state, first.revision)));
    assert.deepStrictEqual(snap.readPointer(state).revision, first.revision);
    const second = store.load();
    assert.strictEqual(second.imported, false);
    assert.strictEqual(second.revision, first.revision);
    assert.strictEqual(store.indexStatus().ok, true);
  });

  await test('手改工作副本 → 校验后导入新快照（parent 指向旧快照），旧快照保留', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const first = store.load();
    const file = pageStore.pageFileFor(state, 'chat');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('title: null', 'title: 工作台'));
    const next = store.load();
    assert.strictEqual(next.imported, true);
    assert.notStrictEqual(next.revision, first.revision);
    assert.strictEqual(snap.readPointer(state).parent, first.revision);
    assert.strictEqual(pageOf(next.model, 'chat').title, '工作台');
    assert.ok(fs.existsSync(snap.snapshotFileFor(state, first.revision)));
    assert.notStrictEqual(next.modelRevision, first.modelRevision);
  });

  await test('定义提交基于旧 revision → model-conflict，先提交的修改不被覆盖', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const base = store.load();
    store.commit({ base, kind: 'definition', changes: { pages: [{ ...pageOf(base.model, 'chat'), title: '工作台' }] } });
    assert.throws(
      () => store.commit({ base, kind: 'definition', changes: { pages: [{ ...pageOf(base.model, 'chat'), purpose: '旧输入' }] } }),
      (e) => e.code === 'model-conflict',
    );
    assert.strictEqual(yamlPage(state, 'chat').title, '工作台');
    assert.strictEqual(yamlPage(state, 'chat').purpose, null);
  });

  await test('两个独立进程：后提交的旧输入得到 model-conflict，而不是覆盖', async (root) => {
    const state = seed(root);
    storeFor(state).load();
    const gate = path.join(root, 'go');
    const script = `
      const fs = require('fs');
      const { createProjectStore } = require(${JSON.stringify(path.resolve(__dirname, '../src/store/project'))});
      const store = createProjectStore({ stateDirAbs: ${JSON.stringify(state)}, docsOutputDir: 'docs/manual' });
      const base = store.load();
      process.stdout.write('loaded\\n');
      const wait = () => { if (!fs.existsSync(${JSON.stringify(gate)})) return setTimeout(wait, 20);
        try {
          const chat = base.model.pages.find((p) => p.id === 'chat');
          store.commit({ base, kind: 'definition', changes: { pages: [{ ...chat, purpose: '子进程的旧输入' }] } });
          process.stdout.write('committed\\n');
        } catch (e) { process.stdout.write(e.code + '\\n'); }
      };
      wait();
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    await new Promise((resolve) => { const check = () => (out.includes('loaded') ? resolve() : setTimeout(check, 20)); check(); });
    const store = storeFor(state);
    const base = store.load();
    store.commit({ base, kind: 'definition', changes: { pages: [{ ...pageOf(base.model, 'chat'), title: '父进程' }] } });
    fs.writeFileSync(gate, '');
    await new Promise((resolve) => child.on('exit', resolve));
    assert.match(out, /model-conflict/);
    assert.strictEqual(yamlPage(state, 'chat').title, '父进程');
    assert.strictEqual(yamlPage(state, 'chat').purpose, null);
  });

  await test('观察提交（capture）基于旧 base 也不会覆盖 describe 的定义修改；也不改变定义 revision', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const captureBase = store.load();
    const describeBase = store.load();
    const described = store.commit({ base: describeBase, kind: 'definition', changes: { pages: [{ ...pageOf(describeBase.model, 'chat'), title: '工作台' }] } });
    const chat = pageOf(captureBase.model, 'chat');
    const observed = store.commit({ base: captureBase, kind: 'observation', changes: { pages: [{ ...chat, browser: { ...chat.browser, verified: true, latestCaptureId: 'x' } }] } });
    assert.strictEqual(observed.modelRevision, described.modelRevision);
    const current = yamlPage(state, 'chat');
    assert.strictEqual(current.title, '工作台', 'describe 的修改保留');
    assert.strictEqual(current.browser.latestCaptureId, 'x', 'capture 的观察写入');
    // 观察之后，基于 describe 之后状态的定义提交仍然可以成功
    const again = store.load();
    store.commit({ base: again, kind: 'definition', changes: { pages: [{ ...pageOf(again.model, 'chat'), purpose: '对话' }] } });
    assert.strictEqual(yamlPage(state, 'chat').browser.latestCaptureId, 'x');
  });

  await test('观察提交不能修改定义', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const base = store.load();
    assert.throws(
      () => store.commit({ base, kind: 'observation', changes: { pages: [{ ...pageOf(base.model, 'chat'), title: '偷改' }] } }),
      (e) => e.code === 'observation-changed-definition',
    );
    assert.strictEqual(yamlPage(state, 'chat').title, null);
  });

  await test('只改一个页面时不重写其它页面文件', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const base = store.load();
    const other = pageStore.pageFileFor(state, 'profile');
    const mtime = fs.statSync(other).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    store.commit({ base, kind: 'observation', changes: { pages: [{ ...pageOf(base.model, 'chat'), browser: { verified: true } }] } });
    assert.strictEqual(fs.statSync(other).mtimeMs, mtime);
  });

  await test('故障注入：快照写入后失败 → 读旧；指针切换后 / 物化中途失败 → 读新并修复工作副本', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const base = store.load();
    const change = { pages: [{ ...pageOf(base.model, 'chat'), title: '新' }, { ...pageOf(base.model, 'profile'), title: '新2' }] };

    assert.throws(() => store.commit({ base, changes: change, hooks: { afterSnapshot: () => { throw new Error('boom'); } } }), /boom/);
    assert.strictEqual(snap.readPointer(state).revision, base.revision);
    assert.strictEqual(store.load().revision, base.revision);
    assert.strictEqual(yamlPage(state, 'chat').title, null);

    assert.throws(() => store.commit({ base, changes: change, hooks: { afterPointer: () => { throw new Error('boom'); } } }), /boom/);
    assert.strictEqual(snap.readPointer(state).materialized, false);
    assert.strictEqual(yamlPage(state, 'chat').title, null, '工作副本尚未物化');
    const repaired = store.load();
    assert.strictEqual(pageOf(repaired.model, 'chat').title, '新');
    assert.strictEqual(yamlPage(state, 'profile').title, '新2');
    assert.strictEqual(snap.readPointer(state).materialized, true);
  });

  await test('物化写到一半失败：下一次读取按快照补齐剩余文件', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const base = store.load();
    const change = { pages: [{ ...pageOf(base.model, 'chat'), title: 'A' }, { ...pageOf(base.model, 'profile'), title: 'B' }] };
    assert.throws(() => store.commit({ base, changes: change, hooks: { afterEntity: (n) => { if (n === 1) throw new Error('crash'); } } }), /crash/);
    const titles = [yamlPage(state, 'chat').title, yamlPage(state, 'profile').title];
    assert.ok(titles.includes(null), '中途失败：至少一个文件尚未写入');
    const loaded = store.load();
    assert.deepStrictEqual([pageOf(loaded.model, 'chat').title, pageOf(loaded.model, 'profile').title], ['A', 'B']);
    assert.strictEqual(loaded.imported, false, '修复不是导入：没有产生新快照');
  });

  await test('索引信封：revision / 文件 hash 不符即视为过期（可解析也不行），可重建', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    store.load();
    assert.strictEqual(readIndexes(state).ok, true);
    const forward = pageStore.forwardIndexFileFor(state);
    fs.writeFileSync(forward, JSON.stringify({ '/chat': { id: 'chat', route: '/somewhere-else' } }));
    const stale = readIndexes(state);
    assert.strictEqual(stale.ok, false);
    assert.match(stale.warning, /index-modified:forward/);
    assert.deepStrictEqual(store.ensureIndexes(), { rebuilt: true, reason: 'index-modified:forward' });
    assert.strictEqual(readIndexes(state).ok, true);
    fs.rmSync(forward);
    assert.strictEqual(readIndexes(state).ok, false);
  });

  await test('Runtime 读取固定在已提交快照，不受未导入的手改影响', async (root) => {
    const state = seed(root);
    const store = storeFor(state);
    const base = store.load();
    const file = pageStore.pageFileFor(state, 'chat');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('title: null', 'title: 手改'));
    const committed = store.readCommitted();
    assert.strictEqual(committed.revision, base.revision);
    assert.strictEqual(pageOf(committed.model, 'chat').title, null);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
