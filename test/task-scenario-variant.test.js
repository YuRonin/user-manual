'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-task-variant-'));
  const previousAuthDir = process.env.MANUAL_AUTH_CACHE_DIR;
  process.env.MANUAL_AUTH_CACHE_DIR = path.join(root, 'auth-cache');
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally {
    if (previousAuthDir === undefined) delete process.env.MANUAL_AUTH_CACHE_DIR; else process.env.MANUAL_AUTH_CACHE_DIR = previousAuthDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class FakeProvider {
  constructor() { this.calls = []; }
  async open(url) { this.calls.push(['open', url]); return { status: 200, finalUrl: url }; }
  async waitUntilReady() { return { steps: {}, warnings: [] }; }
  async performAction(action) { this.calls.push(['action', action.type]); return { target: action.target, rect: { x: 10, y: 10, width: 20, height: 20 } }; }
  async assertCondition() { return { ok: true }; }
  async screenshot({ path: file }) { fs.mkdirSync(path.dirname(file), { recursive: true }); await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toFile(file); return { path: file, bytes: fs.statSync(file).size, meta: { viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 } }; }
  async collectSensitiveElements() { return []; }
  async close() {}
}

/** BrowserSession 替身：记录每个 Scenario 使用的认证档案。 */
function fakeSession(provider) {
  const scenarios = [];
  return { scenarios, withScenario: async (spec, fn) => { scenarios.push(spec); return { value: await fn(provider), warnings: [] }; } };
}

function seed(root) {
  const result = spawnSync(process.execPath, [CLI, 'init', '--project-root', root, '--base-url', 'http://localhost:1'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const stateDir = path.join(root, '.manual');
  const page = {
    id: 'profile', route: '/profile', dynamic: false, params: [], title: '个人中心', purpose: '管理资料', detectedActions: [], entry: 'app/profile/page.tsx', source: [],
    dependencies: { files: [], unresolved: [] }, includeInManual: true, confidence: 'inferred', browser: { verified: false },
    states: { default: { description: '初始状态', assertions: [{ type: 'visible', target: { role: 'heading', name: '资料' } }] } }, status: { router: 'app', sourceAnalysis: 'completed' },
  };
  require('../src/inspect/store').writeModel(stateDir, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: new Date().toISOString() }, [page], { docsOutputDir: 'docs/manual' });
  const { createProjectStore } = require('../src/store/project');
  const { loadConfig } = require('../src/config/load');
  const config = loadConfig(root).config;
  const store = createProjectStore({ stateDirAbs: stateDir, docsOutputDir: config.docs.outputDir });
  const task = {
    id: 'edit-profile', title: '查看资料', goal: '查看资料', entryPage: 'profile', preconditions: ['已登录'], risk: 'read', status: 'approved',
    steps: [{ id: 'inspect', instruction: '查看资料', page: 'profile', action: { type: 'inspect', target: { role: 'heading', name: '资料' } }, capture: { timing: 'after' } }],
    completion: { description: '看到资料', verification: 'verified' },
  };
  const pages = store.load().model.pages;
  task.approval = require('../src/model/approval').approve(task, pages);
  require('../src/tasks/store').writeTask(stateDir, task);
  return { stateDir, config, store, pages };
}

(async () => {
  process.stdout.write('\ntask scenario variant\n');

  await test('任务变体按变体的身份与 scenarioId 采集，不改写默认 lastCapture 与 latest 指针', async (root) => {
    const { stateDir, config, store, pages } = seed(root);
    const { captureTask } = require('../src/tasks/capture-usecase');
    const { deriveTaskScenario, withRevision } = require('../src/scenarios/model');
    const task = store.load().model.tasks[0];
    const variant = withRevision({ ...deriveTaskScenario(task, pages, config), id: 'edit-profile-anon', authProfile: 'anonymous' });
    const session = fakeSession(new FakeProvider());
    const result = await captureTask({ projectRoot: root, config, taskId: 'edit-profile', session, scenario: variant });

    assert.strictEqual(session.scenarios[0].auth.profile, 'anonymous', '浏览器必须用变体的认证档案');
    assert.strictEqual(session.scenarios[0].auth.status, 'disabled');
    const { createCaptureStore } = require('../src/evidence/store');
    const captures = createCaptureStore({ projectRoot: root, stateDirAbs: stateDir });
    const [captureId] = result.updatedTask.lastCapture.captureIds;
    assert.strictEqual(captures.read(captureId).scenarioId, 'edit-profile-anon');
    assert.strictEqual(result.updatedTask.lastCapture.scenarioId || result.scenario.id, 'edit-profile-anon');
    assert.ok(!store.load().model.tasks[0].lastCapture, '变体采集不能写入默认 task.lastCapture');
    const latest = JSON.parse(fs.readFileSync(path.join(stateDir, 'evidence', 'latest.json'), 'utf8'));
    const keys = Object.keys(latest.refs || latest);
    assert.ok(keys.some((key) => key.startsWith('scenario:edit-profile-anon:')), keys.join(','));
    assert.ok(!keys.some((key) => key.startsWith('task:edit-profile:')), '变体不能覆盖默认 latest 指针');
  });

  await test('默认 Scenario 照常写入 lastCapture 与 latest 指针', async (root) => {
    const { stateDir, config, store } = seed(root);
    const { captureTask } = require('../src/tasks/capture-usecase');
    const result = await captureTask({ projectRoot: root, config, taskId: 'edit-profile', session: fakeSession(new FakeProvider()) });
    assert.strictEqual(result.scenario.id, 'edit-profile-default');
    assert.deepStrictEqual(store.load().model.tasks[0].lastCapture.captureIds, result.updatedTask.lastCapture.captureIds);
    const latest = JSON.parse(fs.readFileSync(path.join(stateDir, 'evidence', 'latest.json'), 'utf8'));
    assert.ok(Object.keys(latest.refs || latest).some((key) => key.startsWith('task:edit-profile:')));
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
