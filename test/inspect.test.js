'use strict';

/*
 * `manual inspect` / `manual describe` 的端到端测试：真实 spawn CLI，检查落盘产物。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e });
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`);
  }
}

function run(cmd, root, args = []) {
  const r = spawnSync(process.execPath, [CLI, cmd, '--project-root', root, ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/** 先 init 再 inspect —— inspect 依赖 config.yaml 存在。 */
function initProject(root, extra = []) {
  const r = run('init', root, ['--base-url', 'http://localhost:3000', ...extra]);
  assert.strictEqual(r.status, 0, `init 失败: ${r.stderr}`);
}

function readYaml(file) {
  return yaml.load(fs.readFileSync(file, 'utf8'));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function projectYaml(root) {
  return readYaml(path.join(root, '.manual', 'project.yaml'));
}

function pageYaml(root, id) {
  return readYaml(path.join(root, '.manual', 'pages', `${id}.yaml`));
}

function routes(root) {
  return projectYaml(root).pages.map((p) => p.route).sort();
}

/** 跑一段用例，结束后清掉夹具目录。 */
function withFixture(make, fn) {
  const root = make();
  try {
    fn(root);
  } finally {
    fx.cleanup(root);
  }
}

process.stdout.write('\nmanual inspect\n');

// ---------------------------------------------------------------- App Router 扫描
test('App Router：识别全部用户可访问页面', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    const r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);

    assert.deepStrictEqual(routes(root), [
      '/',
      '/admin',
      '/admin/users',
      '/artifact/:id',
      '/blog/:slug?',
      '/chat',
      '/docs/:slug*',
      '/membership',
      '/pricing',
      '/profile',
      '/settings',
      '/skills',
    ]);
  });
});

test('App Router：layout/loading/error/API/私有目录/并行插槽/拦截路由都不算页面', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    const all = routes(root);
    for (const bad of ['/api/health', '/_internal', '/@modal/photo', '/preview', '/not-found']) {
      assert.ok(!all.includes(bad), `不该出现路由 ${bad}`);
    }
    // 路由组本身不是一段 URL
    assert.ok(!all.some((r) => r.includes('(')), `路由里不该残留括号: ${all.join(' ')}`);
  });
});

test('动态路由：[id] / [...slug] / [[...slug]] 转换正确且标记 dynamic', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const artifact = pageYaml(root, 'artifact-id');
    assert.strictEqual(artifact.route, '/artifact/:id');
    assert.strictEqual(artifact.dynamic, true);
    assert.deepStrictEqual(artifact.params, ['id']);
    assert.strictEqual(artifact.entry, 'app/artifact/[id]/page.tsx');

    assert.strictEqual(pageYaml(root, 'docs-slug').route, '/docs/:slug*');
    assert.strictEqual(pageYaml(root, 'blog-slug').route, '/blog/:slug?');

    // 静态页不应被误标成动态
    assert.strictEqual(pageYaml(root, 'chat').dynamic, false);
    assert.deepStrictEqual(pageYaml(root, 'chat').params, []);
  });
});

test('新页面初始状态：无标题、待分析、未经浏览器验证', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const p = pageYaml(root, 'membership');
    assert.strictEqual(p.id, 'membership');
    assert.strictEqual(p.route, '/membership');
    assert.strictEqual(p.title, null);
    assert.strictEqual(p.purpose, null);
    assert.deepStrictEqual(p.detectedActions, []);
    assert.deepStrictEqual(p.source, ['app/membership/page.tsx']);
    assert.strictEqual(p.includeInManual, true);
    assert.strictEqual(p.confidence, 'none');
    assert.strictEqual(p.status.sourceAnalysis, 'pending');
    assert.strictEqual(p.browser.verified, false);
    assert.strictEqual(p.browser.screenshot, null);
    assert.strictEqual(p.browser.lastCapture, null);
  });
});

