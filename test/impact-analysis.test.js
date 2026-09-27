'use strict';

/*
 * P3-01：旧新依赖图影响分析。
 * 真实 inspect 建立源码图，写入带 sourceBaseline 的发布记录，然后改源码，
 * 检查 file → Page → Scenario → Manual Section 的影响与 reasonPath。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const releases = require('../src/publication/release-store');
const { currentSourceBaseline } = require('../src/update/baseline');
const { analyzeProject, analyzeImpact } = require('../src/update/impact');
const { loadConfig } = require('../src/config/load');
const { newUuid } = require('../src/model/ids');
const { hashFile } = require('../src/inspect/fingerprint');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const HEX = 'a'.repeat(64);

let passed = 0;
const failures = [];
function test(name, fn, { git = true } = {}) {
  if (git && !fx.hasGit()) { process.stdout.write(`  - ${name}（跳过：没有 git）\n`); return; }
  const root = fx.nextAppFixture();
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fx.cleanup(root); }
}

function run(root, cmd, args = []) {
  const r = spawnSync(process.execPath, [CLI, cmd, '--project-root', root, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${cmd}: ${r.stderr}${r.stdout}`);
  return r;
}

const stateDir = (root) => path.join(root, '.manual');

/** chat / skills 共用 Card，profile 独占 Only，admin 有动态 import（依赖覆盖不完整），任务 t 经过 chat。 */
function prepare(root, { git = true } = {}) {
  fx.writeFile(root, 'components/shared/Card.tsx', 'export default function Card(p) { return p.children }\n');
  fx.writeFile(root, 'components/profile/Only.tsx', 'export default function Only() { return null }\n');
  fx.writeFile(root, 'app/chat/page.tsx', "import Card from '../../components/shared/Card'\nexport default function Page() { return <Card>聊天</Card> }\n");
  fx.writeFile(root, 'app/skills/page.tsx', "import Card from '../../components/shared/Card'\nexport default function Page() { return <Card>技能</Card> }\n");
  fx.writeFile(root, 'app/profile/page.tsx', "import Only from '../../components/profile/Only'\nexport default function Page() { return <Only /> }\n");
  fx.writeFile(root, 'app/admin/page.tsx', 'export default async function Page({ name }) { const m = await import(name); return m.default }\n');
  fx.writeFile(root, 'app/layout.tsx', 'export default function Root({ children }) { return children }\n');
  run(root, 'init', ['--base-url', 'http://localhost:3000']);
  require('../src/tasks/store').writeTask(stateDir(root), {
    id: 't', title: '聊天', goal: '发送消息', entryPage: 'chat', preconditions: [], risk: 'read', status: 'approved',
    steps: [{ id: 'open', instruction: '打开聊天', page: 'chat', action: { type: 'inspect' } }],
    completion: { description: '看到聊天', verification: 'verified' },
  });
  run(root, 'inspect', ['--json']);
  if (git) fx.gitInit(root);
}

/** 为指定手册写入当前发布（带当前源码基线）。 */
function publish(root, manualIds, { baseline = true } = {}) {
  const sourceBaseline = baseline ? currentSourceBaseline(root, stateDir(root)) : undefined;
  for (const manualId of manualIds) {
    const kind = manualId.startsWith('task-') ? 'task' : 'page';
    const id = manualId.slice(kind.length + 1);
    const release = {
      schemaVersion: 1, id: newUuid(), manualId,
      documentPath: kind === 'task' ? `docs/manual/tasks/${id}.md` : `docs/manual/${id}.md`,
      documentHash: HEX, factsHash: HEX, captureIds: [], definitionRevisions: {}, createdAt: new Date().toISOString(),
      ...(sourceBaseline ? { sourceBaseline } : {}),
    };
    releases.writeRelease(stateDir(root), release);
    releases.setCurrent(stateDir(root), release);
  }
}

const ALL = ['page-chat', 'page-skills', 'page-profile', 'page-admin', 'task-t'];

function analyze(root, opts = {}) {
  const { config } = loadConfig(root);
  return analyzeProject({ projectRoot: root, config, ...opts });
}

function ids(report) {
  return report.sections.map((s) => s.manualId);
}

function section(report, manualId) {
  return report.sections.find((s) => s.manualId === manualId);
}

process.stdout.write('\nimpact analysis\n');

