'use strict';

/*
 * P1-03：同一获批任务可以反复 capture / generate / finalize / verify；
 * stale 不是死路；审批范围变化要求重新确认，标题润色不需要。真实浏览器 + 测试服务器。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const { startServer } = require('./server');
const taskStore = require('../src/tasks/store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function ok(root, args) {
  const result = await cli(root, args);
  assert.strictEqual(result.status, 0, `manual ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout ? JSON.parse(result.stdout) : null;
}

async function failsWith(root, args, pattern) {
  const result = await cli(root, args);
  assert.strictEqual(result.status, 1, `manual ${args.join(' ')} 应失败\n${result.stdout}`);
  assert.match(result.stdout + result.stderr, pattern);
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

(async () => {
  process.stdout.write('\ntask rerun\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const state = path.join(root, '.manual');
  const task = () => taskStore.readTask(state, 'edit-profile');
  const capture = async () => (await ok(root, ['capture-task', 'edit-profile', '--json'])).evidence;
  const draft = async () => (await ok(root, ['generate-task', 'edit-profile', '--json'])).draftFile;
  try {
    await step('准备：页面 → 候选 → 审批（写入 approval.scopeHash）', async () => {
      await ok(root, ['init', '--base-url', server.baseUrl, '--audience', 'public', '--json']);
      await ok(root, ['inspect', '--json']);
      const { writeModel, readExistingPages } = require('../src/inspect/store');
      const pages = readExistingPages(state).pages;
      pages.push({
        id: 'profile', route: '/task-profile', dynamic: false, params: [], title: '个人中心', purpose: '管理资料',
        detectedActions: [], entry: 'app/profile/page.tsx', source: [], dependencies: { files: [], unresolved: [] },
        includeInManual: true, confidence: 'inferred', browser: { verified: false },
        states: {
          default: { description: '初始', assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
          editor: { description: '编辑面板', assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
        },
        status: { router: 'app', sourceAnalysis: 'completed' },
      });
      writeModel(state, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: new Date().toISOString() }, pages, { docsOutputDir: 'docs/manual' });
      const candidates = path.join(root, 'tasks.json');
      fs.writeFileSync(candidates, JSON.stringify({ tasks: [{
        id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'profile', preconditions: ['已登录'], risk: 'read',
        // 候选输入自带的审批必须被忽略
        approval: { status: 'approved', scopeHash: 'sha256:forged' },
        steps: [
          { id: 'open-editor', instruction: '点击「编辑资料」', page: 'profile', stateBefore: 'default', stateAfter: 'editor',
            action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
          { id: 'save', instruction: '点击「保存修改」', page: 'profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
        ],
        completion: { description: '编辑面板打开', claims: [{ id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] }] },
        branches: [], relatedTasks: [],
      }] }));
      await ok(root, ['discover-tasks', 'profile', '--input', candidates, '--json']);
      assert.deepStrictEqual(task().approval, { status: 'pending', scopeHash: null });
      await failsWith(root, ['capture-task', 'edit-profile', '--json'], /approval-required/);
      const decisions = path.join(root, 'decisions.json');
      fs.writeFileSync(decisions, JSON.stringify({ decisions: [{ id: 'edit-profile', decision: 'approve', actor: 'tester', decisionRef: 'review-1' }] }));
      await ok(root, ['approve-tasks', '--input', decisions, '--json']);
      assert.match(task().approval.scopeHash, /^sha256:[0-9a-f]{64}$/);
      assert.strictEqual(task().approval.actor, 'tester');
    });

    let firstShot;
    await step('同一获批任务 capture 两次：两条记录，旧记录与旧图保持原观察', async () => {
      const first = await capture();
      firstShot = first.steps[0].screenshots[0];
      const recordFile = path.join(state, 'evidence', 'captures', `${firstShot.captureId}.json`);
      const recordText = fs.readFileSync(recordFile, 'utf8');
      const imageBytes = fs.readFileSync(path.join(root, firstShot.annotated));
      const second = await capture();
      const secondShot = second.steps[0].screenshots[0];
      assert.notStrictEqual(secondShot.captureId, firstShot.captureId);
      assert.strictEqual(fs.readFileSync(recordFile, 'utf8'), recordText);
      assert.ok(fs.readFileSync(path.join(root, firstShot.annotated)).equals(imageBytes));
      assert.deepStrictEqual(task().lastCapture.captureIds, [secondShot.captureId]);
      assert.strictEqual(task().lastCapture.scenarioId, 'edit-profile-default');
      const record = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'captures', `${secondShot.captureId}.json`), 'utf8'));
      assert.strictEqual(record.scenarioId, 'edit-profile-default');
    });

    await step('generate → finalize → 再 generate → 再 finalize → verify 两次，都合法', async () => {
      await ok(root, ['generate-task', 'edit-profile', '--finalize', await draft(), '--json']);
      await ok(root, ['generate-task', 'edit-profile', '--finalize', await draft(), '--json']);
      await ok(root, ['verify', 'edit-profile', '--json']);
      const firstVerify = task().lastVerification.at;
      await ok(root, ['verify', 'edit-profile', '--json']);
      assert.strictEqual(task().status, 'verified');
      assert.ok(task().lastVerification.at >= firstVerify);
    });

    await step('草稿之后重新采集：旧草稿 draft-stale，旧文档 verify 报 document-stale；重新生成后恢复', async () => {
      const oldDraft = await draft();
      const kept = path.join(root, 'old-draft.md');
      fs.copyFileSync(oldDraft, kept);
      const oldFacts = fs.readFileSync(path.join(state, 'drafts', 'tasks', 'edit-profile.facts.json'), 'utf8');
      await capture();
      fs.writeFileSync(path.join(state, 'drafts', 'tasks', 'edit-profile.facts.json'), oldFacts);
      await failsWith(root, ['generate-task', 'edit-profile', '--finalize', kept, '--json'], /draft-stale/);
      await failsWith(root, ['verify', 'edit-profile', '--json'], /document-stale/);
      await ok(root, ['generate-task', 'edit-profile', '--finalize', await draft(), '--json']);
      await ok(root, ['verify', 'edit-profile', '--json']);
    });

    await step('stale 不是死路：inspect 标记后生成被阻止，重新 capture 清除标记', async () => {
      taskStore.writeTask(state, { ...task(), stale: { reasons: ['page-changed:profile'], detectedAt: new Date().toISOString() } });
      assert.strictEqual(task().status, 'verified', '标记不改写 status');
      await failsWith(root, ['generate-task', 'edit-profile', '--json'], /evidence-stale.*page-changed:profile/);
      await capture();
      assert.strictEqual(task().stale, null);
      await ok(root, ['generate-task', 'edit-profile', '--finalize', await draft(), '--json']);
    });

    await step('只改标题 / 说明文字：不需要重新审批，证据仍然新鲜', async () => {
      const current = task();
      taskStore.writeTask(state, { ...current, title: '编辑个人资料', steps: current.steps.map((s) => ({ ...s, instruction: `${s.instruction}。` })) });
      await draft();
      await capture();
    });

    await step('动作 / 断言 / claim 变化：需要重新审批，旧证据过期；重新确认后恢复', async () => {
      const current = task();
      taskStore.writeTask(state, { ...current, completion: { ...current.completion, claims: [{ id: 'editor-opened', text: '编辑面板已经打开。', assertionRefs: ['editor-visible'] }] } });
      await failsWith(root, ['capture-task', 'edit-profile', '--json'], /approval-scope-changed/);
      await failsWith(root, ['generate-task', 'edit-profile', '--json'], /evidence-stale.*scope-changed/);
      const decisions = path.join(root, 'decisions-2.json');
      fs.writeFileSync(decisions, JSON.stringify({ decisions: [{ id: 'edit-profile', decision: 'approve' }] }));
      const statusBefore = task().status;
      await ok(root, ['approve-tasks', '--input', decisions, '--json']);
      assert.strictEqual(task().status, statusBefore, '重新确认不重置 status 投影');
      await capture();
      await ok(root, ['generate-task', 'edit-profile', '--finalize', await draft(), '--json']);
      await ok(root, ['verify', 'edit-profile', '--json']);
    });

    await step('已批准任务不能被拒绝；旧证据图与记录一直保留', async () => {
      const decisions = path.join(root, 'decisions-3.json');
      fs.writeFileSync(decisions, JSON.stringify({ decisions: [{ id: 'edit-profile', decision: 'reject' }] }));
      await failsWith(root, ['approve-tasks', '--input', decisions, '--json'], /只有候选任务可以拒绝/);
      assert.ok(fs.existsSync(path.join(root, firstShot.annotated)));
      assert.ok(fs.existsSync(path.join(state, 'evidence', 'captures', `${firstShot.captureId}.json`)));
    });
  } catch (_) {
    // 失败已记录
  } finally {
    await server.close();
    fx.cleanup(root);
    process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
    if (failures.length > 0) process.exitCode = 1;
  }
})();
