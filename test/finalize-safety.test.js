'use strict';

/*
 * 非法 finalize 与写入失败都不能改变已发布文档：所有可提前发现的失败必须发生在正式文件替换之前。
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildPrivacyRecord } = require('../src/publication/validate');
const taskStore = require('../src/tasks/store');
const { loadConfig } = require('../src/config/load');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
let skipped = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-finalize-'));
  try {
    if (fn(root) === 'skip') { skipped++; process.stdout.write(`  - ${name}（跳过）\n`); return; }
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    // 恢复只读属性，保证临时目录可删除
    try { for (const file of walk(root)) fs.chmodSync(file, 0o644); } catch (_) { /* best effort */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const MANUAL = (root) => path.join(root, 'docs', 'manual', 'tasks', 't.md');

/** captured 任务 + 合法草稿，正式文档预先存在一份旧版本。 */
function prepared(root) {
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  const config = loadConfig(root).config;
  const artifactPath = 'docs/manual/images/annotated/t--open--after.png';
  fs.mkdirSync(path.join(root, path.dirname(artifactPath)), { recursive: true });
  fs.writeFileSync(path.join(root, artifactPath), 'png');
  const shot = { timing: 'after', annotated: artifactPath, redactions: [], privacy: buildPrivacyRecord({ redactions: [], config }) };
  const manifest = '.manual/artifacts/manifests/t--evidence.json';
  fs.mkdirSync(path.join(root, path.dirname(manifest)), { recursive: true });
  fs.writeFileSync(path.join(root, manifest), JSON.stringify({ version: 1, taskId: 't', steps: [{ id: 'open', status: 'verified', screenshots: [shot], validations: [] }] }));
  const state = path.join(root, '.manual');
  taskStore.writeTask(state, {
    id: 't', title: '打开设置', goal: '打开设置面板', entryPage: 'home', preconditions: [], branches: [], relatedTasks: [],
    risk: 'read', status: 'captured',
    steps: [{ id: 'open', instruction: '点击「设置」', page: 'home', action: { type: 'click', target: { role: 'button', name: '设置' } } }],
    completion: { description: '设置面板打开' },
    evidenceManifest: manifest,
  });
  const result = cli(root, ['generate-task', 't']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  fs.mkdirSync(path.dirname(MANUAL(root)), { recursive: true });
  fs.writeFileSync(MANUAL(root), 'OLD PUBLISHED DOC\n');
  return { state, draft: JSON.parse(result.stdout).draftFile };
}

process.stdout.write('\nfinalize safety\n');

for (const status of ['candidate', 'approved', 'stale', 'verified', 'generated']) {
  test(`任务状态为 ${status} 时 finalize 失败，正式文档字节不变`, (root) => {
    const { state, draft } = prepared(root);
    taskStore.writeTask(state, { ...taskStore.readTask(state, 't'), status });
    const before = sha(MANUAL(root));
    const result = cli(root, ['generate-task', 't', '--finalize', draft]);
    assert.strictEqual(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /不能从|captured/);
    assert.strictEqual(sha(MANUAL(root)), before, '非法状态下不能改写正式文档');
    assert.strictEqual(taskStore.readTask(state, 't').status, status);
  });
}

test('合法 finalize：正式文档被替换、任务推进到 generated、不留临时文件', (root) => {
  const { state, draft } = prepared(root);
  const result = cli(root, ['generate-task', 't', '--finalize', draft]);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.notStrictEqual(fs.readFileSync(MANUAL(root), 'utf8'), 'OLD PUBLISHED DOC\n');
  assert.strictEqual(taskStore.readTask(state, 't').status, 'generated');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(MANUAL(root))).filter((n) => n.endsWith('.tmp')), []);
});

test('正式文档被占用（只读）时返回 file-busy，旧字节不变、任务状态不变', (root) => {
  if (process.platform !== 'win32') return 'skip'; // POSIX 上只读文件仍可被 rename 覆盖
  const { state, draft } = prepared(root);
  fs.chmodSync(MANUAL(root), 0o444);
  const before = sha(MANUAL(root));
  const result = cli(root, ['generate-task', 't', '--finalize', draft]);
  assert.strictEqual(result.status, 1, result.stdout);
  assert.match(result.stdout, /file-busy/);
  assert.strictEqual(sha(MANUAL(root)), before);
  assert.strictEqual(taskStore.readTask(state, 't').status, 'captured');
});

test('文档已写入但任务状态写入失败：明确报告 partial-commit', (root) => {
  if (process.platform !== 'win32') return 'skip';
  const { state, draft } = prepared(root);
  fs.chmodSync(taskStore.taskFileFor(state, 't'), 0o444);
  const result = cli(root, ['generate-task', 't', '--finalize', draft]);
  assert.strictEqual(result.status, 1, result.stdout);
  const out = JSON.parse(result.stdout);
  assert.strictEqual(out.code, 'partial-commit');
  assert.ok(out.committed.includes(path.relative(root, MANUAL(root)).replace(/\\/g, '/')));
});

test('verify 非 generated 状态：失败且不改任务文件', (root) => {
  const { state } = prepared(root);
  const file = taskStore.taskFileFor(state, 't');
  const before = sha(file);
  const result = cli(root, ['verify', 't']);
  assert.strictEqual(result.status, 1);
  assert.strictEqual(sha(file), before);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
if (failures.length) process.exitCode = 1;
