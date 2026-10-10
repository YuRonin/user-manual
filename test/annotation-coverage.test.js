'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { buildInventory, buildPlan, verifyCoverage, verifyExplanations, pageInventory, stepInventory, stepFeatures } = require('../src/annotations/coverage');
const { renderAnnotationResults } = require('../src/evidence/image-pipeline');
const { layoutAnnotations } = require('../src/artifacts/annotation');
const { derivePublished } = require('../src/evidence/capture-safe');
const { DEFAULT_THEME } = require('../src/config/annotation');
const { inventorySnapshot } = require('../src/annotations/store');
const { validatePage } = require('../src/model/schema');
const { stepPageId } = require('../src/tasks/model');
const { validateArtifact, validateCaptureCoverage } = require('../src/publication/validate');
const { createCaptureStore } = require('../src/evidence/store');
const { annotationCoverageForImages } = require('../src/verify/artifacts');
const pageStore = require('../src/inspect/store');

let passed = 0;
const failures = [];
async function test(name, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-annotations-'));
  try { await fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function features(count) {
  return Array.from({ length: count }, (_, i) => ({ feature_id: `feature-${i + 1}`, label: `功能 ${i + 1}`, priority: 'required', source: ['source'], scenario: 'default', description: `使用功能 ${i + 1}` }));
}

const inventory = features(8);
const plan = inventory.slice(0, 6).map((feature) => ({ feature_id: feature.feature_id, priority: 'required', target: { role: 'button', name: feature.label }, label: feature.label }));
const rendered = plan.map((item) => ({ feature_id: item.feature_id, located: true, outlined: true, intersects: true, drawn: true }));
const drawn = (feature_id) => ({ feature_id, located: true, outlined: true, intersects: true, drawn: true });
const upload = { role: 'button', name: '上传附件' };
const workspace = { id: 'workspace', detectedActions: ['上传附件', '选择仙技'], guide: [{ id: 'upload', title: '上传附件', instruction: '点击上传附件。', target: upload }] };

function png(width = 100, height = 100) {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

function config() {
  return {
    docs: { outputDir: 'docs/manual', imagesDir: 'docs/manual/images' },
    artifacts: {
      stateDir: '.manual', rawDir: '.manual/artifacts/raw/pages', taskRawDir: '.manual/artifacts/raw', sanitizedDir: '.manual/artifacts/sanitized',
      diagnosticsDir: '.manual/artifacts/diagnostics', manifestsDir: '.manual/artifacts/manifests', annotatedDir: 'docs/manual/images/annotated',
    },
    privacy: { audience: 'public', redaction: 'balanced', maskStyle: 'neutral-mosaic', rules: { redact: [], preserve: [] } },
  };
}

function modelPage(overrides = {}) {
  return {
    id: 'workspace', route: '/workspace', dynamic: false, params: [], title: '工作台', purpose: '上传资料', detectedActions: [], entry: 'app/workspace/page.tsx',
    source: ['app/workspace/page.tsx'], dependencies: { files: [], unresolved: [] }, includeInManual: true, confidence: 'inferred',
    browser: { verified: false }, states: { default: { assertions: [{ type: 'url', value: '/workspace' }] } }, status: { router: 'app', sourceAnalysis: 'completed' },
    guide: workspace.guide, ...overrides,
  };
}

/** 真实 Capture 记录：发布图 + annotations.json；返回发布条目与记录。 */
async function seedCapture(root, { pages = [modelPage()], coverage = 'computed', annotations = true, rendered: drawnItems = null } = {}) {
  const stateDirAbs = path.join(root, '.manual');
  pageStore.writeModel(stateDirAbs, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: '2026-10-10T00:00:00.000Z' }, pages);
  const items = pageInventory({ page: modelPage(), scenarioId: 'page-workspace' });
  const planned = buildPlan({ inventory: items, page: modelPage() });
  const data = { version: 1, inventory: items, plan: planned, rendered: drawnItems || planned.map((item) => drawn(item.feature_id)) };
  data.coverage = verifyCoverage(data);
  const store = createCaptureStore({ projectRoot: root, stateDirAbs });
  const handle = store.begin();
  fs.writeFileSync(handle.file('raw.png'), await png());
  fs.writeFileSync(handle.file('published.png'), await png());
  fs.writeFileSync(handle.file('annotations.json'), JSON.stringify(data, null, 2));
  const artifacts = [
    { kind: 'raw', file: handle.file('raw.png'), dir: '.manual/artifacts/raw/pages', prefix: 'workspace' },
    { kind: 'published', file: handle.file('published.png'), dir: 'docs/manual/images/annotated', prefix: 'page--workspace' },
  ];
  if (annotations) artifacts.push({ kind: 'annotations', file: handle.file('annotations.json'), dir: '.manual/artifacts/annotations', prefix: 'workspace' });
  const record = store.commit(handle, { artifacts, record: {
    kind: 'page', subject: { pageId: 'workspace' }, scenarioId: 'page-workspace', observedAt: new Date().toISOString(),
    inputHash: `sha256:${'1'.repeat(64)}`, modelRevision: `sha256:${'2'.repeat(64)}`, finalUrl: { origin: 'http://localhost:5173', pathname: '/workspace' },
    spec: { viewport: { width: 100, height: 100 }, dpr: 1, fullPage: false }, validations: [], privacy: { status: 'passed' },
    ...(coverage === 'computed' ? { annotationCoverage: data.coverage } : coverage ? { annotationCoverage: coverage } : {}),
  } });
  const published = record.artifacts.find((item) => item.kind === 'published');
  return { record, entry: { artifactPath: published.path, sha256: published.sha256, privacy: { status: 'passed' }, captureId: record.id } };
}

const annotationCodes = (errors) => errors.map((item) => item.code).filter((code) => /^(annotation|capture)-/.test(code));

(async () => {
  console.log('annotation coverage');

  await test('Required 8 个、计划 6 个：缺两项 missing-from-plan，不能 100%', () => {
    const report = verifyCoverage({ inventory, plan, rendered });
    assert.strictEqual(report.required.total, 8);
    assert.strictEqual(report.required.verified, 6);
    assert.deepStrictEqual(report.failures.filter((item) => item.reason === 'missing-from-plan').map((item) => item.feature_id), ['feature-7', 'feature-8']);
    assert.deepStrictEqual(verifyCoverage({ inventory: inventory.slice(0, 6), discovered: inventory, plan, rendered }).discoveryMissing.map((item) => item.feature_id), ['feature-7', 'feature-8']);
  });

  await test('计划 6 个、画出 5 个：not-drawn 且 ok=false', () => {
    const report = verifyCoverage({ inventory: inventory.slice(0, 6), plan, rendered: rendered.slice(0, 5) });
    assert.strictEqual(report.ok, false);
    assert.ok(report.failures.some((item) => item.feature_id === 'feature-6' && item.reason === 'not-drawn'));
  });

  await test('超出画布的目标记为 outside-image，不算画出', () => {
    const outside = renderAnnotationResults([{ feature_id: 'feature-1', label: '1', target: { x: 400, y: 0, width: 20, height: 20 }, marker: { x: 0, y: 0, size: 30 } }], { width: 100, height: 100, dpr: 1 });
    assert.strictEqual(outside[0].drawn, false);
    assert.strictEqual(outside[0].reason, 'outside-image');
    for (const rect of [{ x: -30, y: 10, width: 20, height: 20 }, { x: 10, y: -30, width: 20, height: 20 }]) {
      const laidOut = layoutAnnotations([{ feature_id: 'offscreen', label: '1', rect }], { width: 100, height: 100 }, DEFAULT_THEME);
      const [result] = renderAnnotationResults(laidOut.annotations, { width: 100, height: 100, dpr: 1 });
      assert.strictEqual(result.drawn, false);
      assert.strictEqual(result.reason, 'outside-image');
    }
  });

  await test('缺说明报 description-missing；optional / skip 不计入 Required', () => {
    assert.ok(verifyCoverage({ inventory: [{ ...inventory[0], description: '' }], plan: [plan[0]], rendered: [rendered[0]] }).failures.some((item) => item.reason === 'description-missing'));
    const report = verifyCoverage({ inventory: [...inventory.slice(0, 1), { feature_id: 'optional', priority: 'optional' }, { feature_id: 'skip', priority: 'skip' }], plan: [plan[0]], rendered: [rendered[0]] });
    assert.deepStrictEqual(report.required, { total: 1, verified: 1, percent: 100 });
  });

  await test('detectedActions 只进入待确认（undecided），不自动成为 Required', () => {
    const discovered = buildInventory({ page: workspace });
    assert.strictEqual(discovered.length, 2);
    assert.ok(discovered.some((item) => item.priority === 'undecided' && item.label === '选择仙技'));
    assert.ok(discovered.some((item) => item.priority === 'required' && item.label === '上传附件'));
    const planned = buildPlan({ inventory: discovered, page: workspace });
    assert.strictEqual(planned.length, 1);
    const report = verifyCoverage({ inventory: discovered, plan: planned, rendered: [drawn(planned[0].feature_id)] });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.pending.length, 1);
    assert.strictEqual(report.complete, false);
    assert.strictEqual(report.discovery.status, 'pending-review');
    const snapshot = inventorySnapshot([{ ...workspace, route: '/workspace' }]);
    assert.strictEqual(snapshot.pending.length, 1);
    assert.strictEqual(snapshot.pages[0].features.length, 2);
  });

  await test('features 的 schema：priority 必须合法', () => {
    assert.strictEqual(validatePage({ id: 'workspace', route: '/workspace', features: [{ feature_id: 'upload', label: '上传附件', priority: 'required', task_ids: ['upload-task'] }] }).ok, true);
    assert.strictEqual(validatePage({ id: 'workspace', route: '/workspace', features: [{ feature_id: 'upload', label: '上传附件', priority: 'bad' }] }).ok, false);
  });

  await test('正文说明：guide 块必须有正文，step 块必须有编号步骤', () => {
    const [guideFeature] = buildInventory({ page: workspace });
    assert.deepStrictEqual(verifyExplanations('# 工作台\n', [guideFeature]).map((item) => item.reason), ['manual-explanation-missing']);
    assert.deepStrictEqual(verifyExplanations('<!-- manual:block id=guide.upload -->\n## 1. 上传附件\n<!-- /manual:block -->', [guideFeature]).map((item) => item.reason), ['manual-explanation-missing']);
    assert.deepStrictEqual(verifyExplanations('<!-- manual:block id=guide.upload -->\n## 1. 上传附件\n![截图](image.png)\n<!-- /manual:block -->', [guideFeature]).map((item) => item.reason), ['manual-explanation-missing']);
    assert.deepStrictEqual(verifyExplanations('<!-- manual:block id=guide.upload -->\n## 1. 上传附件\n\n点击上传附件。\n<!-- /manual:block -->', [guideFeature]), []);
    const stepFeature = { ...buildInventory({ page: { id: 'workspace' }, task: { id: 'upload-task', steps: [{ id: 'attach', page: 'workspace', instruction: '点击上传附件。', action: { target: upload } }] } })[0], priority: 'required' };
    assert.deepStrictEqual(verifyExplanations('<!-- step:attach -->\n', [stepFeature]).map((item) => item.reason), ['manual-explanation-missing']);
    assert.deepStrictEqual(verifyExplanations('<!-- step:attach -->\n1. 点击「上传附件」', [stepFeature]), []);
    assert.deepStrictEqual(verifyExplanations('<!-- 使用功能 1 -->', [{ ...inventory[0], explanation_ref: null }]).map((item) => item.reason), ['manual-explanation-missing']);
  });

  await test('T01 没有 target 的说明性 guide 是 optional，不阻断；编号仍按 guide 下标', () => {
    const page = { id: 'workspace', guide: [{ id: 'intro', title: '了解工作台', instruction: '工作台汇总了资料。' }, { id: 'upload', title: '上传附件', instruction: '点击上传附件。', target: upload }] };
    const items = buildInventory({ page });
    assert.strictEqual(items.find((item) => item.label === '了解工作台').priority, 'optional');
    const planned = buildPlan({ inventory: items, page });
    assert.deepStrictEqual(planned.map((item) => item.label), ['1', '2']);
    const report = verifyCoverage({ inventory: items, plan: planned, rendered: [{ feature_id: planned[0].feature_id, located: false, drawn: false, reason: 'target-not-declared' }, drawn(planned[1].feature_id)] });
    assert.strictEqual(report.ok, true, JSON.stringify(report.failures));
  });

  await test('T02 显式 Required 功能缺 target：报 target-not-declared，不静默降级', () => {
    const page = { id: 'workspace', features: [{ feature_id: 'intro', label: '了解工作台', priority: 'required', description: '先看总览' }], guide: [{ id: 'intro', title: '了解工作台', instruction: '工作台汇总了资料。' }] };
    const items = buildInventory({ page });
    assert.strictEqual(items[0].priority, 'required');
    const planned = buildPlan({ inventory: items, page });
    const report = verifyCoverage({ inventory: items, plan: planned, rendered: [{ feature_id: 'intro', located: false, drawn: false, reason: 'target-not-declared' }] });
    assert.strictEqual(report.ok, false);
    assert.deepStrictEqual(report.failures.map((item) => `${item.feature_id}:${item.reason}`), ['intro:target-not-declared']);
  });

  await test('T03 变体 Scenario 只校验本 Scenario 的项，不混入默认 guide', () => {
    const page = { ...workspace, features: [{ feature_id: 'empty-hint', label: '空态提示', priority: 'required', scenario: 'workspace-empty', description: '没有资料时显示', target: { text: '暂无资料' } }] };
    const variant = pageInventory({ page, scenarioId: 'workspace-empty', checkpoint: { capture: { annotations: [{ feature_id: 'empty-hint', target: { text: '暂无资料' } }] } } });
    assert.deepStrictEqual(variant.map((item) => item.feature_id), ['empty-hint']);
    const planned = buildPlan({ inventory: variant, page, annotations: [{ feature_id: 'empty-hint', target: { text: '暂无资料' } }] });
    assert.strictEqual(verifyCoverage({ inventory: variant, plan: planned, rendered: [drawn('empty-hint')] }).ok, true);
    const defaults = pageInventory({ page, scenarioId: 'page-workspace' });
    assert.ok(!defaults.some((item) => item.feature_id === 'empty-hint'));
    assert.ok(defaults.some((item) => item.label === '上传附件'));
  });

  await test('T04 操作后目标消失：隐式动作标注是 optional，不让整图失败', () => {
    const task = { id: 'upload-task', steps: [{ id: 'open', page: 'workspace', number: 1, instruction: '打开对话框。', action: { type: 'click', target: { role: 'button', name: '新建' } }, capture: { timing: 'after' } }] };
    const [step] = task.steps;
    const items = stepInventory({ page: { id: 'workspace' }, task, step });
    const planned = buildPlan({ inventory: items, page: { id: 'workspace' }, task, step });
    assert.strictEqual(planned[0].priority, 'optional');
    const report = verifyCoverage({ inventory: items, plan: planned, rendered: [{ feature_id: planned[0].feature_id, located: false, drawn: false, reason: 'annotation-target-missing' }] });
    assert.strictEqual(report.ok, true, JSON.stringify(report.failures));
  });

  await test('隐式标注编号 = 步骤号；页面功能只归属匹配的步骤，不按 task_ids 注入每一步', () => {
    const page = { id: 'workspace', features: [{ feature_id: 'upload', label: '上传附件', priority: 'required', task_ids: ['upload-task'], description: '上传资料', target: upload }] };
    const task = { id: 'upload-task', steps: [
      { id: 'open', page: 'workspace', number: 1, instruction: '打开工作台。', action: { type: 'click', target: { role: 'link', name: '工作台' } }, capture: {} },
      { id: 'pick', page: 'workspace', number: 2, instruction: '选择文件。', action: { type: 'click', target: { role: 'button', name: '选择' } }, capture: {} },
      { id: 'attach', page: 'workspace', number: 3, instruction: '点击上传附件。', action: { type: 'click', target: upload }, capture: {} },
    ] };
    assert.deepStrictEqual(task.steps.map((step) => stepFeatures({ page, task, step }).length), [0, 0, 1]);
    const third = task.steps[2];
    const items = stepInventory({ page, task, step: third });
    const planned = buildPlan({ inventory: items, page, task, step: third });
    assert.deepStrictEqual(planned.map((item) => [item.feature_id, item.label, item.priority]), [['upload', '3', 'required']]);
    assert.ok(!verifyCoverage({ inventory: items, plan: planned, rendered: [] }).ok, '显式 Required 仍要画出');
    const first = buildPlan({ inventory: stepInventory({ page, task, step: task.steps[0] }), page, task, step: task.steps[0] });
    assert.deepStrictEqual(first.map((item) => item.feature_id), ['task:upload-task:open']);
  });

  await test('stepPageId：pageId 优先，兼容旧 page', () => {
    assert.strictEqual(stepPageId({ pageId: 'a', page: 'b' }), 'a');
    assert.strictEqual(stepPageId({ page: 'b' }), 'b');
    const items = buildInventory({ page: { id: 'workspace' }, task: { id: 't', steps: [{ id: 's', pageId: 'workspace', instruction: '点击。', action: { target: upload } }] } });
    assert.strictEqual(items.length, 1);
  });

  await test('派生发布图：坐标越界 / 5 of 6 / 超出单图上限 / 缺说明都不出发布图', async (root) => {
    const rawPath = path.join(root, 'raw.png');
    const publishedPath = path.join(root, 'published.png');
    fs.writeFileSync(rawPath, await png());
    const captured = { shot: { meta: { viewport: { width: 100, height: 100 } } }, geometry: { viewport: { width: 100, height: 100 }, dpr: 1 }, targets: [{ feature_id: 'feature-1', label: '1', rect: { x: 20, y: 20, width: 20, height: 20 } }], candidates: [], inventory: [inventory[0]], plan: [plan[0]] };
    let safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 'sanitized.png'), publishedPath, theme: DEFAULT_THEME });
    assert.strictEqual(safe.coverage.ok, true, JSON.stringify(safe.coverage));
    assert.strictEqual(safe.rendered[0].drawn, true);
    assert.ok(fs.existsSync(publishedPath));
    captured.targets[0].rect.x = 200;
    safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 'sanitized.png'), publishedPath: path.join(root, 'invalid.png'), theme: DEFAULT_THEME });
    assert.strictEqual(safe.coverage.ok, false);
    assert.strictEqual(safe.rendered[0].reason, 'outside-image');
    assert.ok(!fs.existsSync(path.join(root, 'invalid.png')));
    captured.inventory = inventory.slice(0, 6);
    captured.plan = plan;
    captured.targets = plan.slice(0, 5).map((item, index) => ({ feature_id: item.feature_id, label: String(index + 1), rect: { x: 20 + index * 10, y: 20, width: 8, height: 8 } }));
    safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 'sanitized.png'), publishedPath: path.join(root, 'five-of-six.png'), theme: { ...DEFAULT_THEME, maxMarkersPerImage: 6 } });
    assert.strictEqual(safe.coverage.required.verified, 5);
    assert.strictEqual(safe.published, false);
    captured.inventory = inventory;
    captured.targets = plan.map((item, index) => ({ feature_id: item.feature_id, label: String(index + 1), rect: { x: 10 + index * 10, y: 20, width: 8, height: 8 } }));
    safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 'sanitized.png'), publishedPath: path.join(root, 'six-of-eight.png'), theme: DEFAULT_THEME });
    assert.deepStrictEqual(safe.coverage.failures.filter((item) => item.reason === 'missing-from-plan').map((item) => item.feature_id), ['feature-7', 'feature-8']);
    assert.ok(safe.coverage.failures.some((item) => item.reason === 'marker-limit-exceeded'));
    assert.ok(!fs.existsSync(path.join(root, 'six-of-eight.png')));
    captured.inventory = [{ ...inventory[0], description: '' }];
    captured.plan = [plan[0]];
    captured.targets = [captured.targets[0]];
    safe = await derivePublished({ captured, rawPath, sanitizedPath: path.join(root, 'sanitized.png'), publishedPath: path.join(root, 'no-description.png'), theme: DEFAULT_THEME });
    assert.ok(safe.coverage.failures.some((item) => item.reason === 'description-missing'));
    assert.ok(!fs.existsSync(path.join(root, 'no-description.png')));
  });

  await test('发布门禁：合法 Capture 与 annotations.json 通过', async (root) => {
    const { entry } = await seedCapture(root);
    assert.deepStrictEqual(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })), []);
    assert.deepStrictEqual(validateCaptureCoverage({ projectRoot: root, config: config(), captureIds: [entry.captureId] }), []);
  });

  await test('发布门禁：记录有覆盖结果却缺 annotations.json → annotation-metadata-missing', async (root) => {
    const { entry } = await seedCapture(root, { annotations: false });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-metadata-missing'));
  });

  await test('发布门禁：annotations.json 被篡改 → annotation-metadata-invalid', async (root) => {
    const { entry, record } = await seedCapture(root);
    const file = path.join(root, record.artifacts.find((item) => item.kind === 'annotations').path);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.rendered = [];
    fs.writeFileSync(file, JSON.stringify(data));
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-metadata-invalid'));
  });

  await test('发布门禁：Required 未画出 → annotation-coverage-failed（记录与门禁两处）', async (root) => {
    const { entry } = await seedCapture(root, { rendered: [{ feature_id: 'page:workspace:upload', located: true, drawn: false, reason: 'outside-image' }] });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-coverage-failed'));
    assert.deepStrictEqual(validateCaptureCoverage({ projectRoot: root, config: config(), captureIds: [entry.captureId] }).map((item) => item.code), ['annotation-coverage-failed']);
  });

  await test('发布门禁：Capture 对应页面已删除 → annotation-metadata-invalid；记录缺失 → capture-record-missing', async (root) => {
    const { entry } = await seedCapture(root, { pages: [modelPage({ id: 'other', route: '/other' })] });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-metadata-invalid'));
    assert.deepStrictEqual(validateCaptureCoverage({ projectRoot: root, config: config(), captureIds: ['00000000-0000-4000-8000-000000000000'] }).map((item) => item.code), ['capture-record-missing']);
  });

  await test('旧证据没有覆盖结果：不阻断，但 verify 明确标为 unknown', async (root) => {
    const { entry } = await seedCapture(root, { coverage: null, annotations: false });
    assert.deepStrictEqual(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })), []);
    const report = annotationCoverageForImages(root, config(), [{ captureId: entry.captureId }]);
    assert.strictEqual(report.status, 'legacy-unknown');
    assert.strictEqual(report.captures[0].status, 'unknown');
  });

  process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
