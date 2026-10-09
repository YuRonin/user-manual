'use strict';

/*
 * manual site：把已发布手册渲染成静态帮助中心。
 *   - 链接改写：文档互链 → 相对 .html，截图 → .webp，危险协议丢弃，死链让构建失败
 *   - 完成段提示框、注释剥离、目录解析
 *   - 配置校验 fail-closed（颜色、URL、输出目录重叠）
 *   - 构建两阶段：有错误一个文件都不写；只清理自己生成过的文件；非托管目录需 --force
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const sharp = require('sharp');

const { writeFile, makeTempDir, cleanup } = require('./fixtures');
const { rewriteHref, parseCatalog, splitCompletion, renderArticleBody, SiteError } = require('../src/site/render');
const { resolveSiteConfig } = require('../src/config/site');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const known = {
  docs: new Set(['index.md', 'credits.md', 'tasks/review-credits.md']),
  images: new Set(['images/annotated/shot.png']),
  appBaseUrl: null,
};
const LABELS = { completion: '完成后你会看到' };

const cli = (root, ...args) => spawnSync(process.execPath, [CLI, 'site', '--project-root', root, '--json', ...args], { encoding: 'utf8' });

const INDEX = `<!-- manual:catalog -->
# 使用手册

## 操作指南

- [查看积分](tasks/review-credits.md)：查看余额与消耗。

## 功能介绍

- [积分中心](credits.md)：积分说明。
<!-- /manual:catalog -->
`;
const TASK = `<!-- manual:block id=overview -->
# 查看积分

查看当前积分。
<!-- /manual:block -->

<!-- manual:block id=steps -->
## 操作步骤

进入 [积分中心](/credits) 页面，说明见[积分中心介绍](../credits.md)。

1. 点击当前积分

   [![积分弹层](../images/annotated/shot.png)](../images/annotated/shot.png)

   *积分弹层显示余额。*

外链 [示例](https://example.com) 与 [危险链接](javascript:alert(1))。
<!-- /manual:block -->

<!-- manual:block id=completion -->
## 如何确认已完成

完成标志：积分明细已显示。
<!-- /manual:block -->
`;

async function publishedProject() {
  const root = makeTempDir('manual-site-');
  const init = spawnSync(process.execPath, [CLI, 'init', '--base-url', 'http://localhost:3000', '--project-root', root, '--yes'], { encoding: 'utf8' });
  assert.strictEqual(init.status, 0, init.stderr + init.stdout);
  writeFile(root, 'docs/manual/index.md', INDEX);
  writeFile(root, 'docs/manual/README.md', '# 维护说明\n');
  writeFile(root, 'docs/manual/credits.md', '# 积分中心\n\n入口：[积分中心](/credits)\n');
  writeFile(root, 'docs/manual/tasks/review-credits.md', TASK);
  fs.mkdirSync(path.join(root, 'docs/manual/images/annotated'), { recursive: true });
  await sharp({ create: { width: 8, height: 5, channels: 3, background: '#ffffff' } }).png().toFile(path.join(root, 'docs/manual/images/annotated/shot.png'));
  await sharp({ create: { width: 8, height: 5, channels: 3, background: '#000000' } }).png().toFile(path.join(root, 'docs/manual/images/annotated/unused.png'));
  return root;
}

const appendConfig = (root, yaml) => fs.appendFileSync(path.join(root, '.manual/config.yaml'), `\n${yaml}\n`);
const read = (root, rel) => fs.readFileSync(path.join(root, '.manual/site', rel), 'utf8');

(async () => {
  process.stdout.write('\nmanual site\n');

  await test('rewriteHref：文档互链改为相对 .html、截图改为 .webp、站内与外链原样、危险协议丢弃', () => {
    assert.deepStrictEqual(rewriteHref('../credits.md#a', 'tasks/review-credits.md', known), { kind: 'doc', href: '../credits.html#a', target: 'credits.md' });
    assert.strictEqual(rewriteHref('tasks/review-credits.md', 'index.md', known).href, 'tasks/review-credits.html');
    assert.strictEqual(rewriteHref('credits.md', 'credits.md', known).href, 'credits.html');
    assert.deepStrictEqual(rewriteHref('../images/annotated/shot.png', 'tasks/review-credits.md', known), { kind: 'image', href: '../images/annotated/shot.webp', target: 'images/annotated/shot.png' });
    assert.deepStrictEqual(rewriteHref('/credits', 'credits.md', known), { kind: 'internal', href: '/credits' });
    assert.deepStrictEqual(rewriteHref('/credits', 'credits.md', { ...known, appBaseUrl: 'https://app.example.com/' }), { kind: 'internal', href: 'https://app.example.com/credits' });
    assert.strictEqual(rewriteHref('https://example.com', 'credits.md', known).kind, 'external');
    for (const href of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', '']) assert.deepStrictEqual(rewriteHref(href, 'credits.md', known), { kind: 'drop' });
  });

  await test('rewriteHref：死链、越界与无法识别的相对链接抛 SiteError', () => {
    assert.throws(() => rewriteHref('missing.md', 'credits.md', known), (e) => e instanceof SiteError && e.code === 'site-dead-link');
    assert.throws(() => rewriteHref('images/annotated/nope.png', 'credits.md', known), (e) => e.code === 'site-dead-link');
    assert.throws(() => rewriteHref('../../x.md', 'tasks/a.md', known), (e) => e.code === 'site-invalid-link');
    assert.throws(() => rewriteHref('notes.txt', 'credits.md', known), (e) => e.code === 'site-invalid-link');
  });

  await test('parseCatalog：解析分组与摘要；缺段、坏行、空分组都失败', () => {
    const catalog = parseCatalog(INDEX, known);
    assert.deepStrictEqual(catalog.map((g) => [g.title, g.items.map((i) => [i.title, i.summary, i.target])]), [
      ['操作指南', [['查看积分', '查看余额与消耗。', 'tasks/review-credits.md']]],
      ['功能介绍', [['积分中心', '积分说明。', 'credits.md']]],
    ]);
    assert.throws(() => parseCatalog('# 无目录', known), (e) => e.code === 'site-catalog-missing');
    assert.throws(() => parseCatalog(INDEX.replace('- [积分中心](credits.md)：积分说明。', '随便一行'), known), (e) => e.code === 'site-catalog-invalid');
    assert.throws(() => parseCatalog('<!-- manual:catalog -->\n## 空\n<!-- /manual:catalog -->', known), (e) => e.code === 'site-catalog-invalid');
  });

  await test('正文渲染：剥离注释、完成段成提示框、危险链接只留文字、截图懒加载', () => {
    assert.strictEqual(splitCompletion('# 无').completion, null);
    const used = new Set();
    const html = renderArticleBody(TASK, 'tasks/review-credits.md', known, used, LABELS);
    assert.doesNotMatch(html, /manual:block|<!--/);
    assert.match(html, /<section class="completion"[^>]*><h2 id="completion-title">完成后你会看到<\/h2><p>完成标志：积分明细已显示。<\/p>/);
    assert.doesNotMatch(html, /如何确认已完成/);
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /危险链接/);
    assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noopener noreferrer">示例<\/a>/);
    assert.match(html, /<img src="..\/images\/annotated\/shot.webp" alt="积分弹层" loading="lazy" decoding="async">/);
    assert.match(html, /<em class="caption">积分弹层显示余额。<\/em>/);
    assert.deepStrictEqual([...used], ['images/annotated/shot.png']);
  });

  await test('配置校验：非十六进制颜色、非法 URL、输出目录与手册重叠或越界都被拒绝', () => {
    const ctx = { stateDir: '.manual', docsOutputDir: 'docs/manual', language: 'zh-CN', audience: 'internal' };
    const ok = resolveSiteConfig(undefined, ctx);
    assert.ok(ok.ok);
    assert.strictEqual(ok.config.outputDir, '.manual/site');
    assert.strictEqual(ok.config.noindex, true, 'internal 手册默认 noindex');
    assert.strictEqual(resolveSiteConfig(undefined, { ...ctx, audience: 'public' }).config.noindex, false);
    for (const raw of [
      { theme: { primary: 'red;}body{display:none' } },
      { theme: { unknown: '#fff' } },
      { homeUrl: 'javascript:alert(1)' },
      { appBaseUrl: '/relative' },
      { outputDir: 'docs/manual/site' },
      { outputDir: 'docs' },
      { outputDir: '../outside' },
      { outputDir: '.' },
      { webpQuality: 0 },
      { support: { items: [{ description: '缺标题' }] } },
    ]) assert.strictEqual(resolveSiteConfig(raw, ctx).ok, false, JSON.stringify(raw));
  });

  await test('CLI：生成首页、正文与 WebP 截图；只发布被引用的截图；README 不暴露', async () => {
    const root = await publishedProject();
    try {
      const result = cli(root);
      assert.strictEqual(result.status, 0, result.stderr + result.stdout);
      const out = JSON.parse(result.stdout);
      assert.deepStrictEqual([out.ok, out.pages, out.documents, out.images.converted], [true, 3, 2, 1]);
      const site = path.join(root, '.manual/site');
      assert.ok(fs.existsSync(path.join(site, 'images/annotated/shot.webp')));
      assert.ok(!fs.existsSync(path.join(site, 'images/annotated/unused.webp')), '未被引用的截图不发布');
      assert.ok(!fs.existsSync(path.join(site, 'README.html')));
      const home = read(root, 'index.html');
      assert.match(home, /<a class="card" href="tasks\/review-credits.html">/);
      assert.doesNotMatch(home, /noindex/, 'init 默认 audience=public，允许收录');
      assert.match(read(root, 'tasks/review-credits.html'), /<link rel="stylesheet" href="..\/assets\/help.css">/);
      assert.match(read(root, 'tasks/review-credits.html'), /<a href="..\/index.html">帮助中心<\/a><\/li><li aria-hidden="true">\/<\/li><li>操作指南<\/li>/);
      assert.match(fs.readFileSync(path.join(root, '.manual/.gitignore'), 'utf8'), /^site\/$/m, '默认输出被 .manual/.gitignore 忽略');

      const again = JSON.parse(cli(root).stdout);
      assert.deepStrictEqual([again.images.converted, again.images.skipped, again.written], [0, 1, 0], '第二次构建全部复用');
    } finally { cleanup(root); }
  });

  await test('CLI：主题色与求助区配置生效，求助图片复制到 assets/', async () => {
    const root = await publishedProject();
    try {
      await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).png().toFile(path.join(root, 'qr.png'));
      appendConfig(root, "site:\n  title: 使用帮助\n  homeUrl: /\n  theme: { primary: '#213271' }\n  support:\n    items:\n      - { title: 问题反馈群, description: 扫码反馈, image: qr.png }");
      const result = cli(root);
      assert.strictEqual(result.status, 0, result.stderr + result.stdout);
      assert.match(read(root, 'assets/help.css'), /--primary:#213271/);
      const home = read(root, 'index.html');
      assert.match(home, /<title>使用帮助<\/title>/);
      assert.match(home, /<a class="back" href="\/">返回应用<\/a>/);
      assert.match(home, /<h2 id="support-title">没找到答案？<\/h2>/);
      assert.match(home, /<img src="assets\/support-1.png" alt="问题反馈群"/);
      assert.ok(fs.existsSync(path.join(root, '.manual/site/assets/support-1.png')));
    } finally { cleanup(root); }
  });

  await test('CLI：死链让构建失败（退出 1），一个文件都不写', async () => {
    const root = await publishedProject();
    try {
      writeFile(root, 'docs/manual/credits.md', '# 积分中心\n\n[坏链](missing.md)\n');
      const result = cli(root);
      assert.strictEqual(result.status, 1, result.stdout);
      const out = JSON.parse(result.stdout);
      assert.strictEqual(out.errors[0].code, 'site-dead-link');
      assert.ok(!fs.existsSync(path.join(root, '.manual/site/index.html')));
    } finally { cleanup(root); }
  });

  await test('CLI：只清理自己生成过的文件；非托管的非空目录需要 --force（退出 4）', async () => {
    const root = await publishedProject();
    try {
      appendConfig(root, 'site:\n  outputDir: public/help');
      writeFile(root, 'public/help/keep.txt', '业务文件');
      const refused = cli(root);
      assert.strictEqual(refused.status, 4, refused.stdout);
      assert.strictEqual(JSON.parse(refused.stdout).errors[0].code, 'site-output-unmanaged');
      assert.ok(!fs.existsSync(path.join(root, 'public/help/index.html')));

      assert.strictEqual(cli(root, '--force').status, 0);
      fs.rmSync(path.join(root, 'docs/manual/credits.md'));
      writeFile(root, 'docs/manual/index.md', INDEX.replace('\n## 功能介绍\n\n- [积分中心](credits.md)：积分说明。\n', '\n'));
      writeFile(root, 'docs/manual/tasks/review-credits.md', TASK.replace('，说明见[积分中心介绍](../credits.md)', ''));
      const rebuilt = cli(root);
      assert.strictEqual(rebuilt.status, 0, rebuilt.stdout);
      assert.deepStrictEqual(JSON.parse(rebuilt.stdout).removed, ['credits.html']);
      assert.strictEqual(fs.readFileSync(path.join(root, 'public/help/keep.txt'), 'utf8'), '业务文件', '不删别人的文件');
    } finally { cleanup(root); }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
