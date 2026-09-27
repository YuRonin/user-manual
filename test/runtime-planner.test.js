'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { TINY_PNG } = require('./server');
const { loadConfig } = require('../src/config/load');
const { createProjectStore } = require('../src/store/project');
const { createCacheStore } = require('../src/cache/store');
const { createCaptureStore } = require('../src/evidence/store');
const { resolveMode } = require('../src/cache/policy');
const { captureKey } = require('../src/cache/keys');
const { resolveTarget } = require('../src/runtime/resolve-target');
const { collectPlanningInputs, plan, checkDag, imageInputsOf } = require('../src/runtime/planner');
const { createRunStore } = require('../src/runtime/store');
const { ADAPTERS, BrowserProvider } = require('../src/browser');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `manual ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

const writeJson = (file, value) => { fs.writeFileSync(file, JSON.stringify(value)); return file; };

/** 一个不需要浏览器的项目：扫描 → 描述 chat → 给 profile 页加状态 → 两个任务（一个已批准、一个候选）。 */
function setupProject() {
  const root = fx.captureFixture();
  fx.writeFile(root, 'app/profile/page.tsx');
  cli(root, ['init', '--base-url', 'http://127.0.0.1:3999', '--audience', 'public']);
  cli(root, ['inspect']);
  cli(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [{ id: 'chat', title: '工作台', purpose: '与 AI 助手对话。' }] })]);
  const file = path.join(root, '.manual', 'pages', 'profile.yaml');
  const page = yaml.load(fs.readFileSync(file, 'utf8'));
  page.states = {
    default: { assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
    editor: { assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
  };
  fs.writeFileSync(file, yaml.dump(page));
  const task = (id) => ({
    id, title: id, goal: '更新资料', entryPage: 'profile', preconditions: [], risk: 'read',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'profile', stateBefore: 'default', stateAfter: 'editor', action: { type: 'click', target: { role: 'button', name: '编辑资料' } } },
      { id: 'save', instruction: '点击「保存修改」', page: 'profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑面板已打开。', assertionRefs: ['editor-visible'] }] },
    branches: [], relatedTasks: [],
  });
  cli(root, ['discover-tasks', 'profile', '--input', writeJson(path.join(root, 'tasks.json'), { tasks: [task('edit-profile'), task('chat')] })]);
  cli(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })]);
  return root;
}

function context(root) {
  const { config } = loadConfig(root);
  const stateDirAbs = path.join(root, config.artifacts.stateDir);
  const base = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).load();
  return { config, stateDirAbs, base };
}

function planFor(root, targets, { command = 'generate', flags = {}, copy = { mode: 'model' }, cache = true } = {}) {
  const { config, stateDirAbs, base } = context(root);
  const mode = resolveMode(flags);
  const snapshot = collectPlanningInputs({ projectRoot: root, config, base, targets, mode, cacheStore: cache ? createCacheStore({ stateDirAbs }) : null });
  return { snapshot, ...plan(snapshot, { command, copy }) };
}

function treeDigest(dir) {
  const hash = crypto.createHash('sha256');
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const file = path.join(d, name);
      const stat = fs.statSync(file);
      hash.update(`${path.relative(dir, file)}:${stat.mtimeMs}\n`);
      if (stat.isDirectory()) walk(file);
      else hash.update(fs.readFileSync(file));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

/** 伪造一次成功采集并写入缓存（用于命中测试）。 */
function seedCaptureCache(root, subject, { imageInputs } = {}) {
  const { config, stateDirAbs } = context(root);
  const { snapshot } = planFor(root, [`${subject.type}:${subject.id}`], { cache: false });
  const s = snapshot.subjects[`${subject.type}:${subject.id}`];
  const captures = createCaptureStore({ projectRoot: root, stateDirAbs });
  const handle = captures.begin();
  fs.mkdirSync(handle.stagingDir, { recursive: true });
  fs.writeFileSync(handle.file('raw.png'), TINY_PNG);
  const record = captures.commit(handle, {
    record: { observedAt: new Date().toISOString(), validations: [{ scope: 'page-identity', outcome: 'passed' }], privacy: { status: 'passed' } },
    artifacts: [{ kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw', prefix: subject.id }],
  });
  // 直接使用 planner 计算出的 key：写缓存与规划必须使用同一组字段。
  const keyInfo = { kind: 'capture', key: s.captureKey, input: {}, uncertainty: s.captureUncertainty };
  createCacheStore({ stateDirAbs }).put({
    kind: 'capture', key: keyInfo.key, input: keyInfo.input, subject: `capture:${subject.type}:${subject.id}`,
    outputRefs: [{ kind: 'capture', ref: record.id }], observedAt: record.observedAt, validationScopes: ['page-identity'],
    privacy: { status: 'passed' }, uncertainty: [], meta: { imageInputs: imageInputs || imageInputsOf(config) },
  });
  return record;
}

process.stdout.write('\nruntime planner\n');
const root = setupProject();
try {
  test('目标解析：前缀、无前缀唯一命中、manual / scenario 映射、歧义列候选、未知目标', () => {
    const { base } = context(root);
    const index = { tasks: base.model.tasks, pages: base.model.pages, scenarios: [{ id: 'edit-profile-default', subject: { type: 'task', id: 'edit-profile' } }] };
    assert.deepStrictEqual(resolveTarget('task:edit-profile', index).target, { type: 'task', id: 'edit-profile', ref: 'task:edit-profile' });
    assert.deepStrictEqual(resolveTarget('edit-profile', index).target, { type: 'task', id: 'edit-profile', ref: 'task:edit-profile' });
    assert.strictEqual(resolveTarget('manual:task-edit-profile', index).target.id, 'edit-profile');
    assert.strictEqual(resolveTarget('scenario:edit-profile-default', index).target.scenarioId, 'edit-profile-default');
    assert.strictEqual(resolveTarget('profile', index).target.type, 'page');
    const ambiguous = resolveTarget('chat', index);
    assert.strictEqual(ambiguous.code, 'ambiguous-target');
    assert.deepStrictEqual(ambiguous.candidates.sort(), ['page:chat', 'task:chat']);
    assert.strictEqual(resolveTarget('nope', index).code, 'unknown-target');
    assert.strictEqual(resolveTarget('page:nope', index).code, 'unknown-target');
    assert.strictEqual(resolveTarget('Bad Id', index).code, 'invalid-target');
    assert.throws(() => planFor(root, ['chat']), (e) => e.code === 'ambiguous-target' && e.candidates.length === 2);
  });

  test('相同输入得到相同 DAG 与 planHash；计划不含时间戳；规划本身零写入', () => {
    const before = treeDigest(path.join(root, '.manual'));
    const a = planFor(root, ['task:edit-profile']);
    const b = planFor(root, ['task:edit-profile']);
    assert.strictEqual(a.planHash, b.planHash);
    assert.deepStrictEqual(a.plan, b.plan);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(JSON.stringify(a.plan)), '计划里不应出现时间戳');
    assert.strictEqual(treeDigest(path.join(root, '.manual')), before);
  });

  test('已获批任务：capture → draft → rewrite → validate → publish；风险边界在摘要中；缺证据必有 capture', () => {
    const { plan: p, errors } = planFor(root, ['task:edit-profile']);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(p.tasks.map((t) => [t.id, t.kind, t.dependsOn]), [
      ['capture', 'capture', []],
      ['draft', 'draft', ['capture']],
      ['rewrite', 'rewrite', ['draft']],
      ['validate', 'validate', ['draft', 'rewrite']],
      ['publish', 'publish', ['validate']],
    ]);
    assert.match(p.tasks[0].reason, /^capture-required:not-found/);
    assert.strictEqual(p.tasks[0].reuse, null);
    assert.strictEqual(p.summary.browserScenarios, 1);
    assert.deepStrictEqual(p.summary.riskBoundaries.map((b) => [b.stepId, b.execution]), [['save', 'stop-before-action']]);
    assert.strictEqual(p.tasks[0].input.scenario.id, 'edit-profile-default');
    assert.ok(p.tasks[0].input.scopeHash && p.tasks[0].input.definitionRevision);
  });

  test('未获批任务：审批作为 gate 节点排在 capture 之前；已批准的不再询问', () => {
    const { plan: p, errors } = planFor(root, ['task:chat']);
    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(p.tasks.slice(0, 2).map((t) => [t.id, t.kind, t.dependsOn]), [['approve', 'validate', []], ['capture', 'capture', ['approve']]]);
    assert.strictEqual(p.tasks[0].input.gate, 'approval');
    assert.strictEqual(p.summary.waitingFor[0].input, 'approval');
    assert.ok(!planFor(root, ['task:edit-profile']).plan.tasks.some((t) => t.id === 'approve'));
  });

  test('文案策略：default 走确定性路径（validate 只依赖 draft）；--copy 文件记录 hash；capture 命令只到证据', () => {
    const det = planFor(root, ['task:edit-profile'], { copy: { mode: 'default' } }).plan;
    assert.ok(!det.tasks.some((t) => t.kind === 'rewrite'));
    assert.deepStrictEqual(det.tasks.find((t) => t.id === 'validate').dependsOn, ['draft']);
    const file = planFor(root, ['task:edit-profile'], { copy: { mode: 'file', path: 'copy.json', sha256: 'abc' } }).plan;
    assert.deepStrictEqual(file.tasks.find((t) => t.id === 'rewrite').input.copy, { mode: 'file', path: 'copy.json', sha256: 'abc' });
    const capture = planFor(root, ['task:edit-profile'], { command: 'capture' }).plan;
    assert.deepStrictEqual(capture.tasks.map((t) => t.id), ['capture']);
  });

  test('页面未完成源码分析：analyze 是 draft 的依赖，不阻塞采集；已分析的页面没有 analyze', () => {
    const profile = planFor(root, ['page:profile']).plan;
    assert.deepStrictEqual(profile.tasks.find((t) => t.id === 'capture').dependsOn, []);
    assert.deepStrictEqual(profile.tasks.find((t) => t.id === 'draft').dependsOn, ['capture', 'analyze']);
    assert.strictEqual(profile.tasks.find((t) => t.id === 'analyze').reason, 'analysis-missing');
    const chat = planFor(root, ['page:chat']).plan;
    assert.ok(!chat.tasks.some((t) => t.kind === 'analyze'));
  });

  test('缓存命中：capture 标为 reuse candidate（不预先标成功），不计入需要浏览器的场景；图像输入变化插入 derive-image', () => {
    const seeded = seedCaptureCache(root, { type: 'page', id: 'chat' });
    const hit = planFor(root, ['page:chat']);
    const capture = hit.plan.tasks.find((t) => t.id === 'capture');
    assert.strictEqual(capture.reason, 'cache-hit');
    assert.strictEqual(capture.reuse.observedAt, seeded.observedAt);
    assert.strictEqual(capture.reuse.onlineChecked, false);
    assert.strictEqual(hit.plan.summary.browserScenarios, 0);
    assert.strictEqual(hit.plan.summary.cache[0].hit, true);
    assert.ok(!hit.plan.tasks.some((t) => t.kind === 'derive-image'));
    const run = createRunStore({ projectRoot: root, stateDirAbs: path.join(root, '.manual') }).create({ command: 'generate', plan: hit.plan });
    assert.strictEqual(run.tasks.find((t) => t.id === 'capture').status, 'pending');
    fs.rmSync(path.join(root, '.manual', 'runs'), { recursive: true, force: true });

    // --refresh 跳过复用
    assert.match(planFor(root, ['page:chat'], { flags: { refresh: true } }).plan.tasks.find((t) => t.id === 'capture').reason, /^cache-refresh/);

    // 隐私规则变化：raw 复用，只重新派生发布图
    seedCaptureCache(root, { type: 'page', id: 'chat' }, { imageInputs: { privacyRevision: 'old', themeRevision: 'x', rendererVersion: 'sharp-svg-1' } });
    const derive = planFor(root, ['page:chat']).plan;
    assert.deepStrictEqual(derive.tasks.map((t) => t.id), ['capture', 'derive-image', 'draft', 'rewrite', 'validate', 'publish']);
    assert.deepStrictEqual(derive.tasks.find((t) => t.id === 'draft').dependsOn, ['derive-image']);
    assert.strictEqual(derive.tasks.find((t) => t.id === 'derive-image').reason, 'image-inputs-changed→derive-required');
  });

  test('离线模式没有历史证据时规划即报 cache-miss-offline；有证据时可规划', () => {
    const { errors } = planFor(root, ['task:edit-profile'], { flags: { offline: true } });
    assert.ok(errors.some((e) => /^cache-miss-offline/.test(e)), errors.join('\n'));
    assert.deepStrictEqual(planFor(root, ['page:chat'], { flags: { offline: true } }).errors, []);
  });

  test('共享采集去重：两个目标指向同一任务时只采集一次；DAG 检查重复 / 未知依赖 / 循环', () => {
    const { plan: p, errors } = planFor(root, ['task:edit-profile', 'manual:task-edit-profile']);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(p.tasks.filter((t) => t.kind === 'capture').length, 1);
    assert.deepStrictEqual(p.tasks.find((t) => t.id === 'draft-t2').dependsOn, ['capture-t1']);
    const dag = checkDag([
      { id: 'a', dependsOn: ['b'] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['x'] }, { id: 'c', dependsOn: [] },
    ]);
    assert.ok(dag.errors.some((e) => e.startsWith('dependency-cycle')));
    assert.ok(dag.errors.some((e) => e === 'unknown-dependency: c → x'));
    assert.ok(dag.errors.some((e) => e === 'duplicate-node: c'));
  });

  test('Provider 能力不足在规划期报 capability-missing', () => {
    class ShotOnly extends BrowserProvider { static get capabilities() { return { capture: true }; } }
    ADAPTERS['shot-only'] = ShotOnly;
    const configFile = path.join(root, '.manual', 'config.yaml');
    const original = fs.readFileSync(configFile, 'utf8');
    try {
      const config = yaml.load(original);
      config.browser.providers.shot = { type: 'shot-only' };
      config.browser.activeProvider = 'shot';
      fs.writeFileSync(configFile, yaml.dump(config));
      const { errors } = planFor(root, ['task:edit-profile']);
      assert.ok(errors.some((e) => /capability-missing: .*semanticActions/.test(e)), errors.join('\n'));
    } finally {
      fs.writeFileSync(configFile, original);
      delete ADAPTERS['shot-only'];
    }
  });

  test('plan-capture 与 capture-task 使用同一份输入：计划含 Scenario、定义 revision 与页面 revision', () => {
    const out = cli(root, ['plan-capture', 'edit-profile']);
    assert.strictEqual(out.plan.scenario.id, 'edit-profile-default');
    assert.match(out.plan.modelRevision, /^sha256:/);
    assert.deepStrictEqual(Object.keys(out.plan.pageRevisions), ['profile']);
    const key = captureKey({ projectId: 'p', scenarioId: 's', scenarioRevision: 'r', checkpoint: 'c', viewport: { width: 1, height: 1 }, dpr: 1, browser: 'b', captureMode: 'm', readinessPolicy: 'r' });
    assert.ok(key.uncertainty.includes('deployedBuild'));
  });
} finally {
  fx.cleanup(root);
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
