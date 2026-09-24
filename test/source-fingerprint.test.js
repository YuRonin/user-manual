'use strict';

/*
 * P1-05：内容指纹、隐式依赖与保守失效。
 * 真实 spawn `manual inspect`，改动夹具源码后检查指纹、分析状态与影响清单。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { pageObservationRevision, evidenceFreshness, scopeHash, pageRevisionsFor } = require('../src/model/approval');
const { expandSourcePatterns, globToRegex } = require('../src/inspect/fingerprint');
const { frameworkDependencies } = require('../src/inspect/framework-dependencies');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fx.nextAppFixture();
  try { fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fx.cleanup(root); }
}

function run(root, cmd, args = []) {
  const r = spawnSync(process.execPath, [CLI, cmd, '--project-root', root, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function inspect(root) {
  const r = run(root, 'inspect', ['--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

function page(root, id) {
  return yaml.load(fs.readFileSync(path.join(root, '.manual', 'pages', `${id}.yaml`), 'utf8'));
}

function impactOf(out, id) {
  return out.impact.pages.find((p) => p.id === id);
}

/** 初始化、写好 chat 页的依赖、扫描一次并把 chat 的源码分析标为完成。 */
function prepare(root) {
  fx.writeFile(root, 'app/chat/page.tsx', [
    "import Panel from '../../components/chat/Panel'",
    "import zh from '../../locales/zh.json'",
    'export default function Page() { return <Panel title={zh.send}>发送</Panel> }',
  ].join('\n'));
  fx.writeFile(root, 'components/chat/Panel.tsx', 'export default function Panel(p) { return p.children }\n');
  fx.writeFile(root, 'locales/zh.json', '{ "send": "发送" }\n');
  fx.writeFile(root, 'app/layout.tsx', "import './globals.css'\nexport default function Root({ children }) { return children }\n");
  fx.writeFile(root, 'app/globals.css', 'body { color: #333 }\n');
  assert.strictEqual(run(root, 'init', ['--base-url', 'http://localhost:3000']).status, 0);
  inspect(root);
  const r = run(root, 'describe', ['--id', 'chat', '--title', '工作台', '--purpose', '对话。']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(page(root, 'chat').status.sourceAnalysis, 'completed');
  return page(root, 'chat').analysis.sourceRevision;
}

process.stdout.write('\nsource fingerprint\n');

test('重复扫描不改动源码：指纹稳定、分析保持 completed、影响为 unchanged', (root) => {
  const before = prepare(root);
  const out = inspect(root);
  assert.strictEqual(page(root, 'chat').analysis.sourceRevision, before);
  assert.strictEqual(page(root, 'chat').status.sourceAnalysis, 'completed');
  assert.strictEqual(impactOf(out, 'chat').status, 'unchanged');
  assert.deepStrictEqual(out.sourceChanges, []);
  assert.ok(fs.existsSync(path.join(root, '.manual', 'index', 'graph.previous.json')), '旧图快照保留');
});

test('入口路径不变但按钮文字变了：指纹变化，分析与证据标为 stale，原因指向文件', (root) => {
  const before = prepare(root);
  fx.writeFile(root, 'app/chat/page.tsx', fs.readFileSync(path.join(root, 'app/chat/page.tsx'), 'utf8').replace('>发送<', '>提交<'));
  const out = inspect(root);
  const after = page(root, 'chat');
  assert.notStrictEqual(after.analysis.sourceRevision, before);
  assert.strictEqual(after.status.sourceAnalysis, 'stale');
  assert.deepStrictEqual(impactOf(out, 'chat'), { id: 'chat', status: 'changed', reasons: ['content-changed:app/chat/page.tsx'], broadImpact: false });
  assert.deepStrictEqual(out.sourceChanges, [{ id: 'chat', reasons: ['content-changed:app/chat/page.tsx'] }]);
});

for (const [name, file, content] of [
  ['只改上级 layout', 'app/layout.tsx', "import './globals.css'\nexport default function Root({ children }) { return <main>{children}</main> }\n"],
  ['只改全局 CSS（由 layout 引用）', 'app/globals.css', 'body { color: #000 }\n'],
  ['只改翻译 JSON', 'locales/zh.json', '{ "send": "提交" }\n'],
  ['只改同级 loading（框架约定）', 'app/chat/loading.tsx', 'export default function Loading() { return "…" }\n'],
]) {
  test(`${name}：页面指纹变化`, (root) => {
    const before = prepare(root);
    fx.writeFile(root, file, content);
    const out = inspect(root);
    assert.notStrictEqual(page(root, 'chat').analysis.sourceRevision, before);
    assert.deepStrictEqual(impactOf(out, 'chat').reasons, [`content-changed:${file}`]);
  });
}

test('依赖新增与删除都改变指纹并给出原因', (root) => {
  prepare(root);
  fx.writeFile(root, 'components/chat/Extra.tsx', 'export default 1\n');
  fx.writeFile(root, 'app/chat/page.tsx', `import Extra from '../../components/chat/Extra'\n${fs.readFileSync(path.join(root, 'app/chat/page.tsx'), 'utf8')}`);
  let out = inspect(root);
  assert.ok(impactOf(out, 'chat').reasons.includes('dependency-added:components/chat/Extra.tsx'));
  fx.writeFile(root, 'app/chat/page.tsx', fs.readFileSync(path.join(root, 'app/chat/page.tsx'), 'utf8').replace("import Panel from '../../components/chat/Panel'\n", '').replace('<Panel title={zh.send}>发送</Panel>', 'null'));
  out = inspect(root);
  assert.ok(impactOf(out, 'chat').reasons.includes('dependency-removed:components/chat/Panel.tsx'));
});

test('tsconfig 别名配置变化：全局配置影响所有页面（broad impact）', (root) => {
  prepare(root);
  fx.writeFile(root, 'tsconfig.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"] } } }\n');
  const out = inspect(root);
  assert.deepStrictEqual(out.impact.broadImpact, ['global-changed:tsconfig.json']);
  for (const id of ['chat', 'home', 'profile']) {
    const item = impactOf(out, id);
    assert.strictEqual(item.status, 'changed', id);
    assert.ok(item.reasons.includes('global-changed:tsconfig.json'), id);
  }
});

test('无法解析的动态依赖：覆盖标为 partial，没有变化时也报 uncertain，不报零影响', (root) => {
  prepare(root);
  fx.writeFile(root, 'app/profile/page.tsx', 'const mod = import(`../../widgets/${name}`)\nexport default function P() { return null }\n');
  inspect(root);
  const out = inspect(root);
  assert.strictEqual(page(root, 'profile').dependencies.completeness, 'partial');
  assert.strictEqual(page(root, 'profile').analysis.completeness, 'partial');
  const item = impactOf(out, 'profile');
  assert.strictEqual(item.status, 'uncertain');
  assert.ok(item.reasons.includes('coverage-partial'));
});

test('page.source 中的显式文件与受限 glob 纳入指纹（不扫 node_modules）', (root) => {
  prepare(root);
  fx.writeFile(root, 'content/help/a.md', 'A\n');
  fx.writeFile(root, 'node_modules/pkg/index.js', 'x\n');
  const r = run(root, 'describe', ['--id', 'chat', '--source', 'app/chat/page.tsx;content/help/**;node_modules/**']);
  assert.strictEqual(r.status, 0, r.stderr);
  inspect(root);
  const before = page(root, 'chat').analysis;
  assert.deepStrictEqual(before.unmatchedSources, ['node_modules/**']);
  assert.strictEqual(before.completeness, 'partial');
  fx.writeFile(root, 'content/help/a.md', 'B\n');
  const out = inspect(root);
  assert.deepStrictEqual(impactOf(out, 'chat').reasons, ['content-changed:content/help/a.md']);
});

test('框架约定依赖：App Router 逐层祖先文件，Pages Router 的 _app / _document', (root) => {
  fx.writeFile(root, 'pages/_app.tsx', 'x');
  fx.writeFile(root, 'pages/_document.tsx', 'x');
  fx.writeFile(root, 'middleware.ts', 'x');
  assert.deepStrictEqual(
    frameworkDependencies(root, { entry: 'app/chat/page.tsx', router: 'app' }, { appDir: 'app' }),
    ['app/chat/error.tsx', 'app/chat/layout.tsx', 'app/chat/loading.tsx', 'app/layout.tsx', 'app/not-found.tsx', 'middleware.ts'],
  );
  assert.deepStrictEqual(
    frameworkDependencies(root, { entry: 'pages/about.tsx', router: 'pages' }, { pagesDir: 'pages' }),
    ['middleware.ts', 'pages/_app.tsx', 'pages/_document.tsx'],
  );
});

test('glob 与展开的边界', (root) => {
  assert.ok(globToRegex('components/**').test('components/a/b.tsx'));
  assert.ok(globToRegex('components/*.tsx').test('components/a.tsx'));
  assert.ok(!globToRegex('components/*.tsx').test('components/a/b.tsx'));
  const expanded = expandSourcePatterns(root, ['../outside', '/abs', 'app/chat']);
  assert.deepStrictEqual(expanded.unmatched, ['../outside', '/abs']);
  assert.ok(expanded.files.includes('app/chat/page.tsx'));
});

test('源码指纹进入任务证据的新鲜度：同路径内容变化让已采集任务过期', () => {
  const p = { id: 'chat', route: '/chat', states: {}, analysis: { sourceRevision: 'sha256:a' } };
  const task = { id: 't', entryPage: 'chat', risk: 'read', steps: [{ id: 's', page: 'chat', action: { type: 'inspect' } }] };
  const captured = { ...task, lastCapture: { scopeHash: scopeHash(task, [p]), pageRevisions: pageRevisionsFor(task, [p]) } };
  assert.strictEqual(evidenceFreshness(captured, [p]).status, 'fresh');
  const changed = { ...p, analysis: { sourceRevision: 'sha256:b' } };
  assert.notStrictEqual(pageObservationRevision(changed), pageObservationRevision(p));
  assert.deepStrictEqual(evidenceFreshness(captured, [changed]), { status: 'stale', reasons: ['page-changed:chat'] });
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
