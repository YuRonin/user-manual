'use strict';

/*
 * P1-04：显式、可重复执行的项目迁移。三种旧项目：仅页面流程、完整任务流程、部分损坏 / 缺图。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const { loadConfig } = require('../src/config/load');
const { planMigration, applyMigration } = require('../src/store/migrate');
const { cacheCandidacy } = require('../src/evidence/integrity');
const { approvalState } = require('../src/model/approval');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000040000000308020000', 'hex');

let passed = 0;
let skipped = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-migrate-'));
  try {
    const result = fn(root);
    if (result === 'skip') { skipped++; process.stdout.write(`  - ${name}（跳过）\n`); }
    else { passed++; process.stdout.write(`  ✓ ${name}\n`); }
  } catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function cli(root, args) {
  const r = spawnSync(process.execPath, [CLI, ...args, '--project-root', root], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: (() => { try { return JSON.parse(r.stdout); } catch (_) { return null; } })() };
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** 目录树内容指纹（用于"零写入"断言）。 */
function treeHash(root) {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(path.relative(root, full)).update(fs.readFileSync(full));
    }
  };
  walk(root);
  return hash.digest('hex');
}

function legacyPage(id, route, browser) {
  return yaml.dump({
    id, route, dynamic: false, params: [], title: `${id} 页`, purpose: '旧分析结论', detectedActions: [], entry: `app${route}/page.tsx`,
    source: [`app${route}/page.tsx`], dependencies: { files: [], unresolved: [] }, includeInManual: true,
    confidence: browser ? 'verified' : 'inferred', browser: browser || { verified: false, lastCapture: null, screenshot: null, url: null },
    states: { default: { description: '初始', assertions: [{ type: 'url', value: route }] } }, status: { router: 'app', sourceAnalysis: 'completed' },
  });
}

/** 旧项目：v1 配置（没有 project.id）、没有 schemaVersion / lifecycle 的页面。 */
function legacyProject(root, { tasks = false, broken = false } = {}) {
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  const configFile = path.join(root, '.manual', 'config.yaml');
  fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/^ {2}# 项目身份.*\n {2}id: .*\n/m, ''));
  write(root, '.manual/artifacts/raw/pages/chat.png', PNG);
  write(root, 'docs/manual/images/annotated/page--chat.png', PNG);
  write(root, '.manual/pages/chat.yaml', legacyPage('chat', '/chat', {
    verified: true, lastCapture: '2026-09-01T00:00:00.000Z', screenshot: '.manual/artifacts/raw/pages/chat.png', url: 'http://localhost:3000/chat',
    published: { artifactPath: 'docs/manual/images/annotated/page--chat.png', sha256: 'x', privacy: { status: 'passed', unresolved: [], maskStyles: [] } },
  }));
  write(root, '.manual/pages/profile.yaml', legacyPage('profile', '/profile', null));
  if (tasks) {
    write(root, '.manual/artifacts/raw/edit-profile--open--after.png', PNG);
    write(root, 'docs/manual/images/annotated/edit-profile--open--after.png', PNG);
    write(root, '.manual/artifacts/manifests/edit-profile--evidence.json', JSON.stringify({
      version: 1, taskId: 'edit-profile', capturedAt: '2026-09-02T00:00:00.000Z',
      steps: [{ id: 'open', screenshots: [{ raw: '.manual/artifacts/raw/edit-profile--open--after.png', timing: 'after', annotated: 'docs/manual/images/annotated/edit-profile--open--after.png', privacy: { status: 'passed', unresolved: [], maskStyles: [] } }] }],
    }));
    write(root, '.manual/tasks/edit-profile.yaml', yaml.dump({
      id: 'edit-profile', title: '修改资料', goal: '修改', entryPage: 'profile', preconditions: [], risk: 'read', status: 'verified',
      steps: [{ id: 'open', instruction: '打开', page: 'profile', action: { type: 'inspect' } }], completion: { description: '完成' },
      evidenceManifest: '.manual/artifacts/manifests/edit-profile--evidence.json',
    }));
    write(root, '.manual/tasks/new-task.yaml', yaml.dump({
      id: 'new-task', title: '新任务', goal: '新', entryPage: 'chat', preconditions: [], risk: 'read', status: 'candidate',
      steps: [{ id: 'look', instruction: '查看', page: 'chat', action: { type: 'inspect' } }], completion: { description: '完成' },
    }));
    // 旧 facts：图片是字符串（项目根相对路径）；正式文档按文档目录相对引用
    write(root, '.manual/drafts/tasks/edit-profile.facts.json', JSON.stringify({ taskId: 'edit-profile', images: ['docs/manual/images/annotated/edit-profile--open--after.png'] }));
    write(root, 'docs/manual/tasks/edit-profile.md', '# 修改资料\n\n![步骤 1](../images/annotated/edit-profile--open--after.png)\n');
  }
  if (broken) {
    write(root, '.manual/pages/lost.yaml', legacyPage('lost', '/lost', { verified: true, lastCapture: 'not-a-date', screenshot: '.manual/artifacts/raw/pages/lost.png' }));
    write(root, '.manual/drafts/chat.facts.json', JSON.stringify({ pageId: 'chat', images: ['images/annotated/page--chat.png'] }));
    write(root, 'docs/manual/chat.md', '# chat\n\n![其他](images/annotated/other.png)\n');
    write(root, '.manual/drafts/missing.facts.json', JSON.stringify({ pageId: 'missing', images: ['images/annotated/nope.png'] }));
  }
  return root;
}

