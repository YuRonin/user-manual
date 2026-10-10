'use strict';

// 暂态提示条遮挡操作目标（B1-11）：真 Chromium，页面用 data: URL 内联。
const assert = require('assert');
const { createProvider } = require('../src/browser');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const profile = { kind: 'desktop', viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 };
const providerConfig = { type: 'playwright', headless: true, channel: 'chromium' };

/** 「更多操作」按钮被固定定位的提示条盖住；hideAfterMs 后提示条移除，null 表示一直不消失。 */
function page(hideAfterMs) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><body style="margin:0">
    <button id="more" style="position:absolute;left:300px;top:20px;width:120px;height:40px" onclick="window.clicks=(window.clicks||0)+1">更多操作</button>
    <div id="toast" role="status" style="position:fixed;left:250px;top:0;width:300px;height:100px;background:#333;color:#fff">保存成功</div>
    <script>${hideAfterMs === null ? '' : `setTimeout(() => document.getElementById('toast').remove(), ${hideAfterMs});`}</script></body>`);
}

(async () => {
  process.stdout.write('\ntarget obscured\n');

  await test('提示条短暂遮挡：移开指针并等待其消失后点击一次', async () => {
    const provider = createProvider({ id: 'obscured-test', providerConfig, profile });
    try {
      await provider.open(page(800));
      await provider.performAction({ type: 'click', target: { role: 'button', name: '更多操作' } });
      assert.strictEqual(await provider.page.evaluate(() => window.clicks), 1);
    } finally { await provider.close(); }
  });

  await test('提示条一直不消失：有界等待后报 target-obscured，不点击、不重放', async () => {
    const provider = createProvider({ id: 'obscured-test', providerConfig, profile });
    try {
      await provider.open(page(null));
      const started = Date.now();
      await assert.rejects(
        () => provider.performAction({ type: 'click', target: { role: 'button', name: '更多操作' } }),
        (error) => error.code === 'target-obscured' && /status「保存成功」/.test(error.message),
      );
      assert.ok(Date.now() - started < 15000, '等待有上限');
      assert.strictEqual(await provider.page.evaluate(() => window.clicks || 0), 0);
      const { toErrorResult } = require('../src/runtime/errors');
      assert.strictEqual(toErrorResult(Object.assign(new Error('x'), { code: 'target-obscured' })).retryable, false);
    } finally { await provider.close(); }
  });

  await test('标注定位：被浮层盖住的目标报告 obscuredBy（采集记为 target-occluded），未遮挡时为 null', async () => {
    const provider = createProvider({ id: 'obscured-test', providerConfig, profile });
    try {
      await provider.open(page(null));
      const covered = await provider.performAction({ type: 'inspect', target: { role: 'button', name: '更多操作' } });
      assert.match(covered.obscuredBy, /保存成功/);
      await provider.page.evaluate(() => document.getElementById('toast').remove());
      const clear = await provider.performAction({ type: 'inspect', target: { role: 'button', name: '更多操作' } });
      assert.strictEqual(clear.obscuredBy, null);
    } finally { await provider.close(); }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
