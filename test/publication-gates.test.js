'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  validatePublication, buildPrivacyRecord, summarizePrivacy, policyRevision,
} = require('../src/publication/validate');
const { fileSha256 } = require('../src/util/hash');
const taskStore = require('../src/tasks/store');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-gates-'));
  try {
    fn(root);
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function config(audience = 'public') {
  return {
    docs: { outputDir: 'docs/manual', imagesDir: 'docs/manual/images' },
    artifacts: {
      stateDir: '.manual',
      rawDir: '.manual/artifacts/raw/pages',
      taskRawDir: '.manual/artifacts/raw',
      sanitizedDir: '.manual/artifacts/sanitized',
      diagnosticsDir: '.manual/artifacts/diagnostics',
      manifestsDir: '.manual/artifacts/manifests',
      annotatedDir: 'docs/manual/images/annotated',
    },
    privacy: { audience, redaction: 'balanced', maskStyle: 'neutral-mosaic', rules: { redact: [], preserve: [] } },
  };
}

function writeImage(root, rel, bytes = 'png-bytes') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const MANUAL = 'docs/manual/tasks/t.md';

/** 一份合法发布：annotated 图 + 真实 hash + 实际执行过的零命中检测记录。 */
function publishable(root, cfg = config()) {
  const artifactPath = 'docs/manual/images/annotated/a.png';
  writeImage(root, artifactPath);
  const privacy = buildPrivacyRecord({ redactions: [], config: cfg });
  const image = { artifactPath, markdownHref: '../images/annotated/a.png', sha256: fileSha256(path.join(root, artifactPath)), privacy };
  return { image, markdown: '# T\n\n![s](../images/annotated/a.png)\n' };
}

function codes(result) {
  return result.errors.map((e) => e.code);
}

process.stdout.write('\npublication gates\n');

test('合法 annotated 图、正确 hash、零命中检测记录可以发布', (root) => {
  const { image, markdown } = publishable(root);
  const result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: config() });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.deepStrictEqual(image.privacy.maskStyles, []);
  assert.strictEqual(image.privacy.status, 'passed');
});

test('public：缺 privacy 记录按 unknown 阻止；internal 允许但仍校验完整性', (root) => {
  const { image, markdown } = publishable(root);
  delete image.privacy;
  let result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: config() });
  assert.deepStrictEqual(codes(result), ['privacy-unknown']);
  result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: config('internal') });
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
});

test('图片被替换（hash 不符）或缺少 hash 都不能发布', (root) => {
  const { image, markdown } = publishable(root);
  writeImage(root, image.artifactPath, 'replaced');
  let result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: config() });
  assert.deepStrictEqual(codes(result), ['hash-mismatch']);
  delete image.sha256;
  result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: config('internal') });
  assert.deepStrictEqual(codes(result), ['integrity-unknown']);
});

test('缺图：引用解析与产物检查都报告 missing', (root) => {
  const { image, markdown } = publishable(root);
  fs.rmSync(path.join(root, image.artifactPath));
  const result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: config() });
  assert.ok(codes(result).includes('missing'), JSON.stringify(result.errors));
  assert.strictEqual(result.ok, false);
});

test('旧 docs 下的页面原图：public 与 internal 都阻止，并给重新采集建议', (root) => {
  const artifactPath = 'docs/manual/images/raw/chat.png';
  writeImage(root, artifactPath);
  const image = { artifactPath, markdownHref: 'images/raw/chat.png', sha256: fileSha256(path.join(root, artifactPath)) };
  for (const audience of ['public', 'internal']) {
    const result = validatePublication({ projectRoot: root, manualFile: 'docs/manual/chat.md', markdown: '![x](images/raw/chat.png)', images: [image], config: config(audience) });
    assert.ok(codes(result).includes('legacy-raw-reference'), `${audience}: ${JSON.stringify(result.errors)}`);
    assert.match(result.errors.find((e) => e.code === 'legacy-raw-reference').hint, /manual capture/);
  }
});

test('internal 也不能发布 .manual 下的原图/诊断图（引用越出文档目录）', (root) => {
  const artifactPath = '.manual/artifacts/diagnostics/x.png';
  writeImage(root, artifactPath);
  const image = { artifactPath, markdownHref: '../../../.manual/artifacts/diagnostics/x.png', sha256: fileSha256(path.join(root, artifactPath)) };
  const result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown: `![x](${image.markdownHref})`, images: [image], config: config('internal') });
  assert.ok(codes(result).includes('forbidden-artifact'), JSON.stringify(result.errors));
  assert.ok(codes(result).includes('invalid-artifact-path'));
});

test('检测记录：无几何的高风险项进入 unresolved；不安全遮罩与策略变更阻止发布', (root) => {
  const cfg = config();
  const record = buildPrivacyRecord({ redactions: [{ kind: 'phone', confidence: 'high', result: 'neutral-mosaic' }], config: cfg });
  assert.strictEqual(record.status, 'failed');
  assert.deepStrictEqual(record.unresolved, [{ kind: 'phone', confidence: 'high' }]);
  const blur = buildPrivacyRecord({ redactions: [{ kind: 'phone', rect: { x: 0, y: 0, width: 5, height: 5 }, result: 'blur' }], config: cfg });
  assert.strictEqual(blur.status, 'failed');

  const { image, markdown } = publishable(root);
  image.privacy = { ...image.privacy, maskStyles: ['blur'] };
  let result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: cfg });
  assert.ok(codes(result).includes('unsafe-mask-style'));
  image.privacy = buildPrivacyRecord({ redactions: [], config: cfg });
  const changed = config();
  changed.privacy.rules.redact = ['学校'];
  assert.notStrictEqual(policyRevision(changed), policyRevision(cfg));
  result = validatePublication({ projectRoot: root, manualFile: MANUAL, markdown, images: [image], config: changed });
  assert.deepStrictEqual(codes(result), ['privacy-policy-changed']);
});

