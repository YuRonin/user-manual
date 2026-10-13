'use strict';

/*
 * 页面采集用例：`manual capture <page>` 与 Runtime 的 capture handler 共用。
 *
 * 读取已提交模型 → 打开真实页面 → 导航 / 身份验证 → 稳定截图 → 离线派生发布图 →
 * 提交不可变 Capture → 提交页面观察投影。页面打不开就不产出截图（见 capture 命令说明）。
 *
 * 不做任何输出；失败抛 CaptureError（浏览器相关）或带 errors 列表的 RuntimeError（输入问题）。
 * 在 BrowserSession 中运行时由 session 提供隔离 Context 并负责写回认证（含轮换后的令牌）。
 */

const fs = require('fs');
const path = require('path');

const { createProvider } = require('../browser');
const { CaptureError, REASON } = require('../browser/errors');
const { DEFAULT_READY_OPTIONS } = require('../browser/provider');
const { CONFIDENCE, ANALYSIS, normalizePage, isActivePage } = require('../inspect/model');
const { resolveRouteTemplate, resolveEntryLocation, derivePageScenario } = require('../scenarios/model');
const { readIndexes, findForwardPage } = require('../inspect/index-store');
const { prepareAuth, classifyAuthFailure, refreshAuth } = require('../auth/runtime');
const { validateNavigation, validateWithReload, runAssertions, runSetup, checkPreconditions } = require('./validate-page');
const { resolveWaits } = require('../config/waits');
const { captureStable, derivePublished, confirmTargetsShown, inspectWithRetry, locateReason } = require('./capture-safe');
const { pageInventory, buildPlan, domCandidates } = require('../annotations/coverage');
const { annotationArtifacts } = require('../annotations/proof');
const { createProjectStore } = require('../store/project');
const { createCaptureStore, sanitizeUrl, publishedEntries } = require('./store');
const { definitionRevision } = require('../model/revision');
const { revisionOf } = require('../util/hash');
const { RuntimeError } = require('../runtime/errors');
const { resolveScenario } = require('../scenarios/store');
const { prepareScenarioData } = require('../scenarios/fixtures');
const { mergeDemo } = require('../privacy/demo');
const { toCanvasRect } = require('../browser/playwright');
const { subjectKey, recordGateFailure, clearGateFailure } = require('./demo-gate-log');

const REASON_CODES = new Set(Object.values(REASON));

function inputError(code, errors) {
  return new RuntimeError(code, errors.join(' '), { errors });
}

