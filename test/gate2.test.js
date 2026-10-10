'use strict';

/*
 * Gate 2 集成验收（Phase 2）：真实浏览器 + CLI 子进程。
 *   1 generate 首次自动完成依赖；第二次命中缓存不新截图，报告命中原因与旧 observedAt
 *   2 改模板（语言）只重建文档；改 DPR 重新采集；改隐私规则在 raw 存在时只重新派生
 *   3 同一 Run 的 3 个 Scenario：1 次 Browser 启动、3 个 Context、全部关闭
 *   4 Capture 完成后被杀，新进程 resume 从草稿继续
 *   5 错 inputHash 的模型响应被拒，正确响应由另一个进程提交
 *   6 status 解释失败与未完成任务；Run 目录与缓存中没有认证值
 *   7 没有写操作授权：流程停在写动作之前，文档不向读者暴露验证范围
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const cache = require('../src/auth/cache');
const { planTargets, openProject } = require('../src/runtime/app');
const { runRun } = require('../src/runtime/runner');
const { HANDLERS } = require('../src/runtime/handlers');
const { createBrowserSession } = require('../src/browser/session');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args, env = {}) {
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
const count = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).length : 0);

(async () => {
  process.stdout.write('\nGate 2\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const cacheRoot = path.join(root, '.auth-cache');
  const env = { MANUAL_AUTH_CACHE_DIR: cacheRoot };
  const state = path.join(root, '.manual');
  const captures = () => count(path.join(state, 'evidence', 'captures'));
  const configFile = path.join(state, 'config.yaml');
  const editConfig = (fn) => { const c = yaml.load(fs.readFileSync(configFile, 'utf8')); fn(c); fs.writeFileSync(configFile, yaml.dump(c)); };
  try {
    await step('准备：扫描、描述页面、任务候选与审批；认证缓存含 Cookie 秘密值', async () => {
      fx.writeFile(root, 'app/task-profile/page.tsx');
      await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
      fx.useDemoValues(root);
      await expectExit(root, ['inspect'], 0, env);
      await expectExit(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [
        { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' },
        { id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' },
        { id: 'protected', title: '受保护页面', purpose: '登录后可见的内容。' },
        { id: 'missing-route', title: '已下线页面', purpose: '用于验证失败解释。' },
      ] })], 0, env);
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
            action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
          { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
        ],
        completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
        branches: [], relatedTasks: [],
      }] })], 0, env);
      await expectExit(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })], 0, env);
      const cfg = yaml.load(fs.readFileSync(configFile, 'utf8'));
      cache.writeState({ root: cacheRoot, cacheKey: cfg.auth.cacheKey, profile: cfg.auth.activeProfile }, {
        origin: new URL(server.baseUrl).origin,
        storageState: { cookies: [{ name: 'manual_sid', value: 'cookie-secret', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
      });
    });

    let firstObserved;
    await step('1 首次 generate 自动完成依赖；第二次命中缓存不新截图，报告原因与旧 observedAt', async () => {
      const first = await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      assert.deepStrictEqual(first.succeeded, ['capture', 'draft', 'validate', 'publish']);
      assert.ok(fs.existsSync(path.join(root, 'docs', 'manual', 'chat.md')));
      const records = captures();
      const second = await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      assert.strictEqual(captures(), records, '没有新截图');
      assert.strictEqual(second.cache[0].hit, true);
      assert.strictEqual(second.cache[0].reason, 'cache-hit');
      firstObserved = second.cache[0].observedAt;
      assert.ok(firstObserved && Date.parse(firstObserved) < Date.now());
    });

    await step('2 改语言模板只重建文档；改 DPR 重新采集；改隐私规则只从原图重新派生', async () => {
      editConfig((c) => { c.docs.language = 'en-US'; });
      const template = await expectExit(root, ['generate', 'page:chat', '--copy-default', '--plan'], 0, env);
      assert.strictEqual(template.tasks[0].reason, 'cache-hit', '模板变化不重新截图');
      const before = captures();
      await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      assert.strictEqual(captures(), before);
      editConfig((c) => { c.docs.language = 'zh-CN'; });

      editConfig((c) => { c.capture.profiles[c.capture.activeProfile].deviceScaleFactor = 1; });
      const dpr = await expectExit(root, ['generate', 'page:chat', '--copy-default', '--plan'], 0, env);
      assert.match(dpr.tasks[0].reason, /^capture-required:input-changed\(dpr\)/);
      await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      assert.strictEqual(captures(), before + 1, 'DPR 变化重新采集');

      editConfig((c) => { c.privacy.maskStyle = 'soft-solid'; });
      const privacy = await expectExit(root, ['generate', 'page:chat', '--copy-default', '--plan'], 0, env);
      assert.deepStrictEqual(privacy.tasks.slice(0, 2).map((t) => [t.id, t.reason]), [['capture', 'cache-hit'], ['derive-image', 'image-inputs-changed→derive-required']]);
      assert.strictEqual(privacy.summary.browserScenarios, 0, '重新派生不需要浏览器');
      await expectExit(root, ['generate', 'page:chat', '--copy-default'], 0, env);
      assert.strictEqual(captures(), before + 2, '只多一条重新派生记录');
    });

    await step('3 同一 Run 的 3 个 Scenario：1 次 Browser 启动、3 个 Context、3 次关闭，会话结束后全部释放', async () => {
      const project = openProject(root);
      const planned = planTargets({ projectRoot: root, project, command: 'capture', targets: ['page:chat', 'page:task-profile', 'task:edit-profile'], flags: { refresh: true } });
      assert.deepStrictEqual(planned.errors, []);
      const { run } = project.runStore.create({ command: 'capture', plan: planned.plan });
      let session;
      const previous = process.env.MANUAL_AUTH_CACHE_DIR;
      process.env.MANUAL_AUTH_CACHE_DIR = cacheRoot;
      try {
        const summary = await runRun({
          runStore: project.runStore, runId: run.id, handlers: HANDLERS,
          context: { projectRoot: root, config: project.config, stateDirAbs: project.stateDirAbs, mode: planned.mode, cacheStore: project.cacheStore },
          sessionFactory: () => { session = createBrowserSession(); return session; },
        });
        assert.strictEqual(summary.status, 'succeeded', JSON.stringify(summary));
      } finally {
        if (previous === undefined) delete process.env.MANUAL_AUTH_CACHE_DIR; else process.env.MANUAL_AUTH_CACHE_DIR = previous;
      }
      const stats = session.stats();
      assert.deepStrictEqual([stats.launches, stats.contexts, stats.contextCloses, stats.browserCloses, stats.browsers], [1, 3, 3, 1, 0]);
    });

    await step('4 Capture 完成后进程被杀；新进程 resume 补记采集并从草稿继续', async () => {
      const killed = await cli(root, ['generate', 'task:edit-profile', '--copy-default', '--refresh'], { ...env, MANUAL_TEST_FAULTS: '1', MANUAL_TEST_FAULT: 'capture-committed' });
      assert.strictEqual(killed.status, 137, killed.stderr);
      const runs = (await expectExit(root, ['status'], 0, env)).runs;
      const runId = runs[0].id;
      const before = captures();
      const resumed = await expectExit(root, ['resume', runId], 0, env);
      assert.strictEqual(resumed.status, 'succeeded');
      assert.strictEqual(captures(), before, '没有重新采集');
      const status = await expectExit(root, ['status', runId], 0, env);
      assert.deepStrictEqual(status.recovery.map((r) => [r.taskId, r.result]), [['capture', 'reconciled']]);
      assert.deepStrictEqual(status.tasks.map((t) => t.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    });

    await step('5 错 inputHash 的响应被拒；正确响应由另一个进程提交后完成', async () => {
      const waiting = await expectExit(root, ['generate', 'task:edit-profile'], 3, env);
      const modelDir = path.join(state, 'runs', waiting.runId, 'model');
      const request = JSON.parse(fs.readFileSync(path.join(modelDir, fs.readdirSync(modelDir)[0]), 'utf8'));
      const file = path.join(root, 'response.json');
      writeJson(file, { requestId: request.requestId, inputHash: 'sha256:stale', output: { copy: { intro: '先确认手机号，再打开编辑面板。' } } });
      const rejected = await expectExit(root, ['run-submit', waiting.runId, '--request', request.requestId, '--input', file], 1, env);
      assert.strictEqual(rejected.code, 'invalid-model-response');
      writeJson(file, { requestId: request.requestId, inputHash: request.inputHash, output: { copy: { intro: '先确认手机号，再打开编辑面板。' } } });
      await expectExit(root, ['run-submit', waiting.runId, '--request', request.requestId, '--input', file], 0, env);
      await expectExit(root, ['resume', waiting.runId], 0, env);
      assert.match(fs.readFileSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md'), 'utf8'), /先确认手机号，再打开编辑面板。/);
    });

    await step('6 status 解释失败与未完成任务；Run 目录与缓存索引不含认证值', async () => {
      await expectExit(root, ['generate', 'page:protected', '--copy-default'], 0, env);
      const failed = await expectExit(root, ['generate', 'page:missing-route', '--copy-default'], 1, env);
      const status = await expectExit(root, ['status', failed.runId], 0, env);
      const capture = status.tasks.find((t) => t.id === 'capture');
      assert.strictEqual(capture.status, 'failed');
      assert.strictEqual(capture.error.code, 'http-not-found');
      assert.ok(capture.error.message);
      assert.deepStrictEqual(status.tasks.filter((t) => t.status === 'pending').map((t) => t.id), ['draft', 'validate', 'publish']);
      const scan = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name);
          if (fs.statSync(file).isDirectory()) scan(file);
          else assert.ok(!fs.readFileSync(file, 'utf8').includes('cookie-secret'), `${file} 含认证值`);
        }
      };
      scan(path.join(state, 'runs'));
      scan(path.join(state, 'cache'));
    });

    await step('7 没有写操作授权：停在写动作之前，文档不向读者暴露验证范围', async () => {
      const task = yaml.load(fs.readFileSync(path.join(state, 'tasks', 'edit-profile.yaml'), 'utf8'));
      const manifest = JSON.parse(fs.readFileSync(path.join(root, task.evidenceManifest), 'utf8'));
      assert.deepStrictEqual(manifest.steps.map((s) => [s.id, s.status]), [['open-editor', 'verified'], ['save', 'not-executed']]);
      const doc = fs.readFileSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md'), 'utf8');
      assert.doesNotMatch(doc, /此操作未执行|验证范围/);
      assert.ok(!/已保存|保存成功/.test(doc), '不声称写操作已完成');
    });
  } catch (_) {
    // 失败已记录；后续步骤依赖前面的状态，不再继续
  } finally {
    await server.close();
    fx.cleanup(root);
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