test('多张图汇总：任一缺记录即 unknown', () => {
  const ok = { status: 'passed', unresolved: [], maskStyles: ['neutral-mosaic'] };
  assert.strictEqual(summarizePrivacy([ok, ok]).status, 'passed');
  assert.strictEqual(summarizePrivacy([ok, null]).status, 'unknown');
  assert.strictEqual(summarizePrivacy([ok, { ...ok, status: 'failed' }]).status, 'failed');
});

// ---------------------------------------------------------------- CLI：任务 finalize / verify

function cli(root, args) {
  return spawnSync(process.execPath, [CLI, ...args, '--project-root', root, '--json'], { encoding: 'utf8' });
}

/** 构造一个 captured 任务与证据清单（不启动浏览器）。 */
function capturedTask(root, { withPrivacy = true } = {}) {
  assert.strictEqual(cli(root, ['init', '--base-url', 'http://localhost:3000']).status, 0);
  const artifactPath = 'docs/manual/images/annotated/t--open--after.png';
  writeImage(root, artifactPath);
  const shot = { raw: '.manual/artifacts/raw/t--open--after.png', timing: 'after', annotated: artifactPath, redactions: [] };
  if (withPrivacy) {
    const { loadConfig } = require('../src/config/load');
    shot.privacy = buildPrivacyRecord({ redactions: [], config: loadConfig(root).config });
  }
  const evidence = { version: 1, taskId: 't', steps: [{ id: 'open', status: 'verified', screenshots: [shot] }] };
  const manifest = '.manual/artifacts/manifests/t--evidence.json';
  writeImage(root, manifest, JSON.stringify(evidence));
  taskStore.writeTask(path.join(root, '.manual'), {
    id: 't', title: '打开设置', goal: '打开设置面板', entryPage: 'home', preconditions: [], branches: [], relatedTasks: [], risk: 'read', status: 'captured',
    steps: [{ id: 'open', instruction: '点击「设置」', page: 'home', action: { type: 'click', target: { role: 'button', name: '设置' } } }],
    completion: { description: '设置面板打开', verification: 'expected' },
    evidenceManifest: manifest,
  });
  return { artifactPath };
}

function draftAndFinalize(root) {
  let result = cli(root, ['generate-task', 't']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const draft = JSON.parse(result.stdout).draftFile;
  return { draft, result: cli(root, ['generate-task', 't', '--finalize', draft]) };
}

test('任务证据缺 privacy 记录（未执行检测）：public 下草稿与定稿都被阻止', (root) => {
  capturedTask(root, { withPrivacy: false });
  const result = cli(root, ['generate-task', 't']);
  assert.strictEqual(result.status, 1, result.stdout);
  assert.match(result.stdout, /privacy-unknown/);
  assert.strictEqual(fs.existsSync(path.join(root, 'docs/manual/tasks/t.md')), false);
});

test('任务：草稿后替换图片或删除 facts 中的 privacy，finalize 与 verify 均失败且不写文档', (root) => {
  const { artifactPath } = capturedTask(root);
  let result = cli(root, ['generate-task', 't']);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  const { draftFile, factsFile } = JSON.parse(result.stdout);
  const facts = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
  assert.ok(facts.images[0].sha256 && facts.images[0].privacy, '草稿 facts 必须记录 hash 与 privacy');

  writeImage(root, artifactPath, 'swapped');
  result = cli(root, ['generate-task', 't', '--finalize', draftFile]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /draft-stale.*artifacts|hash-mismatch/, '图片内容变化使事实包失效');
  assert.strictEqual(fs.existsSync(path.join(root, 'docs/manual/tasks/t.md')), false);

  writeImage(root, artifactPath, 'png-bytes');
  delete facts.images[0].privacy;
  fs.writeFileSync(factsFile, JSON.stringify(facts));
  result = cli(root, ['generate-task', 't', '--finalize', draftFile]);
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /privacy-unknown/);
  assert.strictEqual(fs.existsSync(path.join(root, 'docs/manual/tasks/t.md')), false);
});

test('任务：合法定稿后 verify 通过；之后替换图片则 verify 失败', (root) => {
  const { artifactPath } = capturedTask(root);
  const { result } = draftAndFinalize(root);
  assert.strictEqual(result.status, 0, result.stdout + result.stderr);
  let verify = cli(root, ['verify', 't']);
  assert.strictEqual(verify.status, 0, verify.stdout);

  const state = path.join(root, '.manual');
  taskStore.writeTask(state, { ...taskStore.readTask(state, 't'), status: 'generated' });
  writeImage(root, artifactPath, 'swapped-after-publish');
  verify = cli(root, ['verify', 't']);
  assert.strictEqual(verify.status, 1);
  assert.match(verify.stdout, /hash-mismatch/);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