/** 解析 `--params "id=123;tab=a"`。 */
function parseParams(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split(';')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

/**
 * 把 `/artifact/:id` 这类模板换成具体路径（catch-all 参数按 / 拆段后逐段编码）。
 * @returns {{ ok: true, route } | { ok: false, missing: string[] }}
 */
function resolveRoute(route, params) {
  const resolved = resolveRouteTemplate(route, params);
  return resolved.ok ? resolved : { ok: false, missing: [...resolved.missing, ...resolved.invalid] };
}

function joinUrl(baseUrl, route) {
  const base = String(baseUrl).replace(/\/$/, '');
  const suffix = route === '/' ? '/' : (route.startsWith('/') ? route : `/${route}`);
  return base + suffix;
}

/** 截图派生输入（几何、标注目标、敏感元素候选）：私有 sidecar，隐私规则变化时据此从同一份 raw 重新派生。 */
function derivationSidecar(captured) {
  return JSON.stringify({ version: 2, geometry: captured.geometry, targets: captured.targets || [], candidates: captured.candidates || [], shotMeta: captured.shot?.meta || null, inventory: captured.inventory || null, plan: captured.plan || null, featureCandidates: captured.featureCandidates || [], figures: captured.figures || null, bindings: captured.bindings || [], stateVerified: captured.stateVerified || false });
}

/**
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {object} p.config
 * @param {string} p.pageId
 * @param {object} [p.options]  { profile, provider, url, params, fullPage, timeout, quietMs, settleMs, noFreezeAnimations, waitFor }
 * @param {object} [p.session]  BrowserSession；缺省时自行创建并关闭 provider
 * @param {string} [p.runId]
 * @returns {Promise<object>} 采集结果（见函数末尾）
 */
async function capturePage({ projectRoot, config, pageId, options = {}, session = null, runId = null }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  // 读取已提交模型（必要时导入手工修改 / 修复半写入）；浏览器工作在锁外进行，最后只提交这一页的观察投影
  const projectStore = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir });
  let base;
  try {
    base = projectStore.load();
  } catch (e) {
    throw inputError('invalid-model', ['已有的页面文件解析失败：', ...(e.errors || [e.message]).map((x) => `  ${x}`)]);
  }
  const pages = base.model.pages;
  if (pages.length === 0) throw inputError('no-pages', ['.manual/pages/ 里还没有页面。先运行 `manual inspect` 扫描项目。']);
  const found = pages.find((p) => p.id === pageId);
  if (!found) throw inputError('unknown-target', [`找不到页面 "${pageId}"。已有: ${pages.map((p) => p.id).join(', ')}`]);
  const page = normalizePage(found);
  if (!isActivePage(page)) {
    throw inputError('page-not-active', [
      `page-not-active: 页面 "${pageId}" 当前是 ${page.lifecycle}，不能采集（定义与历史证据仍保留）。`,
      page.lifecycle === 'missing' ? '如果只是改了路由，在页面文件里声明 routeBindings 后重跑 `manual inspect`。' : '需要恢复时把 lifecycle 改回 active。',
    ]);
  }
  const indexes = readIndexes(stateDirAbs);
  const indexedPage = indexes.ok ? findForwardPage(indexes.forward, { id: page.id, route: page.route }) : null;
  const effectiveRoute = typeof indexedPage?.route === 'string' ? indexedPage.route : page.route;

  // ---- 截图规格与 provider
  const profileId = options.profile || config.capture.activeProfile;
  const profile = config.capture.profiles[profileId];
  if (!profile) throw inputError('invalid-arguments', [`截图规格 "${profileId}" 不在 config 的 capture.profiles 里。`]);
  const providerId = options.provider || config.browser.activeProvider;
  const providerConfig = config.browser.providers[providerId];
  if (!providerConfig) throw inputError('invalid-arguments', [`Browser Provider "${providerId}" 不在 config 的 browser.providers 里。`]);

  const params = typeof options.params === 'string' ? parseParams(options.params) : (options.params || {});

  // Scenario：显式指定（Scenario 变体，如空状态 / 错误态 / 其他角色）或页面默认（含 .manual/scenarios 覆盖）。
  // 先定 Scenario 再拼地址：显式 Scenario 的 entry（params / path / query）决定打开哪条具体内容。
  let scenario = options.scenario || null;
  let explicitScenario = !!scenario;
  let scenarioWarnings = [];
  if (!scenario) {
    const resolved = resolveScenario(stateDirAbs, derivePageScenario(page, config, { params }), { stepIds: [] });
    if (!resolved.ok) throw inputError('invalid-scenario', resolved.errors);
    scenario = resolved.scenario;
    explicitScenario = resolved.explicit;
    scenarioWarnings = resolved.warnings || [];
  }

  // ---- 要打开的地址
  let url;
  if (options.url) {
    url = options.url;
  } else {
    const resolved = resolveEntryLocation(effectiveRoute, scenario.entry, params);
    if (!resolved.ok && resolved.invalid.some((item) => item.startsWith('entry.path'))) {
      throw inputError('invalid-scenario', [`Scenario ${scenario.id} 的 ${resolved.invalid.join('、')}；它不能打开页面 ${pageId} 路由之外的地址。`]);
    }
    if (!resolved.ok) {
      const missing = [...resolved.missing, ...resolved.invalid];
      throw inputError('params-required', [
        `"${pageId}" 是动态路由 ${effectiveRoute}，需要具体参数值才能打开。`,
        `缺少: ${missing.join(', ')}`,
        `补上即可，例如: manual capture ${pageId} --params "${missing.map((m) => `${m}=<值>`).join(';')}"`,
      ]);
    }
    url = joinUrl(config.project.baseUrl, resolved.route) + resolved.search;
  }

  const captureStore = createCaptureStore({ projectRoot, stateDirAbs });
  const format = config.artifacts.format || 'png';
  const waits = resolveWaits(config);
  const readyOptions = {
    // --timeout 优先；否则用项目配置的就绪等待预算（capture.waits.readinessMs，有上限）
    timeout: options.timeout ? Number(options.timeout) : waits.readinessMs,
    quietMs: options.quietMs ? Number(options.quietMs) : DEFAULT_READY_OPTIONS.quietMs,
    settleMs: options.settleMs ? Number(options.settleMs) : DEFAULT_READY_OPTIONS.settleMs,
    freezeAnimations: options.noFreezeAnimations !== true,
    waitFor: options.waitFor || null,
  };

  const isDefaultScenario = scenario.id === `page-${page.id}`;
  // Fixture：先过环境策略（生产 / 未登记环境拒绝），再决定拦截路由；在打开浏览器之前完成
  const data = prepareScenarioData({ stateDirAbs, config, scenario, runId });
  // 每个 Scenario 用自己的身份：匿名 / 成员 / 管理员互不共享认证状态
  const auth = prepareAuth(config, { profile: scenario.authProfile });
  // 派生的默认 Scenario 沿用通用导航规则；显式 Scenario 按声明的状态码 / 预期状态（Empty / Error / Loading）/ 跳转校验
  const expected = explicitScenario
    ? { statuses: scenario.expected?.httpStatuses, state: scenario.expected?.state || 'normal', allowRedirects: scenario.expected?.redirects?.length ? scenario.expected.redirects : undefined }
    : {};
  const checkpoint = (scenario.checkpoints || []).find((c) => c.id === (options.checkpointId || 'default')) || scenario.checkpoints?.[0] || null;
  // 检查点声明的截图方式生效（B5-02）：capture.mode: fullPage 与命令行 --full-page 等价
  if (options.checkpointId && checkpoint?.id !== options.checkpointId) throw new RuntimeError('invalid-scenario', `缺少检查点 ${options.checkpointId}`);
  const fullPage = options.fullPage === true || checkpoint?.capture?.mode === 'fullPage';
  // 变体的检查点状态断言（URL 以外）：setup 之后确认、截图之后复核
  const stateAssertions = (checkpoint?.assertions || []).filter((a) => a && a.type !== 'url');
  // 有 setup 的变体：打开时页面还是默认状态，先用页面默认身份断言，检查点断言在 setup 之后确认
  const hasSetup = (scenario.setup || []).length > 0;
  const identityAssertions = ((isDefaultScenario || hasSetup ? page.states?.default?.assertions : checkpoint?.assertions) || []).filter((a) => a && a.type !== 'url');
  const inventory = pageInventory({ page, scenarioId: scenario.id, checkpoint });
  const layout = require('../annotations/section-plan');
  const figures = layout.figuresFor(page, scenario.id, checkpoint?.id || 'default');
  const annotationPlan = layout.grouped(page) ? layout.layoutPlan(page, scenario.id, checkpoint?.id || 'default') : buildPlan({ inventory, page, annotations: isDefaultScenario ? null : (checkpoint?.capture?.annotations || []) });
  const scopedInventory = layout.grouped(page) ? require('../annotations/coverage').buildInventory({ page, scenario: scenario.id }).map(i => ({ ...i, priority: 'optional' })) : inventory;
  const staging = captureStore.begin();
  const stagedRaw = staging.file(`raw.${format}`);
  const stagedSanitized = staging.file('sanitized.png');
  const stagedPublished = staging.file('published.png');
  const stagedDerivation = staging.file('derivation.json');
  const stagedAnnotations = staging.file('annotations.json');

  const work = async (provider) => {
    // Demo：网络守卫、Fixture 路由与演示值必须在打开页面之前安装；没有 Fixture 也要安装（写请求一律受控）
    if (provider.installDemoGuard) {
      await provider.installDemoGuard({ routes: data.routes, baseUrl: config.project.baseUrl, demo: mergeDemo(config.capture?.demo, data.demo), dataMode: data.mode });
    } else if (data.routes.length) {
      throw new RuntimeError('capability-missing', '当前 Browser Provider 不支持请求拦截（routeMocking），不能使用 mock Fixture。');
    }
    const openResult = await provider.open(url, { timeout: readyOptions.timeout });
    // 等待结束后重新读取 URL 与页面事实：SPA 延迟跳转以截图时的地址为准。
    // 先判断这次打开到底算不算成功，再决定要不要落盘。顺序不能反。长期卡在加载中时刷新一次再判定。
    const { ready, navigation } = await validateWithReload(provider, {
      settle: async () => ({
        ready: await provider.waitUntilReady(readyOptions),
        observation: provider.currentObservation ? await provider.currentObservation() : await provider.probe(),
      }),
      validate: (observation) => validateNavigation({ requestedUrl: url, openResult, observation, expected }),
      enabled: waits.reloadOnStuckLoading, timeout: readyOptions.timeout,
    });
    ready.warnings.push(...navigation.warnings, ...scenarioWarnings, ...(base.warnings || []));
    // 页面身份：只有非 URL 断言能证明"打开的是这一页"；只有 URL 的旧模型记为 url-only。
    let identity = 'url-only';
    if (!options.url && identityAssertions.length > 0) {
      try {
        navigation.validations.push(...await runAssertions(provider, identityAssertions, {
          scope: 'page-identity', idPrefix: 'default', timeoutMs: Math.min(readyOptions.timeout, 10000),
        }));
        identity = 'verified';
      } catch (error) {
        throw new CaptureError(REASON.PAGE_IDENTITY_FAILED, `${url} 的页面身份断言未通过: ${error.message}`, {
          url, finalUrl: navigation.finalUrl, assertionId: error.validation?.assertionId || null,
        });
      }
    }
    // 显式 Scenario：一次性前置数据仍在（B5-06b）→ 执行页面 setup 进入目标状态（B5-01）→ 检查点断言
    if (explicitScenario) {
      const assertOptions = { timeoutMs: Math.min(readyOptions.timeout, 10000) };
      try {
        navigation.validations.push(...await runAssertions(provider, scenario.expected?.roleAssertions || [], { scope: 'auth-identity', idPrefix: `role:${scenario.authProfile}`, ...assertOptions }));
      } catch (error) {
        throw Object.assign(new Error(`以 ${scenario.authProfile} 身份打开后，页面没有呈现该角色应有的内容：${error.message}。确认账号权限；不会改用其他身份。`), { code: 'auth-identity-mismatch' });
      }
      navigation.validations.push(...await checkPreconditions(provider, scenario.preconditions || [], assertOptions));
      navigation.validations.push(...await runSetup(provider, scenario.setup || [], assertOptions));
      if (hasSetup && stateAssertions.length) navigation.validations.push(...await runAssertions(provider, stateAssertions, { scope: 'scenario-state', idPrefix: checkpoint?.id || 'default', timeoutMs: assertOptions.timeoutMs }));
    }
    // 语义摘要与采集环境：在线验证据此判断内容漂移、视觉比较是否可比（P3-04）
    if (provider.applyDemo) await provider.applyDemo();
    const semantic = provider.semanticSnapshot ? await provider.semanticSnapshot() : null;
    const bindings = [];
    const boundTargets = new Map();
    if (layout.grouped(page)) {
      const unresolved = [];
      for (const item of annotationPlan) {
        const key = `${item.figure_id}/${item.operation_id}`;
        const binding = await require('../annotations/binding').bindOperation(provider, item, semantic, options.bindingChoices?.[key]);
        if (binding.status !== 'verified') unresolved.push({ key, operationId: item.operation_id, figureId: item.figure_id, intent: item.bindingIntent, description: item.description, reason: binding.reason, candidates: binding.candidates });
        else { boundTargets.set(key, binding.target); bindings.push({ operationId: item.operation_id, figureId: item.figure_id, status: 'verified', target: binding.target, source: binding.source, name: binding.name, role: binding.role, authProfile: scenario.authProfile, scenarioId: scenario.id, checkpointId: checkpoint?.id || 'default' }); }
      }
      if (unresolved.length) throw Object.assign(new Error('分类图片的控件绑定需要宿主模型消歧'), { code: 'binding-input-required', unresolved });
    }
    const resolvedFigures = [];
    for (const f of figures) {
      let regionRect = null;
      if (f.frame?.mode === 'region') {
        const region = await inspectWithRetry(provider, f.frame.target);
        if (!region.rect || region.obscuredBy) throw Object.assign(new Error(`图片 ${f.id} 区域无法定位`), { code: 'figure-region-invalid' });
        const geometry = fullPage ? await provider.collectGeometry({ fullPage: true }) : null;
        regionRect = toCanvasRect(region.rect, { fullPage, geometry, pinned: region.pinned || null });
      }
      resolvedFigures.push({ ...f, ...(regionRect ? { regionRect } : {}) });
    }
    const environment = provider.environmentInfo ? provider.environmentInfo({ fullPage }) : null;
    // 稳定截图 + 离线派生：原图只留在 rawDir，发布图由同一份原图遮罩后写入 annotatedDir。
    const captured = await captureStable(provider, { rawPath: stagedRaw, fullPage, format, stabilityMs: waits.stabilityMs,
      // 截图后复核状态（B5-05）：定位标注时的悬停 / 滚动可能把菜单、弹窗弄没
      assertState: stateAssertions.length ? async () => {
        const validated = await runAssertions(provider, stateAssertions, { scope: 'scenario-state', idPrefix: 'after-shot', timeoutMs: 1500 });
        navigation.validations.push(...validated);
        return validated;
      } : null,
      resolveTargets: async () => {
        const targets = [];
        const located = [];
        for (const [i, planned] of annotationPlan.entries()) {
          const item = layout.grouped(page) ? { ...planned, target: boundTargets.get(`${planned.figure_id}/${planned.operation_id}`) } : planned;
          const extra = item.operation_id ? { operation_id: item.operation_id, figure_id: item.figure_id } : {};
          const label = item.label || String(i + 1);
          if (item.rect) { targets.push({ ...extra, feature_id: item.feature_id, label, rect: item.rect, resolution: { source: 'declared-rect' } }); continue; }
          if (!item.target) { targets.push({ ...extra, feature_id: item.feature_id, label, reason: 'target-not-declared' }); continue; }
          try {
            const found = await inspectWithRetry(provider, item.target);
            if (found.obscuredBy) { targets.push({ ...extra, feature_id: item.feature_id, label, reason: 'target-occluded', obscuredBy: found.obscuredBy }); continue; }
            if (!found.rect) { targets.push({ ...extra, feature_id: item.feature_id, label, reason: 'target-not-located' }); continue; }
            // 整页截图：与隐私遮罩同一套换算（滚动偏移、fixed 元素），框和遮罩不会相对错位（B4-04）
            const geometry = fullPage ? await provider.collectGeometry({ fullPage: true }) : null;
            const rect = toCanvasRect(found.rect, { fullPage, geometry, pinned: found.pinned || null });
            // 记录实际命中的定位策略（主目标或第几个备选），备选命中不再静默（B2-07）
            targets.push({ ...extra, feature_id: item.feature_id, label, rect, resolution: found.resolution || null });
            located.push({ target: item.target, label, revealedBy: found.revealedBy || null });
          } catch (error) { targets.push({ ...extra, feature_id: item.feature_id, label, reason: locateReason(error) }); }
        }
        await confirmTargetsShown(provider, located);
        // Region geometry must belong to the same stabilized scroll state as the targets.
        for (const figure of resolvedFigures.filter(f => f.frame?.mode === 'region')) {
          const region = await inspectWithRetry(provider, figure.frame.target);
          if (!region.rect || region.obscuredBy) throw Object.assign(new Error(`图片 ${figure.id} 区域无法定位`), { code: 'figure-region-invalid' });
          const geometry = fullPage ? await provider.collectGeometry({ fullPage: true }) : null;
          figure.regionRect = toCanvasRect(region.rect, { fullPage, geometry, pinned: region.pinned || null });
        }
        return targets;
      },
    });
    ready.warnings.push(...(captured.warnings || []));
    captured.inventory = scopedInventory;
    if (figures.length) Object.assign(captured, { figures: resolvedFigures, bindings, stateVerified: (checkpoint?.assertions || []).some(a => a.type !== 'url') });
    captured.plan = layout.grouped(page) ? annotationPlan.map(item => ({ ...item, target: boundTargets.get(`${item.figure_id}/${item.operation_id}`) || item.target })) : annotationPlan;
    // 默认 Scenario 的整页截图：无障碍树里清单未覆盖的可交互元素作为待确认候选（变体只看本状态声明的项）
    captured.featureCandidates = isDefaultScenario ? domCandidates({ semantic, inventory, page, ignore: [...(config.inventory?.ignoreCandidates || []), ...bindings.map(b => b.name).filter(Boolean)] }) : [];
    fs.writeFileSync(stagedDerivation, derivationSidecar(captured));
    const safe = await derivePublished({
      captured,
      rawPath: stagedRaw,
      sanitizedPath: stagedSanitized,
      publishedPath: stagedPublished,
      theme: config.annotation.themes[config.annotation.activeTheme],
      redactionRules: config.privacy || {},
    });
    const annotationOut = annotationArtifacts({ inventory: scopedInventory, figures: safe.figures, bindings: safe.bindings, plan: annotationPlan, rendered: safe.rendered, candidates: captured.featureCandidates, coverage: safe.coverage });
    fs.writeFileSync(stagedAnnotations, JSON.stringify(annotationOut.document, null, 2));
    safe.proof = annotationOut.proof;
    const fallbacks = safe.rendered.filter((item) => item.locator?.fallback).map((item) => `${item.feature_id}（备选 ${item.locator.strategyIndex}）`);
    if (fallbacks.length) ready.warnings.push(`annotation-locator-fallback: 主定位未命中，改用备选定位：${fallbacks.join('、')}；确认后更新 target。`);
    ready.warnings.push(...safe.quality.warnings);
    if (safe.coverage?.pending.length) ready.warnings.push(`annotation-priority-undecided: ${safe.coverage.pending.map((item) => item.label).join('、')}`);
    if (safe.coverage && !safe.coverage.ok) ready.warnings.push(`annotation-coverage-failed: ${safe.coverage.failures.map((item) => `${item.feature_id}:${item.reason}`).join('、')}`);
    if (!safe.published) ready.warnings.push(`页面隐私检测未通过（${safe.privacy.unresolved.length} 项无法定位），未生成发布图；手册只能出文字版。`);
    if (!session) {
      const refreshed = await refreshAuth(provider, auth);
      if (refreshed.warning) ready.warnings.push(refreshed.warning);
    }
    return { shot: captured.shot, ready, navigation, identity, safe, semantic, environment };
  };

  let observed;
  try {
    if (session) {
      const result = await session.withScenario({ id: providerId, providerConfig, profile, auth }, work);
      observed = result.value;
      observed.ready.warnings.push(...result.warnings);
    } else {
      const provider = createProvider({ id: providerId, providerConfig, profile, storageState: auth.storageState });
      try {
        observed = await work(provider);
      } catch (error) {
        // 失败也要保存已轮换的令牌，否则下次注入的是已作废的旧 refresh token。
        await refreshAuth(provider, auth, { onlyIfChanged: true });
        throw error;
      } finally {
        await provider.close();
      }
    }
  } catch (e) {
    captureStore.abort(staging);
    // Demo 门禁失败没有 Capture 记录可留：单独记下原因码，generate 据此提示"重新采集被阻断、仍在用旧图"
    recordGateFailure(stateDirAbs, subjectKey(['page', pageId, scenario.id]), e);
    if (e.code === 'binding-input-required') throw e;
    if (e.code === 'browser-crashed' || e.code === 'session-closed') throw e;
    const normalized = e instanceof CaptureError
      ? e
      // 标注 / 几何类失败是确定性的，保留原码，不能改写成可重试的 navigation-failed（B4-08）
      : new CaptureError(e.code && (REASON_CODES.has(e.code) || /^(annotation|figure|binding|geometry|scenario|precondition|auth-identity)-/.test(e.code)) ? e.code : REASON.NAVIGATION_FAILED, String(e.message || e), { url });
    throw classifyAuthFailure(normalized, auth);
  }
  const { shot, ready, navigation, identity, safe, semantic, environment } = observed;

  // ---- 提交不可变 Capture：产物安装 → 记录可见 → latest 引用 → 页面投影
  const capturedAt = new Date().toISOString();
  const spec = {
    viewport: shot.meta.viewport,
    dpr: shot.meta.deviceScaleFactor,
    fullPage: !!shot.meta.fullPage,
    profile: profileId,
    provider: providerId,
  };
  const modelRevision = definitionRevision('page', page);
  let record;
  try {
    const artifacts = [
      ...(config.capture.safety?.persistRaw === false ? [] : [{ kind: 'raw', file: stagedRaw, dir: config.artifacts.rawDir, prefix: pageId }]),
      { kind: 'sanitized', file: stagedSanitized, dir: `${config.artifacts.sanitizedDir}/pages`, prefix: pageId },
      { kind: 'derivation', file: stagedDerivation, dir: `${config.artifacts.stateDir}/artifacts/derivation`, prefix: pageId },
      { kind: 'annotations', file: stagedAnnotations, dir: `${config.artifacts.stateDir}/artifacts/annotations`, prefix: pageId },
    ];
    artifacts.push(...publishedEntries(safe, { file: stagedPublished, dir: config.artifacts.annotatedDir, prefix: `page--${pageId}` }));
    record = captureStore.commit(staging, {
      record: {
        kind: 'page',
        rawRetained: config.capture.safety?.persistRaw !== false,
        subject: { pageId },
        runId,
        scenarioId: scenario.id,
        scenarioRevision: scenario.revision,
        checkpointId: checkpoint?.id || 'default',
        ...(layout.grouped(page) ? { bindingRevision: layout.bindingRevision(page), layoutRevision: layout.layoutRevision(page) } : {}),
        inputHash: revisionOf({ pageId, modelRevision, scenarioRevision: scenario.revision, url: sanitizeUrl(url), spec }),
        modelRevision,
        // 截图时的源码指纹：之后源码变化时据此判断这张图已过期（记录本身不改，只是不再适用）
        sourceFingerprint: page.analysis?.sourceRevision || null,
        observedAt: capturedAt,
        finalUrl: sanitizeUrl(shot.meta.url),
        actualRoute: navigation.actualRoute,
        identity,
        spec,
        validations: navigation.validations,
        ...(semantic ? { semantic } : {}),
        ...(environment ? { environment } : {}),
        privacy: safe.privacy,
        quality: safe.quality,
        annotationCoverage: safe.coverage,
        // 精简标注证明随记录入库：删除 artifacts / 重新 clone 后仍能核对覆盖率（B2-12）
        ...(safe.proof ? { annotationProof: safe.proof } : {}),
        redactions: safe.redactions.map(({ kind, rect, result }) => ({ kind, rect, result })),
        // simulated：界面由拦截的静态响应驱动，只证明"界面如何呈现这种数据"；fixture：登记的测试数据
        ...(data.fixture ? { fixture: data.fixture } : {}),
        provenance: {
          mode: data.mode,
          derivedFromRawHash: safe.derived.rawHash,
          geometryHash: safe.derived.geometryHash,
          rendererVersion: safe.derived.rendererVersion,
          themeRevision: safe.derived.themeRevision,
        },
      },
      artifacts,
    });
    // Scenario 变体的采集不替换页面默认截图
    captureStore.setLatest({ [isDefaultScenario ? `page:${pageId}` : `scenario:${scenario.id}`]: record.id, [`figure-state:${scenario.id}:${checkpoint?.id || 'default'}`]: record.id });
    clearGateFailure(stateDirAbs, subjectKey(['page', pageId, scenario.id]));
  } catch (e) {
    captureStore.abort(staging);
    throw new RuntimeError(e.code || 'capture-commit-failed', `${e.code || 'capture-commit-failed'}: ${e.message}`);
  }

  // 观察提交：只改这一页的 browser 投影与可信度，不重写其它页面、不覆盖同时发生的定义修改。
  // 模拟数据 / Scenario 变体的采集只作为独立证据，不成为页面手册的默认截图。
  const updatedPage = isDefaultScenario && data.mode === 'live' ? pageProjection(page, record, { shotMeta: shot.meta, providerId, navigation, identity }) : page;
  if (updatedPage !== page) {
    try {
      projectStore.commit({ base, kind: 'observation', changes: { pages: [updatedPage] } });
    } catch (e) {
      throw new RuntimeError(e.code || 'model-commit-failed', `${e.code || 'model-commit-failed'}: ${e.message}（Capture ${record.id} 已提交，可重新运行以更新页面投影）`, { captureId: record.id });
    }
  }

  return {
    page, updatedPage, record, shot, ready, navigation, identity, safe, url, effectiveRoute,
    profileId, profile, providerId, capturedAt,
    screenshotRelative: record.artifacts.find((a) => a.kind === 'raw')?.path || null,
    published: updatedPage.browser?.published || null,
  };
}

