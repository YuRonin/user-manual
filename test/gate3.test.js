'use strict';

/*
 * Gate 3 集成验收（Phase 3 最终场景）：真实浏览器 + CLI 子进程，同一个 Git 管理的项目。
 *   1  新项目首次 generate：完整 Run、可信 Capture、有效 Markdown
 *   2  无变化再次 generate：命中缓存，保留 observedAt，零新截图
 *   3  只改文档语言：不重新截图；改界面语言（locale）：重新采集
 *   4  改共享组件：update 只更新关联的页面 / 任务手册，未关联文档 bytes / mtime 不变
 *   5  改全局配置：保守扩大并给出理由
 *   6  Git 无 diff、权限改变：verify --live 失败（不能靠缓存通过），update 无源码影响
 *   7  改人工说明后 update：保留；同一块两边都改：明确冲突，采用提案后 resume 完成
 *   8  进程在 Capture 提交后被杀：resume 不重做已提交证据
 *   9  Fixture 模拟的错误态：声明 error 的 Scenario 通过并标 simulated；未声明时不被当作正常成功
 *   10 public 发布：正式文档不含原图 / 诊断 / 认证值 / 手机号，图片 hash 与隐私链完整
 *   11 删除未引用的过期 staging：dry-run 可审阅，apply 只删清单内对象
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const releases = require('../src/publication/release-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

async function expectExit(root, args, exit, env) {
  const r = await cli(root, args, env);
  assert.strictEqual(r.status, exit, `manual ${args.join(' ')} 应以 ${exit} 退出\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };
const writeYaml = (file, v) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, yaml.dump(v)); };
const snapshot = (file) => ({ bytes: fs.readFileSync(file, 'utf8'), mtime: fs.statSync(file).mtimeMs });

(async () => {
  process.stdout.write('\nGate 3\n');
  if (!fx.hasGit()) { process.stdout.write('  - 跳过：没有 git\n\n0 passed, 0 failed\n'); return; }
  const server = await startServer();
  const root = fx.captureFixture();
  const env = { MANUAL_AUTH_CACHE_DIR: path.join(root, '.auth-cache') };
  const state = path.join(root, '.manual');
  const docs = path.join(root, 'docs', 'manual');
  const doc = (rel) => path.join(docs, rel);
  const configFile = path.join(state, 'config.yaml');
  const editConfig = (fn) => { const c = yaml.load(fs.readFileSync(configFile, 'utf8')); fn(c); fs.writeFileSync(configFile, yaml.dump(c)); };
  const captures = () => fs.readdirSync(path.join(state, 'evidence', 'captures')).length;
  const describe = (pages) => expectExit(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages })], 0, env);
  const PAGES = {
    chat: { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' },
    home: { id: 'home', title: '首页', purpose: '产品入口。' },
    'task-profile': { id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' },
  };
  try {
    await step('准备：共享组件被 chat 与个人中心使用，首页独立；任务已批准；Git 基线', async () => {
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return null }\n');
      fx.writeFile(root, 'components/Home.tsx', 'export default function Home() { return null }\n');
      fx.writeFile(root, 'app/page.tsx', "import Home from '../components/Home'\nexport default function Page() { return <Home /> }\n");
      fx.writeFile(root, 'app/chat/page.tsx', "import Shared from '../../components/Shared'\nexport default function Page() { return <Shared /> }\n");
      fx.writeFile(root, 'app/task-profile/page.tsx', "import Shared from '../../components/Shared'\nexport default function Page() { return <Shared /> }\n");
      fx.writeFile(root, 'app/dashboard/page.tsx');
      await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
      await expectExit(root, ['inspect'], 0, env);
      await describe(Object.values(PAGES));
      const file = path.join(state, 'pages', 'task-profile.yaml');
      const page = yaml.load(fs.readFileSync(file, 'utf8'));
      page.states = {
        default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
        editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
      };
      fs.writeFileSync(file, yaml.dump(page));
      await expectExit(root, ['discover-tasks', 'task-profile', '--input', writeJson(path.join(root, 'tasks.json'), { tasks: [{
        id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'task-profile', preconditions: ['已登录'], risk: 'read',
        steps: [
          { id: 'open-editor', instruction: '点击「编辑资料」', page: 'task-profile', stateBefore: 'default', stateAfter: 'editor',
            action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after' } },
          { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
        ],
        completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
        branches: [], relatedTasks: [],
      }] })], 0, env);
      await expectExit(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })], 0, env);
      fx.gitInit(root);
    });

    let observed;
    await step('1 新项目首次 generate：完整 Run、可信 Capture、有效 Markdown', async () => {
      for (const target of ['page:chat', 'page:home', 'task:edit-profile']) {
        const out = await expectExit(root, ['generate', target, '--copy-default'], 0, env);
        assert.strictEqual(out.status, 'succeeded');
      }
      const task = fs.readFileSync(doc('tasks/edit-profile.md'), 'utf8');
      assert.match(task, /<!-- manual:block id=step.open-editor -->/);
      assert.match(task, /完成标志：编辑资料面板已打开。/);
      await expectExit(root, ['verify', '--all'], 0, env);
      const record = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'captures', `${releases.readCurrentRelease(state, 'page-chat').captureIds[0]}.json`), 'utf8'));
      assert.ok(record.validations.every((v) => v.outcome === 'passed') && record.privacy.status === 'passed' && record.provenance.mode === 'live');
    });

    await step('2 无变化再次 generate：命中缓存、保留 observedAt、零新截图', async () => {
      const before = captures();
      const out = await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      assert.strictEqual(out.cache[0].reason, 'cache-hit');
      observed = out.cache[0].observedAt;
      assert.ok(Date.parse(observed) < Date.now());
      assert.strictEqual(captures(), before);
    });

    await step('3 只改文档语言不截图；改界面语言（locale）重新采集', async () => {
      editConfig((c) => { c.docs.language = 'en-US'; });
      const lang = await expectExit(root, ['generate', 'page:home', '--copy-default', '--plan'], 0, env);
      assert.strictEqual(lang.tasks.find((t) => t.kind === 'capture').reason, 'cache-hit');
      editConfig((c) => { c.docs.language = 'zh-CN'; c.capture.profiles[c.capture.activeProfile].locale = 'en-US'; });
      const locale = await expectExit(root, ['generate', 'page:home', '--copy-default', '--plan'], 0, env);
      assert.match(locale.tasks.find((t) => t.kind === 'capture').reason, /capture-required:input-changed\(.*locale/);
      editConfig((c) => { delete c.capture.profiles[c.capture.activeProfile].locale; });
    });

    let home;
    await step('4 改共享组件：update 只更新 chat 与任务手册，首页 bytes / mtime 不变', async () => {
      home = snapshot(doc('home.md'));
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return <nav>导航</nav> }\n');
      fx.gitCommit(root, 'shared v2');
      const plan = await expectExit(root, ['update', '--plan'], 0, env);
      assert.deepStrictEqual(plan.targets.map((t) => t.target), ['page:chat', 'task:edit-profile']);
      assert.deepStrictEqual(plan.targets.find((t) => t.target === 'task:edit-profile').reasonPaths[0], ['components/Shared.tsx', 'task-profile', 'edit-profile-default', 'task-edit-profile']);
      // 源码变化后页面语义分析需要复核：刷新指纹、复核后执行
      await expectExit(root, ['inspect'], 0, env);
      await describe([PAGES.chat, PAGES['task-profile']]);
      const out = await expectExit(root, ['update', '--copy-default'], 0, env);
      assert.deepStrictEqual(out.targets.map((t) => [t.target, t.result]), [['page:chat', 'updated'], ['task:edit-profile', 'updated']]);
      assert.deepStrictEqual(snapshot(doc('home.md')), home);
    });

    await step('5 改全局配置：保守扩大到全部已发布手册并给出理由', async () => {
      fx.writePackageJson(root, { next: '^15.1.0' });
      const plan = await expectExit(root, ['update', '--plan'], 0, env);
      assert.strictEqual(plan.confidence, 'conservative');
      assert.deepStrictEqual(plan.targets.map((t) => t.target), ['page:chat', 'page:home', 'task:edit-profile']);
      assert.ok(plan.baselines.some((b) => b.broadImpact.includes('global-changed:package.json')));
      fx.git(root, ['checkout', '--', 'package.json']);
    });

    await step('6 Git 无 diff、权限改变：verify --live 失败；update 没有源码影响；离线产物验证仍通过', async () => {
      assert.strictEqual(fx.git(root, ['status', '--porcelain', '--', 'app', 'components', 'package.json']), '');
      server.set({ canEdit: false });
      const live = await expectExit(root, ['verify', 'task:edit-profile', '--live'], 4, env);
      assert.strictEqual(live.reports[0].result, 'failed');
      assert.ok(live.reports[0].failures.some((f) => f.stepId === 'open-editor'));
      assert.deepStrictEqual((await expectExit(root, ['update', '--plan'], 0, env)).targets, []);
      await expectExit(root, ['verify', 'task:edit-profile'], 0, env);
      server.reset();
    });

    await step('7 人工说明在 update 中保留；同一块两边都改 → 冲突与提案，采用后 resume 完成', async () => {
      fs.appendFileSync(doc('chat.md'), '\n> 团队说明：工作台只对成员开放。\n');
      fx.writeFile(root, 'components/Shared.tsx', 'export default function Shared() { return <nav>导航 v3</nav> }\n');
      fx.gitCommit(root, 'shared v3');
      await expectExit(root, ['inspect'], 0, env);
      await describe([PAGES.chat, PAGES['task-profile']]);
      await expectExit(root, ['update', '--copy-default'], 0, env);
      assert.match(fs.readFileSync(doc('chat.md'), 'utf8'), /团队说明：工作台只对成员开放。/);

      // 人改简介块；生成器也改简介（页面用途变了）
      fs.writeFileSync(doc('chat.md'), fs.readFileSync(doc('chat.md'), 'utf8').replace('与 AI 助手对话。', '在这里和助手聊天（团队版）。'));
      await describe([{ ...PAGES.chat, purpose: '与 AI 助手多轮对话。' }]);
      const conflict = await cli(root, ['generate', 'page:chat', '--copy-default'], env);
      assert.strictEqual(conflict.status, 4, '人工修改冲突属于冲突类（C08），Run 停在 waiting_input');
      assert.strictEqual(conflict.json.status, 'waiting_input');
      const waiting = conflict.json.waiting.find((w) => w.code === 'merge-conflict');
      assert.ok(waiting, conflict.stdout);
      assert.match(fs.readFileSync(doc('chat.md'), 'utf8'), /在这里和助手聊天（团队版）。/, '冲突时正式文档不变');
      const proposed = path.join(state, 'runs', conflict.json.runId, 'merge', 'page-chat', 'proposed.md');
      assert.match(fs.readFileSync(proposed, 'utf8'), /与 AI 助手多轮对话。/);
      assert.match(fs.readFileSync(proposed, 'utf8'), /团队说明/);
      fs.copyFileSync(proposed, doc('chat.md'));
      await expectExit(root, ['resume', conflict.json.runId], 0, env);
      const text = fs.readFileSync(doc('chat.md'), 'utf8');
      assert.match(text, /与 AI 助手多轮对话。/);
      assert.match(text, /团队说明：工作台只对成员开放。/);
    });

    await step('8 Capture 提交后进程被杀：resume 补记采集，不重做已提交证据', async () => {
      const killed = await cli(root, ['generate', 'page:home', '--copy-default', '--refresh'], { ...env, MANUAL_TEST_FAULTS: '1', MANUAL_TEST_FAULT: 'capture-committed' });
      assert.strictEqual(killed.status, 137, killed.stderr);
      const runId = (await expectExit(root, ['status'], 0, env)).runs.slice(-1)[0].id;
      const before = captures();
      const resumed = await expectExit(root, ['resume', runId], 0, env);
      assert.strictEqual(resumed.status, 'succeeded');
      assert.strictEqual(captures(), before, '没有重新采集');
    });

    await step('9 Fixture 模拟错误态：声明 error 时通过并标 simulated；未声明时不被当作正常成功', async () => {
      editConfig((c) => { c.fixtures = { environments: { local: { origins: ['http://127.0.0.1:*'] } } }; });
      writeYaml(path.join(state, 'fixtures', 'dashboard-error.yaml'), {
        schemaVersion: 1, id: 'dashboard-error', version: 1, kind: 'mock', environments: ['local'], dataset: 'demo/error', sideEffectClass: 'none',
        mock: { routes: [{ path: '/dashboard', contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h1>数据看板</h1><div role="alert">加载失败，请稍后重试</div></body></html>' }] },
      });
      const scenario = (id, state) => writeYaml(path.join(root, '.manual', 'scenarios', `${id}.yaml`), {
        schemaVersion: 1, id, userTaskId: null, environment: 'local', authProfile: 'anonymous',
        entry: { pageId: 'dashboard', routeBindingId: 'main', params: {} }, data: { mode: 'fixture', fixture: 'dashboard-error' },
        expected: { httpStatuses: [200], redirects: [], state }, setup: [],
        checkpoints: [{ id: 'default', afterStepId: null, pageId: 'dashboard', assertions: [{ id: 'error-alert', type: 'visible', target: { text: '加载失败，请稍后重试' } }], capture: { mode: 'viewport', annotations: [] } }],
      });
      scenario('dashboard-error', 'error');
      scenario('dashboard-error-as-normal', 'normal');
      await expectExit(root, ['capture', 'scenario:dashboard-error'], 0, env);
      const latest = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'latest.json'), 'utf8')).refs;
      const record = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'captures', `${latest['scenario:dashboard-error']}.json`), 'utf8'));
      assert.strictEqual(record.provenance.mode, 'simulated');
      const wrong = await cli(root, ['capture', 'scenario:dashboard-error-as-normal'], env);
      assert.notStrictEqual(wrong.status, 0);
      assert.match(wrong.stdout, /unexpected-page-state/);
    });

    await step('10 public 发布：文档不含原图 / 诊断 / 认证值 / 手机号，图片 hash 与隐私链完整', async () => {
      const cfg = yaml.load(fs.readFileSync(configFile, 'utf8'));
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } };
      walk(docs);
      const markdown = files.filter((f) => f.endsWith('.md')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
      assert.doesNotMatch(markdown, /\.manual\/|artifacts\/raw|sanitized|diagnostics|cookie|13812345678/);
      assert.ok(files.every((f) => f.endsWith('.md') || f.includes(`${path.sep}images${path.sep}annotated${path.sep}`)), '文档目录只有正式文档与发布图');
      for (const manualId of ['page-chat', 'page-home', 'task-edit-profile']) {
        const release = releases.readCurrentRelease(state, manualId);
        for (const image of release.facts.images || []) assert.strictEqual(image.privacy.status, 'passed');
      }
      assert.strictEqual(cfg.privacy.audience, 'public');
      await expectExit(root, ['verify', '--all'], 0, env);
    });

    await step('11 删除未引用的过期 staging：dry-run 可审阅，apply 只删清单内对象', async () => {
      const orphan = path.join(state, 'evidence', 'staging', 'orphan-capture');
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(path.join(orphan, 'raw.png'), 'x');
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
      fs.utimesSync(orphan, old, old);
      const plan = await expectExit(root, ['gc'], 0, env);
      assert.deepStrictEqual(plan.items.map((i) => [i.kind, i.path]), [['staging', '.manual/evidence/staging/orphan-capture']]);
      assert.ok(fs.existsSync(orphan), 'dry-run 不删除');
      const applied = await expectExit(root, ['gc', '--apply', '--expect', plan.planHash], 0, env);
      assert.deepStrictEqual(applied.removed.map((i) => i.path), ['.manual/evidence/staging/orphan-capture']);
      assert.ok(!fs.existsSync(orphan));
      await expectExit(root, ['verify', '--all'], 0, env);
    });
  } catch (_) {
    // 已记录
  } finally {
    await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
