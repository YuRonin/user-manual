'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { buildInventory, buildPlan, verifyCoverage, verifyExplanations, pageInventory, stepInventory, stepFeatures, domCandidates } = require('../src/annotations/coverage');
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
const { annotationArtifacts } = require('../src/annotations/proof');
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
const workspace = { id: 'workspace', detectedActions: ['上传附件', '选择仙技'], features: [{ id: 'upload', label: '上传附件', priority: 'required', description: '上传资料', target: upload }], guide: [{ id: 'upload', title: '上传附件', instruction: '点击上传附件。', target: upload }] };

function png(width = 100, height = 100) {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer();
}

function config(audience = 'public') {
  return {
    docs: { outputDir: 'docs/manual', imagesDir: 'docs/manual/images' },
    artifacts: {
      stateDir: '.manual', rawDir: '.manual/artifacts/raw/pages', taskRawDir: '.manual/artifacts/raw', sanitizedDir: '.manual/artifacts/sanitized',
      diagnosticsDir: '.manual/artifacts/diagnostics', manifestsDir: '.manual/artifacts/manifests', annotatedDir: 'docs/manual/images/annotated',
    },
    privacy: { audience, redaction: 'balanced', maskStyle: 'neutral-mosaic', rules: { redact: [], preserve: [] } },
  };
}

function modelPage(overrides = {}) {
  return {
    id: 'workspace', route: '/workspace', dynamic: false, params: [], title: '工作台', purpose: '上传资料', detectedActions: [], entry: 'app/workspace/page.tsx',
    source: ['app/workspace/page.tsx'], dependencies: { files: [], unresolved: [] }, includeInManual: true, confidence: 'inferred',
    browser: { verified: false }, states: { default: { assertions: [{ type: 'url', value: '/workspace' }] } }, status: { router: 'app', sourceAnalysis: 'completed' },
    features: workspace.features, guide: workspace.guide, ...overrides,
  };
}

