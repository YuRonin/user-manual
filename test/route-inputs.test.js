'use strict';

/*
 * 路由发现的 L3 AI 候选与 L4 人工覆盖（docs/MULTI_FRAMEWORK_PLAN.md 阶段 4）：
 * 两者都只是扫描输入；AI 候选只能补未解析记录或新增未发现的路由，依据的源码变了就过期；
 * 人工覆盖优先级最高，可以排除记录；静态发现不支持的项目靠补充也只能是 partial。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function run(root, cmd, args = []) {
  return spawnSync(process.execPath, [CLI, cmd, '--project-root', root, ...args], { encoding: 'utf8' });
}

function inspectJson(root, args = []) {
  const r = run(root, 'inspect', ['--json', ...args]);
  assert.strictEqual(r.status, 0, `inspect 失败: ${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout);
}

const ROUTES = `import { createBrowserRouter } from 'react-router-dom'
import Home from './pages/home'
import { PREFIX } from './config'
export default createBrowserRouter([
  { path: '/', Component: Home },
  { path: PREFIX + '/reports/:id', lazy: () => import('./pages/report') },
  { path: '/debug', lazy: () => import('./pages/debug') },
])
`;

function project({ jsx = false } = {}) {
  const root = fx.makeTempDir('manual-routes-input-');
  fx.writeFile(root, 'package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.23.0' } }));
  if (jsx) {
    fx.writeFile(root, 'src/App.tsx', "import { Routes, Route } from 'react-router-dom'\nimport Home from './pages/home'\nexport default () => <Routes><Route path='/' element={<Home />} /></Routes>\n");
  } else {
    fx.writeFile(root, 'src/routes.tsx', ROUTES);
    fx.writeFile(root, 'src/config.ts', "export const PREFIX = '/admin'\n");
  }
  for (const page of ['home', 'report', 'debug']) fx.writeFile(root, `src/pages/${page}.tsx`, 'export default () => null\n');
  const init = run(root, 'init', ['--base-url', 'http://localhost:5173']);
  assert.strictEqual(init.status, 0, init.stderr);
  return root;
}

function within(make, fn) {
  const root = make();
  try { fn(root); } finally { fx.cleanup(root); }
}

function writeInput(root, body) {
  const file = path.join(root, 'routes-input.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

process.stdout.write('\nroute inputs\n');

test('AI 候选补全未解析记录：校验通过后写入候选文件，完整性变为 complete', () => {
  within(project, (root) => {
    let out = inspectJson(root);
    assert.strictEqual(out.discovery.completeness, 'partial');
    const recordId = out.discovery.unresolved[0].recordId;
    out = inspectJson(root, ['--routes-input', writeInput(root, { routes: [{ recordId, route: '/admin/reports/:id', entry: 'src/pages/report.tsx', reason: 'PREFIX 在 src/config.ts 里是常量 /admin', evidence: ['src/config.ts'] }] })]);
    assert.strictEqual(out.discovery.completeness, 'complete', JSON.stringify(out.discovery));
    assert.ok(out.pages.some((p) => p.route === '/admin/reports/:id' && p.entry === 'src/pages/report.tsx'));
    const candidates = fs.readFileSync(path.join(root, '.manual/routes.candidates.yaml'), 'utf8');
    assert.match(candidates, /src\/config\.ts/);
    // 页面文件里只有扫描字段，来源记为 L3
    const page = out.pages.find((p) => p.route === '/admin/reports/:id');
    const yamlText = fs.readFileSync(path.join(root, '.manual/pages', `${page.id}.yaml`), 'utf8');
    assert.match(yamlText, /source: L3/);
  });
});

test('候选依据的源码变了：候选过期，记录回到未解析，并给出诊断', () => {
  within(project, (root) => {
    const recordId = inspectJson(root).discovery.unresolved[0].recordId;
    inspectJson(root, ['--routes-input', writeInput(root, { routes: [{ recordId, route: '/admin/reports/:id', entry: 'src/pages/report.tsx', reason: '常量前缀', evidence: ['src/config.ts'] }] })]);
    fs.writeFileSync(path.join(root, 'src/config.ts'), "export const PREFIX = '/manage'\n");
    const out = inspectJson(root);
    assert.strictEqual(out.discovery.completeness, 'partial');
    assert.ok(!out.pages.some((p) => p.route === '/admin/reports/:id'));
    assert.ok(out.discovery.diagnostics.some((d) => /过期/.test(d) && /src\/config\.ts/.test(d)), JSON.stringify(out.discovery.diagnostics));
  });
});

test('候选不能改写已由静态扫描确定的路由，也不能指向不存在的未解析记录；整批拒绝且不写文件', () => {
  within(project, (root) => {
    inspectJson(root);
    let r = run(root, 'inspect', ['--routes-input', writeInput(root, { routes: [{ route: '/debug', entry: 'src/pages/home.tsx', reason: '想改入口' }] })]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /已由静态扫描确定/);
    r = run(root, 'inspect', ['--routes-input', writeInput(root, { routes: [{ recordId: 'nope', route: '/x', entry: 'src/pages/home.tsx', reason: 'x' }] })]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /不是当前未解析的路由记录/);
    r = run(root, 'inspect', ['--routes-input', writeInput(root, { routes: [{ route: '/y', entry: 'src/pages/missing.tsx' }] })]);
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /reason/);
    assert.match(r.stderr, /文件不存在/);
    assert.ok(!fs.existsSync(path.join(root, '.manual/routes.candidates.yaml')));
  });
});

test('人工覆盖：排除记录、修正入口、新增路由，优先级高于 AI 候选', () => {
  within(project, (root) => {
    const out0 = inspectJson(root);
    const debugId = 'src/routes.tsx#/debug';
    const unresolvedId = out0.discovery.unresolved[0].recordId;
    inspectJson(root, ['--routes-input', writeInput(root, { routes: [{ recordId: unresolvedId, route: '/admin/reports/:id', entry: 'src/pages/report.tsx', reason: 'AI' }] })]);
    fs.writeFileSync(path.join(root, '.manual/routes.override.yaml'), [
      'version: 1',
      'routes:',
      `  - exclude: "${debugId}"`,
      '    reason: 调试页不进手册',
      `  - recordId: "${unresolvedId}"`,
      '    route: /manage/reports/:id',
      '    entry: src/pages/report.tsx',
      '    reason: 人工确认的真实前缀',
      '  - route: /help',
      '    entry: src/pages/home.tsx',
      '    reason: 运行时注册的帮助页',
      '',
    ].join('\n'));
    const out = inspectJson(root);
    const routes = out.pages.map((p) => p.route).sort();
    assert.deepStrictEqual(routes, ['/', '/help', '/manage/reports/:id']);
    assert.ok(out.skipped.some((s) => s.reason === 'excluded'));
    assert.strictEqual(out.discovery.completeness, 'complete');
  });
});

test('人工覆盖写错（文件不存在 / 缺 reason）：inspect 失败并指出位置，不悄悄忽略', () => {
  within(project, (root) => {
    fs.mkdirSync(path.join(root, '.manual'), { recursive: true });
    fs.writeFileSync(path.join(root, '.manual/routes.override.yaml'), 'version: 1\nroutes:\n  - route: /x\n    entry: src/pages/nope.tsx\n');
    const r = run(root, 'inspect');
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /routes\.override\.yaml routes\[0\]/);
  });
});

test('静态发现不支持的项目：没有补充时 inspect 失败；人工补充后可以扫描，但完整性只能是 partial', () => {
  within(() => project({ jsx: true }), (root) => {
    let r = run(root, 'inspect');
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /<Routes>/);
    assert.match(r.stderr, /routes\.override\.yaml|--routes-input/);
    fs.writeFileSync(path.join(root, '.manual/routes.override.yaml'), 'version: 1\nroutes:\n  - route: /\n    entry: src/pages/home.tsx\n    reason: JSX 路由，人工登记\n');
    const out = inspectJson(root);
    assert.deepStrictEqual(out.pages.map((p) => p.route), ['/']);
    assert.strictEqual(out.discovery.completeness, 'partial');
  });
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