test('发布记录带 sourceBaseline（图快照 + Git 提交），无变化 → 零影响且非 fallback', (root) => {
  prepare(root);
  publish(root, ALL);
  const release = releases.readCurrentRelease(stateDir(root), 'page-chat');
  assert.match(release.sourceBaseline.graphRevision, /^sha256:[a-f0-9]{64}$/);
  assert.match(release.sourceBaseline.gitCommit, /^[a-f0-9]{40}$/);
  const report = analyze(root);
  assert.strictEqual(report.fullRebuild, null);
  assert.strictEqual(report.mode, 'per-release');
  assert.deepStrictEqual(report.sections, []);
});

test('修改共享组件：只影响 chat / skills 及经过 chat 的任务，reasonPath 可解释', (root) => {
  prepare(root);
  publish(root, ALL);
  fx.writeFile(root, 'components/shared/Card.tsx', 'export default function Card(p) { return <b>{p.children}</b> }\n');
  const report = analyze(root);
  assert.deepStrictEqual(ids(report), ['page-chat', 'page-skills', 'task-t']);
  assert.deepStrictEqual(section(report, 'page-chat').reasonPaths[0], ['components/shared/Card.tsx', 'chat', 'page-chat', 'page-chat']);
  assert.deepStrictEqual(section(report, 'task-t').reasonPaths[0], ['components/shared/Card.tsx', 'chat', 't-default', 'task-t']);
  assert.strictEqual(section(report, 'page-chat').confidence, 'exact');
  assert.strictEqual(report.confidence, 'exact');
  assert.strictEqual(report.runtimeFreshness.checked, false, '源码影响不宣称线上状态');
});

test('删除依赖文件：只在旧图里有记录，union 查询仍能找到 profile', (root) => {
  prepare(root);
  publish(root, ALL);
  fs.rmSync(path.join(root, 'components/profile/Only.tsx'));
  fx.writeFile(root, 'app/profile/page.tsx', 'export default function Page() { return null }\n');
  const report = analyze(root);
  assert.ok(ids(report).includes('page-profile'), JSON.stringify(ids(report)));
  const reasons = report.groups[0].report.pages.find((p) => p.id === 'profile').reasons;
  assert.ok(reasons.includes('dependency-removed:components/profile/Only.tsx'), reasons.join(','));
  assert.ok(!ids(report).includes('page-chat'));
});

test('rename 组件：旧路径归属 profile，新路径不在旧图也能关联', (root) => {
  prepare(root);
  publish(root, ALL);
  fx.git(root, ['mv', 'components/profile/Only.tsx', 'components/profile/Renamed.tsx']);
  fx.writeFile(root, 'app/profile/page.tsx', "import Only from '../../components/profile/Renamed'\nexport default function Page() { return <Only /> }\n");
  const report = analyze(root);
  const change = report.groups[0].report.changes.find((c) => c.status === 'R');
  assert.ok(change, JSON.stringify(report.groups[0].report.changes));
  assert.strictEqual(change.oldPath, 'components/profile/Only.tsx');
  assert.ok(ids(report).includes('page-profile'));
  const reasons = report.groups[0].report.pages.find((p) => p.id === 'profile').reasons;
  assert.ok(reasons.some((r) => r === 'dependency-renamed:components/profile/Only.tsx'), reasons.join(','));
});

test('全局配置（package.json）变化：保守扩散到所有页面并给出理由', (root) => {
  prepare(root);
  publish(root, ALL);
  fx.writePackageJson(root, { next: '^15.1.0', react: '^19.0.0' });
  const report = analyze(root);
  assert.deepStrictEqual(ids(report), ALL.slice().sort());
  assert.strictEqual(report.confidence, 'conservative');
  assert.ok(report.groups[0].report.broadImpact.includes('global-changed:package.json'));
  assert.strictEqual(section(report, 'page-profile').confidence, 'conservative');
});

test('框架约定 layout 变化：按依赖图精确影响所有页面（非全局猜测）', (root) => {
  prepare(root);
  publish(root, ALL);
  fx.writeFile(root, 'app/layout.tsx', 'export default function Root({ children }) { return <main>{children}</main> }\n');
  const report = analyze(root);
  assert.deepStrictEqual(ids(report), ALL.slice().sort());
  assert.deepStrictEqual(section(report, 'page-skills').reasonPaths[0], ['app/layout.tsx', 'skills', 'page-skills', 'page-skills']);
});

test('无法归属的新源码 + 动态 import 页面：只有依赖不完整的页面被保守纳入', (root) => {
  prepare(root);
  publish(root, ALL);
  fx.writeFile(root, 'lib/plugins/report.ts', 'export default 1\n');
  const report = analyze(root);
  assert.ok(ids(report).includes('page-admin'), JSON.stringify(ids(report)));
  assert.ok(!ids(report).includes('page-chat'), '依赖完整的页面不受无关文件影响');
  assert.strictEqual(section(report, 'page-admin').confidence, 'conservative');
  assert.ok(report.groups[0].report.broadImpact.includes('unresolved-dependency:lib/plugins/report.ts'));
});