/** 真实 Capture 记录：发布图 + annotations.json；返回发布条目与记录。 */
async function seedCapture(root, { pages = [modelPage()], coverage = 'computed', annotations = true, rendered: drawnItems = null, proof = true, page = modelPage(), candidates = [] } = {}) {
  const stateDirAbs = path.join(root, '.manual');
  pageStore.writeModel(stateDirAbs, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: '2026-10-10T00:00:00.000Z' }, pages);
  const items = pageInventory({ page, scenarioId: 'page-workspace' });
  const planned = buildPlan({ inventory: items, page });
  const rendered = drawnItems || planned.map((item) => drawn(item.feature_id));
  const out = annotationArtifacts({ inventory: items, plan: planned, rendered, candidates, coverage: verifyCoverage({ inventory: items, plan: planned, rendered, candidates }) });
  const data = out.document;
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
    ...(proof && coverage ? { annotationProof: out.proof } : {}),
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

  await test('B2-08 大半在图外（partially-clipped）或被隐私遮罩盖住（target-redacted）不算标到；可见比例门槛可配置', () => {
    const item = (sourceRect) => ({ feature_id: 'f', label: '1', sourceRect, target: { x: sourceRect.x - 2, y: sourceRect.y - 2, width: sourceRect.width + 4, height: sourceRect.height + 4 }, marker: { x: 10, y: 10, size: 20 } });
    const [clipped] = renderAnnotationResults([item({ x: 80, y: 40, width: 40, height: 20 })], { width: 100, height: 100, dpr: 1 });
    assert.strictEqual(clipped.drawn, true);
    assert.strictEqual(clipped.visible, false);
    assert.strictEqual(clipped.reason, 'partially-clipped');
    assert.strictEqual(clipped.visibleRatio, 0.5);
    const [lenient] = renderAnnotationResults([item({ x: 80, y: 40, width: 40, height: 20 })], { width: 100, height: 100, dpr: 1, minVisibleRatio: 0.4 });
    assert.strictEqual(lenient.visible, true);
    const [masked] = renderAnnotationResults([item({ x: 20, y: 40, width: 40, height: 20 })], { width: 100, height: 100, dpr: 1, redactions: [{ rect: { x: 20, y: 40, width: 30, height: 20 } }] });
    assert.strictEqual(masked.reason, 'target-redacted');
    const required = [{ feature_id: 'f', priority: 'required', description: 'x' }];
    assert.deepStrictEqual(verifyCoverage({ inventory: required, plan: [{ feature_id: 'f' }], rendered: [clipped] }).failures.map((f) => f.reason), ['partially-clipped']);
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

  await test('只有 guide 的页面：带 target 的 guide 是待确认候选，Required 显示 N/A 而不是 100%', () => {
    const page = { id: 'workspace', guide: workspace.guide };
    const items = buildInventory({ page });
    assert.deepStrictEqual(items.map((item) => [item.feature_id, item.priority]), [['page:workspace:upload', 'undecided']]);
    const planned = buildPlan({ inventory: items, page });
    assert.strictEqual(planned.length, 1, '候选照常进入标注计划');
    const report = verifyCoverage({ inventory: items, plan: planned, rendered: [drawn(planned[0].feature_id)] });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.required.percent, null);
    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.pending.map((item) => item.label), ['上传附件']);
  });

  await test('同名功能按目标对应、不互相覆盖；新旧字段写法（id / taskIds）都可读', () => {
    const delA = { role: 'button', name: '删除', within: { role: 'row', name: 'A' } };
    const delB = { role: 'button', name: '删除', within: { role: 'row', name: 'B' } };
    const page = { id: 'list', features: [{ id: 'del-a', label: '删除', priority: 'required', description: '删除 A', target: delA, taskIds: ['t'] }, { feature_id: 'del-b', label: '删除', priority: 'optional', target: delB }],
      guide: [{ id: 'g-b', title: '删除', instruction: '删除 B。', target: delB }, { id: 'g-a', title: '删除', instruction: '删除 A。', target: delA }] };
    const items = buildInventory({ page });
    assert.deepStrictEqual(items.map((item) => [item.feature_id, item.guide_id, item.priority]), [['del-a', 'g-a', 'required'], ['del-b', 'g-b', 'optional']]);
    assert.deepStrictEqual(buildPlan({ inventory: items, page }).map((item) => [item.feature_id, item.label]), [['del-b', '1'], ['del-a', '2']]);
    assert.deepStrictEqual(stepFeatures({ page, task: { id: 't' }, step: { id: 's', action: { target: delA } } }).map((item) => item.id), ['del-a']);
  });

  await test('页面上观察到、清单未覆盖的可交互元素成为候选；链接 / 输入框 / 已知 / 忽略名单不计', () => {
    const semantic = { items: [{ role: 'button', name: '导出' }, { role: 'button', name: '上传附件' }, { role: 'link', name: '首页' }, { role: 'textbox', name: '搜索' }, { role: 'button', name: '帮助中心' }, { role: 'button', name: '导出' }, { role: 'button', name: '[redacted]' }] };
    const items = pageInventory({ page: workspace, scenarioId: 'page-workspace' });
    const candidates = domCandidates({ semantic, inventory: items, page: workspace, ignore: ['帮助*'] });
    assert.deepStrictEqual(candidates.map((item) => item.label), ['导出']);
    assert.strictEqual(domCandidates({ semantic, inventory: items, page: workspace, ignore: ['帮助*'] })[0].candidate_id, candidates[0].candidate_id, 'id 稳定');
    const report = verifyCoverage({ inventory: items, plan: buildPlan({ inventory: items, page: workspace }), rendered: [drawn('upload')], candidates });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.complete, false);
    assert.deepStrictEqual(report.unresolvedCandidates.map((item) => item.label), ['导出']);
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
    const { entry } = await seedCapture(root, { annotations: false, proof: false });
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
    const { entry } = await seedCapture(root, { rendered: [{ feature_id: 'upload', located: true, drawn: false, reason: 'outside-image' }] });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-coverage-failed'));
    assert.deepStrictEqual(validateCaptureCoverage({ projectRoot: root, config: config(), captureIds: [entry.captureId] }).map((item) => item.code), ['annotation-coverage-failed']);
  });

  await test('发布门禁：Capture 对应页面已删除 → annotation-plan-changed；记录缺失 → capture-record-missing', async (root) => {
    const { entry } = await seedCapture(root, { pages: [modelPage({ id: 'other', route: '/other' })] });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-plan-changed'));
    assert.deepStrictEqual(validateCaptureCoverage({ projectRoot: root, config: config(), captureIds: ['00000000-0000-4000-8000-000000000000'] }).map((item) => item.code), ['capture-record-missing']);
  });

  await test('T27 旧证据没有覆盖结果：public 阻断（annotation-coverage-unknown），internal 只警告；verify 标为 unknown', async (root) => {
    const { entry } = await seedCapture(root, { coverage: null, annotations: false });
    assert.deepStrictEqual(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })), ['annotation-coverage-unknown']);
    const warnings = [];
    assert.deepStrictEqual(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config('internal'), warnings })), []);
    assert.deepStrictEqual(warnings.map((item) => item.code), ['annotation-coverage-unknown']);
    const report = annotationCoverageForImages(root, config(), [{ captureId: entry.captureId }]);
    assert.strictEqual(report.status, 'legacy-unknown');
    assert.strictEqual(report.captures[0].status, 'unknown');
  });

  await test('AC-06 删除 .manual/artifacts 后：内嵌证明仍能完成标注验收；没有证明的旧记录明确要求重采', async (root) => {
    const { entry } = await seedCapture(root);
    fs.rmSync(path.join(root, '.manual', 'artifacts'), { recursive: true, force: true });
    assert.deepStrictEqual(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })), []);
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    const legacy = await seedCapture(root, { proof: false });
    fs.rmSync(path.join(root, '.manual', 'artifacts'), { recursive: true, force: true });
    assert.deepStrictEqual(annotationCodes(validateArtifact(legacy.entry, { projectRoot: root, config: config() })), ['annotation-metadata-invalid']);
  });

  await test('B2-13 截图后定义变化：发布前要求重采（annotation-plan-changed），核对已发布证据时只提示', async (root) => {
    const { entry } = await seedCapture(root, { pages: [modelPage({ features: [...workspace.features, { id: 'export', label: '导出', priority: 'required', description: '导出报告', target: { role: 'button', name: '导出' } }] })] });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-plan-changed'));
    const warnings = [];
    assert.deepStrictEqual(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config(), frozen: true, warnings })), [], '历史截图的结论不被当前定义改写');
    assert.deepStrictEqual(warnings.map((item) => item.code), ['annotation-plan-changed']);
  });

  await test('B2-14 public 页面有已确认的必标功能时不能用 --no-screenshot 跳过截图；internal 允许', async (root) => {
    pageStore.writeModel(path.join(root, '.manual'), { name: 'x', framework: 'nextjs', router: 'app', generatedAt: '2026-10-10T00:00:00.000Z' }, [modelPage()]);
    const { draftPage } = require('../src/generate/page-usecase');
    assert.throws(() => draftPage({ projectRoot: root, config: config(), pageId: 'workspace', noScreenshot: true }), (error) => /screenshot-required/.test((error.errors || [error.message]).join(' ')));
    let internalError = null;
    try { draftPage({ projectRoot: root, config: config('internal'), pageId: 'workspace', noScreenshot: true }); } catch (error) { internalError = error; }
    assert.ok(!/screenshot-required/.test(String(internalError?.errors || internalError?.message || '')), 'internal 不因必标功能拒绝纯文字草稿');
  });

  await test('T13 调换 guide 顺序但沿用旧图：annotation-label-mismatch', async (root) => {
    const intro = { id: 'intro', title: '了解工作台', instruction: '工作台汇总了资料。' };
    const before = modelPage({ guide: [...workspace.guide, intro] });
    const { entry } = await seedCapture(root, { page: before, pages: [modelPage({ guide: [intro, ...workspace.guide] })] });
    assert.ok(annotationCodes(validateArtifact(entry, { projectRoot: root, config: config() })).includes('annotation-label-mismatch'));
  });

  await test('未确认的候选功能：public 发布阻断（inventory-review-required），internal 只警告', async (root) => {
    const candidates = [{ candidate_id: 'page:workspace:dom:x', label: '导出', role: 'button' }];
    const { entry } = await seedCapture(root, { candidates });
    assert.ok(validateArtifact(entry, { projectRoot: root, config: config() }).some((item) => item.code === 'inventory-review-required' && /导出（页面发现）/.test(item.message)));
    const warnings = [];
    assert.ok(!validateArtifact(entry, { projectRoot: root, config: config('internal'), warnings }).some((item) => item.code === 'inventory-review-required'));
    assert.deepStrictEqual(warnings.map((item) => item.code), ['inventory-review-required']);
  });

  process.stdout.write(`${passed} passed, ${failures.length} failed\n`);
  if (failures.length) process.exitCode = 1;
})();
