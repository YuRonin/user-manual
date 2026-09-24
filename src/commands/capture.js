'use strict';

/*
 * `manual capture <page>` —— 用真实浏览器打开页面并截图。
 *
 * 铁律：**页面打不开就不要产出截图**。没有截图是个可见的缺口，
 * 伪造的截图会悄悄混进手册，谁都不知道那页其实是坏的。
 *
 * 这一层不认识 Playwright，只通过 BrowserProvider 契约说话（见 src/browser/）。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProvider } = require('../browser');
const { CaptureError, REASON } = require('../browser/errors');
const { DEFAULT_READY_OPTIONS } = require('../browser/provider');
const { CONFIDENCE, ANALYSIS, normalizePage } = require('../inspect/model');
const store = require('../inspect/store');
const { readIndexes, findForwardPage } = require('../inspect/index-store');
const { displayPath } = require('../util/fsx');
const { prepareAuth, classifyAuthFailure, refreshAuth } = require('../auth/runtime');
const { validateNavigation, runAssertions } = require('../evidence/validate-page');
const { captureStable, derivePublished } = require('../evidence/capture-safe');

const REASON_CODES = new Set(Object.values(REASON));

const KNOWN_FLAGS = new Set([
  'projectRoot', 'params', 'url', 'waitFor', 'timeout', 'quietMs', 'settleMs',
  'fullPage', 'noFreezeAnimations', 'provider', 'profile', 'out', 'json', 'help',
]);
const BOOLEAN_FLAGS = ['fullPage', 'noFreezeAnimations'];

const HELP = `
manual capture —— 用真实浏览器打开页面并截图

用法:
  manual capture <page-id> [选项]

做什么:
  从 .manual/pages/<page-id>.yaml 取出 route → 拼出 {baseUrl}{route} → 用配置里的
  Browser Provider 打开真实页面 → 等页面稳定 → 按配置的 viewport 与 DPR 截图 →
  回写页面模型的 browser 状态。

  页面打不开时**不会**产出任何截图，并给出分类的失败原因。

截图前会依次等待:
  load 事件 → 网络空闲 → 指定元素(可选) → Web Font 就绪 → 图片加载完 →
  DOM 连续静止 → 冻结 CSS 动画与过渡 → 静置回流

选项:
  --project-root <路径>    项目根目录，默认当前工作目录
  --params <k=v;k=v>       动态路由的参数值，例如 --params "id=123"
  --url <完整URL>          直接指定要打开的地址，绕过 route 拼接（调试用）
  --wait-for <选择器>      必须出现的元素（超时即失败，不截图），最可靠的「页面好了」信号
  --timeout <毫秒>         单步等待上限，默认 ${DEFAULT_READY_OPTIONS.timeout}
  --quiet-ms <毫秒>        DOM 静止多久算稳定，默认 ${DEFAULT_READY_OPTIONS.quietMs}
  --settle-ms <毫秒>       截图前静置时长，默认 ${DEFAULT_READY_OPTIONS.settleMs}
  --full-page              整页截图（默认只截一屏视口）
  --no-freeze-animations   不冻结动画（默认冻结，保证同页两次截图一致）
  --provider <id>          临时覆盖 config 里的 activeProvider
  --profile <id>           临时覆盖 config 里的 activeProfile
  --out <路径>             临时覆盖输出路径
  --json                   以 JSON 输出结果
  --help                   显示本帮助

示例:
  manual capture chat
  manual capture chat --provider playwright-headed
  manual capture artifact-id --params "id=123"
  manual capture membership --wait-for "text=购买" --full-page
`.trim();

function fail(error, { json }) {
  const payload = error instanceof CaptureError
    ? error.toJSON()
    : { reason: 'error', message: Array.isArray(error) ? error.join(' ') : String(error) };
  const list = Array.isArray(error) ? error : null;

  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: false, ...(list ? { errors: list } : payload) }, null, 2) + '\n'
    );
  } else {
    process.stderr.write('\n[manual capture] 截图失败：\n');
    if (list) {
      for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    } else {
      process.stderr.write(`  ✗ ${payload.message}\n`);
      if (payload.reason && payload.reason !== 'error') {
        process.stderr.write(`    原因分类: ${payload.reason}\n`);
      }
      if (payload.finalUrl) process.stderr.write(`    最终地址: ${payload.finalUrl}\n`);
      if (payload.status) process.stderr.write(`    HTTP 状态: ${payload.status}\n`);
      if (Array.isArray(payload.pageErrors) && payload.pageErrors.length > 0) {
        process.stderr.write('    页面报错:\n');
        for (const pe of payload.pageErrors) process.stderr.write(`      ${pe}\n`);
      }
      if (payload.hint) process.stderr.write(`\n  → ${payload.hint}\n`);
    }
    process.stderr.write('\n  没有产出截图文件（页面打不开时不会伪造截图）。\n\n');
  }
  return 1;
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
 * 把 `/artifact/:id` 这类模板换成具体路径。
 * @returns {{ ok: true, route } | { ok: false, missing: string[] }}
 */