test('inspect 递归扫描并稳定持久化页面依赖', () => {
  withFixture(fx.nextAppFixture, (root) => {
    fx.writeFile(root, 'app/chat/page.tsx', [
      "import ChatPanel from '../../components/chat/ChatPanel'",
      'export default ChatPanel',
    ].join('\n'));
    fx.writeFile(root, 'components/chat/ChatPanel.tsx', [
      "import Input from '../shared/Input'",
      'export default Input',
    ].join('\n'));
    fx.writeFile(root, 'components/shared/Input.tsx', 'export default function Input() {}\n');

    initProject(root);
    let r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);

    const first = pageYaml(root, 'chat').dependencies;
    // 祖先 layout / loading / error / not-found 是框架约定依赖（scope），与 import 依赖一起进入依赖集
    const scope = ['app/chat/error.tsx', 'app/chat/layout.tsx', 'app/chat/loading.tsx', 'app/layout.tsx', 'app/not-found.tsx'];
    assert.deepStrictEqual(first, {
      files: [...scope, 'components/chat/ChatPanel.tsx', 'components/shared/Input.tsx'].sort(),
      assets: [],
      scope,
      unresolved: [],
      completeness: 'complete',
    });
    assert.match(pageYaml(root, 'chat').analysis.sourceRevision, /^sha256:/);

    r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(pageYaml(root, 'chat').dependencies, first);
  });
});

test('inspect 写入稳定的 forward.json 与 reverse.json', () => {
  withFixture(fx.nextAppFixture, (root) => {
    fx.writeFile(root, 'app/chat/page.tsx', [
      "import Input from '../../components/shared/Input'",
      'export default Input',
    ].join('\n'));
    fx.writeFile(root, 'components/shared/Input.tsx', 'export default function Input() {}\n');
    initProject(root);

    let r = run('inspect', root, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const forwardPath = path.join(root, '.manual', 'index', 'forward.json');
    const reversePath = path.join(root, '.manual', 'index', 'reverse.json');

    assert.ok(fs.existsSync(forwardPath));
    assert.ok(fs.existsSync(reversePath));
    assert.ok(out.writtenFiles.includes(forwardPath));
    assert.ok(out.writtenFiles.includes(reversePath));

    const forward = readJson(forwardPath);
    const reverse = readJson(reversePath);
    assert.deepStrictEqual(forward['/chat'].entry, ['app/chat/page.tsx']);
    assert.deepStrictEqual(forward['/chat'].files, [
      'app/chat/error.tsx',
      'app/chat/layout.tsx',
      'app/chat/loading.tsx',
      'app/chat/page.tsx',
      'app/layout.tsx',
      'app/not-found.tsx',
      'components/shared/Input.tsx',
    ]);
    assert.deepStrictEqual(reverse['components/shared/Input.tsx'], ['/chat']);

    const firstForward = fs.readFileSync(forwardPath, 'utf8');
    const firstReverse = fs.readFileSync(reversePath, 'utf8');
    r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(fs.readFileSync(forwardPath, 'utf8'), firstForward);
    assert.strictEqual(fs.readFileSync(reversePath, 'utf8'), firstReverse);
  });
});

test('project.yaml 记录技术栈与统计', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const proj = projectYaml(root);
    assert.strictEqual(proj.project.framework, 'nextjs');
    assert.strictEqual(proj.project.frameworkVersion, '^15.0.3');
    assert.strictEqual(proj.project.router, 'app');
    assert.strictEqual(proj.project.appDir, 'app');
    assert.strictEqual(proj.summary.total, 12);
    assert.strictEqual(proj.summary.pending, 12);
    assert.strictEqual(proj.summary.analyzed, 0);
    assert.strictEqual(proj.summary.dynamic, 3);
    // 索引应指向每页详情
    const chat = proj.pages.find((p) => p.id === 'chat');
    assert.strictEqual(chat.detail, '.manual/pages/chat.yaml');
  });
});

// ---------------------------------------------------------------- Pages Router
test('Pages Router（src/ 下）：index/动态/catch-all 正确，_app 与 api 跳过', () => {
  withFixture(fx.nextPagesFixture, (root) => {
    initProject(root);
    const r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);

    assert.deepStrictEqual(routes(root), ['/', '/about', '/posts/:slug*', '/user', '/user/:id']);
    const proj = projectYaml(root);
    assert.strictEqual(proj.project.router, 'pages');
    assert.strictEqual(proj.project.pagesDir, 'src/pages');
    assert.strictEqual(pageYaml(root, 'home').route, '/');
  });
});

// ---------------------------------------------------------------- 排除
test('config.inspect.exclude 能把路由排除出手册', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    // 手工改 config，模拟用户编辑
    const cfgPath = path.join(root, '.manual', 'config.yaml');
    fs.writeFileSync(
      cfgPath,
      fs.readFileSync(cfgPath, 'utf8').replace('  exclude: []', "  exclude:\n    - '/admin/**'")
    );

    const r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);

    const all = routes(root);
    assert.ok(!all.includes('/admin'), '/admin 应被 /admin/** 排除');
    assert.ok(!all.includes('/admin/users'), '/admin/users 应被排除');
    assert.ok(all.includes('/chat'), '其它路由不该受影响');
    assert.ok(!fs.existsSync(path.join(root, '.manual', 'pages', 'admin.yaml')));
  });
});

