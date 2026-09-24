'use strict';

/*
 * Gate 1 集成验收（Phase 1）：在一个真实浏览器项目里串起版本化模型、不可变证据、
 * Project Store、FactPack 定稿、发布事务与迁移。
 *   1 旧项目 dry-run → apply → 重复 apply，映射稳定
 *   2 同任务连续采集两次，旧截图不变；重新生成、重复 verify 合法
 *   3 改同一组件内容，inspect 报关联证据 stale；新观察不删除旧记录
 *   4 改图片内容不改路径，完整性检查失败
 *   5 发布中断可逐边界恢复；两个写者发生 CAS 冲突而非丢数据
 *   6 删除 drafts 后已发布版本仍可验证
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const { createProjectStore } = require('../src/store/project');
const { publish } = require('../src/publication/publisher');
const { readCurrentRelease } = require('../src/publication/release-store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

async function ok(root, args) {
  const r = await cli(root, [...args, '--json']);
  assert.strictEqual(r.status, 0, `manual ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

async function fails(root, args, pattern) {
  const r = await cli(root, [...args, '--json']);
  assert.strictEqual(r.status, 1, `manual ${args.join(' ')} 应失败\n${r.stdout}`);
  assert.match(r.stdout + r.stderr, pattern);
  return r;
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

const writeJson = (file, value) => { fs.writeFileSync(file, JSON.stringify(value)); return file; };

(async () => {
  process.stdout.write('\nGate 1\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const legacy = fx.makeTempDir('manual-gate1-legacy-');
  const state = path.join(root, '.manual');
  const docs = path.join(root, 'docs', 'manual');
  const task = () => yaml.load(fs.readFileSync(path.join(state, 'tasks', 'edit-profile.yaml'), 'utf8'));
  const records = () => fs.readdirSync(path.join(state, 'evidence', 'captures')).sort();
  try {
    await step('准备：扫描 → 描述 → 页面状态（手改 YAML 被导入为新提交）→ 页面采集与 --copy 定稿', async () => {
      fx.writeFile(root, 'components/Profile.tsx', 'export default function Profile() { return "编辑资料" }\n');
      fx.writeFile(root, 'app/task-profile/page.tsx', "import Profile from '../../components/Profile'\nexport default Profile\n");
      await ok(root, ['init', '--base-url', server.baseUrl, '--audience', 'public']);
      await ok(root, ['inspect']);
      const input = writeJson(path.join(root, 'describe.json'), { pages: [
        { id: 'chat', title: '工作台', purpose: '与 AI 助手对话。', detectedActions: ['点击「新对话」创建会话'] },
        { id: 'task-profile', title: '个人中心', purpose: '管理个人资料。' },
      ] });
      await ok(root, ['describe', '--input', input]);
      const file = path.join(state, 'pages', 'task-profile.yaml');
      const page = yaml.load(fs.readFileSync(file, 'utf8'));
      page.states = {
        default: { description: '初始', assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
        editor: { description: '编辑面板', assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
      };
      fs.writeFileSync(file, yaml.dump(page));
      await ok(root, ['capture', 'chat']);
      await ok(root, ['generate', 'chat']);
      await ok(root, ['generate', 'chat', '--copy', writeJson(path.join(root, 'page-copy.json'), { intro: '在这里和 AI 助手对话。' })]);
      assert.match(fs.readFileSync(path.join(docs, 'chat.md'), 'utf8'), /在这里和 AI 助手对话。/);
      assert.ok(readCurrentRelease(state, 'page-chat'), '页面定稿产生发布记录');
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(state, 'current.json'), 'utf8')).materialized, true);
    });

    let firstShot;
    await step('2 同任务连续采集两次，旧截图与旧记录不变；--copy 定稿，重复生成与重复 verify 合法', async () => {
      const candidates = writeJson(path.join(root, 'tasks.json'), { tasks: [{
        id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'task-profile', preconditions: ['已登录'], risk: 'read',
        steps: [
          { id: 'open-editor', instruction: '点击「编辑资料」', page: 'task-profile', stateBefore: 'default', stateAfter: 'editor',
            action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
          { id: 'save', instruction: '点击「保存修改」', page: 'task-profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
        ],
        completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
        branches: [], relatedTasks: [],
      }] });
      await ok(root, ['discover-tasks', 'task-profile', '--input', candidates]);
      await ok(root, ['approve-tasks', '--input', writeJson(path.join(root, 'decisions.json'), { decisions: [{ id: 'edit-profile', decision: 'approve' }] })]);
      const first = await ok(root, ['capture-task', 'edit-profile']);
      firstShot = first.evidence.steps[0].screenshots[0];
      const recordText = fs.readFileSync(path.join(state, 'evidence', 'captures', `${firstShot.captureId}.json`), 'utf8');
      const imageBytes = fs.readFileSync(path.join(root, firstShot.annotated));
      await ok(root, ['capture-task', 'edit-profile']);
      assert.strictEqual(fs.readFileSync(path.join(state, 'evidence', 'captures', `${firstShot.captureId}.json`), 'utf8'), recordText);
      assert.ok(fs.readFileSync(path.join(root, firstShot.annotated)).equals(imageBytes));
      for (let i = 0; i < 2; i++) {
        const draft = await ok(root, ['generate-task', 'edit-profile']);
        assert.deepStrictEqual(Object.keys(draft.copyBlocks), ['intro', 'step.open-editor', 'step.save']);
        await ok(root, ['generate-task', 'edit-profile', '--copy', writeJson(path.join(root, 'copy.json'), { 'step.open-editor': '「编辑资料」在个人信息卡片右上角。' })]);
      }
      await ok(root, ['verify', 'edit-profile']);
      await ok(root, ['verify', 'edit-profile']);
      const doc = fs.readFileSync(path.join(docs, 'tasks', 'edit-profile.md'), 'utf8');
      assert.match(doc, /1\. 点击「编辑资料」\n\n {3}「编辑资料」在个人信息卡片右上角。/);
      assert.match(doc, /已验证界面结果：编辑资料面板已打开。/);
    });

    await step('6 删除 drafts 后已发布版本仍可验证', async () => {
      fs.rmSync(path.join(state, 'drafts'), { recursive: true, force: true });
      await ok(root, ['verify', 'edit-profile']);
    });

    await step('4 改图片内容不改路径：Capture 完整性与发布门槛都失败', async () => {
      const release = readCurrentRelease(state, 'task-edit-profile');
      const image = path.join(root, release.facts.images[0].artifactPath);
      const original = fs.readFileSync(image);
      fs.writeFileSync(image, Buffer.concat([original, Buffer.from('tampered')]));
      await fails(root, ['verify', 'edit-profile'], /hash-mismatch/);
      await fails(root, ['generate-task', 'edit-profile'], /size-mismatch|hash-mismatch/);
      fs.writeFileSync(image, original);
      await ok(root, ['verify', 'edit-profile']);
    });

    await step('5a 发布在文档安装之后中断：status 显示可继续，repair 完成，verify 通过', async () => {
      const release = readCurrentRelease(state, 'task-edit-profile');
      const docFile = path.join(docs, 'tasks', 'edit-profile.md');
      const markdown = `${fs.readFileSync(docFile, 'utf8')}\n`;
      assert.throws(() => publish({
        projectRoot: root, stateDirAbs: state, manualId: 'task-edit-profile', documentFile: docFile, markdown, facts: release.facts,
        captureIds: release.captureIds, definitionRevisions: release.definitionRevisions, hooks: { 'after:document-installed': () => { throw new Error('killed'); } },
      }), /killed/);
      const status = await ok(root, ['publication', 'status']);
      assert.strictEqual(status.transactions[0].next, 'resume');
      await fails(root, ['verify', 'edit-profile'], /document-modified/);
      const repaired = await ok(root, ['publication', 'repair']);
      assert.strictEqual(repaired.results[0].result, 'completed');
      assert.strictEqual(readCurrentRelease(state, 'task-edit-profile').previousReleaseId, release.id);
      await ok(root, ['verify', 'edit-profile']);
    });

    await step('5b 两个写者：旧输入的定义提交得到 model-conflict，先提交的修改保留', async () => {
      const store = createProjectStore({ stateDirAbs: state, docsOutputDir: 'docs/manual' });
      const stale = store.load();
      await ok(root, ['describe', '--id', 'chat', '--purpose', '新的用途说明。']);
      const chat = stale.model.pages.find((p) => p.id === 'chat');
      assert.throws(() => store.commit({ base: stale, kind: 'definition', changes: { pages: [{ ...chat, title: '旧输入' }] } }), (e) => e.code === 'model-conflict');
      const page = yaml.load(fs.readFileSync(path.join(state, 'pages', 'chat.yaml'), 'utf8'));
      assert.strictEqual(page.purpose, '新的用途说明。');
      assert.strictEqual(page.title, '工作台');
    });

    await step('3 改同一组件内容：inspect 报关联页面与任务证据 stale，旧记录保留；重新采集后恢复', async () => {
      const before = records();
      fx.writeFile(root, 'components/Profile.tsx', 'export default function Profile() { return "修改资料" }\n');
      const out = await ok(root, ['inspect']);
      const impact = out.impact.pages.find((p) => p.id === 'task-profile');
      assert.strictEqual(impact.status, 'changed');
      assert.deepStrictEqual(impact.reasons, ['content-changed:components/Profile.tsx']);
      assert.ok(out.staleTasks.includes('edit-profile'));
      assert.deepStrictEqual(task().stale.reasons.includes('page-changed:task-profile'), true);
      await fails(root, ['generate-task', 'edit-profile'], /evidence-stale/);
      assert.deepStrictEqual(records(), before, '新的判断不删除旧观察');
      await ok(root, ['capture-task', 'edit-profile']);
      assert.strictEqual(task().stale, null);
      assert.ok(records().length > before.length);
      await ok(root, ['generate-task', 'edit-profile']);
    });

    await step('1 旧项目：dry-run 零写入 → apply → 重复 apply，映射与备份稳定', async () => {
      assert.strictEqual((await cli(legacy, ['init', '--base-url', server.baseUrl])).status, 0);
      const configFile = path.join(legacy, '.manual', 'config.yaml');
      fs.writeFileSync(configFile, fs.readFileSync(configFile, 'utf8').replace(/^ {2}# 项目身份.*\n {2}id: .*\n/m, ''));
      fx.writeFile(legacy, '.manual/artifacts/raw/pages/chat.png', 'png');
      fx.writeFile(legacy, '.manual/pages/chat.yaml', yaml.dump({
        id: 'chat', route: '/chat', dynamic: false, params: [], title: '工作台', purpose: '对话', detectedActions: [], entry: 'app/chat/page.tsx',
        source: ['app/chat/page.tsx'], dependencies: { files: [], unresolved: [] }, includeInManual: true, confidence: 'verified',
        browser: { verified: true, lastCapture: '2026-09-01T00:00:00.000Z', screenshot: '.manual/artifacts/raw/pages/chat.png' },
        states: { default: { assertions: [{ type: 'url', value: '/chat' }] } }, status: { router: 'app', sourceAnalysis: 'completed' },
      }));
      const planFile = path.join(fx.makeTempDir('manual-gate1-plan-'), 'plan.json');
      const plan = (await ok(legacy, ['migrate', '--dry-run', '--manifest', planFile])).plan;
      assert.ok(!fs.existsSync(path.join(legacy, '.manual', 'migrations')), 'dry-run 零写入');
      const applied = await ok(legacy, ['migrate', '--apply', '--manifest', planFile]);
      assert.strictEqual(applied.projectId, plan.projectId);
      assert.deepStrictEqual(applied.legacyCaptures, plan.legacyCaptures.map((c) => c.id));
      const again = await ok(legacy, ['migrate', '--apply']);
      assert.strictEqual(again.alreadyMigrated, true);
      assert.strictEqual(again.projectId, plan.projectId);
      assert.ok(fs.existsSync(path.join(legacy, applied.backup.backupDir, '.manual', 'pages', 'chat.yaml')));
      fs.rmSync(path.dirname(planFile), { recursive: true, force: true });
    });
  } catch (_) {
    /* 失败已记录 */
  } finally {
    await server.close();
    fx.cleanup(root);
    fx.cleanup(legacy);
    process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
    if (failures.length > 0) process.exitCode = 1;
  }
})();
