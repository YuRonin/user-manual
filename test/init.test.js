'use strict';

/*
 * `manual init` 的端到端测试：真实 spawn CLI，检查落盘产物。
 * 无测试框架依赖，直接 `node test/init.test.js`。
 */

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];

function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-init-'));
  try {
    fn(root);
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e });
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** 跑 CLI，返回 { status, stdout, stderr }。 */
function runInit(root, args = []) {
  const r = spawnSync(process.execPath, [CLI, 'init', '--project-root', root, ...args], {
    encoding: 'utf8',
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function configPath(root) {
  return path.join(root, '.manual', 'config.yaml');
}

function readConfig(root) {
  return yaml.load(fs.readFileSync(configPath(root), 'utf8'));
}

/** 递归列出目录下所有文件的相对路径。 */
function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

process.stdout.write('\nmanual init\n');

// ---------------------------------------------------------------- 1. 默认路径
test('默认参数生成 config.yaml 与 .gitignore', (root) => {
  const r = runInit(root, ['--base-url', 'http://localhost:5173', '--yes']);
  assert.strictEqual(r.status, 0, `退出码应为 0，实际 ${r.status}\n${r.stderr}`);
  assert.ok(fs.existsSync(configPath(root)), '缺少 .manual/config.yaml');
  assert.ok(fs.existsSync(path.join(root, '.manual', '.gitignore')), '缺少 .manual/.gitignore');

  const c = readConfig(root);
  assert.strictEqual(c.version, 1);
  assert.strictEqual(c.project.baseUrl, 'http://localhost:5173');
  assert.strictEqual(c.capture.activeProfile, 'desktop-standard');
  assert.deepStrictEqual(c.capture.profiles['desktop-standard'].viewport, { width: 1440, height: 900 });
  assert.strictEqual(c.capture.profiles['desktop-standard'].deviceScaleFactor, 2);
  assert.strictEqual(c.capture.profiles['desktop-standard'].kind, 'desktop');
  assert.strictEqual(c.browser.activeProvider, 'playwright-headless');
  assert.strictEqual(c.browser.providers['playwright-headless'].headless, true);
  assert.strictEqual(c.browser.providers['playwright-headless'].type, 'playwright');
  assert.strictEqual(c.docs.language, 'zh-CN');
  assert.strictEqual(c.docs.outputDir, 'docs/manual');
  assert.strictEqual(c.docs.imagesDir, 'docs/manual/images');
  // 截图落在文档目录下：手册要引用它们，得跟手册一起入库
  assert.strictEqual(c.artifacts.rawDir, '.manual/artifacts/raw/pages');
  assert.strictEqual(c.artifacts.annotatedDir, 'docs/manual/images/annotated');
  assert.strictEqual(c.artifacts.taskRawDir, '.manual/artifacts/raw');
  assert.strictEqual(c.artifacts.sanitizedDir, '.manual/artifacts/sanitized');
  assert.strictEqual(c.artifacts.diagnosticsDir, '.manual/artifacts/diagnostics');
  assert.strictEqual(c.artifacts.manifestsDir, '.manual/artifacts/manifests');
  assert.strictEqual(c.annotation.activeTheme, 'default');
  assert.strictEqual(c.annotation.themes.default.primary, '#E86349');
  assert.strictEqual(c.annotation.themes.default.maxMarkersPerImage, 5);
  assert.deepStrictEqual(c.privacy, {
    audience: 'public',
    redaction: 'balanced',
    maskStyle: 'neutral-mosaic',
    rules: { redact: [], preserve: [] },
  });
  assert.strictEqual(c.auth.enabled, true);
  assert.strictEqual(c.auth.activeProfile, 'default');
  assert.match(c.auth.cacheKey, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
  assert.strictEqual(c.auth.loginUrl, '/login');
  assert.strictEqual(c.auth.verifyPath, null);
  // 页面清单不在 config 里——它是 inspect 的产出，落在 project.yaml / pages/
  assert.strictEqual(c.pages, undefined, 'config 不应再有 pages 字段');
  assert.deepStrictEqual(c.inspect.exclude, []);
});

test('三个预设规格全部写入 profiles，便于事后切换', (root) => {
  runInit(root, ['--base-url', 'http://localhost:5173', '--yes']);
  const c = readConfig(root);
  assert.deepStrictEqual(
    Object.keys(c.capture.profiles).sort(),
    ['desktop-standard', 'desktop-wide', 'laptop']
  );
  assert.deepStrictEqual(c.capture.profiles['desktop-wide'].viewport, { width: 1920, height: 1080 });
  assert.strictEqual(c.capture.profiles['desktop-wide'].deviceScaleFactor, 1);
  assert.deepStrictEqual(c.capture.profiles.laptop.viewport, { width: 1280, height: 800 });
  assert.strictEqual(c.capture.profiles.laptop.deviceScaleFactor, 2);
});

// ---------------------------------------------------------------- 2. 自定义规格
test('--profile custom 写入自定义规格并设为 active', (root) => {
  const r = runInit(root, [
    '--base-url', 'https://app.example.com',
    '--profile', 'custom', '--viewport', '1600x1000', '--dpr', '1.5',
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  const c = readConfig(root);
  assert.strictEqual(c.capture.activeProfile, 'custom');
  assert.deepStrictEqual(c.capture.profiles.custom.viewport, { width: 1600, height: 1000 });
  assert.strictEqual(c.capture.profiles.custom.deviceScaleFactor, 1.5);
  // 预设仍在，自定义只是多一项
  assert.ok(c.capture.profiles['desktop-standard'], 'custom 不应挤掉预设');
});

// ---------------------------------------------------------------- 3. Provider
test('--provider playwright-headed 正确生效', (root) => {
  const r = runInit(root, ['--base-url', 'http://localhost:3000', '--provider', 'playwright-headed']);
  assert.strictEqual(r.status, 0, r.stderr);
  const c = readConfig(root);
  assert.strictEqual(c.browser.activeProvider, 'playwright-headed');
  assert.strictEqual(c.browser.providers['playwright-headed'].headless, false);
  assert.strictEqual(c.browser.providers['playwright-headed'].type, 'playwright');
});

test('--audience internal 写入内部发布策略', (root) => {
  const r = runInit(root, ['--base-url', 'https://app.example.com', '--audience', 'internal']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readConfig(root).privacy.audience, 'internal');
});

test('旧配置缺少 auth/privacy 时由读取器补默认值', (root) => {
  const r = runInit(root, ['--base-url', 'https://app.example.com']);
  assert.strictEqual(r.status, 0, r.stderr);
  const file = configPath(root);
  const legacy = readConfig(root);
  delete legacy.auth;
  delete legacy.privacy;
  fs.writeFileSync(file, yaml.dump(legacy), 'utf8');
  const loaded = require('../src/config/load').loadConfig(root);
  assert.strictEqual(loaded.ok, true, loaded.errors?.join('\n'));
  assert.strictEqual(loaded.config.version, 1);
  assert.strictEqual(loaded.config.privacy.audience, 'public');
  assert.strictEqual(loaded.config.auth.activeProfile, 'default');
});

// ---------------------------------------------------------------- 4. 幂等与覆盖
test('已存在配置时不覆盖，退出码 1', (root) => {
  runInit(root, ['--base-url', 'http://localhost:5173']);
  const before = fs.readFileSync(configPath(root), 'utf8');

  const r = runInit(root, ['--base-url', 'http://other.example.com']);
  assert.strictEqual(r.status, 1, '重复 init 应以 1 退出');
  assert.match(r.stderr, /配置已存在/);
  assert.strictEqual(fs.readFileSync(configPath(root), 'utf8'), before, '原配置不应被改动');
  assert.ok(!fs.existsSync(configPath(root) + '.bak'), '未加 --force 不应产生备份');
});

test('--force 覆盖并留下 .bak 备份', (root) => {
  runInit(root, ['--base-url', 'http://localhost:5173']);
  const before = fs.readFileSync(configPath(root), 'utf8');

  const r = runInit(root, ['--base-url', 'https://app.example.com', '--force']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(readConfig(root).project.baseUrl, 'https://app.example.com');
  assert.strictEqual(
    fs.readFileSync(configPath(root) + '.bak', 'utf8'),
    before,
    '备份内容应与覆盖前一致'
  );
});

// ---------------------------------------------------------------- 5. 错误用例
const badCases = [
  ['非 http 协议', ['--base-url', 'ftp://x.example.com'], /只支持 http\/https/],
  ['baseUrl 不是 URL', ['--base-url', 'not a url'], /不是合法 URL/],
  ['缺少 baseUrl', [], /缺少 --base-url/],
  ['未知 profile', ['--base-url', 'http://a.co', '--profile', 'nope'], /未知的截图规格/],
  ['未知 provider', ['--base-url', 'http://a.co', '--provider', 'nope'], /未知的 Browser Provider/],
  ['未知 audience', ['--base-url', 'http://a.co', '--audience', 'partner'], /--audience/],
  ['docsDir 逃逸', ['--base-url', 'http://a.co', '--docs-dir', '../escape'], /不能超出项目根目录/],
  ['docsDir 绝对路径', ['--base-url', 'http://a.co', '--docs-dir', 'C:\\abs'], /不能是绝对路径/],
  ['docsDir 是 node_modules', ['--base-url', 'http://a.co', '--docs-dir', 'node_modules/x'], /不能放在 node_modules/],
  ['custom 缺 viewport', ['--base-url', 'http://a.co', '--profile', 'custom', '--dpr', '2'], /需要 --viewport/],
  ['custom 缺 dpr', ['--base-url', 'http://a.co', '--profile', 'custom', '--viewport', '800x600'], /需要 --dpr/],
  ['dpr 越界', ['--base-url', 'http://a.co', '--profile', 'custom', '--viewport', '800x600', '--dpr', '99'], /--dpr 需在/],
  ['viewport 越界', ['--base-url', 'http://a.co', '--profile', 'custom', '--viewport', '10x10', '--dpr', '2'], /宽度需在/],
  ['预设不接受 viewport', ['--base-url', 'http://a.co', '--profile', 'laptop', '--viewport', '800x600'], /只在 --profile custom 时有效/],
  ['非法语言标签', ['--base-url', 'http://a.co', '--lang', '中文'], /需要是语言标签/],
  ['未知参数', ['--base-url', 'http://a.co', '--nope', 'x'], /未知参数/],
];

for (const [name, args, pattern] of badCases) {
  test(`拒绝：${name}`, (root) => {
    const r = runInit(root, args);
    assert.strictEqual(r.status, 1, `应以 1 退出，实际 ${r.status}`);
    assert.match(r.stderr, pattern, `报错信息不匹配，实际:\n${r.stderr}`);
    assert.ok(!fs.existsSync(configPath(root)), '校验失败时不应产生配置文件');
  });
}

// ---------------------------------------------------------------- 6. 注释预留
test('生成的 YAML 保留 mobile / computer-use 扩展示例', (root) => {
  runInit(root, ['--base-url', 'http://localhost:5173']);
  const text = fs.readFileSync(configPath(root), 'utf8');
  assert.ok(text.includes('# mobile-iphone:'), '缺少 mobile profile 注释示例');
  assert.ok(text.includes('#   kind: mobile'), '缺少 mobile kind 注释示例');
  assert.ok(text.includes('# chatgpt-desktop:'), '缺少 chatgpt-desktop 注释示例');
  assert.ok(text.includes('#   type: computer-use'), '缺少 computer-use type 注释示例');
  assert.ok(text.includes('# agent-browser:'), '缺少 agent-browser 注释示例');
});

// ---------------------------------------------------------------- 7. 零侵入
test('除 .manual/ 外不碰业务项目任何文件', (root) => {
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"biz"}');
  fs.writeFileSync(path.join(root, 'src', 'main.js'), 'console.log(1)');
  const before = listFiles(root);

  runInit(root, ['--base-url', 'http://localhost:5173']);

  const after = listFiles(root);
  const added = after.filter((f) => !before.includes(f));
  assert.deepStrictEqual(added, ['.manual/.gitignore', '.manual/config.yaml']);
  for (const f of before) {
    assert.ok(after.includes(f), `原有文件不应消失: ${f}`);
  }
  assert.strictEqual(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), '{"name":"biz"}');
  // 文档输出目录由后续 generate 创建，init 不应提前建空目录
  assert.ok(!fs.existsSync(path.join(root, 'docs')), 'init 不应创建 docs/');
});

// ---------------------------------------------------------------- 8. JSON 输出
test('--json 输出合法 JSON 且含关键字段', (root) => {
  const r = runInit(root, ['--base-url', 'http://localhost:5173', '--provider', 'playwright-headed', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.ok(out.configPath.endsWith(path.join('.manual', 'config.yaml')), out.configPath);
  assert.strictEqual(out.activeProfile, 'desktop-standard');
  assert.strictEqual(out.activeProvider, 'playwright-headed');
  assert.strictEqual(out.providerType, 'playwright');
  assert.strictEqual(out.language, 'zh-CN');
  assert.strictEqual(out.docsDir, 'docs/manual');
  assert.strictEqual(out.version, 1);
});

test('--json 失败时也输出 JSON 而非裸文本', (root) => {
  const r = runInit(root, ['--base-url', 'ftp://x', '--json']);
  assert.strictEqual(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.ok, false);
  assert.ok(Array.isArray(out.errors) && out.errors.length > 0);
});

// ---------------------------------------------------------------- 其它
test('--name 与 --lang 与 --docs-dir 生效', (root) => {
  const r = runInit(root, [
    '--base-url', 'https://app.example.com',
    '--name', 'neostar-kb', '--lang', 'en-US', '--docs-dir', 'website/docs/guide',
  ]);
  assert.strictEqual(r.status, 0, r.stderr);
  const c = readConfig(root);
  assert.strictEqual(c.project.name, 'neostar-kb');
  assert.strictEqual(c.docs.language, 'en-US');
  assert.strictEqual(c.docs.outputDir, 'website/docs/guide');
  assert.strictEqual(c.docs.imagesDir, 'website/docs/guide/images');
});

test('项目名默认取项目根目录名', (root) => {
  runInit(root, ['--base-url', 'http://localhost:5173']);
  assert.strictEqual(readConfig(root).project.name, path.basename(root));
});

test('baseUrl 末尾斜杠被规范掉', (root) => {
  runInit(root, ['--base-url', 'http://localhost:5173/']);
  assert.strictEqual(readConfig(root).project.baseUrl, 'http://localhost:5173');
});

test('--flag=value 写法同样可用', (root) => {
  const r = runInit(root, ['--base-url=http://localhost:4000', '--lang=ja-JP']);
  assert.strictEqual(r.status, 0, r.stderr);
  const c = readConfig(root);
  assert.strictEqual(c.project.baseUrl, 'http://localhost:4000');
  assert.strictEqual(c.docs.language, 'ja-JP');
});

test('init --help 退出码 0 且列出预设', (root) => {
  const r = spawnSync(process.execPath, [CLI, 'init', '--help'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /desktop-standard/);
  assert.match(r.stdout, /playwright-headed/);
});

test('未实现的子命令给出明确提示（退出码 2）', () => {
  const r = spawnSync(process.execPath, [CLI, 'update'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 2);
  assert.match(r.stderr, /尚未实现/);
});

// ---------------------------------------------------------------- 汇总
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  process.exitCode = 1;
}