const readYaml = (root, rel) => yaml.load(fs.readFileSync(path.join(root, rel), 'utf8'));

process.stdout.write('\nmodel migration\n');

test('dry-run 零写入，并列出版本变化、拟生成 ID、无法证明的验证与需要重新采集的对象', (root) => {
  legacyProject(root, { tasks: true, broken: true });
  const before = treeHash(root);
  const r = cli(root, ['migrate', '--dry-run', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(treeHash(root), before, 'dry-run 不能写任何文件');
  const plan = r.json.plan;
  assert.deepStrictEqual(plan.config, { from: 1, to: 2 });
  assert.match(plan.projectId, /^[0-9a-f-]{36}$/);
  assert.ok(plan.entities.some((e) => e.entity === 'page' && e.id === 'chat' && e.oldVersion === 1 && e.newVersion === 2));
  assert.ok(plan.entities.some((e) => e.entity === 'task' && e.id === 'edit-profile' && e.status === 'verified'));
  assert.deepStrictEqual(plan.legacyCaptures.map((c) => c.kind).sort(), ['page', 'task-step']);
  assert.ok(plan.unverifiable.some((u) => u.id === 'chat' && u.claim === 'browser.verified'));
  assert.ok(plan.unverifiable.some((u) => u.id === 'edit-profile' && u.claim === 'status=verified'));
  assert.ok(plan.recapture.some((x) => x.id === 'lost' && x.reason === 'screenshot-missing'));
  assert.ok(plan.facts.some((f) => f.file.endsWith('chat.facts.json') && f.action === 'conflict' && f.conflicts[0].reason === 'markdown-sidecar-mismatch'));
  assert.ok(plan.facts.some((f) => f.file.endsWith('missing.facts.json') && f.conflicts[0].reason === 'image-missing'));
  assert.strictEqual(plan.facts.find((f) => f.file.endsWith('edit-profile.facts.json')).action, 'convert');
  assert.deepStrictEqual(plan.auth.action, 'keep-alias');
});

test('仅页面流程：apply 使用同一份计划的 ID；旧 verified 降为 legacy-unknown，不伪造验证', (root) => {
  legacyProject(root);
  const manifest = path.join(os.tmpdir(), `manual-plan-${process.pid}-a.json`);
  const plan = cli(root, ['migrate', '--dry-run', '--manifest', manifest, '--json']).json.plan;
  const r = cli(root, ['migrate', '--apply', '--manifest', manifest, '--json']);
  fs.rmSync(manifest, { force: true });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.json.projectId, plan.projectId);
  assert.deepStrictEqual(r.json.legacyCaptures, plan.legacyCaptures.map((c) => c.id));

  const config = readYaml(root, '.manual/config.yaml');
  assert.strictEqual(config.version, 2);
  assert.strictEqual(config.project.id, plan.projectId);
  assert.match(fs.readFileSync(path.join(root, '.manual/config.yaml'), 'utf8'), /# Living User Manual/, '保留原配置注释');

  const chat = readYaml(root, '.manual/pages/chat.yaml');
  assert.strictEqual(chat.schemaVersion, 2);
  assert.strictEqual(chat.lifecycle, 'active');
  assert.strictEqual(chat.browser.verified, false);
  assert.strictEqual(chat.browser.identity, 'legacy-unknown');
  assert.strictEqual(chat.confidence, 'inferred');
  assert.strictEqual(chat.browser.latestCaptureId, plan.legacyCaptures[0].id);
  assert.strictEqual(chat.title, 'chat 页', '分析结论保留');

  const record = JSON.parse(fs.readFileSync(path.join(root, '.manual/evidence/captures', `${chat.browser.latestCaptureId}.json`), 'utf8'));
  assert.strictEqual(record.provenance.mode, 'legacy');
  assert.ok(record.validations.every((v) => v.scope === 'artifact-integrity' || v.outcome === 'inconclusive'));
  assert.ok(!record.validations.some((v) => v.scope === 'page-identity' && v.outcome === 'passed'), '有截图不等于验证通过');
  assert.strictEqual(cacheCandidacy(record).ok, false, 'legacy 记录不能成为 cache candidate');
  assert.ok(fs.existsSync(path.join(root, '.manual', 'current.json')));
  assert.ok(fs.readdirSync(path.join(root, '.manual', 'migrations', plan.id, 'backup', '.manual', 'pages')).includes('chat.yaml'));
});

test('完整任务流程：审批变为 legacy-status（执行前需重新确认），旧 verified 投影为 generated，facts 转为结构化引用', (root) => {
  legacyProject(root, { tasks: true });
  const r = cli(root, ['migrate', '--apply', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const task = readYaml(root, '.manual/tasks/edit-profile.yaml');
  assert.strictEqual(task.schemaVersion, 2);
  assert.deepStrictEqual(task.approval, { status: 'approved', scopeHash: null, provenance: 'legacy-status', migratedFrom: 'verified' });
  assert.strictEqual(approvalState(task, []), 'legacy-unverified');
  assert.strictEqual(task.status, 'generated');
  assert.strictEqual(task.lastVerification.result, 'legacy-unknown');
  assert.strictEqual(task.captureIds.length, 1);
  assert.deepStrictEqual(readYaml(root, '.manual/tasks/new-task.yaml').approval, { status: 'pending', scopeHash: null });
  const facts = JSON.parse(fs.readFileSync(path.join(root, '.manual/drafts/tasks/edit-profile.facts.json'), 'utf8'));
  assert.deepStrictEqual(facts.images, [{
    artifactPath: 'docs/manual/images/annotated/edit-profile--open--after.png',
    markdownHref: '../images/annotated/edit-profile--open--after.png', sha256: null, privacy: null, legacy: true,
  }]);
  // 认证缓存沿用原 cacheKey，备份里没有任何认证缓存内容
  assert.strictEqual(loadConfig(root).config.auth.cacheKey, readYaml(root, '.manual/config.yaml').auth.cacheKey);
  const backupRoot = path.join(root, '.manual', 'migrations', r.json.migrationId, 'backup');
  const backedUp = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : backedUp.push(path.relative(backupRoot, path.join(dir, e.name)))));
  walk(backupRoot);
  assert.ok(backedUp.every((f) => f.startsWith('.manual')), backedUp.join(','));
  assert.ok(!backedUp.some((f) => /auth|storage/i.test(f)));
});

test('apply 两次结果相同：第二次不改任何文件、不重新生成 projectId', (root) => {
  legacyProject(root, { tasks: true });
  const first = cli(root, ['migrate', '--apply', '--json']).json;
  const after = treeHash(root);
  const second = cli(root, ['migrate', '--apply', '--json']);
  assert.strictEqual(second.status, 0, second.stdout);
  assert.strictEqual(second.json.alreadyMigrated, true);
  assert.strictEqual(second.json.projectId, first.projectId);
  assert.strictEqual(treeHash(root), after);
});

test('计划之后输入变化：migration-input-changed，且不写任何文件', (root) => {
  legacyProject(root);
  const manifest = path.join(os.tmpdir(), `manual-plan-${process.pid}-b.json`);
  cli(root, ['migrate', '--dry-run', '--manifest', manifest, '--json']);
  write(root, '.manual/pages/profile.yaml', fs.readFileSync(path.join(root, '.manual/pages/profile.yaml'), 'utf8').replace('profile 页', '改过的标题'));
  const before = treeHash(root);
  const r = cli(root, ['migrate', '--apply', '--manifest', manifest, '--json']);
  fs.rmSync(manifest, { force: true });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(r.json.code, 'migration-input-changed');
  assert.strictEqual(treeHash(root), before);
});

for (const phase of ['backed-up', 'captures-registered', 'model-committed', 'facts-converted']) {
  test(`中途故障（${phase} 之后）：再次 apply 按 journal 继续，使用同一计划，定义不丢`, (root) => {
    legacyProject(root, { tasks: true });
    const loaded = loadConfig(root);
    const raw = readYaml(root, '.manual/config.yaml');
    assert.throws(() => applyMigration(root, loaded.config, raw, { hooks: { [`after:${phase}`]: () => { throw new Error('crash'); } } }), /crash/);
    assert.strictEqual(readYaml(root, '.manual/config.yaml').version, 1, '配置最后才切换版本');
    assert.strictEqual(readYaml(root, '.manual/pages/chat.yaml').title, 'chat 页');
    const journal = fs.readdirSync(path.join(root, '.manual', 'migrations'));
    assert.strictEqual(journal.length, 1);
    const resumed = cli(root, ['migrate', '--apply', '--json']);
    assert.strictEqual(resumed.status, 0, resumed.stdout + resumed.stderr);
    assert.strictEqual(resumed.json.migrationId, journal[0], '沿用 journal 中的计划');
    assert.strictEqual(readYaml(root, '.manual/config.yaml').version, 2);
    assert.strictEqual(readYaml(root, '.manual/pages/chat.yaml').title, 'chat 页');
    assert.strictEqual(readYaml(root, '.manual/tasks/edit-profile.yaml').title, '修改资料');
    assert.strictEqual(fs.readdirSync(path.join(root, '.manual', 'evidence', 'captures')).length, 2, 'legacy 记录不重复登记');
  });
}

test('部分损坏项目：缺图报告为需重新采集；facts 与正式文档冲突时两者都不改', (root) => {
  legacyProject(root, { broken: true });
  const factsBefore = fs.readFileSync(path.join(root, '.manual/drafts/chat.facts.json'), 'utf8');
  const docBefore = fs.readFileSync(path.join(root, 'docs/manual/chat.md'), 'utf8');
  const r = cli(root, ['migrate', '--apply', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.json.recapture.some((x) => x.id === 'lost'));
  assert.ok(r.json.conflicts.some((c) => c.file.endsWith('chat.facts.json')));
  assert.strictEqual(fs.readFileSync(path.join(root, '.manual/drafts/chat.facts.json'), 'utf8'), factsBefore);
  assert.strictEqual(fs.readFileSync(path.join(root, 'docs/manual/chat.md'), 'utf8'), docBefore);
  const lost = readYaml(root, '.manual/pages/lost.yaml');
  assert.strictEqual(lost.browser.latestCaptureId ?? null, null, '没有产物就不登记 Capture');
  assert.strictEqual(lost.browser.verified, false);
});

test('rollback：用完整备份恢复定义、配置与 current 指针', (root) => {
  legacyProject(root, { tasks: true });
  const originals = ['.manual/config.yaml', '.manual/pages/chat.yaml', '.manual/tasks/edit-profile.yaml', '.manual/drafts/tasks/edit-profile.facts.json']
    .map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')]);
  const applied = cli(root, ['migrate', '--apply', '--json']).json;
  const r = cli(root, ['migrate', '--rollback', applied.migrationId, '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  for (const [rel, content] of originals) assert.strictEqual(fs.readFileSync(path.join(root, rel), 'utf8'), content, rel);
  assert.ok(!fs.existsSync(path.join(root, '.manual', 'current.json')), '迁移前没有 current 指针');
});

test('迁移后旧版工具按原有版本检查拒绝该配置（v2 不会被旧 writer 写入）', (root) => {
  const OLD = '0c4ad0d';
  const files = ['load.js', 'schema.js', 'annotation.js', 'profiles.js', 'providers.js'];
  const dir = path.join(root, 'old-tool', 'src', 'config');
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const shown = spawnSync('git', ['show', `${OLD}:src/config/${file}`], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
    if (shown.status !== 0) return 'skip'; // 非 git 检出环境无法取得旧版本
    fs.writeFileSync(path.join(dir, file), shown.stdout);
  }
  fs.symlinkSync(path.resolve(__dirname, '..', 'node_modules'), path.join(root, 'old-tool', 'node_modules'), 'junction');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  legacyProject(project);
  const oldLoad = require(path.join(dir, 'load.js'));
  assert.strictEqual(oldLoad.loadConfig(project).ok, true, '迁移前旧版工具可以读取');
  assert.strictEqual(cli(project, ['migrate', '--apply', '--json']).status, 0);
  const rejected = oldLoad.loadConfig(project);
  assert.strictEqual(rejected.ok, false);
  assert.match(rejected.errors.join('\n'), /高于当前工具支持/);
});

test('新工具读取迁移后的项目：普通命令继续可用', (root) => {
  legacyProject(root, { tasks: true });
  assert.strictEqual(cli(root, ['migrate', '--apply', '--json']).status, 0);
  const r = cli(root, ['describe', '--id', 'profile', '--purpose', '新的用途。', '--json']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(readYaml(root, '.manual/pages/profile.yaml').schemaVersion, 2);
  const plan = planMigration(root, loadConfig(root).config, readYaml(root, '.manual/config.yaml'));
  assert.strictEqual(plan.config.from, 2);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ''}\n`);
if (failures.length > 0) process.exitCode = 1;