// ---------------------------------------------------------------- 幂等与合并
test('重跑 inspect 不覆盖已有分析结果（核心约定）', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const d = run('describe', root, [
      '--id', 'membership',
      '--title', '会员计划',
      '--purpose', '查看和购买会员套餐。',
      '--actions', '查看套餐;购买 Pro;购买 Max',
    ]);
    assert.strictEqual(d.status, 0, d.stderr);

    // 再扫一次
    const r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);

    const p = pageYaml(root, 'membership');
    assert.strictEqual(p.title, '会员计划');
    assert.strictEqual(p.purpose, '查看和购买会员套餐。');
    assert.deepStrictEqual(p.detectedActions, ['查看套餐', '购买 Pro', '购买 Max']);
    assert.strictEqual(p.status.sourceAnalysis, 'completed');
    assert.strictEqual(p.confidence, 'inferred');
  });
});

test('重跑 inspect 幂等：页面数量与 id 都不变', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    const first = projectYaml(root).pages.map((p) => `${p.id}|${p.route}`);

    run('inspect', root);
    const second = projectYaml(root).pages.map((p) => `${p.id}|${p.route}`);
    assert.deepStrictEqual(second, first);
  });
});

test('入口文件改了扩展名：分析结果保留但标记为 stale', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    run('describe', root, ['--id', 'skills', '--title', '仙技库', '--purpose', '浏览技能。']);
    assert.strictEqual(pageYaml(root, 'skills').status.sourceAnalysis, 'completed');

    // 把 page.tsx 换成 page.jsx —— 同一路由，入口变了
    fs.renameSync(
      path.join(root, 'app', 'skills', 'page.tsx'),
      path.join(root, 'app', 'skills', 'page.jsx')
    );

    const r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);
    const p = pageYaml(root, 'skills');
    assert.strictEqual(p.entry, 'app/skills/page.jsx');
    assert.strictEqual(p.title, '仙技库', '分析结果不应丢失');
    assert.strictEqual(p.status.sourceAnalysis, 'stale', '入口变了应标记 stale');
    assert.match(r.stdout, /stale/);
  });
});

test('新增页面只新增，不动已有页面', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    run('describe', root, ['--id', 'chat', '--title', '工作台', '--purpose', '与助手对话。']);

    fx.writeFile(root, 'app/team/page.tsx');
    const r = run('inspect', root);
    assert.strictEqual(r.status, 0, r.stderr);

    assert.ok(routes(root).includes('/team'));
    assert.strictEqual(pageYaml(root, 'team').status.sourceAnalysis, 'pending');
    assert.strictEqual(pageYaml(root, 'chat').title, '工作台');
  });
});

test('代码里删掉的路由默认只报告不删，--prune 才清理', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    assert.ok(fs.existsSync(path.join(root, '.manual', 'pages', 'profile.yaml')));

    fs.rmSync(path.join(root, 'app', 'profile'), { recursive: true });

    const r1 = run('inspect', root);
    assert.strictEqual(r1.status, 0, r1.stderr);
    assert.match(r1.stdout, /找不到对应路由/);
    assert.match(r1.stdout, /--prune/);
    assert.ok(
      fs.existsSync(path.join(root, '.manual', 'pages', 'profile.yaml')),
      '未加 --prune 不应删除页面文件'
    );

    const r2 = run('inspect', root, ['--prune']);
    assert.strictEqual(r2.status, 0, r2.stderr);
    assert.ok(!fs.existsSync(path.join(root, '.manual', 'pages', 'profile.yaml')));
    assert.ok(!routes(root).includes('/profile'));
  });
});

test('路由消失：页面标为 missing 并保留定义，capture 拒绝；显式 retired 的页面 --prune 也不删除', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    assert.strictEqual(pageYaml(root, 'profile').lifecycle, 'active');
    let r = run('describe', root, ['--id', 'profile', '--title', '个人中心', '--purpose', '管理资料。']);
    assert.strictEqual(r.status, 0, r.stderr);

    fs.rmSync(path.join(root, 'app', 'profile'), { recursive: true });
    r = run('inspect', root, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout).missing.find((p) => p.id === 'profile').lifecycle, 'missing');
    assert.strictEqual(pageYaml(root, 'profile').lifecycle, 'missing');
    assert.strictEqual(pageYaml(root, 'profile').title, '个人中心', '分析结果保留');
    r = run('capture', root, ['profile']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /page-not-active/);

    r = run('describe', root, ['--id', 'profile', '--lifecycle', 'retired']);
    assert.strictEqual(r.status, 0, r.stderr);
    r = run('describe', root, ['--id', 'profile', '--lifecycle', 'missing']);
    assert.strictEqual(r.status, 1, 'missing 由 inspect 维护，不能手工设置');
    r = run('inspect', root, ['--prune']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(pageYaml(root, 'profile').lifecycle, 'retired', 'retire 与 prune 分离');
  });
});

