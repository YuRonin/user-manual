'use strict';

/*
 * 统一路由发现层（docs/MULTI_FRAMEWORK_PLAN.md 阶段 1）：
 * 记录去向不变式、冲突与完整性判定、Next 适配器的记录覆盖、按能力区分的解析器版本、
 * 路由定义文件不进入页面依赖。
 */

const assert = require('assert');

const fx = require('./fixtures');
const { finalizeDiscovery, DISPOSITION } = require('../src/inspect/adapters/records');
const nextAdapter = require('../src/inspect/adapters/nextjs');
const { detectProject } = require('../src/inspect/detect');
const { scanSource } = require('../src/inspect/source-graph');
const { PARSER_VERSION, parserVersionFor, pageFingerprint } = require('../src/inspect/fingerprint');
const { buildImportGraph } = require('../src/inspect/import-graph');
const { revision } = require('../src/model/revision');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function page(recordId, fullPath, entry) {
  return { recordId, fullPath, entry, disposition: DISPOSITION.PAGE, layoutChain: [], source: 'L2' };
}
const toPage = (record) => ({ route: record.fullPath, dynamic: false, params: [], entry: record.entry, router: 'test' });

process.stdout.write('\nroute discovery\n');

test('不变式：每条记录恰好一个去向，计数对得上', () => {
  const result = finalizeDiscovery({
    adapter: 'test',
    records: [
      page('r/a', '/a', 'A.tsx'),
      page('r/b', '/b', 'B.tsx'),
      { recordId: 'r/layout', disposition: DISPOSITION.SKIPPED, reason: 'layout-only' },
      { recordId: 'r/star', disposition: DISPOSITION.SKIPPED, reason: 'catch-all' },
    ],
    toPage,
  });
  assert.deepStrictEqual(result.counts, { routeRecords: 4, pageRecords: 2, pages: 2, skipped: 2, unresolved: 0, conflicts: 0 });
  assert.strictEqual(result.completeness, 'complete');
  assert.ok(result.records.every((r) => r.disposition !== DISPOSITION.PAGE || /^sha256:[0-9a-f]{64}$/.test(r.recordHash)));
});

test('同一 URL 的多条记录记入冲突：页面数少于页面记录数，但每条记录仍有去向', () => {
  const result = finalizeDiscovery({ adapter: 'test', records: [page('r/1', '/', 'Login.tsx'), page('r/2', '/', 'Other.tsx')], toPage });
  assert.strictEqual(result.counts.pageRecords, 2);
  assert.strictEqual(result.counts.pages, 1);
  assert.deepStrictEqual(result.conflicts, [{ route: '/', entries: ['Login.tsx', 'Other.tsx'], recordIds: ['r/1', 'r/2'] }]);
  assert.strictEqual(result.pages[0].entry, 'Login.tsx', '保留先出现的记录');
});

