'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { computeClaims } = require('../src/evidence/claims');
const { buildTaskDraft } = require('../src/generate/task-draft');
const { validateTaskFinal } = require('../src/generate/task-facts');
const { validateTask } = require('../src/tasks/model');
const { executeCapturePlan } = require('../src/tasks/executor');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

function task(completion) {
  return {
    id: 'edit-profile', title: '修改个人资料', goal: '更新昵称', entryPage: 'profile', preconditions: [], risk: 'local', status: 'captured',
    steps: [
      { id: 'open-editor', instruction: '点击「编辑资料」', page: 'profile', action: { type: 'click', target: { role: 'button', name: '编辑资料' } } },
      { id: 'save', instruction: '点击「保存修改」', page: 'profile', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
    ],
    completion,
  };
}

const CLAIMS = {
  description: '编辑面板打开，保存后资料更新',
  claims: [
    { id: 'editor-opened', text: '编辑面板已打开。', assertionRefs: ['editor-visible'] },
    { id: 'profile-saved', text: '资料已保存。', assertionRefs: ['profile-saved-toast'] },
  ],
};

/** 保存步骤因写操作边界未执行：只有 editor-visible 在 after 阶段通过。 */
function evidence() {
  return {
    validations: [{ scope: 'page-identity', assertionId: 'profile-heading', outcome: 'passed', checkedAt: 't0' }],
    steps: [
      { id: 'open-editor', status: 'verified', screenshots: [{ annotated: 'docs/manual/images/annotated/e.png' }], validations: [
        { scope: 'scenario-state', phase: 'before', assertionId: 'profile-heading', outcome: 'passed', checkedAt: 't1' },
        { scope: 'scenario-state', phase: 'after', assertionId: 'editor-visible', outcome: 'passed', checkedAt: 't2' },
      ] },
      { id: 'save', status: 'not-executed', reason: 'stop-before-action', screenshots: [], validations: [] },
    ],
  };
}

process.stdout.write('\ncompletion claims\n');

(async () => {
  await test('保存未执行：「编辑器已打开」verified，「资料已保存」not_run', () => {
    const claims = computeClaims(task(CLAIMS), evidence());
    assert.deepStrictEqual(claims.map((c) => [c.id, c.status]), [['editor-opened', 'verified'], ['profile-saved', 'not_run']]);
    assert.deepStrictEqual(claims[0].evidence, [{ assertionId: 'editor-visible', stepId: 'open-editor', scope: 'scenario-state', checkedAt: 't2' }]);
  });

  await test('completion.verification 字符串不能提升等级：旧任务是 legacy-unbound', () => {
    const claims = computeClaims(task({ description: '资料已保存', verification: 'verified' }), evidence());
    assert.deepStrictEqual(claims.map((c) => c.status), ['legacy-unbound']);
  });

  await test('只在 before 阶段出现的断言、错误检查点的断言都不能证明 claim', () => {
    const before = task({ description: 'x', claims: [{ id: 'on-profile', text: '在个人中心。', assertionRefs: ['profile-heading'], checkpoint: 'open-editor' }] });
    assert.strictEqual(computeClaims(before, evidence())[0].status, 'not_run');
    const wrongCheckpoint = task({ description: 'x', claims: [{ id: 'editor', text: '编辑面板已打开。', assertionRefs: ['editor-visible'], checkpoint: 'save' }] });
    assert.strictEqual(computeClaims(wrongCheckpoint, evidence())[0].status, 'not_run');
    const failed = evidence();
    failed.steps[0].validations[1].outcome = 'failed';
    assert.strictEqual(computeClaims(task(CLAIMS), failed)[0].status, 'failed');
  });

  await test('任务模型校验 claims：id 唯一、文本非空、assertionRefs 非空', () => {
    assert.strictEqual(validateTask(task(CLAIMS)).ok, true, validateTask(task(CLAIMS)).errors?.join('\n'));
    const bad = task({ description: 'x', claims: [
      { id: 'a', text: '一', assertionRefs: [] },
      { id: 'a', text: '', assertionRefs: ['x'] },
    ] });
    const result = validateTask(bad);
    assert.strictEqual(result.ok, false);
    assert.match(result.errors.join('\n'), /assertionRefs/);
    assert.match(result.errors.join('\n'), /重复/);
    assert.match(result.errors.join('\n'), /text/);
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-claims-'));
  try {
    fs.mkdirSync(path.join(root, 'docs/manual/images/annotated'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/manual/images/annotated/e.png'), 'png');
    const ctx = { projectRoot: root, finalPath: path.join(root, 'docs/manual/tasks/edit-profile.md') };

    await test('草稿分开渲染已验证界面结果与预期业务结果，并说明验证范围', () => {
      const draft = buildTaskDraft(task(CLAIMS), evidence(), ctx);
      assert.strictEqual(draft.ok, true, draft.errors?.join('\n'));
      assert.match(draft.markdown, /<!-- claim:editor-opened -->\n已验证界面结果：编辑面板已打开。/);
      assert.match(draft.markdown, /<!-- claim:profile-saved -->\n预期业务结果：资料已保存。/);
      assert.match(draft.markdown, /验证范围/);
      assert.deepStrictEqual(draft.facts.claims.map((c) => [c.id, c.status]), [['editor-opened', 'verified'], ['profile-saved', 'not_run']]);
      assert.strictEqual(validateTaskFinal(draft.markdown, draft.facts).ok, true);
    });

    await test('定稿不能把预期结果改成已验证，也不能新增未引用的声明', () => {
      const draft = buildTaskDraft(task(CLAIMS), evidence(), ctx);
      const promoted = draft.markdown.replace('预期业务结果：资料已保存。', '已验证界面结果：资料已保存。');
      let result = validateTaskFinal(promoted, draft.facts);
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join('\n'), /claim/);

      const extra = draft.markdown + '\n<!-- claim:invented -->\n已验证界面结果：已自动通知管理员。\n';
      result = validateTaskFinal(extra, draft.facts);
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join('\n'), /unsupported-claim/);

      const legacyPhrase = draft.markdown + '\n已验证结果：全部完成。\n';
      assert.strictEqual(validateTaskFinal(legacyPhrase, draft.facts).ok, false);
    });

    await test('旧版 facts（只有 completionVerification）要求重新生成', () => {
      const draft = buildTaskDraft(task(CLAIMS), evidence(), ctx);
      const legacy = { ...draft.facts, completionVerification: 'verified' };
      delete legacy.claims;
      const result = validateTaskFinal(draft.markdown, legacy);
      assert.strictEqual(result.ok, false);
      assert.match(result.errors.join('\n'), /重新运行 generate-task/);
    });

    await test('执行器：风险停止后余下步骤全部显式记录，validation 带 stepId', async () => {
      const calls = [];
      const provider = {
        async open(url) { return { status: 200, finalUrl: url }; },
        async waitUntilReady() { return { steps: {}, warnings: [] }; },
        async assertCondition() { return { ok: true }; },
        async performAction(action) { calls.push(action.type); return { target: action.target, rect: null }; },
        async screenshot({ path: file }) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'png'); return { path: file, bytes: 3, meta: { viewport: { width: 1, height: 1 } } }; },
        async close() {},
      };
      const dialog = { id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } };
      const plan = {
        taskId: 'edit-profile', entry: { page: 'profile', route: '/profile', assertions: [] },
        steps: [
          { id: 'open-editor', page: 'profile', stateBefore: 'default', beforeState: { id: 'default', assertions: [] }, action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, willExecute: true, execution: 'auto', expectedState: { id: 'editor', assertions: [dialog] } },
          { id: 'save', page: 'profile', action: { type: 'click', target: {} }, willExecute: false, execution: 'stop-before-action', expectedState: null },
          { id: 'close', page: 'profile', action: { type: 'click', target: {} }, willExecute: true, execution: 'auto', expectedState: { id: 'default', assertions: [dialog] } },
        ],
      };
      const result = await executeCapturePlan(plan, provider, { baseUrl: 'http://x.test', stateDir: path.join(root, '.manual'), assertionTimeoutMs: 10 });
      assert.deepStrictEqual(result.steps.map((s) => [s.id, s.status, s.reason || null]), [
        ['open-editor', 'verified', null],
        ['save', 'not-executed', 'stop-before-action'],
        ['close', 'not-executed', 'skipped-by-boundary'],
      ]);
      assert.deepStrictEqual(calls, ['click'], '边界之后的步骤不能执行');
      assert.strictEqual(result.steps[0].validations.find((v) => v.phase === 'after').assertionId, 'editor-visible');
      assert.strictEqual(result.steps[0].validations[0].stepId, 'open-editor');
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
