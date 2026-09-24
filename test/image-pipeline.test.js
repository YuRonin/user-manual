'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const { deriveImages, toImageRect } = require('../src/evidence/image-pipeline');
const { DEFAULT_THEME } = require('../src/config/annotation');
const { DEFAULT_MOSAIC } = require('../src/privacy/renderer');
const { sha256Hex } = require('../src/util/hash');
const { executeCapturePlan } = require('../src/tasks/executor');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-image-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const RED = { r: 255, g: 0, b: 0 };

/** 纯红 raw：任何残留的红色像素都说明遮罩没盖住。 */
async function redPng(file, width, height) {
  await sharp({ create: { width, height, channels: 3, background: RED } }).png().toFile(file);
  return file;
}

async function pixels(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  return { data, info, at(x, y) { const i = (y * info.width + x) * info.channels; return [data[i], data[i + 1], data[i + 2]]; } };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const MOSAIC_COLORS = [DEFAULT_MOSAIC.base, DEFAULT_MOSAIC.cellA, DEFAULT_MOSAIC.cellB].map(hexToRgb);

/** 遮罩像素：落在马赛克调色范围内（含圆角抗锯齿的混合色），与纯红 raw 完全无关。 */
function isMosaic(rgb) {
  const [lo, hi] = [0, 1, 2].map((i) => [Math.min(...MOSAIC_COLORS.map((c) => c[i])), Math.max(...MOSAIC_COLORS.map((c) => c[i]))]).reduce((acc, [l, h]) => [[...acc[0], l], [...acc[1], h]], [[], []]);
  return rgb.every((v, i) => v >= lo[i] - 2 && v <= hi[i] + 2);
}

process.stdout.write('\nimage pipeline\n');

(async () => {
  await test('坐标换算：按 DPR 放大、向外取整、裁剪到图像范围，完全在图外返回 null', () => {
    assert.deepStrictEqual(toImageRect({ x: 10.4, y: 10, width: 20, height: 10 }, { dpr: 2, width: 200, height: 200 }), { x: 20, y: 20, width: 41, height: 20 });
    assert.deepStrictEqual(toImageRect({ x: 90, y: 90, width: 50, height: 50 }, { dpr: 1, width: 100, height: 100 }), { x: 90, y: 90, width: 10, height: 10 });
    assert.strictEqual(toImageRect({ x: 200, y: 0, width: 10, height: 10 }, { dpr: 1, width: 100, height: 100 }), null);
  });

  for (const dpr of [1, 2]) {
    await test(`DPR=${dpr}：遮罩完全覆盖目标像素，区域外像素不变，raw 字节不变`, async (root) => {
      const raw = await redPng(path.join(root, 'raw.png'), 200 * dpr, 100 * dpr);
      const rawHash = sha256Hex(fs.readFileSync(raw));
      const rect = { x: 30, y: 20, width: 60, height: 16 };
      const result = await deriveImages({
        rawPath: raw, geometry: { dpr }, redactions: [{ kind: 'phone', rect, result: 'neutral-mosaic' }], annotations: [], theme: DEFAULT_THEME,
        sanitizedPath: path.join(root, 'sanitized.png'), publishedPath: path.join(root, 'published.png'),
      });
      assert.strictEqual(sha256Hex(fs.readFileSync(raw)), rawHash, 'raw 不能被修改');
      assert.strictEqual(result.rawHash, `sha256:${rawHash}`);
      const img = await pixels(path.join(root, 'published.png'));
      assert.strictEqual(img.info.width, 200 * dpr);
      for (let y = rect.y * dpr; y < (rect.y + rect.height) * dpr; y++) {
        for (let x = rect.x * dpr; x < (rect.x + rect.width) * dpr; x++) {
          const rgb = img.at(x, y);
          assert.ok(isMosaic(rgb), `(${x},${y}) 未被遮罩: ${rgb}`);
        }
      }
      assert.deepStrictEqual(img.at(5, 5), [255, 0, 0]);
      assert.deepStrictEqual(img.at((rect.x + rect.width) * dpr + 30, rect.y * dpr), [255, 0, 0]);
      assert.strictEqual(result.publishedSha256, sha256Hex(fs.readFileSync(path.join(root, 'published.png'))));
    });
  }

  await test('标注只叠加在 sanitized 之上：遮罩区依然不透明，标注框被画出', async (root) => {
    const raw = await redPng(path.join(root, 'raw.png'), 300, 200);
    const annotations = [{ label: 1, target: { x: 100, y: 100, width: 60, height: 30 }, marker: { x: 60, y: 100, size: 30 } }];
    await deriveImages({
      rawPath: raw, geometry: { dpr: 1 }, redactions: [{ kind: 'phone', rect: { x: 10, y: 10, width: 50, height: 12 }, result: 'neutral-mosaic' }], annotations, theme: DEFAULT_THEME,
      sanitizedPath: path.join(root, 's.png'), publishedPath: path.join(root, 'p.png'),
    });
    const sanitized = await pixels(path.join(root, 's.png'));
    const published = await pixels(path.join(root, 'p.png'));
    assert.ok(isMosaic(published.at(30, 15)));
    assert.deepStrictEqual(sanitized.at(100, 115), [255, 0, 0], 'sanitized 不含标注');
    assert.notDeepStrictEqual(published.at(100, 115), [255, 0, 0], '发布图在目标左边框处应有标注描边');
    assert.notDeepStrictEqual(published.at(75, 115), [255, 0, 0], '序号圆点应被画出');
  });

  // ------------------------------------------------------------ 执行器：几何稳定性与 after 目标重定位
  const PNG = await sharp({ create: { width: 100, height: 100, channels: 3, background: RED } }).png().toBuffer();
  class Provider {
    constructor({ unstable = false, targetGone = false } = {}) { this.unstable = unstable; this.targetGone = targetGone; this.generation = 0; this.shots = 0; this.clicked = false; }
    async open(url) { return { status: 200, finalUrl: url }; }
    async waitUntilReady() { return { steps: {}, warnings: [] }; }
    async assertCondition() { return { ok: true }; }
    async performAction(action) {
      if (action.type === 'click') { this.clicked = true; return { target: action.target, rect: { x: 10, y: 10, width: 20, height: 10 } }; }
      if (this.targetGone && this.clicked) throw Object.assign(new Error('gone'), { code: 'target-not-visible' });
      // 动作后目标移动了：截图时的位置与动作前不同
      return { target: action.target, rect: this.clicked ? { x: 50, y: 60, width: 20, height: 10 } : { x: 10, y: 10, width: 20, height: 10 } };
    }
    async collectGeometry() { if (this.unstable) this.generation++; return { viewport: { width: 100, height: 100 }, scroll: { x: 0, y: 0 }, dpr: 1, documentSize: { width: 100, height: 100 }, mutationGeneration: this.generation }; }
    async collectSensitiveElements() { return [{ text: '13812345678', label: '手机号', source: 'form-control', rect: { x: 5, y: 80, width: 40, height: 10 } }]; }
    async screenshot({ path: file }) { this.shots++; fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, PNG); return { path: file, bytes: PNG.length, meta: { viewport: { width: 100, height: 100 }, deviceScaleFactor: 1 } }; }
    async close() {}
  }
  const plan = () => ({
    taskId: 't', entry: { page: 'p', route: '/p', assertions: [] },
    steps: [{ id: 'open', page: 'p', stateBefore: 'default', beforeState: { assertions: [] }, action: { type: 'click', target: { role: 'button', name: '打开' } }, willExecute: true, execution: 'auto',
      expectedState: { id: 'open', assertions: [{ type: 'visible', target: { role: 'dialog', name: '面板' } }] }, capture: { timing: 'after', annotations: [{ target: 'action.target', label: 1 }] } }],
  });
  const opts = (root) => ({ baseUrl: 'http://x.test', stateDir: path.join(root, '.manual'), projectRoot: root, annotatedDir: 'docs/manual/images/annotated', theme: DEFAULT_THEME, redactionRules: { audience: 'public', rules: { redact: [], preserve: [] } }, assertionTimeoutMs: 10 });

  await test('执行器：after 标注使用截图时刻重新定位的矩形，隐私记录与派生信息写入证据', async (root) => {
    const provider = new Provider();
    const result = await executeCapturePlan(plan(), provider, opts(root));
    const shot = result.steps[0].screenshots[0];
    assert.strictEqual(shot.annotations[0].target.x, 50 - DEFAULT_THEME.targetPadding, '不能使用动作前的旧矩形');
    assert.strictEqual(shot.privacy.status, 'passed');
    assert.deepStrictEqual(shot.privacy.maskStyles, ['neutral-mosaic']);
    assert.match(shot.derivedFromRawHash, /^sha256:/);
    assert.ok(shot.geometryHash && shot.rendererVersion);
    const published = await pixels(path.join(root, shot.annotated));
    assert.ok(isMosaic(published.at(20, 85)), '手机号区域必须被遮罩');
    assert.strictEqual(provider.shots, 1, '发布图不再由浏览器重新截图');
  });

  await test('执行器：after 目标消失时返回 annotation-target-missing，不写发布图', async (root) => {
    await assert.rejects(() => executeCapturePlan(plan(), new Provider({ targetGone: true }), opts(root)), (e) => e.code === 'annotation-target-missing');
    assert.ok(!fs.existsSync(path.join(root, 'docs')), '失败产物不能进入文档目录');
  });

  await test('执行器：截图前后 DOM 持续变化时有限重试后返回 geometry-unstable', async (root) => {
    const provider = new Provider({ unstable: true });
    await assert.rejects(() => executeCapturePlan(plan(), provider, opts(root)), (e) => e.code === 'geometry-unstable');
    assert.strictEqual(provider.shots, 4, '3 次尝试 + 1 张失败诊断图（私有目录）');
    assert.ok(fs.existsSync(path.join(root, '.manual', 'artifacts', 'diagnostics', 't--open--failure.png')));
    assert.ok(!fs.existsSync(path.join(root, 'docs')));
  });

  await test('执行器：强制遮罩的高风险项没有几何时标 unresolved，发布门槛会拒绝', async (root) => {
    const provider = new Provider();
    provider.collectSensitiveElements = async () => [{ text: '13812345678', label: '手机号', source: 'form-control', rect: null }];
    const result = await executeCapturePlan(plan(), provider, opts(root));
    const privacy = result.steps[0].screenshots[0].privacy;
    assert.strictEqual(privacy.status, 'failed');
    assert.deepStrictEqual(privacy.unresolved.map((u) => u.kind), ['phone']);
    assert.strictEqual(result.steps[0].screenshots[0].annotated, null, '隐私未通过时不产出发布图');
    assert.ok(!fs.existsSync(path.join(root, 'docs')));
  });

  // ------------------------------------------------------------ 真浏览器：页面采集走同一条管线
  const { spawn } = require('child_process');
  const fx = require('./fixtures');
  const { startServer } = require('./server');
  const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');
  const runCli = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const server = await startServer();
  const isRed = (rgb) => rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60;
  try {
    for (const [dpr, fullPage] of [[1, false], [2, false], [1, true]]) {
      await test(`真浏览器页面采集 DPR=${dpr}${fullPage ? ' 整页' : ''}：发布图遮住手机号${fullPage ? '与视口外邮箱' : ''}，原图保留在私有目录`, async () => {
        const project = fx.captureFixture();
        try {
          let r = await runCli(['init', '--project-root', project, '--base-url', server.baseUrl, '--profile', 'custom', '--viewport', '800x600', '--dpr', String(dpr)]);
          assert.strictEqual(r.status, 0, r.stderr);
          r = await runCli(['inspect', '--project-root', project]);
          assert.strictEqual(r.status, 0, r.stderr);
          r = await runCli(['capture', 'chat', '--project-root', project, '--url', `${server.baseUrl}/privacy-page`, '--json', ...(fullPage ? ['--full-page'] : [])]);
          assert.strictEqual(r.status, 0, r.stdout + r.stderr);
          const out = JSON.parse(r.stdout);
          assert.strictEqual(out.published.artifactPath, 'docs/manual/images/annotated/page--chat.png');
          assert.strictEqual(out.published.privacy.status, 'passed');
          assert.deepStrictEqual(out.published.privacy.maskStyles, ['neutral-mosaic']);
          assert.ok(!r.stdout.includes('13812345678') && !r.stdout.includes('teacher@example.com'), '输出不能含敏感原文');

          const rawFile = path.join(project, '.manual', 'artifacts', 'raw', 'pages', 'chat.png');
          const raw = await pixels(rawFile);
          const pub = await pixels(path.join(project, out.published.artifactPath));
          assert.strictEqual(pub.info.width, raw.info.width);
          assert.strictEqual(pub.info.width, 800 * dpr);
          assert.strictEqual(out.published.derivedFromRawHash, `sha256:${sha256Hex(fs.readFileSync(rawFile))}`);

          const kinds = out.redactions.map((item) => item.kind);
          assert.ok(kinds.includes('phone'), JSON.stringify(out.redactions));
          assert.strictEqual(kinds.includes('email'), fullPage, '视口截图不包含视口外的邮箱；整页截图必须覆盖它');
          for (const item of out.redactions) {
            const cx = Math.floor((item.rect.x + item.rect.width / 2) * dpr);
            const cy = Math.floor((item.rect.y + item.rect.height / 2) * dpr);
            assert.ok(isRed(raw.at(cx, cy)), `raw 在 ${item.kind} 中心应是红色`);
            assert.ok(isMosaic(pub.at(cx, cy)), `${item.kind} 在发布图中未被遮罩: ${pub.at(cx, cy)}`);
          }
          if (fullPage) assert.ok(out.redactions.find((item) => item.kind === 'email').rect.y > 600, '整页坐标应为文档坐标');
          assert.ok(!fs.existsSync(path.join(project, 'docs', 'manual', 'images', 'raw')), '原图不进文档目录');
        } finally {
          fx.cleanup(project);
        }
      });
    }
  } finally {
    await server.close();
  }

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