// ---------------------------------------------------------------- 错误路径
test('未 init 就 inspect：提示先跑 init', () => {
  withFixture(fx.nextAppFixture, (root) => {
    const r = run('inspect', root);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /找不到配置/);
    assert.match(r.stderr, /manual init/);
  });
});

test('非 Next.js 项目：给出准确的「暂不支持」提示', () => {
  withFixture(fx.vueFixture, (root) => {
    initProject(root);
    const r = run('inspect', root);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /只支持 Next\.js/);
    assert.match(r.stderr, /Vue Router/, '应报出实际检测到的框架');
  });
});

test('是 Next.js 但没有路由目录：提示可能指错了根目录', () => {
  withFixture(fx.nextNoRoutesFixture, (root) => {
    initProject(root);
    const r = run('inspect', root);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /既没有 app\/ 也没有 pages\//);
  });
});

test('没有 package.json：明确说明 inspect 需要它', () => {
  const root = fx.makeTempDir();
  try {
    initProject(root);
    const r = run('inspect', root);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /package\.json/);
  } finally {
    fx.cleanup(root);
  }
});

test('--json 输出含工作清单', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    const r = run('inspect', root, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);

    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.framework, 'nextjs');
    assert.strictEqual(out.counts.total, 12);
    assert.strictEqual(out.counts.added, 12);
    assert.strictEqual(out.worklist.length, 12);

    const item = out.worklist.find((w) => w.id === 'membership');
    assert.deepStrictEqual(item.read, ['app/membership/page.tsx']);
    assert.deepStrictEqual(item.needs, ['title', 'purpose', 'detectedActions']);
    assert.strictEqual(item.reason, 'pending');
    // 被跳过的文件也报出来，方便核对扫描是否漏了东西
    assert.ok(out.skipped.some((s) => s.reason === 'parallel-slot'));
  });
});

test('无法解析的本地依赖只产生 warning，不中断其它页面扫描', () => {
  withFixture(fx.nextAppFixture, (root) => {
    fx.writeFile(root, 'app/chat/page.tsx', [
      "import Missing from '../../components/chat/Missing'",
      'export default Missing',
    ].join('\n'));
    initProject(root);

    const r = run('inspect', root, ['--json']);
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);

    assert.ok(out.warnings.some((warning) => warning.includes('/chat')));
    assert.ok(out.warnings.some((warning) => warning.includes('Missing')));
    assert.ok(out.pages.some((page) => page.route === '/membership'));
    assert.deepStrictEqual(pageYaml(root, 'chat').dependencies.unresolved, [
      'app/chat/page.tsx: ../../components/chat/Missing',
    ]);
  });
});

// ---------------------------------------------------------------- describe
process.stdout.write('\nmanual describe\n');

test('--input 批量写回并重建索引', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const inputPath = path.join(root, 'describe.json');
    fs.writeFileSync(
      inputPath,
      JSON.stringify({
        pages: [
          {
            id: 'chat',
            title: '工作台',
            purpose: '用户与 AI 助手对话、管理会话的主入口。',
            detectedActions: ['发送消息', '新建会话', '切换模型'],
          },
          {
            id: 'membership',
            title: '会员计划',
            purpose: '查看和购买会员套餐。',
            detectedActions: ['查看套餐', '购买 Pro'],
            source: ['app/membership/page.tsx', 'components/membership/**'],
          },
        ],
      }, null, 2),
      'utf8'
    );

    const r = run('describe', root, ['--input', inputPath]);
    assert.strictEqual(r.status, 0, r.stderr);

    const chat = pageYaml(root, 'chat');
    assert.strictEqual(chat.title, '工作台');
    assert.strictEqual(chat.purpose, '用户与 AI 助手对话、管理会话的主入口。');
    assert.deepStrictEqual(chat.detectedActions, ['发送消息', '新建会话', '切换模型']);
    assert.strictEqual(chat.confidence, 'inferred');
    assert.strictEqual(chat.status.sourceAnalysis, 'completed');

    const m = pageYaml(root, 'membership');
    assert.deepStrictEqual(m.source, ['app/membership/page.tsx', 'components/membership/**']);

    const proj = projectYaml(root);
    assert.strictEqual(proj.summary.analyzed, 2);
    assert.strictEqual(proj.summary.pending, 10);
    assert.strictEqual(proj.pages.find((p) => p.id === 'chat').title, '工作台');
  });
});