function resolveRoute(route, params) {
  const missing = [];
  const resolved = route
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      const name = segment.slice(1).replace(/[*?]$/, '');
      const optional = segment.endsWith('?');
      const value = params[name];
      if (value === undefined || value === '') {
        if (optional) return null; // 可选 catch-all 缺省就整段去掉
        missing.push(name);
        return segment;
      }
      return encodeURIComponent(value);
    })
    .filter((segment) => segment !== null)
    .join('/');

  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, route: resolved === '' ? '/' : resolved };
}

function joinUrl(baseUrl, route) {
  const base = String(baseUrl).replace(/\/$/, '');
  const suffix = route === '/' ? '/' : (route.startsWith('/') ? route : `/${route}`);
  return base + suffix;
}

/**
 * 兼容旧接口：根据 HTTP 状态与页面事实判断这次打开是否真的成功。
 * 实际规则在 evidence/validate-page，与任务入口共用。
 */
function assessOutcome({ requestedUrl, openResult, probe }) {
  return validateNavigation({ requestedUrl, openResult, observation: probe });
}

function renderSummary({ page, url, outPath, shot, ready, projectRoot, provider, profileId, profile }) {
  const L = [''];
  L.push('[manual capture] 截图完成。');
  L.push('');
  L.push(`  页面        ${page.id}${page.title ? `  ${page.title}` : ''}`);
  L.push(`  地址        ${url}`);
  L.push(`  规格        ${profileId} (${profile.viewport.width}x${profile.viewport.height} @${profile.deviceScaleFactor}x)`);
  L.push(`  Provider    ${provider.id} (${provider.type}, ${provider.headless ? '无头' : '有头'})`);
  L.push(`  输出        ${displayPath(outPath, projectRoot)}  ${(shot.bytes / 1024).toFixed(0)} KB`);
  L.push('');

  const s = ready.steps;
  const imageNote = s.images && typeof s.images === 'object' ? `${s.images.status}(${s.images.waited})` : s.images;
  L.push(`  等待过程    load=${s.load}  network=${s.networkIdle}  fonts=${s.fonts}  images=${imageNote}  dom=${s.domQuiet}`);
  if (s.animationsFrozen !== undefined) L.push(`              已冻结动画 ${s.animationsFrozen} 个`);

  if (ready.warnings.length > 0) {
    L.push('');
    L.push('  ⚠ 等待过程中的提示:');
    for (const w of ready.warnings) L.push(`    - ${w}`);
  }

  L.push('');
  L.push('  页面模型已更新: browser.verified = true');
  L.push('');
  return L.join('\n');
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, {
    known: KNOWN_FLAGS,
    booleans: BOOLEAN_FLAGS,
  });
  const json = values.json === true;

  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) return fail([`未知参数: ${unknownFlags.join(', ')}`], { json });

  const pageId = positional[0];
  if (!pageId) {
    return fail(['需要指定页面 id，例如 `manual capture chat`。用 `manual inspect` 看有哪些页面。'], { json });
  }
  if (positional.length > 1) {
    return fail([`一次只能截一个页面，收到: ${positional.join(', ')}`], { json });
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const existing = store.readExistingPages(stateDirAbs);
  if (existing.errors.length > 0) {
    return fail(['已有的页面文件解析失败：', ...existing.errors.map((e) => `  ${e}`)], { json });
  }
  if (existing.pages.length === 0) {
    return fail(['.manual/pages/ 里还没有页面。先运行 `manual inspect` 扫描项目。'], { json });
  }

  const page = normalizePage(existing.pages.find((p) => p.id === pageId));
  if (!page) {
    const ids = existing.pages.map((p) => p.id).join(', ');
    return fail([`找不到页面 "${pageId}"。已有: ${ids}`], { json });
  }
  const indexes = readIndexes(stateDirAbs);
  const indexedPage = indexes.ok
    ? findForwardPage(indexes.forward, { id: page.id, route: page.route })
    : null;
  const effectiveRoute = typeof indexedPage?.route === 'string' ? indexedPage.route : page.route;

  // ---- 解析截图规格与 provider
  const profileId = values.profile || config.capture.activeProfile;
  const profile = config.capture.profiles[profileId];
  if (!profile) {
    return fail([`截图规格 "${profileId}" 不在 config 的 capture.profiles 里。`], { json });
  }

  const providerId = values.provider || config.browser.activeProvider;
  const providerConfig = config.browser.providers[providerId];
  if (!providerConfig) {
    return fail([`Browser Provider "${providerId}" 不在 config 的 browser.providers 里。`], { json });
  }

  // ---- 拼出要打开的地址
  let url;
  if (values.url) {
    url = values.url;
  } else {
    const params = parseParams(values.params);
    const resolved = resolveRoute(effectiveRoute, params);
    if (!resolved.ok) {
      return fail(
        [
          `"${pageId}" 是动态路由 ${effectiveRoute}，需要具体参数值才能打开。`,
          `缺少: ${resolved.missing.join(', ')}`,
          `补上即可，例如: manual capture ${pageId} --params "${resolved.missing.map((m) => `${m}=<值>`).join(';')}"`,
        ],
        { json }
      );
    }
    url = joinUrl(config.project.baseUrl, resolved.route);
  }

  // ---- 输出路径
  const outPath = values.out
    ? path.resolve(projectRoot, values.out)
    : path.join(projectRoot, config.artifacts.rawDir, `${pageId}.${config.artifacts.format || 'png'}`);

  // ---- 真正干活
  const readyOptions = {
    timeout: values.timeout ? Number(values.timeout) : DEFAULT_READY_OPTIONS.timeout,
    quietMs: values.quietMs ? Number(values.quietMs) : DEFAULT_READY_OPTIONS.quietMs,
    settleMs: values.settleMs ? Number(values.settleMs) : DEFAULT_READY_OPTIONS.settleMs,
    freezeAnimations: values.noFreezeAnimations !== true,
    waitFor: values.waitFor || null,
  };

  let auth;
  try {
    auth = prepareAuth(config);
  } catch (e) {
    return fail(e, { json });
  }

  let provider;
  try {
    provider = createProvider({ id: providerId, providerConfig, profile, storageState: auth.storageState });
  } catch (e) {
    return fail(e, { json });
  }

  let shot;
  let ready;
  let safe = null;
  let published = null;
  let navigation;
  let identity = 'url-only';
  const identityAssertions = (page.states?.default?.assertions || []).filter((a) => a && a.type !== 'url');
  try {
    const openResult = await provider.open(url, { timeout: readyOptions.timeout });
    ready = await provider.waitUntilReady(readyOptions);
    // 等待结束后重新读取 URL 与页面事实：SPA 延迟跳转以截图时的地址为准。
    const observation = provider.currentObservation
      ? await provider.currentObservation()
      : await provider.probe();

    // 先判断这次打开到底算不算成功，再决定要不要落盘。顺序不能反。
    navigation = validateNavigation({ requestedUrl: url, openResult, observation });
    ready.warnings.push(...navigation.warnings);
    // 页面身份：只有非 URL 断言能证明"打开的是这一页"；只有 URL 的旧模型记为 url-only。
    if (!values.url && identityAssertions.length > 0) {
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

    // 稳定截图 + 离线派生：原图只留在 rawDir，发布图由同一份原图遮罩后写入 annotatedDir。
    const captured = await captureStable(provider, {
      rawPath: outPath,
      fullPage: values.fullPage === true,
      format: config.artifacts.format || 'png',
    });
    shot = captured.shot;
    const publishedRelative = path.posix.join(String(config.artifacts.annotatedDir).replace(/\\/g, '/'), `page--${pageId}.png`);
    safe = await derivePublished({
      captured,
      rawPath: outPath,
      sanitizedPath: path.join(projectRoot, config.artifacts.sanitizedDir, 'pages', `${pageId}.png`),
      publishedPath: path.join(projectRoot, publishedRelative),
      theme: config.annotation.themes[config.annotation.activeTheme],
      redactionRules: config.privacy || {},
    });
    published = safe.published ? {
      artifactPath: publishedRelative,
      sha256: safe.derived.publishedSha256,
      privacy: safe.privacy,
      derivedFromRawHash: safe.derived.rawHash,
      geometryHash: safe.derived.geometryHash,
      rendererVersion: safe.derived.rendererVersion,
    } : null;
    if (!safe.published) ready.warnings.push(`页面隐私检测未通过（${safe.privacy.unresolved.length} 项无法定位），未生成发布图；手册只能出文字版。`);
    const refreshed = await refreshAuth(provider, auth);
    if (refreshed.warning) ready.warnings.push(refreshed.warning);
  } catch (e) {
    await provider.close();
    const normalized = e instanceof CaptureError
      ? e
      : new CaptureError(e.code && REASON_CODES.has(e.code) ? e.code : REASON.NAVIGATION_FAILED, String(e.message || e), { url });
    return fail(classifyAuthFailure(normalized, auth), { json });
  } finally {
    await provider.close();
  }

  // ---- 回写页面模型
  const capturedAt = new Date().toISOString();
  const screenshotRelative = path.relative(projectRoot, outPath).replace(/\\/g, '/');

  const updatedPage = {
    ...page,
    browser: {
      verified: true,
      lastCapture: capturedAt,
      screenshot: screenshotRelative,
      url: shot.meta.url,
      actualRoute: navigation.actualRoute,
      identity,
      viewport: `${shot.meta.viewport.width}x${shot.meta.viewport.height}`,
      deviceScaleFactor: shot.meta.deviceScaleFactor,
      provider: providerId,
      published,
    },
  };
  // 源码分析也做完了的话，这一页就从「推断」升级成「验证过」
  if (page.status?.sourceAnalysis === ANALYSIS.COMPLETED) {
    updatedPage.confidence = CONFIDENCE.VERIFIED;
  }

  const allPages = existing.pages
    .map((p) => (p.id === pageId ? updatedPage : p))
    .sort((a, b) => String(a.route).localeCompare(String(b.route)));

  let meta = { name: config.project.name, framework: null, frameworkVersion: null, router: null, appDir: null, pagesDir: null };
  const projectFilePath = store.projectFileFor(stateDirAbs);
  if (fs.existsSync(projectFilePath)) {
    try {
      const yaml = require('js-yaml');
      const prev = yaml.load(fs.readFileSync(projectFilePath, 'utf8'));
      if (prev?.project) meta = { ...meta, ...prev.project };
    } catch (_) { /* 索引坏了不影响写页面 */ }
  }
  meta.generatedAt = capturedAt;

  store.writeModel(stateDirAbs, meta, allPages, {
    docsOutputDir: config.docs.outputDir,
  });

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          pageId,
          route: effectiveRoute,
          url: shot.meta.url,
          screenshot: screenshotRelative,
          screenshotAbsolute: outPath,
          bytes: shot.bytes,
          capturedAt,
          profile: profileId,
          viewport: shot.meta.viewport,
          deviceScaleFactor: shot.meta.deviceScaleFactor,
          provider: { id: providerId, type: shot.meta.providerType, headless: shot.meta.headless },
          fullPage: shot.meta.fullPage,
          readySteps: ready.steps,
          identity,
          actualRoute: navigation.actualRoute,
          published,
          // 只含类型与区域，不含敏感原文
          redactions: safe ? safe.redactions.map(({ kind, rect, result }) => ({ kind, rect, result })) : [],
          validations: navigation.validations,
          warnings: ready.warnings,
          confidence: updatedPage.confidence,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(
      renderSummary({
        page, url, outPath, shot, ready, projectRoot, profileId, profile,
        provider: { id: providerId, type: shot.meta.providerType, headless: shot.meta.headless },
      }) + '\n'
    );
  }

  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, resolveRoute, parseParams, joinUrl, assessOutcome };
