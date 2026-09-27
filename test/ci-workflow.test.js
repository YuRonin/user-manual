'use strict';

/*
 * P3-07：CI 工作流静态校验（本地无法运行 GitHub Actions 矩阵，这里核对工作流的安全与完整性约束）。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const pkg = require('../package.json');
const { FILES, BROWSER, groupOf } = require('./run');

const REPO = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'manual-tests.yml');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

const text = fs.readFileSync(WORKFLOW, 'utf8');
const workflow = yaml.load(text);
const job = workflow.jobs.test;
const steps = job.steps;
const runs = steps.map((s) => s.run || '').join('\n');

function versionAtLeast(actual, minimum) {
  const a = actual.split('.').map(Number);
  const m = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== m[i]) return a[i] > m[i];
  return true;
}

process.stdout.write('\nci workflow\n');

test('触发与权限：push / pull_request，只读权限，不用 pull_request_target，不引用 secrets', () => {
  const on = workflow.on || workflow[true];
  assert.ok(on.push && 'pull_request' in on);
  assert.ok(!('pull_request_target' in on));
  assert.deepStrictEqual(workflow.permissions, { contents: 'read' });
  assert.doesNotMatch(text, /secrets\./);
});

test('矩阵：Windows 与 Linux；Node 版本精确固定且满足 engines', () => {
  const { os, node } = job.strategy.matrix;
  assert.ok(os.some((o) => /^ubuntu/.test(o)) && os.some((o) => /^windows/.test(o)));
  const minimum = pkg.engines.node.replace(/^>=\s*/, '');
  for (const version of node) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `Node 版本需要精确固定: ${version}`);
    assert.ok(versionAtLeast(version, minimum), `${version} 低于 engines ${pkg.engines.node}`);
  }
  assert.strictEqual(job.strategy['fail-fast'], false);
});

test('步骤：npm ci、固定 Chromium、Linux 中文字体、doctor、unit 与 browser 分组', () => {
  assert.match(runs, /\bnpm ci\b/);
  assert.doesNotMatch(runs, /\bnpm install\b/);
  assert.match(runs, /playwright install (--with-deps )?chromium/);
  assert.match(runs, /fonts-noto-cjk/);
  assert.match(runs, /bin\/manual\.js doctor/);
  assert.match(runs, /npm run test:unit/);
  assert.match(runs, /npm run test:browser/);
  assert.strictEqual(pkg.scripts['test:unit'], 'node test/run.js --group unit');
  assert.strictEqual(pkg.scripts['test:browser'], 'node test/run.js --group browser');
  // 认证缓存与浏览器放在 runner 临时目录
  assert.match(job.env.MANUAL_AUTH_CACHE_DIR, /runner\.temp/);
});

test('产物：只上传 test-results/，短保留期；不上传原图 / trace / 认证缓存 / 项目状态', () => {
  const uploads = steps.filter((s) => String(s.uses || '').startsWith('actions/upload-artifact'));
  assert.ok(uploads.length >= 1);
  for (const upload of uploads) {
    const paths = String(upload.with.path).split('\n').map((p) => p.trim()).filter(Boolean);
    assert.deepStrictEqual(paths, ['test-results/']);
    assert.ok(upload.with['retention-days'] <= 7);
  }
  assert.doesNotMatch(text, /\.auth|\.manual\/|artifacts\/raw|trace\.zip/);
  // 不自动接受基线、不发布、不合并
  assert.doesNotMatch(runs, /--force|git push|gh pr merge|approve/);
});

test('测试分组：启动浏览器 / 测试服务器的文件都在 browser 组，run.js 覆盖全部测试文件', () => {
  const onDisk = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  assert.deepStrictEqual([...FILES].sort(), onDisk, 'test/run.js 的 FILES 与磁盘上的测试文件一致');
  for (const file of FILES) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    const usesBrowser = /require\('\.\/server'\)|createBrowserSession\(\)|chromium\.launch|launchBrowser\(/.test(source);
    if (usesBrowser) assert.strictEqual(groupOf(file), 'browser', `${file} 启动浏览器，应在 browser 组`);
  }
  for (const file of BROWSER) assert.ok(!FILES.includes(file) || fs.existsSync(path.join(__dirname, file)));
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