/** 由 Capture 记录构造页面 browser 投影（采集与复用 / 重新派生共用）。 */
function pageProjection(page, record, { shotMeta = null, providerId = null, navigation = null, identity = null } = {}) {
  const artifactOf = (kind) => record.artifacts.find((a) => a.kind === kind) || null;
  const publishedArtifact = artifactOf('published');
  const viewport = shotMeta?.viewport || record.spec?.viewport;
  // 页面投影只是指向记录的便捷字段；可信度以 Capture 记录的 validations 为准。
  const published = publishedArtifact ? {
    captureId: record.id,
    artifactPath: publishedArtifact.path,
    sha256: publishedArtifact.sha256,
    privacy: record.privacy,
    derivedFromRawHash: record.provenance?.derivedFromRawHash || null,
    geometryHash: record.provenance?.geometryHash || null,
    rendererVersion: record.provenance?.rendererVersion || null,
  } : null;
  const updated = {
    ...page,
    browser: {
      verified: true,
      latestCaptureId: record.id,
      lastCapture: record.observedAt,
      screenshot: artifactOf('raw')?.path || null,
      url: shotMeta?.url || (record.finalUrl ? `${record.finalUrl.origin || ''}${record.finalUrl.pathname}` : null),
      actualRoute: navigation?.actualRoute ?? record.actualRoute ?? null,
      identity: identity || record.identity || null,
      viewport: viewport ? `${viewport.width}x${viewport.height}` : null,
      deviceScaleFactor: shotMeta?.deviceScaleFactor ?? record.spec?.dpr ?? null,
      provider: providerId || record.spec?.provider || null,
      published,
    },
  };
  // 源码分析也做完了的话，这一页就从「推断」升级成「验证过」
  if (page.status?.sourceAnalysis === ANALYSIS.COMPLETED) updated.confidence = CONFIDENCE.VERIFIED;
  return updated;
}

module.exports = { capturePage, pageProjection, parseParams, resolveRoute, joinUrl, derivationSidecar };
