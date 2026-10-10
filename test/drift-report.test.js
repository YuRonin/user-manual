'use strict';

/*
 * P3-04：语义与视觉漂移报告（真实浏览器 + CLI 子进程）。
 *   - 按钮改名 → content-changed（drift，退出码 4），说明新增 / 消失的界面名称
 *   - 布局移动 → visual-only（退出码 0），给出差异比例、包围盒与差异 PNG
 *   - 时钟区域变化 → 未声明动态区域时 visual-only；声明后被 mask，结果无漂移
 *   - mask 与页面身份断言目标重叠 → 拒绝 mask 并警告
 *   - 视口规格变化 → environment-incompatible，不做像素比较、不报页面回归
 *   - 验证发现差异不会自动接受新基线（发布记录与 Capture 不变）
 * 另含语义摘要解析与图像比较的单元用例（不需要浏览器）。
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const sharp = require('sharp');

const fx = require('./fixtures');
const { startServer } = require('./server');
const releases = require('../src/publication/release-store');
const { parseAriaSnapshot, semanticSummary, compareSemantic } = require('../src/verify/semantic-diff');
const { compareImages, applicableMasks, environmentCompatible } = require('../src/verify/visual-diff');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

function cli(root, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, json: (() => { try { return JSON.parse(stdout); } catch (_) { return null; } })() }));
  });
}

async function expectExit(root, args, exit, env) {
  const r = await cli(root, args, env);
  assert.strictEqual(r.status, exit, `manual ${args.join(' ')} 应以 ${exit} 退出\n${r.stdout}\n${r.stderr}`);
  return r.json;
}

let passed = 0;
const failures = [];
async function step(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const writeJson = (file, v) => { fs.writeFileSync(file, JSON.stringify(v)); return file; };

(async () => {
  process.stdout.write('\ndrift report\n');

  // ---------------------------------------------------------------- 单元
  await step('语义摘要：只保留白名单角色与名称，丢弃正文与控件值，名称中的个人信息被替换', () => {
    const items = parseAriaSnapshot([
      '- heading "数据看板" [level=1]',
      '- paragraph: 本周新增用户 128 人。',
      '- button "导出报表"',
      '- textbox "手机号": "13812345678"',
      '- link "联系 a@b.com":',
      '  - /url: /x',
    ].join('\n'));
    assert.deepStrictEqual(items, [
      { role: 'heading', name: '数据看板', level: 1 },
      { role: 'button', name: '导出报表' },
      { role: 'textbox', name: '手机号' },
      { role: 'link', name: '联系 [redacted]' },
    ]);
    const a = semanticSummary(items);
    const b = semanticSummary(items.map((i) => (i.role === 'button' ? { ...i, name: '下载报表' } : i)));
    assert.deepStrictEqual(compareSemantic(a, a).status, 'same');
    assert.deepStrictEqual(compareSemantic(a, b), { status: 'changed', added: ['button:下载报表'], removed: ['button:导出报表'] });
    assert.strictEqual(compareSemantic(null, b).status, 'baseline-missing');
  });

  await step('图像比较：阈值、mask、尺寸变化；关键区域不能被 mask；环境字段逐项比较', async () => {
    const dir = fx.makeTempDir('manual-visual-');
    try {
      const make = (file, color) => sharp({ create: { width: 40, height: 20, channels: 4, background: color } }).png().toFile(path.join(dir, file));
      await make('a.png', '#ffffff');
      await sharp(path.join(dir, 'a.png')).composite([{ input: { create: { width: 10, height: 10, channels: 4, background: '#000000' } }, left: 0, top: 0 }]).png().toFile(path.join(dir, 'b.png'));
      const changed = await compareImages({ baseline: path.join(dir, 'a.png'), current: path.join(dir, 'b.png'), diffPath: path.join(dir, 'diff.png') });
      assert.strictEqual(changed.status, 'changed');
      assert.strictEqual(changed.diffPixels, 100);
      assert.deepStrictEqual(changed.bbox, { x: 0, y: 0, width: 10, height: 10 });
      assert.ok(fs.existsSync(path.join(dir, 'diff.png')));
      const masked = await compareImages({ baseline: path.join(dir, 'a.png'), current: path.join(dir, 'b.png'), masks: [{ x: 0, y: 0, width: 10, height: 10 }] });
      assert.strictEqual(masked.status, 'same');
      await sharp({ create: { width: 30, height: 20, channels: 4, background: '#ffffff' } }).png().toFile(path.join(dir, 'c.png'));
      assert.strictEqual((await compareImages({ baseline: path.join(dir, 'a.png'), current: path.join(dir, 'c.png') })).status, 'size-changed');
      const { used, refused } = applicableMasks([{ id: 'clock', rect: { x: 0, y: 0, width: 5, height: 5 } }, { id: 'total', rect: { x: 50, y: 50, width: 5, height: 5 } }], [{ id: 'amount', rect: { x: 52, y: 52, width: 10, height: 10 } }]);
      assert.deepStrictEqual([used.map((m) => m.id), refused], [['clock'], [{ id: 'total', overlaps: 'amount' }]]);
      assert.strictEqual(environmentCompatible(null, {}).ok, false);
      assert.deepStrictEqual(environmentCompatible({ dpr: 1 }, { dpr: 2 }).mismatches, ['dpr: 1 → 2']);
    } finally { fx.cleanup(dir); }
  });

  // ---------------------------------------------------------------- 端到端
  const server = await startServer();
  const root = fx.captureFixture();
  const env = { MANUAL_AUTH_CACHE_DIR: path.join(root, '.auth-cache') };
  const state = path.join(root, '.manual');
  const configFile = path.join(state, 'config.yaml');
  const editConfig = (fn) => { const c = yaml.load(fs.readFileSync(configFile, 'utf8')); fn(c); fs.writeFileSync(configFile, yaml.dump(c)); };
  const verify = (exit) => expectExit(root, ['verify', 'page:dashboard', '--live'], exit, env).then((out) => out.reports[0]);
  try {
    await step('准备：发布仪表盘页面（页面身份断言：标题）', async () => {
      fx.writeFile(root, 'app/dashboard/page.tsx');
      await expectExit(root, ['init', '--base-url', server.baseUrl, '--audience', 'public'], 0, env);
      await expectExit(root, ['inspect'], 0, env);
      await expectExit(root, ['describe', '--input', writeJson(path.join(root, 'describe.json'), { pages: [{ id: 'dashboard', title: '数据看板', purpose: '查看本周数据。', features: [{ id: 'export', label: '导出报表', priority: 'optional' }] }] })], 0, env);
      const file = path.join(state, 'pages', 'dashboard.yaml');
      const page = yaml.load(fs.readFileSync(file, 'utf8'));
      page.states = { default: { assertions: [{ id: 'dashboard-heading', type: 'visible', target: { role: 'heading', name: '数据看板' } }] } };
      fs.writeFileSync(file, yaml.dump(page));
      await expectExit(root, ['generate', 'page:dashboard', '--copy-default'], 0, env);
      const release = releases.readCurrentRelease(state, 'page-dashboard');
      const record = JSON.parse(fs.readFileSync(path.join(state, 'evidence', 'captures', `${release.captureIds[0]}.json`), 'utf8'));
      assert.ok(record.semantic.items.some((i) => i.role === 'button' && i.name === '导出报表'), '采集记录语义摘要');
      assert.ok(record.environment.browserVersion && record.environment.dpr, '采集记录环境');
    });

    await step('无变化：没有漂移', async () => {
      const report = await verify(0);
      assert.strictEqual(report.drift.classification, 'none', JSON.stringify(report.drift));
      assert.strictEqual(report.drift.visual.status, 'same');
    });

    await step('按钮改名（行为断言不涉及它）：content-changed → drift，退出码 4', async () => {
      server.set({ exportLabel: '下载报表' });
      const report = await verify(4);
      assert.strictEqual(report.result, 'drift');
      assert.strictEqual(report.drift.classification, 'content-changed');
      assert.deepStrictEqual([report.drift.semantic.added, report.drift.semantic.removed], [['button:下载报表'], ['button:导出报表']]);
      server.reset();
    });

    await step('布局移动：visual-only，退出码 0，差异比例 / 包围盒 / 差异图可定位', async () => {
      server.set({ shift: 80 });
      const report = await verify(0);
      assert.strictEqual(report.result, 'passed', '视觉差异不能否定已验证行为');
      assert.strictEqual(report.drift.classification, 'visual-only');
      assert.ok(report.drift.visual.ratio > 0.002 && report.drift.visual.bbox);
      assert.ok(fs.existsSync(path.join(root, report.drift.visual.diffPath)));
      assert.deepStrictEqual(fs.readdirSync(path.join(state, 'verifications')).filter((f) => f.startsWith('.work-')), [], '原图等中间产物已删除');
      server.reset();
    });

    await step('时钟区域变化：未声明动态区域 → visual-only；声明后被 mask → 无漂移', async () => {
      // 时钟只占整页很小一块：用更严格的阈值让它可见
      editConfig((c) => { c.verify = { visual: { threshold: 0.00001 } }; });
      server.set({ clock: '23:59' });
      const unmasked = await verify(0);
      assert.strictEqual(unmasked.drift.classification, 'visual-only', JSON.stringify(unmasked.drift.visual));
      editConfig((c) => { c.verify = { visual: { threshold: 0.00001, dynamicRegions: [{ id: 'clock', selector: '#clock' }] } }; });
      const report = await verify(0);
      assert.strictEqual(report.drift.classification, 'none', JSON.stringify(report.drift.visual));
      assert.deepStrictEqual(report.drift.visual.masks, ['clock']);
      server.reset();
    });

    await step('mask 覆盖页面身份断言目标：拒绝并警告，标题变化仍被发现', async () => {
      editConfig((c) => { c.verify = { visual: { dynamicRegions: [{ id: 'title', selector: 'h1' }] } }; });
      const report = await verify(0);
      assert.deepStrictEqual(report.drift.visual.refusedMasks, [{ id: 'title', overlaps: 'dashboard-heading' }]);
      assert.ok(report.drift.warnings.some((w) => /critical-region-not-masked/.test(w)));
      editConfig((c) => { delete c.verify; });
    });

    await step('视口规格变化：environment-incompatible，不做像素比较', async () => {
      editConfig((c) => { c.capture.profiles[c.capture.activeProfile].viewport.width -= 200; });
      const report = await verify(0);
      assert.strictEqual(report.drift.classification, 'environment-incompatible');
      assert.ok(report.drift.visual.reasons.some((r) => /viewportWidth/.test(r)));
      editConfig((c) => { c.capture.profiles[c.capture.activeProfile].viewport.width += 200; });
    });

    await step('基线不被自动接受：多次发现差异后发布记录与采集记录数不变', async () => {
      const release = releases.readCurrentRelease(state, 'page-dashboard');
      const captures = fs.readdirSync(path.join(state, 'evidence', 'captures')).length;
      server.set({ shift: 40 });
      const report = await verify(0);
      assert.strictEqual(report.drift.baselineAccepted, false);
      assert.strictEqual(releases.readCurrentRelease(state, 'page-dashboard').id, release.id);
      assert.strictEqual(fs.readdirSync(path.join(state, 'evidence', 'captures')).length, captures);
      server.reset();
    });
  } finally {
    await server.close();
    fx.cleanup(root);
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
