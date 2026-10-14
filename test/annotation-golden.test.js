'use strict';

/*
 * B4-07 / AC-18 标注几何 Golden（真实 Chromium + 本地测试站）：
 *   DPR 1 / 1.5 / 2 × 视口截图 / 整页截图（页面先滚到中部），目标分别是
 *   sticky 顶栏里的按钮、长页面深处的按钮、fixed 底栏里的按钮；fixed 底栏里的手机号输入框需要隐私遮罩。
 * 断言的是像素：换算后的目标矩形中心在原图里正是该按钮的颜色、目标框落在按钮四周、遮罩盖住输入框。
 * 不做整图逐像素比对（字体渲染跨平台不同），只断言几何。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { spawn } = require('child_process');
const yaml = require('js-yaml');
const fx = require('./fixtures');
const { startServer } = require('./server');
const { createProvider } = require('../src/browser');
const { toCanvasRect } = require('../src/browser/playwright');
const { captureStable, derivePublished } = require('../src/evidence/capture-safe');
const { DEFAULT_THEME } = require('../src/config/annotation');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
function expectExit(root, args, exit, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      if (status !== exit) return reject(new Error(`manual ${args.join(' ')} 退出 ${status}（期望 ${exit}）\n${stdout}\n${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (_) { resolve(null); }
    });
  });
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

async function pixels(file) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { info, at: (x, y) => { const i = (Math.round(y) * info.width + Math.round(x)) * 3; return [data[i], data[i + 1], data[i + 2]]; } };
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

const TARGETS = [
  { id: 'menu', css: '#menu', color: '#facc15' },
  { id: 'deep', css: '#deep', color: '#1d4ed8' },
  { id: 'buy', css: '#buy', color: '#16a34a' },
];

(async () => {
  process.stdout.write('\nannotation golden\n');
  const server = await startServer();
  const root = fx.makeTempDir('manual-golden-');
  try {
    for (const dpr of [1, 1.5, 2]) {
      for (const fullPage of [false, true]) {
        await test(`DPR ${dpr} · ${fullPage ? '整页（先滚动到中部）' : '视口（按钮滚入视口）'}：框与遮罩落在目标上`, async () => {
          const provider = createProvider({ id: 'playwright-headless', providerConfig: { type: 'playwright', headless: true }, profile: { kind: 'desktop', viewport: { width: 900, height: 600 }, deviceScaleFactor: dpr } });
          const dir = path.join(root, `${dpr}-${fullPage}`);
          fs.mkdirSync(dir, { recursive: true });
          try {
            await provider.installDemoGuard({ baseUrl: server.baseUrl, demo: {} });
            await provider.open(`${server.baseUrl}/layout-golden`, { timeout: 10000 });
            // 视口截图：把深处按钮滚进视口；整页截图：停在中部，验证截图前回到顶部后的换算
            await provider.page.evaluate((y) => window.scrollTo(0, y), fullPage ? 700 : 900);
            const rawPath = path.join(dir, 'raw.png');
            const captured = await captureStable(provider, {
              rawPath, fullPage,
              resolveTargets: async () => {
                const out = [];
                for (const [i, t] of TARGETS.entries()) {
                  const found = await provider.performAction({ type: 'inspect', target: { selector: t.css } });
                  const geometry = await provider.collectGeometry({ fullPage });
                  out.push({ feature_id: t.id, label: String(i + 1), rect: toCanvasRect(found.rect, { fullPage, geometry, pinned: found.pinned }) });
                }
                return out;
              },
            });
            const safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(dir, 'sanitized.png'), publishedPath: path.join(dir, 'published.png'),
              theme: DEFAULT_THEME, redactionRules: { audience: 'public', rules: { redact: [], preserve: [] } } });
            const raw = await pixels(rawPath);
            const pub = await pixels(path.join(dir, 'published.png'));
            const scale = captured.geometry.dpr;
            const shown = TARGETS.filter((t) => captured.targets.find((x) => x.feature_id === t.id).rect.y < (fullPage ? captured.geometry.documentSize.height : 600));
            assert.ok(shown.length >= 2, '至少两个目标在画面里');
            for (const t of shown) {
              const r = captured.targets.find((x) => x.feature_id === t.id).rect;
              if (r.y + r.height > (fullPage ? captured.geometry.documentSize.height : 600)) continue;
              const center = raw.at((r.x + 6) * scale, (r.y + 6) * scale); // 按钮左上内侧（避开文字）
              assert.ok(near(center, hex(t.color)), `${t.id} 的换算位置不在按钮上: ${center} vs ${t.color}（rect ${JSON.stringify(r)}）`);
              const item = safe.rendered.find((x) => x.feature_id === t.id);
              assert.ok(item.drawn && item.visible, `${t.id}: ${item.reason}`);
              // 目标框左边线（外扩 padding）在发布图上是主题主色
              // 采样框线中心所在像素（与渲染器同样取整），避免落在抗锯齿边缘
              const item2 = safe.rendered.find((x) => x.feature_id === t.id);
              const edge = pub.at(item2.target.x, item2.target.y + item2.target.height / 2);
              assert.ok(near(edge, hex(DEFAULT_THEME.primary), 60), `${t.id} 的框线不在按钮左侧: ${edge}`);
            }
            // fixed 底栏里的手机号输入框被遮罩：遮罩与标注用同一套换算
            const phone = safe.redactions.find((item) => item.kind === 'phone' || /phone/.test(item.kind || ''));
            assert.ok(phone, JSON.stringify(safe.redactions.map((r) => r.kind)));
            const m = phone.rect;
            const masked = pub.at((m.x + Math.min(m.width, 24) / 2) * scale, (m.y + m.height / 2) * scale);
            assert.ok(!near(masked, [255, 255, 255], 8), `手机号输入框没有被遮罩（${masked}）`);
            const bar = raw.at(20 * scale, (m.y + m.height / 2) * scale);
            assert.ok(near(bar, hex('#7c2d12')), `遮罩所在行不是底栏: ${bar}`);
          } finally { await provider.close(); }
        });
      }
    }

    // ------------------------------------------------------------ AC-16 端到端：7 个标注、单图上限 5 → 两张图进入手册
    await test('AC-16 端到端：分类工具栏的 7 个操作拆成两图并沿用步骤号；B6-08 删掉 .manual/artifacts 后离线验证仍可核对，缺发布图明确报错', async () => {
      const project = fx.captureFixture();
      try {
        fx.writeFile(project, 'app/layout-dense/page.tsx');
        const env = { MANUAL_AUTH_CACHE_DIR: path.join(project, '.auth-cache') };
        await expectExit(project, ['init', '--base-url', server.baseUrl, '--audience', 'internal', '--profile', 'custom', '--viewport', '1000x700', '--dpr', '1'], 0, env);
        await expectExit(project, ['inspect'], 0, env);
        const names = ['新建', '导入', '导出', '分享', '打印', '归档', '删除'];
        const input = path.join(project, 'describe.json');
        fs.writeFileSync(input, JSON.stringify({ pages: [{ id: 'layout-dense', title: '批改工具栏', purpose: '管理批改任务。' }] }));
        await expectExit(project, ['describe', '--input', input], 0, env);
        const file = path.join(project, '.manual', 'pages', 'layout-dense.yaml');
        const page = yaml.load(fs.readFileSync(file, 'utf8'));
        page.guide = names.map((name, i) => ({ id: `tool-${i + 1}`, title: name, instruction: `点击「${name}」。`, target: { role: 'button', name } }));
        page.schemaVersion = 3;
        page.features = page.guide.map(g => ({ id: `page:${page.id}:${g.id}`, guideId: g.id, label: g.title, priority: 'required', contentKind: 'operation', operations: [{ id: g.id, instruction: g.instruction, evidenceRequirement: 'entry', targetHint: g.target }] }));
        page.sections = [{ id: 'toolbar', title: '管理批改任务', goal: '找到批改工具栏的操作入口。', featureRefs: page.features.map(f => f.id), figureRefs: ['toolbar'] }];
        page.figures = [{ id: 'toolbar', sectionId: 'toolbar', purpose: 'entry', caption: '批改工具栏', operationRefs: page.guide.map(g => g.id), frame: { mode: 'auto' } }];
        fs.writeFileSync(file, yaml.dump(page));
        const out = await expectExit(project, ['generate', 'page:layout-dense', '--copy-default'], 0, env);
        const record = JSON.parse(fs.readFileSync(path.join(project, '.manual', 'evidence', 'captures', `${JSON.parse(fs.readFileSync(path.join(project, '.manual', 'evidence', 'latest.json'), 'utf8')).refs['page:layout-dense']}.json`), 'utf8'));
        const parts = record.artifacts.filter((a) => a.kind === 'published');
        assert.deepStrictEqual(parts.map((a) => a.part), [1, 2], JSON.stringify(record.artifacts.map((a) => a.kind)));
        assert.ok(/--part-2--/.test(parts[1].path), parts[1].path);
        // 标注号即步骤号：第二张图接着画 6、7，与正文第 6、7 步对应
        assert.deepStrictEqual(record.annotationProof.rendered.map((r) => [r.label, r.part]), names.map((_, i) => [String(i + 1), i < 5 ? 1 : 2]));
        const doc = fs.readFileSync(path.join(project, 'docs', 'manual', 'layout-dense.md'), 'utf8');
        const images = [...doc.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
        assert.strictEqual(images.length, 2, doc);
        assert.ok(path.basename(images[0]) === path.basename(parts[0].path) && path.basename(images[1]) === path.basename(parts[1].path));
        assert.ok(out, 'generate 有输出');

        // B6-08 干净 clone：不入库的 .manual/artifacts（原图、sidecar、派生中间件）全部缺失时，
        // 离线验证仍能靠入库的精简证明核对；入库的发布图缺失时明确报错，而不是误判通过
        fs.rmSync(path.join(project, '.manual', 'artifacts'), { recursive: true, force: true });
        const verified = await expectExit(project, ['verify', 'page:layout-dense'], 0, env);
        assert.strictEqual(verified.status, 'artifact-verified');
        fs.rmSync(path.join(project, parts[1].path));
        const failed = await new Promise((resolve) => {
          const child = spawn(process.execPath, [CLI, 'verify', 'page:layout-dense', '--project-root', project, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
          let stdout = '';
          child.stdout.on('data', (d) => { stdout += d; });
          child.on('close', (status) => resolve({ status, json: JSON.parse(stdout || '{}') }));
        });
        assert.notStrictEqual(failed.status, 0);
        assert.match(JSON.stringify(failed.json.errors), /part-2/, '缺失的拆分图被点名');
      } finally { fx.cleanup(project); }
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
