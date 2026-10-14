'use strict';

/*
 * React Router 对象路由适配器（docs/MULTI_FRAMEWORK_PLAN.md 阶段 2）：
 * 逐条核对路由记录的去向、页面入口与布局依赖；路由定义文件变化只影响对应页面；
 * 不支持的写法给出明确的 partial / unsupported，而不是扫出 0 条路由冒充成功。
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

function inspectJson(root) {
  const r = run(root, 'inspect', ['--json']);
  assert.strictEqual(r.status, 0, `inspect 失败: ${r.stderr}${r.stdout}`);
  return JSON.parse(r.stdout);
}

function withProject(make, fn) {
  const root = make();
  try {
    const init = run(root, 'init', ['--base-url', 'http://localhost:5173']);
    assert.strictEqual(init.status, 0, init.stderr);
    fn(root);
  } finally {
    fx.cleanup(root);
  }
}

const ROUTES = `import { createBrowserRouter, Navigate } from 'react-router-dom';
import { dynamic } from '@/lib/dynamic';
import { Guard } from './components/guard';
import Settings from './pages/settings';
import extraRoutes from './extra-routes';

export default createBrowserRouter([
  // 不带登录态
  { path: '/', Component: dynamic(() => import('@/pages/login')) },
  { path: '/:code', Component: dynamic(() => import('@/pages/login')) },
  {
    path: '/',
    Component: Guard,
    children: [
      { path: '/dashboard', Component: dynamic(() => import('@/pages/dashboard')) },
      { path: 'reports/:id', lazy: () => import('./pages/report') },
      { path: '/settings', element: <Settings /> },
      {
        path: '/help',
        Component: dynamic(() => import('@/pages/help')),
        children: [{ path: '/help/login', Component: dynamic(() => import('@/pages/help/login')) }],
      },
      { path: '/old', element: <Navigate to="/dashboard" /> },
      {
        path: '/admin',
        children: [
          { index: true, Component: dynamic(() => import('@/pages/admin')) },
          { path: 'users', Component: dynamic(() => import('@/pages/admin/users')) },
        ],
      },
      ...extraRoutes,
      { path: '*', Component: dynamic(() => import('@/pages/not-found')) },
    ],
  },
]);
`;

function reactFixture() {
  const root = fx.makeTempDir('manual-rr-');
  fx.writeFile(root, 'package.json', JSON.stringify({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-router-dom': '^6.23.0' }, devDependencies: { vite: '^5.2.11' } }));
  fx.writeFile(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: './', paths: { '@/*': ['./src/*'] } } }));
  fx.writeFile(root, 'vite.config.ts', 'export default {}\n');
  fx.writeFile(root, 'index.html', '<div id="root"></div>\n');
  fx.writeFile(root, 'src/main.tsx', "import router from '@/routes'\nimport { RouterProvider } from 'react-router-dom'\nexport const App = () => <RouterProvider router={router} />\n");
  fx.writeFile(root, 'src/routes.tsx', ROUTES);
  fx.writeFile(root, 'src/extra-routes.ts', "import { dynamic } from '@/lib/dynamic'\nexport default [{ path: '/extra', Component: dynamic(() => import('@/pages/extra')) }]\n");
  fx.writeFile(root, 'src/lib/dynamic.tsx', 'export function dynamic(load) { return load }\n');
  fx.writeFile(root, 'src/components/guard/index.tsx', "import { Outlet } from 'react-router-dom'\nexport function Guard() { return <Outlet /> }\n");
  fx.writeFile(root, 'src/components/card.tsx', 'export default function Card() { return null }\n');
  // 页面组件 import 了路由表（跳转用）：路由表不能因此成为页面依赖
  fx.writeFile(root, 'src/pages/dashboard/index.tsx', "import Card from '@/components/card'\nimport router from '@/routes'\nexport default function Dashboard() { return <Card onClick={() => router.navigate('/')} /> }\n");
  for (const page of ['login', 'report', 'settings', 'help/index', 'help/login', 'admin/index', 'admin/users', 'extra', 'not-found']) {
    fx.writeFile(root, `src/pages/${page}.tsx`, 'export default function Page() { return null }\n');
  }
  return root;
}

process.stdout.write('\nreact router\n');

test('逐条核对路由记录：页面、跳过原因、入口文件与布局链', () => {
  withProject(reactFixture, (root) => {
    const out = inspectJson(root);
    assert.strictEqual(out.discovery.adapter, 'react-router-objects');
    assert.strictEqual(out.discovery.completeness, 'complete', JSON.stringify(out.discovery));
    assert.deepStrictEqual(out.discovery.counts, { routeRecords: 14, pageRecords: 10, pages: 10, skipped: 4, unresolved: 0, conflicts: 0 });
    const entries = Object.fromEntries(out.pages.map((p) => [p.route, p.entry]));
    assert.deepStrictEqual(entries, {
      '/': 'src/pages/login.tsx',
      '/:code': 'src/pages/login.tsx',
      '/admin': 'src/pages/admin/index.tsx',
      '/admin/users': 'src/pages/admin/users.tsx',
      '/dashboard': 'src/pages/dashboard/index.tsx',
      '/extra': 'src/pages/extra.tsx',
      '/help': 'src/pages/help/index.tsx',
      '/help/login': 'src/pages/help/login.tsx',
      '/reports/:id': 'src/pages/report.tsx',
      '/settings': 'src/pages/settings.tsx',
    });
    assert.deepStrictEqual(out.skipped.map((s) => s.reason).sort(), ['catch-all', 'layout-only', 'layout-only', 'redirect']);
    const helpLogin = yamlPage(root, out, '/help/login');
    assert.deepStrictEqual(helpLogin.dependencies.scope, ['src/components/guard/index.tsx', 'src/pages/help/index.tsx']);
    assert.strictEqual(helpLogin.status.router, 'react-router');
    assert.strictEqual(helpLogin.dependencies.route.adapter, 'react-router-objects');
    const report = out.pages.find((p) => p.route === '/reports/:id');
    assert.strictEqual(report.dynamic, true);
  });
});

test('页面 import 了路由表：路由表不进页面依赖，也不让依赖覆盖变成 partial', () => {
  withProject(reactFixture, (root) => {
    const out = inspectJson(root);
    const dashboard = yamlPage(root, out, '/dashboard');
    assert.deepStrictEqual(dashboard.dependencies.files, ['src/components/card.tsx', 'src/components/guard/index.tsx'], '布局组件计入，路由表不计入');
    assert.strictEqual(dashboard.dependencies.completeness, 'complete');
    const graph = JSON.parse(fs.readFileSync(path.join(root, '.manual/index/graph.json'), 'utf8'));
    assert.deepStrictEqual(Object.keys(graph.routeSources).sort(), ['src/extra-routes.ts', 'src/routes.tsx']);
    assert.ok(graph.globals['vite.config.ts'] && graph.globals['index.html'], 'Vite 配置与 index.html 计入全局文件');
  });
});

test('改一条路由只影响这一个页面；只改路由文件里的注释不影响任何页面', () => {
  withProject(reactFixture, (root) => {
    inspectJson(root);
    const file = path.join(root, 'src/routes.tsx');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('// 不带登录态', '// 匿名访问的页面'));
    let out = inspectJson(root);
    assert.deepStrictEqual(out.impact.pages.filter((p) => p.status !== 'unchanged'), [], '注释改动不应影响页面');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("path: 'reports/:id'", "path: 'reports/:reportId'"));
    out = inspectJson(root);
    const changed = out.impact.pages.filter((p) => p.status !== 'unchanged');
    assert.strictEqual(changed.length, 1, JSON.stringify(changed));
    assert.ok(changed[0].reasons.some((r) => r.startsWith('route-record-changed:')), JSON.stringify(changed[0]));
    assert.deepStrictEqual(out.renamed.map((r) => [r.from, r.to]), [['/reports/:id', '/reports/:reportId']]);
  });
});

test('update 影响分析：路由定义文件的改动单独登记，不按"无法归属的源码"扩散', () => {
  withProject(reactFixture, (root) => {
    const { analyzeImpact } = require('../src/update/impact');
    const { loadConfig } = require('../src/config/load');
    const { createProjectStore } = require('../src/store/project');
    // 让一个页面依赖覆盖不完整：旧规则下，无法归属的源码改动会扩散到它
    fx.writeFile(root, 'src/pages/extra.tsx', 'export default async function Page({ n }) { return import(n) }\n');
    inspectJson(root);
    const graphFile = path.join(root, '.manual/index/graph.json');
    const before = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const file = path.join(root, 'src/routes.tsx');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('// 不带登录态', '// 改了注释'));
    inspectJson(root);
    const after = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
    const { config } = loadConfig(root);
    const model = createProjectStore({ stateDirAbs: path.join(root, '.manual'), docsOutputDir: config.docs.outputDir }).readCommitted().model;
    const report = analyzeImpact({
      projectRoot: root, config, baseGraph: before, confirmGraph: before, currentGraph: after, model,
      detection: { mode: 'snapshot', base: null, head: null, changes: [{ status: 'M', path: 'src/routes.tsx' }] },
    });
    assert.deepStrictEqual(report.routeDefinitions, ['src/routes.tsx']);
    assert.deepStrictEqual(report.broadImpact, []);
    assert.deepStrictEqual(report.pages, []);
  });
});

test('无法静态求值的 path：记为未解析，完整性为 partial，inspect 仍然产出其余页面', () => {
  withProject(reactFixture, (root) => {
    const file = path.join(root, 'src/routes.tsx');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace("{ path: '/:code',", "{ path: PREFIX + '/code',"));
    const out = inspectJson(root);
    assert.strictEqual(out.discovery.completeness, 'partial');
    assert.strictEqual(out.discovery.counts.unresolved, 1);
    assert.strictEqual(out.discovery.unresolved[0].reason, 'dynamic-path');
    assert.strictEqual(out.discovery.unresolved[0].location.file, 'src/routes.tsx');
    assert.strictEqual(out.pages.length, 9);
    const text = run(root, 'inspect');
    assert.match(text.stdout, /不完整/);
    assert.match(text.stdout, /src\/routes\.tsx:\d+\s+dynamic-path/);
  });
});

test('JSX <Routes> 声明式路由：明确报告不支持，不扫出 0 条冒充成功', () => {
  const make = () => {
    const root = fx.makeTempDir('manual-rr-jsx-');
    fx.writeFile(root, 'package.json', JSON.stringify({ dependencies: { 'react-router-dom': '^6.23.0' } }));
    fx.writeFile(root, 'src/App.tsx', "import { Routes, Route } from 'react-router-dom'\nimport Home from './Home'\nexport default () => <Routes><Route path='/' element={<Home />} /></Routes>\n");
    fx.writeFile(root, 'src/Home.tsx', 'export default () => null\n');
    return root;
  };
  withProject(make, (root) => {
    const r = run(root, 'inspect');
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, /<Routes>/);
  });
});

test('framework mode（@react-router/dev）：明确报告不支持', () => {
  const make = () => {
    const root = fx.makeTempDir('manual-rr-fw-');
    fx.writeFile(root, 'package.json', JSON.stringify({ dependencies: { 'react-router': '^7.0.0' }, devDependencies: { '@react-router/dev': '^7.0.0' } }));
    fx.writeFile(root, 'app/routes.ts', "import { index } from '@react-router/dev/routes'\nexport default [index('routes/home.tsx')]\n");
    return root;
  };
  withProject(make, (root) => {
    const r = run(root, 'inspect');
    assert.strictEqual(r.status, 1, r.stdout);
    assert.match(r.stderr, /framework mode/);
  });
});

function yamlPage(root, out, route) {
  const yaml = require('js-yaml');
  const id = out.pages.find((p) => p.route === route).id;
  return yaml.load(fs.readFileSync(path.join(root, '.manual/pages', `${id}.yaml`), 'utf8'));
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
