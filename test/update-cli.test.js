'use strict';

/*
 * P3-02：manual update 的 CLI 行为（不启动浏览器）。
 * --plan 只读、无变化零写入、参数错误、无基线、下线建议、阻塞目标、有人工修改的文档提示。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const releases = require('../src/publication/release-store');
const { currentSourceBaseline } = require('../src/update/baseline');
const { newUuid } = require('../src/model/ids');
const { sha256Hex } = require('../src/util/hash');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  if (!fx.hasGit()) { process.stdout.write(`  - ${name}（跳过：没有 git）\n`); return; }
  const root = fx.nextAppFixture();
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fx.cleanup(root); }
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || ''), json: (() => { try { return JSON.parse(r.stdout); } catch (_) { return null; } })() };
}

const stateDir = (root) => path.join(root, '.manual');

/** .manual 与 docs 下所有文件的 路径 → hash + mtime，用于证明"零写入"。 */
function tree(root) {
  const out = {};
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(root, full)] = `${sha256Hex(fs.readFileSync(full))}@${fs.statSync(full).mtimeMs}`;
    }
  };
  walk(path.join(root, '.manual'));
  walk(path.join(root, 'docs'));
  return out;
}

function prepare(root) {
  fx.writeFile(root, 'components/shared/Card.tsx', 'export default function Card(p) { return p.children }\n');
  fx.writeFile(root, 'app/chat/page.tsx', "import Card from '../../components/shared/Card'\nexport default function Page() { return <Card>聊天</Card> }\n");
  fx.writeFile(root, 'app/skills/page.tsx', "import Card from '../../components/shared/Card'\nexport default function Page() { return <Card>技能</Card> }\n");
  fx.writeFile(root, 'app/profile/page.tsx', 'export default function Page() { return null }\n');
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  require('../src/tasks/store').writeTask(stateDir(root), {
    id: 't', title: '聊天', goal: '发送消息', entryPage: 'chat', preconditions: [], risk: 'read', status: 'approved',
    steps: [{ id: 'open', instruction: '打开聊天', page: 'chat', action: { type: 'inspect' } }],
    completion: { description: '看到聊天', verification: 'verified' },
  });
  assert.strictEqual(cli(root, ['inspect', '--json']).status, 0);
  const desc = cli(root, ['describe', '--input', writeJson(root, 'describe.json', { pages: ['chat', 'skills', 'profile'].map((id) => ({ id, title: id, purpose: `${id} 页面。` })) })]);
  assert.strictEqual(desc.status, 0, desc.out);
  fx.gitInit(root);
  publish(root, ['page-chat', 'page-skills', 'page-profile', 'task-t']);
}