test('有未解析记录 → partial；检测报告不支持 → unsupported；不以页面数量判定完整', () => {
  const partial = finalizeDiscovery({
    adapter: 'test', toPage,
    records: [page('r/a', '/a', 'A.tsx'), { recordId: 'r/x', disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-path', location: { file: 'routes.ts', line: 9 } }],
  });
  assert.strictEqual(partial.completeness, 'partial');
  assert.strictEqual(partial.counts.unresolved, 1);
  const unsupported = finalizeDiscovery({ adapter: 'test', toPage, records: [], detectStatus: 'unsupported' });
  assert.strictEqual(unsupported.completeness, 'unsupported', '0 条路由不能被当成扫描成功');
  const mixed = finalizeDiscovery({ adapter: 'test', toPage, records: [page('r/a', '/a', 'A.tsx')], detectStatus: 'partial' });
  assert.strictEqual(mixed.completeness, 'partial');
});

test('非法去向 / 原因 / 重复 id 是适配器 bug，直接抛出', () => {
  assert.throws(() => finalizeDiscovery({ adapter: 't', toPage, records: [{ recordId: 'x', disposition: 'maybe' }] }), /去向非法/);
  assert.throws(() => finalizeDiscovery({ adapter: 't', toPage, records: [{ recordId: 'x', disposition: DISPOSITION.SKIPPED, reason: 'whatever' }] }), /skipped 原因/);
  assert.throws(() => finalizeDiscovery({ adapter: 't', toPage, records: [page('x', '/a', 'A'), page('x', '/b', 'B')] }), /重复/);
  assert.throws(() => finalizeDiscovery({ adapter: 't', toPage, records: [{ recordId: 'x', disposition: DISPOSITION.PAGE }] }), /fullPath/);
});

test('记录 hash 只看内容（path / 入口 / props / 布局链），不看行号', () => {
  const a = finalizeDiscovery({ adapter: 't', toPage, records: [{ ...page('r', '/a', 'A.tsx'), location: { file: 'r.ts', line: 1 } }] }).records[0];
  const b = finalizeDiscovery({ adapter: 't', toPage, records: [{ ...page('r', '/a', 'A.tsx'), location: { file: 'r.ts', line: 40 } }] }).records[0];
  const c = finalizeDiscovery({ adapter: 't', toPage, records: [{ ...page('r', '/a', 'A.tsx'), props: { module: 'writing' } }] }).records[0];
  assert.strictEqual(a.recordHash, b.recordHash);
  assert.notStrictEqual(a.recordHash, c.recordHash);
});

test('Next 适配器：每个被扫描的文件恰好一条记录，跳过原因原样保留，结果完整', () => {
  const root = fx.nextAppFixture();
  try {
    const detected = detectProject(root);
    assert.strictEqual(detected.ok, true);
    assert.strictEqual(detected.adapter, 'nextjs');
    assert.deepStrictEqual(detected.routing.status, 'supported');
    const discovery = nextAdapter.discover({ projectRoot: root, context: detected.context });
    assert.strictEqual(discovery.completeness, 'complete');
    assert.strictEqual(discovery.counts.routeRecords, discovery.counts.pageRecords + discovery.counts.skipped);
    assert.ok(discovery.counts.skipped > 0, '夹具含 layout / api / 私有目录等应跳过的文件');
    assert.deepStrictEqual(discovery.routeSources, [], 'Next 路由由文件路径决定，没有路由定义文件');
    const scanned = scanSource(root);
    assert.strictEqual(scanned.scan.pages.length, discovery.pages.length);
    assert.ok(scanned.scan.skipped.every((s) => typeof s.file === 'string' && typeof s.reason === 'string' && !('route' in s)), '保持改造前的 skipped 形状');
    assert.ok(scanned.scan.pages.every((p) => !p.dependencies.route), 'Next 页面不带路由记录（指纹输入不变）');
  } finally {
    fx.cleanup(root);
  }
});

test('未支持的框架：报出检测到的框架，不扫出 0 个页面冒充成功', () => {
  const root = fx.makeTempDir();
  try {
    fx.writeFile(root, 'package.json', JSON.stringify({ dependencies: { '@angular/core': '^17.0.0' } }));
    const detected = detectProject(root);
    assert.strictEqual(detected.ok, false);
    assert.match(detected.errors.join('\n'), /Angular/);
  } finally {
    fx.cleanup(root);
  }
});

test('解析器版本按能力区分：只用 js-ts 的页面与改造前完全一致', () => {
  assert.strictEqual(parserVersionFor({ files: ['app/page.tsx', 'lib/a.ts'] }), PARSER_VERSION);
  assert.strictEqual(parserVersionFor({ files: ['src/views/A.vue'] }), `${PARSER_VERSION}+vue-sfc-1`);
  assert.strictEqual(parserVersionFor({ files: ['src/A.vue'], routeCapability: 'route:vue-router-objects' }), `${PARSER_VERSION}+vr-objects-1+vue-sfc-1`);
  assert.throws(() => parserVersionFor({ routeCapability: 'route:unknown' }), /未登记/);
});

test('页面指纹：没有路由记录时等于改造前的公式；有路由记录时随记录 hash 变化', () => {
  const root = fx.makeTempDir();
  try {
    fx.writeFile(root, 'app/page.tsx', 'export default function P() { return null }\n');
    const base = pageFingerprint(root, { entry: 'app/page.tsx', globals: { 'package.json': 'x' } });
    const legacy = revision({ parserVersion: PARSER_VERSION, entry: 'app/page.tsx', files: base.fileHashes, globals: { 'package.json': 'x' } });
    assert.strictEqual(base.sourceRevision, legacy);
    const r1 = pageFingerprint(root, { entry: 'app/page.tsx', routeRecord: { recordId: 'a', recordHash: '1' }, routeCapability: 'route:react-router-objects' });
    const r2 = pageFingerprint(root, { entry: 'app/page.tsx', routeRecord: { recordId: 'a', recordHash: '2' }, routeCapability: 'route:react-router-objects' });
    assert.notStrictEqual(r1.sourceRevision, r2.sourceRevision);
    assert.strictEqual(r1.parserVersion, `${PARSER_VERSION}+rr-objects-1`);
  } finally {
    fx.cleanup(root);
  }
});

test('路由定义文件是依赖图边界：页面 import router 不会把整张路由表算进页面依赖', () => {
  const root = fx.makeTempDir();
  try {
    fx.writeFile(root, 'src/router/index.ts', "import Home from '../views/Home'\nexport default [Home]\n");
    fx.writeFile(root, 'src/views/Home.tsx', 'export default function Home() { return null }\n');
    fx.writeFile(root, 'src/views/Detail.tsx', "import router from '../router'\nimport Util from './util'\nexport default function D() { return router && Util }\n");
    fx.writeFile(root, 'src/views/util.ts', 'export default 1\n');
    const open = buildImportGraph(root, 'src/views/Detail.tsx');
    assert.ok(open.files.includes('src/router/index.ts') && open.files.includes('src/views/Home.tsx'));
    const bounded = buildImportGraph(root, 'src/views/Detail.tsx', { boundary: ['src/router/index.ts'] });
    assert.deepStrictEqual(bounded.files, ['src/views/util.ts']);
    assert.strictEqual(bounded.completeness, 'complete');
  } finally {
    fx.cleanup(root);
  }
});

test('依赖提取：注释掉的 import 不算依赖；Vite 的 ?url / ?raw 后缀解析到真实文件；字符串里的 // 不被当成注释', () => {
  const root = fx.makeTempDir();
  try {
    fx.writeFile(root, 'src/page.tsx', [
      "// import { Gone } from './gone'",
      "/* import Old from './old'",
      "   import Older from './older' */",
      "import logo from './logo.svg?url'",
      "import raw from './text.md?raw'",
      "const url = 'https://example.com//x'; import Real from './real'",
      'export default function P() { return [logo, raw, url, Real] }',
      '',
    ].join('\n'));
    fx.writeFile(root, 'src/logo.svg', '<svg/>');
    fx.writeFile(root, 'src/text.md', '# t');
    fx.writeFile(root, 'src/real.tsx', 'export default 1\n');
    const result = buildImportGraph(root, 'src/page.tsx');
    assert.deepStrictEqual(result.unresolved, []);
    assert.deepStrictEqual(result.files, ['src/real.tsx']);
    assert.deepStrictEqual(result.assets, ['src/logo.svg', 'src/text.md']);
  } finally {
    fx.cleanup(root);
  }
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
