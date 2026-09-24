'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { spawn, spawnSync } = require('child_process');
const { startServer } = require('./server');
const { listMarkdownImages } = require('../src/publication/paths');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function runAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function runSync(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

async function completeTask(root, stateDir, taskId) {
  let result = runSync(['plan-capture', taskId, '--project-root', root, '--json']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const plan = JSON.parse(result.stdout).plan;
  assert.ok(plan.steps.some((step) => step.execution === 'stop-before-action' && !step.willExecute));

  result = await runAsync(['capture-task', taskId, '--project-root', root, '--json']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);

  const captured = require('../src/tasks/store').readTask(stateDir, taskId);
  assert.strictEqual(captured.status, 'captured');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, captured.evidenceManifest), 'utf8'));
  assert.ok(fs.existsSync(path.join(root, evidence.steps[0].screenshots[0].annotated)));

  result = runSync(['generate-task', taskId, '--project-root', root, '--json']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const draft = JSON.parse(result.stdout).draftFile;

  result = runSync(['generate-task', taskId, '--project-root', root, '--finalize', draft, '--json']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);

  // 正式文档中的每张图都按文档所在目录解析到真实的 annotated 文件。
  const manualFile = JSON.parse(result.stdout).manual;
  const images = listMarkdownImages(fs.readFileSync(manualFile, 'utf8'));
  assert.ok(images.length > 0);
  for (const image of images) {
    assert.match(image.src, /^\.\.\/images\/annotated\//);
    assert.ok(fs.existsSync(path.resolve(path.dirname(manualFile), image.src)), image.src);
  }

  result = runSync(['verify', taskId, '--project-root', root, '--json']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  assert.strictEqual(require('../src/tasks/store').readTask(stateDir, taskId).status, 'verified');
  return evidence;
}

(async () => {
  const server = await startServer();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-task-e2e-'));
  try {
    let result = runSync(['init', '--project-root', root, '--base-url', server.baseUrl]);
    assert.strictEqual(result.status, 0, result.stderr);
    const stateDir = path.join(root, '.manual');

    // “学校”属于语义不确定字段：验收配置必须显式选择脱敏，不能靠工具猜测。
    const configFile = path.join(stateDir, 'config.yaml');
    const config = yaml.load(fs.readFileSync(configFile, 'utf8'));
    config.redaction = { redact: ['昵称', '学校', '会话标题'] };
    fs.writeFileSync(configFile, yaml.dump(config, { noRefs: true }), 'utf8');

    const page = {
      id: 'profile',
      route: '/task-profile',
      dynamic: false,
      params: [],
      title: '个人中心',
      purpose: '管理资料与查看权益',
      detectedActions: ['编辑资料', '学校权益'],
      entry: 'app/profile/page.tsx',
      source: [],
      dependencies: { files: [], unresolved: [] },
      includeInManual: true,
      confidence: 'inferred',
      browser: { verified: false },
      states: {
        default: {
          description: '初始',
          assertions: [{ type: 'visible', target: { role: 'heading', name: '个人中心' } }],
        },
        editor: {
          description: '编辑资料面板打开',
          assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }],
        },
        benefits: {
          description: '学校权益面板打开',
          assertions: [{ id: 'benefits-visible', type: 'visible', target: { role: 'dialog', name: '学校权益' } }],
        },
      },
      status: { router: 'app', sourceAnalysis: 'completed' },
    };
    require('../src/inspect/store').writeModel(
      stateDir,
      { name: 'x', framework: 'nextjs', router: 'app', generatedAt: new Date().toISOString() },
      [page],
      { docsOutputDir: 'docs/manual' }
    );

    result = runSync(['discover-tasks', 'profile', '--project-root', root, '--json']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.strictEqual(JSON.parse(result.stdout).phase, 'worklist');

    const candidates = { tasks: [{
      id: 'edit-profile',
      title: '修改个人资料',
      goal: '更新手机号',
      entryPage: 'profile',
      preconditions: ['已登录'],
      risk: 'read',
      status: 'approved',
      steps: [{
        id: 'locate-editor',
        instruction: '在个人中心找到「编辑资料」',
        page: 'profile',
        stateBefore: 'default',
        stateAfter: 'default',
        action: { type: 'inspect', target: { role: 'button', name: '编辑资料' } },
        capture: { timing: 'before', annotations: [{ target: 'action.target', label: 1 }] },
      }, {
        id: 'open-editor',
        instruction: '点击「编辑资料」',
        page: 'profile',
        stateBefore: 'default',
        stateAfter: 'editor',
        action: { type: 'click', target: { role: 'button', name: '编辑资料' } },
        capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] },
      }, {
        id: 'save-profile',
        instruction: '确认资料无误后，点击「保存修改」',
        page: 'profile',
        stateBefore: 'editor',
        action: { type: 'click', target: { role: 'button', name: '保存修改' } },
        risk: 'write',
      }],
      completion: {
        description: '资料保存后个人中心显示更新内容',
        verification: 'expected',
        claims: [
          { id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] },
          { id: 'profile-saved', text: '资料保存后个人中心显示更新内容。', assertionRefs: ['profile-updated'] },
        ],
      },
      branches: [{ id: 'teaching-info-cooldown', condition: '教学信息处于冷却期', effect: '学校等教学信息不可修改' }],
      relatedTasks: ['view-school-benefits'],
    }, {
      id: 'view-school-benefits',
      title: '查看学校权益',
      goal: '查看当前学校及其权益',
      entryPage: 'profile',
      preconditions: ['已登录'],
      risk: 'read',
      status: 'approved',
      steps: [{
        id: 'locate-benefits',
        instruction: '在个人中心找到「学校权益」',
        page: 'profile',
        stateBefore: 'default',
        stateAfter: 'default',
        action: { type: 'inspect', target: { role: 'button', name: '学校权益' } },
        capture: { timing: 'before', annotations: [{ target: 'action.target', label: 1 }] },
      }, {
        id: 'open-benefits',
        instruction: '点击「学校权益」',
        page: 'profile',
        stateBefore: 'default',
        stateAfter: 'benefits',
        action: { type: 'click', target: { role: 'button', name: '学校权益' } },
        capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] },
      }, {
        id: 'switch-benefits',
        instruction: '如需更改权益，点击「切换权益」',
        page: 'profile',
        stateBefore: 'benefits',
        action: { type: 'click', target: { role: 'button', name: '切换权益' } },
        risk: 'write',
      }],
      completion: {
        description: '学校权益面板显示当前权益、可用选项和限制原因',
        verification: 'verified',
        claims: [{ id: 'benefits-shown', text: '学校权益面板显示当前权益、可用选项和限制原因。', assertionRefs: ['benefits-visible'] }],
      },
      branches: [{ id: 'switch-denied', condition: '当前账号没有管理员授权', effect: '只能查看，不能切换权益' }],
      relatedTasks: ['edit-profile'],
    }] };
    const candidatesFile = path.join(root, 'task-candidates.json');
    fs.writeFileSync(candidatesFile, JSON.stringify(candidates), 'utf8');
    result = runSync(['discover-tasks', 'profile', '--input', candidatesFile, '--project-root', root, '--json']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    const taskStore = require('../src/tasks/store');
    assert.ok(taskStore.readTasks(stateDir).tasks.every((task) => task.status === 'candidate'));

    const decisionsFile = path.join(root, 'task-decisions.json');
    fs.writeFileSync(decisionsFile, JSON.stringify({ decisions: [
      { id: 'edit-profile', decision: 'approve', priority: 'high' },
      { id: 'view-school-benefits', decision: 'approve', priority: 'high' },
    ] }), 'utf8');
    result = runSync(['approve-tasks', '--input', decisionsFile, '--project-root', root, '--json']);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(taskStore.readTasks(stateDir).tasks.every((task) => task.status === 'approved'));

    const profileEvidence = await completeTask(root, stateDir, 'edit-profile');
    assert.strictEqual(profileEvidence.steps.length, 3);
    assert.strictEqual(profileEvidence.steps[2].status, 'not-executed');
    assert.strictEqual(profileEvidence.steps[2].reason, 'stop-before-action');
    const profileRedactionKinds = profileEvidence.steps[1].screenshots[0].redactions.map((item) => item.kind);
    assert.ok(profileRedactionKinds.includes('phone'));
    assert.ok(profileRedactionKinds.includes('semantic'));
    assert.ok(profileEvidence.steps[1].screenshots[0].redactions.every((item) => item.result === 'neutral-mosaic'));
    const nicknameMask = profileEvidence.steps[1].screenshots[0].redactions.find((item) => item.kind === 'semantic');
    assert.ok(nicknameMask.rect.width < 150, `昵称遮罩应只覆盖文字，实际宽度 ${nicknameMask.rect.width}`);
    // 保存未执行：编辑器声明有证据，保存结果只能是预期
    const profileDoc = fs.readFileSync(path.join(root, 'docs', 'manual', 'tasks', 'edit-profile.md'), 'utf8');
    assert.match(profileDoc, /已验证界面结果：编辑资料面板已打开。/);
    assert.match(profileDoc, /预期业务结果：资料保存后个人中心显示更新内容。/);
    assert.match(profileDoc, /验证范围/);
    const benefitsEvidence = await completeTask(root, stateDir, 'view-school-benefits');
    assert.match(fs.readFileSync(path.join(root, 'docs', 'manual', 'tasks', 'view-school-benefits.md'), 'utf8'), /已验证界面结果：学校权益面板/);
    assert.strictEqual(benefitsEvidence.steps.length, 3);
    assert.strictEqual(benefitsEvidence.steps[2].status, 'not-executed');
    assert.strictEqual(benefitsEvidence.steps[2].reason, 'stop-before-action');
    assert.strictEqual(benefitsEvidence.steps[0].screenshots.length, 1);
    assert.strictEqual(benefitsEvidence.steps[1].screenshots.length, 1);
    assert.ok(
      benefitsEvidence.steps[1].screenshots[0].redactions.some((item) => item.kind === 'semantic'),
      '学校字段应在进入文档前被不透明遮罩'
    );

    process.stdout.write(
      '\ntask-first e2e\n' +
      '  ✓ 修改个人资料：candidate → approve → plan → capture → redact/annotate → generate → verify\n' +
      '  ✓ 查看学校权益：候选审批 → 显式语义脱敏 → 写操作前停止 → verify\n\n' +
      '2 passed, 0 failed\n'
    );
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