function writeJson(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function publish(root, manualIds) {
  const sourceBaseline = currentSourceBaseline(root, stateDir(root));
  for (const manualId of manualIds) {
    const [kind, id] = [manualId.split('-')[0], manualId.slice(manualId.indexOf('-') + 1)];
    const documentPath = kind === 'task' ? `docs/manual/tasks/${id}.md` : `docs/manual/${id}.md`;
    fx.writeFile(root, documentPath, `# ${id}\n`);
    const release = {
      schemaVersion: 1, id: newUuid(), manualId, documentPath,
      documentHash: `sha256:${sha256Hex(`# ${id}\n`)}`, factsHash: `sha256:${'a'.repeat(64)}`,
      captureIds: [], definitionRevisions: {}, createdAt: new Date().toISOString(), sourceBaseline,
    };
    releases.writeRelease(stateDir(root), release);
    releases.setCurrent(stateDir(root), release);
  }
}

process.stdout.write('\nupdate cli\n');

test('参数错误：目标参数 / --base 缺值 / 非法 --base / 未知参数 → 退出码 2', (root) => {
  prepare(root);
  assert.strictEqual(cli(root, ['update', 'page:chat']).status, 2);
  assert.strictEqual(cli(root, ['update', '--base']).status, 2);
  assert.strictEqual(cli(root, ['update', '--base', 'no-such-ref', '--plan']).status, 2);
  assert.strictEqual(cli(root, ['update', '--bogus']).status, 2);
  assert.strictEqual(cli(root, ['update', '--offline', '--refresh']).status, 2);
  const help = cli(root, ['update', '--help']);
  assert.strictEqual(help.status, 0);
  assert.match(help.out, /--plan/);
});

test('无变化：--plan 与执行都零写入、退出 0', (root) => {
  prepare(root);
  const before = tree(root);
  const planned = cli(root, ['update', '--plan', '--json']);
  assert.strictEqual(planned.status, 0, planned.out);
  assert.deepStrictEqual(planned.json.targets, []);
  const r = cli(root, ['update', '--json']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(r.json.status, 'no-change');
  assert.deepStrictEqual(tree(root), before, '没有写入任何文件');
  assert.ok(!fs.existsSync(path.join(stateDir(root), 'runs')), '没有创建 Run');
});

test('--plan 只读：列出受影响目标、原因链、缓存决策与人工修改的文档，不写 .manual / docs', (root) => {
  prepare(root);
  fx.writeFile(root, 'components/shared/Card.tsx', 'export default function Card(p) { return <b>{p.children}</b> }\n');
  fs.appendFileSync(path.join(root, 'docs/manual/chat.md'), '\n手工补充\n');
  const before = tree(root);
  const r = cli(root, ['update', '--plan', '--json']);
  assert.strictEqual(r.status, 0, r.out);
  assert.strictEqual(r.json.dryRun, true);
  assert.deepStrictEqual(r.json.targets.map((t) => t.target), ['page:chat', 'page:skills', 'task:t']);
  const chat = r.json.targets.find((t) => t.target === 'page:chat');
  assert.deepStrictEqual(chat.reasonPaths[0], ['components/shared/Card.tsx', 'chat', 'page-chat', 'page-chat']);
  assert.strictEqual(chat.document.state, 'edited');
  assert.ok(r.json.plan.summary.cache.every((c) => /capture-required/.test(c.reason)), JSON.stringify(r.json.plan.summary.cache));
  assert.ok(r.json.plan.tasks.some((t) => t.kind === 'analyze'), '源码变化后页面分析需要复核');
  assert.strictEqual(r.json.runtimeFreshness.checked, false);
  assert.deepStrictEqual(tree(root), before, '--plan 不写任何文件');

  const text = cli(root, ['update', '--plan']);
  assert.match(text.out, /page:chat.*文档有人工修改/);
  assert.match(text.out, /Card\.tsx → chat → page-chat/);
});

test('删除页面：给出下线建议，不删除文档；经过它的任务被阻塞并说明原因', (root) => {
  prepare(root);
  fs.rmSync(path.join(root, 'app/chat/page.tsx'));
  const r = cli(root, ['update', '--plan', '--json']);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.json.retirement.map((x) => [x.manualId, x.status]), [['page-chat', 'pending-retirement']]);
  assert.deepStrictEqual(r.json.blocked.map((b) => b.target), ['task:t']);
  assert.ok(fs.existsSync(path.join(root, 'docs/manual/chat.md')));
});

test('没有任何发布记录：no-baseline，提示用 generate', (root) => {
  fx.writeFile(root, 'app/chat/page.tsx', 'export default function Page() { return null }\n');
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  assert.strictEqual(cli(root, ['inspect']).status, 0);
  const r = cli(root, ['update', '--json']);
  assert.strictEqual(r.status, 1, r.out);
  assert.match(r.out, /no-baseline/);
  assert.match(r.out, /manual generate/);
});

test('只改 docs 与 README：不触发更新（避免自触发）', (root) => {
  prepare(root);
  fx.writeFile(root, 'docs/manual/skills.md', '# 手改\n');
  fx.writeFile(root, 'README.md', 'x\n');
  const r = cli(root, ['update', '--plan', '--json']);
  assert.strictEqual(r.status, 0, r.out);
  assert.deepStrictEqual(r.json.targets, []);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