test('describe 不动扫描字段，且入口文件不会被 source 挤掉', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const r = run('describe', root, [
      '--id', 'artifact-id',
      '--title', '作品详情',
      '--purpose', '查看单个作品。',
      '--source', 'components/artifact/**',
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const p = pageYaml(root, 'artifact-id');
    assert.strictEqual(p.route, '/artifact/:id', 'route 是扫描字段，不该被改');
    assert.strictEqual(p.entry, 'app/artifact/[id]/page.tsx');
    assert.ok(p.source.includes('app/artifact/[id]/page.tsx'), '入口必须留在 source 里');
    assert.ok(p.source.includes('components/artifact/**'));
  });
});

test('只给 title 不给 purpose：不算分析完成', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const r = run('describe', root, ['--id', 'skills', '--title', '仙技库']);
    assert.strictEqual(r.status, 0, r.stderr);

    const p = pageYaml(root, 'skills');
    assert.strictEqual(p.title, '仙技库');
    assert.strictEqual(p.status.sourceAnalysis, 'pending');
    assert.strictEqual(p.confidence, 'none');
  });
});

test('--include-in-manual false 把页面移出手册范围', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    run('describe', root, ['--id', 'admin', '--include-in-manual', 'false']);
    assert.strictEqual(pageYaml(root, 'admin').includeInManual, false);

    // 移出后不再出现在待分析清单里
    const r = run('inspect', root, ['--json']);
    const out = JSON.parse(r.stdout);
    assert.ok(!out.worklist.some((w) => w.id === 'admin'));
  });
});

test('未知 id 报错并列出可用 id，且不写入任何东西', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    const before = fs.readFileSync(path.join(root, '.manual', 'pages', 'chat.yaml'), 'utf8');

    const r = run('describe', root, ['--id', 'nope', '--title', 'X', '--purpose', 'Y']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /不存在/);
    assert.match(r.stderr, /membership/, '应列出可用 id');
    assert.strictEqual(fs.readFileSync(path.join(root, '.manual', 'pages', 'chat.yaml'), 'utf8'), before);
  });
});

test('一条不合法就整批不写（全或全无）', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const inputPath = path.join(root, 'bad.json');
    fs.writeFileSync(inputPath, JSON.stringify({
      pages: [
        { id: 'chat', title: '工作台', purpose: '正常的一条。' },
        { id: 'skills', title: 123 },
      ],
    }), 'utf8');

    const r = run('describe', root, ['--input', inputPath]);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /title 需要是非空字符串/);
    assert.strictEqual(pageYaml(root, 'chat').title, null, '合法的那条也不该被写入');
  });
});

test('没跑过 inspect 就 describe：提示先扫描', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    const r = run('describe', root, ['--id', 'chat', '--title', 'X']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /manual inspect/);
  });
});

test('--input 与 --id 不能混用', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    const r = run('describe', root, ['--input', 'x.json', '--id', 'chat']);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /只能用其中一种/);
  });
});

test('中文长文本经 YAML 往返不失真', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);

    const purpose =
      '用户在此查看和管理个人资料、修改头像与昵称，并查看账户的使用统计信息，' +
      '包括累计对话次数、本月剩余额度以及会员到期时间等关键数据。';
    const r = run('describe', root, [
      '--id', 'profile', '--title', '用户中心', '--purpose', purpose,
      '--actions', '编辑个人资料;修改头像;查看统计',
    ]);
    assert.strictEqual(r.status, 0, r.stderr);

    const p = pageYaml(root, 'profile');
    assert.strictEqual(p.purpose, purpose, '长中文段落往返后应完全一致');
    assert.deepStrictEqual(p.detectedActions, ['编辑个人资料', '修改头像', '查看统计']);
  });
});

test('含冒号和 # 的标题不会破坏 YAML', () => {
  withFixture(fx.nextAppFixture, (root) => {
    initProject(root);
    run('inspect', root);
    const tricky = 'Pricing: Pro #1 plan';
    const r = run('describe', root, ['--id', 'pricing', '--title', tricky, '--purpose', '定价页。']);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(pageYaml(root, 'pricing').title, tricky);
  });
});

// ---------------------------------------------------------------- 汇总
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
