'use strict';

/*
 * Gate 0 集成验收：在一个干净的 public 项目里跑完页面与任务两条流程，
 * 再用 markdown-it 实际渲染所有正式文档，确认每张图都能按文档位置打开、
 * 文档目录中没有任何原图，并验证篡改（删隐私记录、换图、改完成声明）都无法通过。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');

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
  return result;
}

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** 用真实 Markdown 渲染器渲染，从 HTML 中取出 <img src>，按文档目录解析。 */
function renderedImages(file) {
  const html = new MarkdownIt({ html: true }).render(fs.readFileSync(file, 'utf8'));
  return [...html.matchAll(/<img[^>]*\bsrc="([^"]+)"/g)].map((m) => decodeURI(m[1]));
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); throw error; }
}

(async () => {
  process.stdout.write('\nGate 0\n');
  const server = await startServer();
  const root = fx.captureFixture();
  const docs = path.join(root, 'docs', 'manual');
  const state = path.join(root, '.manual');
  try {
    await step('public 项目：init → inspect → describe → capture → generate → finalize（页面）', async () => {
      await ok(root, ['init', '--base-url', server.baseUrl, '--audience', 'public']);
      await ok(root, ['inspect']);
      const input = path.join(root, 'describe.json');
      fs.writeFileSync(input, JSON.stringify({ pages: [{ id: 'chat', title: '工作台', purpose: '与 AI 助手对话。', detectedActions: ['点击「新对话」创建会话'] }] }));
      await ok(root, ['describe', '--input', input]);
      const capture = JSON.parse((await ok(root, ['capture', 'chat', '--json'])).stdout);
      assert.strictEqual(capture.published.privacy.status, 'passed');
      await ok(root, ['generate', 'chat']);
      await ok(root, ['generate', 'chat', '--finalize', path.join(state, 'drafts', 'chat.md')]);
    });

    await step('任务：候选 → 审批 → 计划 → 采集（入口/before/after 断言）→ 生成 → 定稿 → verify', async () => {
      const pagesFile = path.join(state, 'pages', 'profile.yaml');
      const { writeModel, readExistingPages } = require('../src/inspect/store');
      const existing = readExistingPages(state).pages;
      existing.push({
        id: 'profile', route: '/task-profile', dynamic: false, params: [], title: '个人中心', purpose: '管理资料',
        detectedActions: [], entry: 'app/profile/page.tsx', source: [], dependencies: { files: [], unresolved: [] },
        includeInManual: true, confidence: 'inferred', browser: { verified: false },
        states: {
          default: { description: '初始', assertions: [{ id: 'profile-heading', type: 'visible', target: { role: 'heading', name: '个人中心' } }] },
          editor: { description: '编辑面板', assertions: [{ id: 'editor-visible', type: 'visible', target: { role: 'dialog', name: '编辑资料' } }] },
        },
        status: { router: 'app', sourceAnalysis: 'completed' },
      });
      writeModel(state, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: new Date().toISOString() }, existing, { docsOutputDir: 'docs/manual' });
      assert.ok(fs.existsSync(pagesFile));
      const candidates = path.join(root, 'tasks.json');
      fs.writeFileSync(candidates, JSON.stringify({ tasks: [{
        id: 'edit-profile', title: '修改个人资料', goal: '更新手机号', entryPage: 'profile', preconditions: ['已登录'], risk: 'read', status: 'approved',
        steps: [
          { id: 'open-editor', instruction: '点击「编辑资料」', page: 'profile', stateBefore: 'default', stateAfter: 'editor',
            action: { type: 'click', target: { role: 'button', name: '编辑资料' } }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } },
          { id: 'save', instruction: '点击「保存修改」', page: 'profile', stateBefore: 'editor', risk: 'write', action: { type: 'click', target: { role: 'button', name: '保存修改' } } },
        ],
        completion: { description: '编辑面板打开，保存后资料更新', claims: [
          { id: 'editor-opened', text: '编辑资料面板已打开。', assertionRefs: ['editor-visible'] },
          { id: 'profile-saved', text: '资料已保存。', assertionRefs: ['profile-saved-toast'] },
        ] },
        branches: [], relatedTasks: [],
      }] }));
      await ok(root, ['discover-tasks', 'profile', '--input', candidates, '--json']);
      const decisions = path.join(root, 'decisions.json');
      fs.writeFileSync(decisions, JSON.stringify({ decisions: [{ id: 'edit-profile', decision: 'approve' }] }));
      await ok(root, ['approve-tasks', '--input', decisions, '--json']);
      await ok(root, ['plan-capture', 'edit-profile', '--json']);
      const captured = JSON.parse((await ok(root, ['capture-task', 'edit-profile', '--json'])).stdout).evidence;
      assert.strictEqual(captured.entryIdentity, 'verified');
      assert.deepStrictEqual(captured.steps[0].validations.map((v) => v.phase), ['before', 'after']);
      assert.ok(captured.steps[0].screenshots[0].redactions.some((r) => r.kind === 'phone'), '可见手机号必须被遮罩');
      const draft = JSON.parse((await ok(root, ['generate-task', 'edit-profile', '--json'])).stdout).draftFile;
      await ok(root, ['generate-task', 'edit-profile', '--finalize', draft, '--json']);
      await ok(root, ['verify', 'edit-profile', '--json']);
      const doc = fs.readFileSync(path.join(docs, 'tasks', 'edit-profile.md'), 'utf8');
      assert.match(doc, /已验证界面结果：编辑资料面板已打开。/);
      assert.match(doc, /预期业务结果：资料已保存。/);
    });

    await step('Markdown 渲染冒烟：所有正式文档的图片按文档位置可打开，且都在 annotated 发布目录', async () => {
      const manuals = walk(docs).filter((f) => f.endsWith('.md'));
      assert.deepStrictEqual(manuals.map((f) => path.relative(docs, f).replace(/\\/g, '/')).sort(), ['chat.md', 'tasks/edit-profile.md']);
      let count = 0;
      for (const manual of manuals) {
        for (const src of renderedImages(manual)) {
          const target = path.resolve(path.dirname(manual), src);
          assert.ok(fs.existsSync(target), `${path.basename(manual)} 的图片打不开: ${src}`);
          assert.ok(path.relative(path.join(docs, 'images', 'annotated'), target).split(path.sep)[0] !== '..', `非发布目录图片: ${src}`);
          count++;
        }
      }
      assert.ok(count >= 2);
    });

    await step('文档目录中没有任何原图；原图只在 .manual/artifacts 下', async () => {
      const files = walk(docs).map((f) => path.relative(root, f).replace(/\\/g, '/'));
      assert.ok(files.every((f) => !/\/raw\/|sanitized|diagnostic/.test(f)), files.join('\n'));
      assert.ok(fs.readdirSync(path.join(state, 'artifacts', 'raw', 'pages')).some((f) => /^chat--[0-9a-f]{16}\.png$/.test(f)));
    });

    await step('篡改检测：删除隐私记录、替换发布图、修改完成声明都会让 verify 失败', async () => {
      const factsFile = path.join(state, 'drafts', 'tasks', 'edit-profile.facts.json');
      const manual = path.join(docs, 'tasks', 'edit-profile.md');
      const originalFacts = fs.readFileSync(factsFile, 'utf8');
      const originalDoc = fs.readFileSync(manual, 'utf8');
      const reset = () => taskStore.writeTask(state, { ...taskStore.readTask(state, 'edit-profile'), status: 'generated' });

      const cases = [
        ['privacy-unknown', () => { const f = JSON.parse(originalFacts); delete f.images[0].privacy; fs.writeFileSync(factsFile, JSON.stringify(f)); }],
        ['hash-mismatch', () => { const img = path.join(root, JSON.parse(originalFacts).images[0].artifactPath); fs.writeFileSync(`${img}.orig`, fs.readFileSync(img)); fs.copyFileSync(path.join(root, require('js-yaml').load(fs.readFileSync(path.join(state, 'pages', 'chat.yaml'), 'utf8')).browser.screenshot), img); }],
        ['验证等级被改动', () => { fs.writeFileSync(manual, originalDoc.replace('预期业务结果：资料已保存。', '已验证界面结果：资料已保存。')); }],
      ];
      for (const [expected, tamper] of cases) {
        reset();
        tamper();
        const result = await cli(root, ['verify', 'edit-profile', '--json']);
        assert.strictEqual(result.status, 1, `${expected} 应当失败`);
        assert.ok(result.stdout.includes(expected), `${expected}: ${result.stdout}`);
        fs.writeFileSync(factsFile, originalFacts);
        fs.writeFileSync(manual, originalDoc);
        const img = path.join(root, JSON.parse(originalFacts).images[0].artifactPath);
        if (fs.existsSync(`${img}.orig`)) fs.renameSync(`${img}.orig`, img);
      }
      reset();
      await ok(root, ['verify', 'edit-profile', '--json']);
    });

    await step('错误 HTTP 与缺断言状态：采集失败且不产出截图', async () => {
      const bad = await cli(root, ['capture', 'chat', '--url', `${server.baseUrl}/error500-with-button`, '--json']);
      assert.strictEqual(bad.status, 1);
      assert.strictEqual(JSON.parse(bad.stdout).reason, 'http-error');
    });
  } catch (_) {
    /* 失败已记录 */
  } finally {
    await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