test('只改 docs 与 .manual：不视为业务源码变化', (root) => {
  prepare(root);
  publish(root, ALL);
  fx.writeFile(root, 'docs/manual/chat.md', '# 手改\n');
  fx.writeFile(root, 'README.md', 'x\n');
  const report = analyze(root);
  assert.deepStrictEqual(report.sections, []);
  const group = report.groups[0].report;
  assert.ok(group.excluded.some((c) => c.path === 'docs/manual/chat.md'));
  assert.ok(group.unowned.includes('README.md'));
});

test('删除页面：对应页面文档标 retirement，经过它的任务标 brokenReference', (root) => {
  prepare(root);
  publish(root, ALL);
  fs.rmSync(path.join(root, 'app/chat/page.tsx'));
  const report = analyze(root);
  assert.strictEqual(section(report, 'page-chat').retirement, true);
  assert.strictEqual(section(report, 'task-t').brokenReference, true);
  assert.strictEqual(report.groups[0].report.pages.find((p) => p.id === 'chat').status, 'removed');
});

test('不同基线分组：各手册只与自己发布时的源码比较', (root) => {
  prepare(root);
  publish(root, ['page-chat', 'task-t']);
  fx.writeFile(root, 'components/shared/Card.tsx', 'export default function Card() { return 1 }\n');
  fx.gitCommit(root, 'card v2');
  run(root, 'inspect', ['--json']);
  publish(root, ['page-skills']); // skills 在 Card 修改之后才发布
  const report = analyze(root);
  assert.strictEqual(report.groups.length, 2);
  assert.deepStrictEqual(ids(report), ['page-chat', 'task-t']);
});

test('显式 --base：统一与该提交比较', (root) => {
  prepare(root);
  const base = fx.git(root, ['rev-parse', 'HEAD']);
  publish(root, ALL);
  fx.writeFile(root, 'components/profile/Only.tsx', 'export default function Only() { return 1 }\n');
  fx.gitCommit(root, 'x');
  run(root, 'inspect', ['--json']);
  publish(root, ALL);
  assert.deepStrictEqual(analyze(root).sections, [], '按发布基线：已无变化');
  const explicit = analyze(root, { base });
  assert.strictEqual(explicit.mode, 'explicit-base');
  assert.deepStrictEqual(ids(explicit), ['page-profile']);
});

test('无发布记录 / 旧发布记录无基线：full-rebuild-required，不返回零影响', (root) => {
  prepare(root);
  const none = analyze(root);
  assert.strictEqual(none.fullRebuild.fallback, 'full-rebuild-required');
  assert.strictEqual(none.fullRebuild.reason, 'no-baseline');
  publish(root, ['page-chat'], { baseline: false });
  publish(root, ['page-skills']);
  const mixed = analyze(root);
  assert.deepStrictEqual(mixed.fullRebuild.manualIds, ['page-chat']);
  assert.strictEqual(mixed.confidence, 'conservative');
});

test('非 Git 项目：用发布时的图快照比较内容', (root) => {
  prepare(root, { git: false });
  publish(root, ALL);
  assert.strictEqual(releases.readCurrentRelease(stateDir(root), 'page-chat').sourceBaseline.gitCommit, null);
  fx.writeFile(root, 'components/profile/Only.tsx', 'export default function Only() { return 2 }\n');
  const report = analyze(root);
  assert.strictEqual(report.groups[0].report.mode, 'snapshot');
  assert.deepStrictEqual(ids(report), ['page-profile']);
}, { git: false });

test('内容二次确认：Git 报告修改但内容与基线一致 → 不计入影响', (root) => {
  prepare(root, { git: false });
  const { config } = loadConfig(root);
  const graph = require('../src/inspect/index-store').readCurrentGraph(stateDir(root));
  const model = { pages: require('../src/store/project').readWorkingCopy(stateDir(root)).model.pages, tasks: [] };
  const detection = { mode: 'git', base: 'x', changes: [{ status: 'M', path: 'components/shared/Card.tsx' }] };
  const report = analyzeImpact({ projectRoot: root, config, detection, baseGraph: graph, currentGraph: graph, model });
  assert.deepStrictEqual(report.sections, []);
  assert.strictEqual(report.identical[0].path, 'components/shared/Card.tsx');
  assert.strictEqual(hashFile(root, 'components/shared/Card.tsx'), graph.pages.chat.files['components/shared/Card.tsx']);
}, { git: false });

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
