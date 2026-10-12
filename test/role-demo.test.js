'use strict';
const assert = require('assert');
const { startServer } = require('./server');
const { createProvider } = require('../src/browser');
const { resolveDemoConfig, decide } = require('../src/privacy/demo');
let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (error) { failures.push(error); console.log(`  ✗ ${name}\n${error.stack}`); } }
(async () => {
 const server = await startServer();
 const p = createProvider({ id: 'playwright-headless', providerConfig: { type: 'playwright', headless: true }, profile: { kind: 'desktop', viewport: { width: 1000, height: 700 }, deviceScaleFactor: 1 } });
 const config = (selectors) => resolveDemoConfig({ demo: { selectors, text: { private: ['演示甲', '演示乙'] } } });
 const prepare = async (selectors) => { await p.installDemoGuard({ baseUrl: server.baseUrl, demo: config(selectors).demo }); await p.open(server.baseUrl + '/role-demo'); await p.applyDemo(); };
 const gate = async () => decide({ audit: await p.auditDemo(), demo: p.demo });
 try {
 await test('外层声明、内层带样式：演示值写进内层元素，保留其 class；有直接文字的区域整体替换', async () => {
  await p.installDemoGuard({ baseUrl: server.baseUrl, demo: config({ private: '.wrap, .mixed' }).demo });
  await p.open(server.baseUrl + '/role-demo');
  await p.page.evaluate(() => document.body.insertAdjacentHTML('beforeend',
   '<p><span class="wrap"><span class="styled" style="font-weight:700">真实余额7356</span></span></p>' +
   '<p><span class="mixed">余额 <b class="inner">真实数字8123</b></span></p>'));
  await p.applyDemo();
  const styled = p.page.locator('.wrap > .styled');
  assert.strictEqual(await styled.count(), 1);
  assert.match(await styled.textContent(), /^演示/);
  assert.strictEqual(await p.page.locator('.mixed .inner').count(), 0);
  assert.match(await p.page.locator('.mixed').textContent(), /^演示/);
  assert.strictEqual((await gate()).status, 'passed');
 });
 await test('角色重复命中全部替换，名称改变后仍可幂等处理与审计', async () => {
  await prepare({ private: { role: 'button', name: '私人说明甲' } });
  assert.deepStrictEqual(await p.page.locator('.private').allTextContents(), ['演示甲', '演示乙']);
  await p.applyDemo(); assert.strictEqual((await gate()).status, 'passed');
 });
 await test('SPA 在下一轮截图前重建目标可重新解析净化', async () => {
  await p.page.evaluate(() => document.querySelectorAll('.private').forEach(el => { const copy = el.cloneNode(); copy.textContent = '私人说明甲'; for (const attr of copy.getAttributeNames()) if (attr.startsWith('data-manual-')) copy.removeAttribute(attr); el.replaceWith(copy); }));
  await p.applyDemo(); assert.strictEqual((await gate()).status, 'passed');
 });
 await test('截图后元素被替换不能放行，审计不修改 DOM', async () => {
  await p.page.screenshot();
  await p.page.evaluate(() => { const el = document.querySelector('.private'); el.outerHTML = '<button class="private">全新的私人说明</button>'; });
  const before = await p.page.content(); assert.strictEqual((await gate()).status, 'blocked'); assert.strictEqual(await p.page.content(), before);
 });
 await test('临时标记丢失不能放行', async () => {
  await prepare({ private: { role: 'button', name: '私人说明甲' } });
  await p.page.evaluate(() => { const el = document.querySelector('.private'); for (const attr of el.getAttributeNames()) if (attr.startsWith('data-manual-sensitive-')) el.removeAttribute(attr); });
  assert.strictEqual((await gate()).status, 'blocked');
 });
 await test('目标不存在与无效配置拒绝，CSS 保持兼容', async () => {
  assert.strictEqual(config({ private: { role: 'button' } }).ok, false);
  assert.strictEqual(config({ private: { role: 'button', name: 'x', exact: false } }).ok, false);
  await prepare({ private: { role: 'button', name: '不存在' } });
  assert.strictEqual((await gate()).status, 'needs_fixture');
  assert.ok((await gate()).reasons.some(r => r.code === 'demo-selector-missing'));
  await prepare({ private: '.private' }); assert.strictEqual((await gate()).status, 'passed');
 });
 await test('语义逐项关联唯一 locator，同名歧义显式记录；不存值、正文或未处理 PII', async () => {
  await p.open(server.baseUrl + '/role-demo');
  const snapshot = await p.semanticSnapshot();
  const unique = snapshot.items.find(i => i.name === '唯一入口'); assert.strictEqual(unique.resolution, 'unique');
  assert.strictEqual(await p.locatorFor(unique.locator).count(), 1);
  const duplicates = snapshot.items.filter(i => i.name === '私人说明甲'); assert.strictEqual(duplicates.length, 2);
  for (const i of duplicates) { assert.strictEqual(i.resolution, 'ambiguous'); assert.strictEqual(i.locator, null); assert.strictEqual(i.matchCount, 2); }
  const json = JSON.stringify(snapshot); assert.doesNotMatch(json, /不应记录|person@private/);
  assert.strictEqual(snapshot.items.find(i => i.name.includes('[redacted]')).locator, null);
  await p.page.locator('.private').first().evaluate(el => el.setAttribute('aria-label', '私人说明甲'));
  p.demo = config({ private: '.private' }).demo;
  await p.applyDemo();
  assert.doesNotMatch(JSON.stringify(await p.semanticSnapshot()), /私人说明甲/);
  await p.page.locator('.private').first().evaluate(el => { el.textContent = '私人 \"说明\"'; el.setAttribute('aria-label', el.textContent); });
  await p.applyDemo();
  assert.doesNotMatch(JSON.stringify(await p.semanticSnapshot()), /私人/);
  await p.page.locator('.private').first().evaluate(el => { el.textContent = '私人   敏感说明'; el.setAttribute('aria-label', el.textContent); });
  await p.applyDemo();
  assert.doesNotMatch(JSON.stringify(await p.semanticSnapshot()), /敏感说明/);
 });
 } finally { await p.close(); await server.close(); }
 console.log(`\n${passed} passed, ${failures.length} failed`); if (failures.length) process.exitCode = 1;
})();
