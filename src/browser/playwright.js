'use strict';

/*
 * PlaywrightBrowserProvider —— 用 Playwright + Chromium 驱动真实浏览器。
 *
 * 这一层只做「把页面稳定地渲染出来并截下来」。它不认识 page id、不认识手册，
 * 也不判断「需要登录」这类业务语义——那些交给 capture 命令，provider 只提供证据。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { BrowserProvider, DEFAULT_READY_OPTIONS } = require('./provider');
const { CaptureError, REASON, classifyNavigationError } = require('./errors');
const { clipRect } = require('../privacy/geometry');

/** 过渡期的旧搜索路径（~/gstack、npx 缓存）；仅在 MANUAL_PLAYWRIGHT_LEGACY_SEARCH=1 时启用。 */
function legacyPlaywrightCandidates(home = os.homedir()) {
  const candidates = [
    path.join(home, 'gstack', 'node_modules', 'playwright'),
    path.join(home, '.claude', 'skills', 'gstack', 'node_modules', 'playwright'),
  ];
  const npxRoot = path.join(home, 'npm-cache', '_npx');
  try {
    for (const dir of fs.readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, dir, 'node_modules', 'playwright'));
    }
  } catch (_) { /* npx 缓存可能不存在 */ }
  return candidates;
}

/**
 * 按固定顺序解析 Playwright，保证安装与 CI 可复现：
 * 1. MANUAL_PLAYWRIGHT_PATH 显式覆盖；2. 工具自身 package.json 固定的依赖；
 * 3. 仅在显式开启 legacy 开关时搜索个人目录。
 * @returns {{ playwright: object, source: string, path: string }}
 */
function resolvePlaywright({ env = process.env, requireImpl = require, home = os.homedir() } = {}) {
  const attempts = [];
  const tryLoad = (source, request) => {
    try {
      const resolved = requireImpl.resolve(request);
      return { playwright: requireImpl(resolved), source, path: resolved };
    } catch (error) {
      attempts.push({ source, request, error: error.code || error.message });
      return null;
    }
  };

  if (env.MANUAL_PLAYWRIGHT_PATH) {
    const hit = tryLoad('env', path.resolve(env.MANUAL_PLAYWRIGHT_PATH));
    if (hit) return hit;
    // 显式覆盖失败时不静默回退到别的副本，避免用错版本。
    throw new CaptureError(REASON.PROVIDER_UNAVAILABLE, `MANUAL_PLAYWRIGHT_PATH 指向的 playwright 无法加载: ${env.MANUAL_PLAYWRIGHT_PATH}`, { attempts });
  }

  const own = tryLoad('dependency', 'playwright');
  if (own) return own;

  if (env.MANUAL_PLAYWRIGHT_LEGACY_SEARCH === '1') {
    for (const candidate of legacyPlaywrightCandidates(home)) {
      if (!fs.existsSync(candidate)) continue;
      const hit = tryLoad('legacy', candidate);
      if (hit) return hit;
    }
  }

  throw new CaptureError(
    REASON.PROVIDER_UNAVAILABLE,
    '找不到 playwright 包。请在工具目录运行 `npm ci`，或用 MANUAL_PLAYWRIGHT_PATH 指定。',
    { attempts }
  );
}

function loadPlaywright() {
  return resolvePlaywright().playwright;
}

/**
 * 冻结动画用的样式。
 * 把时长和延迟清零，让 CSS 动画/过渡直接落到终态；关掉平滑滚动与光标闪烁，
 * 这两个是「同一页面两次截图像素不一致」的常见来源。
 */
const FREEZE_CSS = `
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}
`;
const LOGIN_PATH_RE = /\/(login|signin|sign-in|sign_in|auth|sso|account\/login)(\/|$|\?)/i;

// ---------------------------------------------------------------- 浏览器侧脚本
// 这些函数被序列化到页面里执行，必须自包含、且都带自己的超时上限——
// 页面可能永远不空闲（轮询、长连接、无限动画），不能让等待卡死。

/** 等 Web Font 就绪。 */
function waitForFonts(capMs) {
  if (!document.fonts) return Promise.resolve('no-font-api');
  return Promise.race([
    document.fonts.ready.then(() => 'ready'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), capMs)),
  ]);
}

/** 等所有 <img> 加载结束（成功或失败都算结束）。 */
function waitForImages(capMs) {
  const pending = Array.from(document.images).filter((img) => !img.complete);
  if (pending.length === 0) return Promise.resolve({ waited: 0, status: 'none-pending' });

  const settled = Promise.all(
    pending.map(
      (img) =>
        new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
        })
    )
  ).then(() => 'loaded');

  return Promise.race([
    settled.then((status) => ({ waited: pending.length, status })),
    new Promise((resolve) => setTimeout(() => resolve({ waited: pending.length, status: 'timeout' }), capMs)),
  ]);
}

/** 等 DOM 连续 quietMs 毫秒没有变动，最多等 maxMs。这是「异步内容稳定」的判据。 */
function waitForDomQuiet({ quietMs, maxMs }) {
  return new Promise((resolve) => {
    const target = document.body || document.documentElement;
    if (!target) { resolve('no-body'); return; }

    let quietTimer = null;
    let hardTimer = null;
    let observer = null;

    const finish = (status) => {
      if (observer) { try { observer.disconnect(); } catch (_) { /* 已断开 */ } }
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      resolve(status);
    };

    observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), quietMs);
    });
    observer.observe(target, { childList: true, subtree: true, attributes: true, characterData: true });

    quietTimer = setTimeout(() => finish('quiet'), quietMs);
    hardTimer = setTimeout(() => finish('max-wait'), maxMs);
  });
}

/** 把 Web Animations 推到终态；无限循环的动画只能暂停。 */
function freezeRunningAnimations() {
  if (!document.getAnimations) return 0;
  let handled = 0;
  for (const animation of document.getAnimations()) {
    try {
      const timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
      if (timing && timing.iterations === Infinity) animation.pause();
      else animation.finish();
      handled++;
    } catch (_) {
      try { animation.pause(); handled++; } catch (__) { /* 放弃这一个 */ }
    }
  }
  return handled;
}

/** 读一些页面事实，交给上层判断「是不是需要登录」「是不是白屏」。 */
function probePage() {
  const body = document.body;
  const heading = document.querySelector('h1');
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const identityText = `${document.title || ''} ${heading ? heading.innerText : ''}`;
  return {
    title: document.title || '',
    heading: heading ? heading.innerText.trim().slice(0, 120) : null,
    hasPasswordField: !!document.querySelector('input[type="password"]'),
    bodyTextLength: body && body.innerText ? body.innerText.trim().length : 0,
    elementCount: body ? body.querySelectorAll('*').length : 0,
    // 软 404：状态码 200，但标题/主标题说明这是「不存在」页
    notFoundHint: /(^|\D)404(\D|$)|not found|页面不存在|找不到(该)?页面/i.test(identityText),
    // 仍在加载：只认语义标记，不猜 spinner 类名
    busy: [...document.querySelectorAll('[aria-busy="true"],[role="progressbar"]')].some(visible),
    errorAlert: [...document.querySelectorAll('[role="alert"]')].some((el) => visible(el) && /错误|出错|失败|异常|error|failed/i.test(el.innerText || '')),
  };
}

// ---------------------------------------------------------------- Provider

/** 浏览器启动参数。BrowserSession 用它判断两个 Scenario 能否共用同一个 Browser 进程。 */
function launchOptionsFor(providerConfig = {}) {
  const launchOptions = { headless: providerConfig.headless !== false };
  // config 里的 'chromium' 指内置内核，不是 Playwright 的 channel；
  // 只有 chrome / msedge 这类系统浏览器才需要传 channel。
  const channel = providerConfig.channel;
  if (channel && channel !== 'chromium') launchOptions.channel = channel;
  if (Array.isArray(providerConfig.launchArgs)) launchOptions.args = providerConfig.launchArgs;
  if (providerConfig.slowMo) launchOptions.slowMo = Number(providerConfig.slowMo);
  return launchOptions;
}

/** 启动一个 Browser 进程。browserType 可注入（测试计数 / 其他内核）；默认用解析到的 Playwright chromium。 */
async function launchBrowser(providerConfig = {}, { browserType = null } = {}) {
  const launchOptions = launchOptionsFor(providerConfig);
  try {
    return await (browserType || loadPlaywright().chromium).launch(launchOptions);
  } catch (e) {
    if (e instanceof CaptureError) throw e;
    throw new CaptureError(
      REASON.BROWSER_LAUNCH_FAILED,
      `Chromium 启动失败: ${String(e.message).split('\n')[0]}`,
      { headless: launchOptions.headless, channel: launchOptions.channel || 'chromium' }
    );
  }
}

class PlaywrightBrowserProvider extends BrowserProvider {
  /**
   * @param {object} options  除 BrowserProvider 的字段外：
   * @param {object} [options.browser]      借用的 Browser（BrowserSession 提供）；close() 不会关闭它
   * @param {object} [options.browserType]  注入的 browserType（带 launch()），仅在自己启动 Browser 时使用
   */
  constructor(options) {
    super(options);
    this.browser = options.browser || null;
    this.ownsBrowser = !options.browser;
    this.browserType = options.browserType || null;
    this.context = null;
    this.page = null;
    this.pages = new Map();
    this.popupCount = 0;
    this.pageErrors = [];
    this.closed = false;
  }

  get type() {
    return 'playwright';
  }

  static get capabilities() {
    return { capture: true, semanticActions: true, assertions: true, storageExport: true, privacyGeometry: true, popups: true, routeMocking: true };
  }

  get headless() {
    return this.providerConfig.headless !== false;
  }

  /** 兼容入口：Browser（自有或借用）+ 本 provider 独占的 Context。 */
  async launch() {
    if (this.context) return;
    if (this.closed) throw new CaptureError(REASON.NAVIGATION_FAILED, 'provider 已关闭，不能再次使用；请为新的 Scenario 创建新的 provider。');
    if (!this.browser) this.browser = await launchBrowser(this.providerConfig, { browserType: this.browserType });
    await this.newContext();
  }

  /**
   * Fixture 静态响应（P3-05）：只作用于本 Scenario 的 Context，在打开页面之前安装。
   * routes: [{ matcher: RegExp(pathname), method?, status, contentType, body }]；只匹配同源请求。
   */
  async installRoutes(routes, { baseUrl }) {
    await this.launch();
    const origin = new URL(baseUrl).origin;
    this.mockedRequests = [];
    await this.context.route(() => true, async (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch (_) { return route.continue(); }
      const hit = url.origin === origin && routes.find((r) => r.matcher.test(url.pathname) && (!r.method || r.method === request.method()));
      if (!hit) return route.continue();
      this.mockedRequests.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: hit.status, contentType: hit.contentType, body: hit.body });
    });
  }

  /** 为本 Scenario 新建隔离的 Context：认证快照、视口、DPR、语言、时区、配色都在这里注入。 */
  async newContext() {
    const { viewport, deviceScaleFactor } = this.profile;
    const locale = this.profile.locale || this.providerConfig.locale;
    const timezoneId = this.profile.timezoneId || this.providerConfig.timezoneId;
    this.context = await this.browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: deviceScaleFactor,
      isMobile: this.profile.kind === 'mobile' ? true : undefined,
      hasTouch: this.profile.hasTouch,
      userAgent: this.profile.userAgent || undefined,
      colorScheme: this.profile.colorScheme || undefined,
      ...(locale ? { locale } : {}),
      ...(timezoneId ? { timezoneId } : {}),
      // 动画对截图是噪音：同一页面两次截图不该因为动画相位不同而不一样
      reducedMotion: 'reduce',
      ...(this.storageState ? { storageState: this.storageState } : {}),
    });
    // 服务器下发 Set-Cookie（例如 refresh token 轮换）时通知上层立即持久化，不等 Scenario 结束：
    // 失败、超时、进程中断都不能让认证缓存停在已作废的旧令牌上。
    this.context.on('response', (response) => {
      if (typeof this.onCredentialChange !== 'function') return;
      response.headerValue('set-cookie')
        .then((value) => { if (value && typeof this.onCredentialChange === 'function') this.onCredentialChange(); })
        .catch(() => { /* 页面已关闭 */ });
    });
    // 进行中的数据请求（fetch / xhr / 流式 EventSource）：流式回复在请求结束前都不算完成（B1-09）
    this.inflight = new Set();
    const track = (request) => ['fetch', 'xhr', 'eventsource'].includes(request.resourceType());
    this.context.on('request', (request) => { if (track(request)) this.inflight.add(request); });
    this.context.on('requestfinished', (request) => this.inflight.delete(request));
    this.context.on('requestfailed', (request) => this.inflight.delete(request));
    this.page = await this.context.newPage();
    this.registerPage('main', this.page);
    // 同一流程内打开的弹窗 / 新标签登记为 popup-N，由动作显式切换，不默认作用于旧 Page。
    // 先登记 main 再监听，避免把主页面本身当成弹窗。
    this.context.on('page', (page) => {
      if ([...this.pages.values()].includes(page)) return;
      this.popupCount += 1;
      this.registerPage(`popup-${this.popupCount}`, page);
    });
  }

  registerPage(alias, page) {
    this.pages.set(alias, page);
    // 白屏时这些是唯一线索，先收着
    page.on('pageerror', (err) => this.pageErrors.push(String(err.message).split('\n')[0]));
    page.on('console', (msg) => {
      if (msg.type() === 'error') this.pageErrors.push(msg.text().split('\n')[0]);
    });
  }

  pageAliases() {
    return [...this.pages.keys()];
  }

  /** 切换后续动作 / 断言 / 截图的目标页面。弹窗登记是异步的，给一个短暂的等待窗口。 */
  async usePage(alias, { timeout = 5000 } = {}) {
    const deadline = Date.now() + timeout;
    while (!this.pages.has(alias)) {
      if (Date.now() >= deadline) throw Object.assign(new Error(`没有名为 ${alias} 的页面（当前: ${this.pageAliases().join(', ')}）。`), { code: 'page-alias-missing' });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    this.page = this.pages.get(alias);
    // 新开的弹窗先是 about:blank，再导航到目标地址；等它离开空白页后再交给后续动作。
    const remaining = Math.max(deadline - Date.now(), 1000);
    if (this.page.url() === 'about:blank') await this.page.waitForURL((url) => url.href !== 'about:blank', { timeout: remaining }).catch(() => {});
    await this.page.waitForLoadState('domcontentloaded', { timeout: remaining }).catch(() => {});
    return this.page;
  }

  /**
   * 打开页面。
   * @returns {{ status: number|null, finalUrl: string, redirected: boolean }}
   */
  /** 刷新当前页面（入口长期卡在加载中时由调用方有记录地使用一次）。 */
  async reload({ timeout = DEFAULT_READY_OPTIONS.timeout } = {}) {
    if (!this.page) throw Object.assign(new Error('没有可刷新的页面。'), { code: 'navigation-failed' });
    try {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      throw classifyNavigationError(e, this.page.url());
    }
  }

  async open(url, { timeout = DEFAULT_READY_OPTIONS.timeout } = {}) {
    await this.launch();

    let response;
    try {
      // 先只等 domcontentloaded：networkidle 放到 waitUntilReady 里做，
      // 这样长连接/轮询的页面不会在导航这一步就直接超时失败。
      response = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
      throw classifyNavigationError(e, url);
    }

    const finalUrl = this.page.url();
    return {
      status: response ? response.status() : null,
      finalUrl,
      redirected: finalUrl.replace(/\/$/, '') !== url.replace(/\/$/, ''),
    };
  }

  /**
   * 等到页面可以截图：网络空闲 → 指定元素 → 字体 → 图片 → DOM 稳定 → 冻结动画 → 静置。
   * 每一步都有独立上限。网络空闲/字体/图片/DOM 静止这类"尽力而为"的信号超时只记 warning——
   * 永不空闲的轮询不该让整页失败；但调用方指定的 waitFor 是必需条件，超时即失败。
   * @returns {{ steps: object, warnings: string[] }}
   */
  async waitUntilReady(options = {}) {
    const opts = { ...DEFAULT_READY_OPTIONS, ...options };
    const page = this.page;
    const warnings = [];
    const steps = {};

    if (!page) throw new CaptureError(REASON.NAVIGATION_FAILED, 'waitUntilReady 之前必须先 open()。');

    // 1. 完整 load 事件
    try {
      await page.waitForLoadState('load', { timeout: opts.timeout });
      steps.load = 'ok';
    } catch (_) {
      steps.load = 'timeout';
      warnings.push('load 事件未在超时内触发，继续等待其它信号。');
    }

    // 2. 网络空闲。轮询和 WebSocket 会让它永远达不到，所以超时是可接受的。
    // Long polling / SSE pages often never reach networkidle. Fonts, images and
    // DOM stability are checked below, so keep this optional signal bounded.
    const networkIdleTimeout = Math.min(opts.timeout, opts.networkIdleTimeout ?? 3000);
    try {
      await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout });
      steps.networkIdle = 'ok';
    } catch (_) {
      steps.networkIdle = 'timeout';
      warnings.push(`网络未在 ${networkIdleTimeout}ms 内空闲（页面可能有轮询或长连接），继续。`);
    }

    // 3. 调用方指定的元素——最可靠的「这页真的好了」信号。它是必需条件：
    //    等不到就说明页面没到预期状态，不能截一张"差不多"的图冒充成功。
    if (opts.waitFor) {
      try {
        await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: opts.timeout });
        steps.waitFor = 'ok';
      } catch (_) {
        throw new CaptureError(REASON.READINESS_TIMEOUT, `等待元素 ${opts.waitFor} 超时（${opts.timeout}ms）。`, {
          waitFor: opts.waitFor, finalUrl: page.url(),
        });
      }
    }

    // 4. Web Font。字体没就绪就截图会拍到回退字体，排版和最终效果对不上。
    try {
      steps.fonts = await page.evaluate(waitForFonts, Math.min(opts.timeout, 10000));
      if (steps.fonts === 'timeout') warnings.push('Web Font 未在 10s 内就绪，可能拍到回退字体。');
    } catch (_) {
      steps.fonts = 'error';
    }

    // 5. 图片
    try {
      const result = await page.evaluate(waitForImages, Math.min(opts.timeout, 15000));
      steps.images = result;
      if (result.status === 'timeout') warnings.push(`有 ${result.waited} 张图片未加载完，可能拍到占位图。`);
    } catch (_) {
      steps.images = 'error';
    }

    // 6. DOM 稳定
    try {
      steps.domQuiet = await page.evaluate(waitForDomQuiet, {
        quietMs: opts.quietMs,
        maxMs: Math.min(opts.timeout, 10000),
      });
      if (steps.domQuiet === 'max-wait') warnings.push('DOM 一直在变动，等到上限后仍未稳定。');
    } catch (_) {
      steps.domQuiet = 'error';
    }

    // 7. 冻结动画。顺序要紧：先停掉正在跑的，再用样式挡住后续的。
    // 反过来的话，FREEZE_CSS 会先把动画结束掉，getAnimations() 返回空集，
    // 计数永远是 0——看起来像没生效，实际上无从判断。
    if (opts.freezeAnimations) {
      try {
        steps.animationsFrozen = await page.evaluate(freezeRunningAnimations);
        await page.addStyleTag({ content: FREEZE_CSS });
        // 注入样式本身可能触发新的过渡，补一刀
        await page.evaluate(freezeRunningAnimations);
      } catch (_) {
        steps.animationsFrozen = 'error';
      }
    }

    // 8. 静置：等上面那些改动引起的回流落定
    await page.waitForTimeout(opts.settleMs);

    return { steps, warnings };
  }

  /**
   * 等待之后重新读取的页面事实：当前 URL（SPA 跳转后的真实地址）、标题、
   * 是否有密码框、是否仍在加载 / 显示错误等，供上层做页面身份与状态判断。
   */
  async currentObservation() {
    if (!this.page) return null;
    const url = this.page.url();
    try {
      const result = await this.page.evaluate(probePage);
      return { url, ...result, pageErrors: this.pageErrors.slice(0, 5) };
    } catch (_) {
      // 页面正在跳转时执行上下文会被销毁；URL 仍是可靠事实。
      return { url: this.page.url(), pageErrors: this.pageErrors.slice(0, 5) };
    }
  }

  /**
   * 页面可访问结构摘要（P3-04 语义漂移）：白名单角色 + 可访问名称，不含正文与控件值。
   * 失败（页面跳转中等）返回 null，调用方按"无法比较"处理。
   */
  async semanticSnapshot() {
    if (!this.page) return null;
    try {
      const { parseAriaSnapshot, semanticSummary } = require('../verify/semantic-diff');
      return semanticSummary(parseAriaSnapshot(await this.page.locator('body').ariaSnapshot({ timeout: 5000 })));
    } catch (_) {
      return null;
    }
  }

  /** 采集环境（视觉比较的前提）：浏览器版本、平台、视口、DPR、语言、时区。 */
  environmentInfo({ fullPage = false } = {}) {
    const { environmentOf } = require('../verify/visual-diff');
    return environmentOf({
      browserVersion: this.browser?.version ? `chromium-${this.browser.version()}` : null,
      viewport: this.profile.viewport,
      dpr: this.profile.deviceScaleFactor,
      locale: this.profile.locale || this.providerConfig.locale || null,
      timezone: this.profile.timezoneId || this.providerConfig.timezoneId || null,
      fullPage,
    });
  }

  /**
   * 选择器 / 语义目标在视口中的矩形（CSS 像素）；找不到返回 null。
   * content=true 时取元素内容（文字）的实际范围：块级标题的盒子常常占满整行，不能代表关键内容所在区域。
   */
  async rectOf(target, { content = false } = {}) {
    if (!this.page) return null;
    try {
      const locator = typeof target === 'string' ? this.page.locator(target).first() : this.locatorFor(target).first();
      if (!content) return await locator.boundingBox({ timeout: 2000 });
      return await locator.evaluate((el) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        const box = r.width && r.height ? r : el.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }, null, { timeout: 2000 });
    } catch (_) {
      return null;
    }
  }

  /** 兼容旧调用：等同 currentObservation()。 */
  async probe() {
    return this.currentObservation();
  }

  locatorFor(target) {
    if (!this.page) throw new Error('定位元素之前必须先 open()。');
    if (!target || typeof target !== 'object') throw new Error('缺少语义目标。');
    const root = target.within ? this.locatorFor(target.within) : this.page;
    if (target.role && target.name) return root.getByRole(target.role, { name: target.name, exact: target.exact !== false, includeHidden: target.includeHidden === true });
    if (target.label) return root.getByLabel(target.label, { exact: target.exact !== false });
    if (target.text) return root.getByText(target.text, { exact: target.exact !== false });
    if (target.testId) return root.getByTestId(target.testId);
    if (target.selector) return root.locator(target.selector);
    throw new Error('目标需要 role+name、label、text、testId 或 selector。');
  }

  async uniqueVisibleLocator(target) {
    const strategies = [target, ...(target.alternatives || [])];
    for (const [index, strategy] of strategies.entries()) {
      const locator = this.locatorFor({ ...strategy, within: strategy.within || target.within });
      const visible = [];
      for (let i = 0, count = await locator.count(); i < count; i++) {
        const item = locator.nth(i);
        if (await item.isVisible().catch(() => false)) visible.push(item);
      }
      if (visible.length > 1) throw Object.assign(new Error(`目标元素匹配到 ${visible.length} 个可见结果，请限定所在区域。`), { code: 'target-ambiguous' });
      if (visible.length === 1) { this.lastResolution = { strategyIndex: index, fallback: index > 0 }; return visible[0]; }
    }
    throw Object.assign(new Error('目标元素不存在或不可见；检查前置数据、空结果和页面状态。'), { code: 'target-not-visible' });
  }

  /** 元素实际画出来了吗：自身 visibility 不可见，或自身与祖先 opacity 连乘近 0（hover 才显示的图标常见写法）都算透明。 */
  async isTransparent(locator) {
    return locator.evaluate((el) => {
      if (getComputedStyle(el).visibility !== 'visible') return true;
      let opacity = 1;
      for (let node = el; node && node.nodeType === 1; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      return opacity < 0.05;
    });
  }

  /** visibility:hidden 的目标 isVisible 为 false，但仍占位；唯一占位的那个可以 hover 唤出。 */
  async uniqueLaidOutLocator(target) {
    const laidOut = [];
    for (const strategy of [target, ...(target.alternatives || [])]) {
      // visibility:hidden 的元素不在可访问性树里，按角色查找要显式包含隐藏元素（仅内部使用，不进模型 schema）。
      const locator = this.locatorFor({ ...strategy, within: strategy.within || target.within, includeHidden: true });
      for (let i = 0, count = await locator.count(); i < count; i++) {
        const box = await locator.nth(i).boundingBox().catch(() => null);
        if (box && box.width && box.height) laidOut.push(locator.nth(i));
      }
      if (laidOut.length) break;
    }
    return laidOut.length === 1 ? laidOut[0] : null;
  }

  /**
   * 定位标注 / 检查目标并确认它真的画在像素里。hover 才显示的目标（祖先 :hover、mouseenter）
   * 在 reveal=true 时把指针移到它上面再确认；仍透明就报错，绝不返回一个框住空白的矩形。
   * 返回的 revealedBy='hover' 表示目标依赖指针位置：同一张图里只能有一处这样的状态。
   */
  async inspectTarget(target, { reveal = true } = {}) {
    const transparent = () => Object.assign(new Error(reveal
      ? '目标在页面上是透明的（opacity 为 0 或 visibility 隐藏），把指针移上去后仍未显示；检查它需要的前置交互。'
      : '目标在页面上是透明的（opacity 为 0 或 visibility 隐藏），截图里看不到它。'), { code: 'target-transparent' });
    const hover = async (locator) => {
      await locator.hover({ force: true, timeout: 2000 });
      // mouseenter 驱动的显示要等一次框架渲染；CSS :hover 已被 FREEZE_CSS 去掉过渡，立即生效。
      for (let i = 0; i < 10 && await this.isTransparent(locator); i++) await this.page.waitForTimeout(100);
    };
    let locator;
    let revealedBy = null;
    try {
      locator = await this.uniqueVisibleLocator(target);
    } catch (error) {
      if (!reveal || error.code !== 'target-not-visible') throw error;
      const hidden = await this.uniqueLaidOutLocator(target);
      if (!hidden) throw error;
      await hover(hidden);
      revealedBy = 'hover';
      try { locator = await this.uniqueVisibleLocator(target); } catch (_) { throw transparent(); }
    }
    if (await this.isTransparent(locator)) {
      if (!reveal || revealedBy) throw transparent();
      await hover(locator);
      revealedBy = 'hover';
      if (await this.isTransparent(locator)) throw transparent();
    }
    // 被浮层盖住的目标照常返回几何，由调用方判定为 target-occluded（B2-08）
    return { target, rect: await locator.boundingBox(), resolution: this.lastResolution, revealedBy, obscuredBy: await this.coverOf(locator) };
  }

  /**
   * 目标被暂态浮层（保存成功提示条等）盖住时，只做无副作用的恢复：把指针移到页面左上角
   * （悬停会让提示条保持显示），再在有限时间内等浮层消失。仍被遮挡就报 target-obscured，
   * 不点击浮层、不反复点击目标，也不会让 Runtime 重放之前的保存（B1-11）。
   */
  /** 盖在目标中心点上的其他元素（描述文字）；没有遮挡或中心点不在视口内返回 null。不滚动页面。 */
  coverOf(locator) {
    return locator.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!top || el === top || el.contains(top) || top.contains(el)) return null;
      const label = top.getAttribute('role') || top.tagName.toLowerCase();
      return `${label}「${(top.innerText || top.getAttribute('aria-label') || '').trim().slice(0, 40)}」`;
    }).catch(() => null);
  }

  async ensureUnobscured(locator, { timeoutMs = 5000 } = {}) {
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    const probe = () => this.coverOf(locator);
    let cover = await probe();
    if (!cover) return;
    await this.page.mouse.move(0, 0).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (cover && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      cover = await probe();
    }
    if (cover) throw Object.assign(new Error(`目标被 ${cover} 遮挡，等待 ${timeoutMs}ms 后仍未消失；未执行动作。`), { code: 'target-obscured' });
  }

  async performAction(action) {
    if (action.page) await this.usePage(action.page);
    if (action.type === 'inspect' && !action.target) return { target: null, rect: null };
    if (action.type === 'inspect') return this.inspectTarget(action.target, { reveal: action.reveal !== false });
    const locator = await this.uniqueVisibleLocator(action.target);
    await this.ensureUnobscured(locator);
    const rect = await locator.boundingBox();
    if (action.type === 'click') await locator.click();
    else if (action.type === 'hover') await locator.hover();
    else if (action.type === 'fill') await locator.fill(String(action.value ?? ''));
    else if (action.type === 'select') await locator.selectOption(action.value);
    else if (action.type === 'check') await locator.check();
    else if (action.type === 'uncheck') await locator.uncheck();
    else if (action.type !== 'inspect') throw new Error(`不支持的交互类型: ${action.type}`);
    return { target: action.target, rect, resolution: this.lastResolution };
  }

  async assertCondition(assertion) {
    if (assertion.type === 'url') {
      const actual = new URL(this.page.url());
      if (actual.pathname !== assertion.value && this.page.url() !== assertion.value) {
        throw Object.assign(new Error(`URL 断言失败，期望 ${assertion.value}，实际 ${actual.pathname}`), { code: 'state-assertion-failed' });
      }
      return { ok: true, actual: actual.pathname };
    }
    if (assertion.type === 'hidden') {
      const count = await this.locatorFor(assertion.target).count();
      for (let index = 0; index < count; index++) {
        if (await this.locatorFor(assertion.target).nth(index).isVisible().catch(() => false)) {
          throw Object.assign(new Error('目标仍然可见。'), { code: 'state-assertion-failed' });
        }
      }
      return { ok: true };
    }
    const locator = await this.uniqueVisibleLocator(assertion.target);
    if (assertion.type === 'editable' && !(await locator.isEditable())) {
      throw Object.assign(new Error('目标字段不可编辑。'), { code: 'state-assertion-failed' });
    }
    if (!['visible', 'editable'].includes(assertion.type)) throw new Error(`不支持的状态断言: ${assertion.type}`);
    return { ok: true };
  }

  async collectSensitiveElements({ fullPage = false } = {}) {
    if (!this.page) return [];
    const candidates = await this.page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const add = (element, text, label, source, inputType, rectOverride) => {
        const rect = rectOverride || element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const key = `${source}:${Math.round(rect.x)}:${Math.round(rect.y)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({
          text: String(text || ''), label: String(label || ''), source,
          inputType: String(inputType || ''), pagePath: location.pathname,
          selectorHint: element.id ? `#${element.id}` : '',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        });
      };
      for (const input of document.querySelectorAll('input,textarea,[data-redact]')) {
        const id = input.id;
        const label = input.getAttribute('aria-label') || (id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText : '') || input.getAttribute('name') || '';
        if (input.hasAttribute('data-redact')) {
          add(input, input.value || input.textContent, label, 'explicit', input.type);
          continue;
        }
        const outer = input.getBoundingClientRect();
        const style = getComputedStyle(input);
        const borderLeft = parseFloat(style.borderLeftWidth) || 0;
        const borderTop = parseFloat(style.borderTopWidth) || 0;
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingRight = parseFloat(style.paddingRight) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const paddingBottom = parseFloat(style.paddingBottom) || 0;
        const available = Math.max(0, outer.width - borderLeft - (parseFloat(style.borderRightWidth) || 0) - paddingLeft - paddingRight);
        let measured = available;
        if (input.tagName !== 'TEXTAREA') {
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d');
          if (context) {
            context.font = style.font;
            measured = Math.min(available, context.measureText(String(input.value || '')).width + 2);
          }
        }
        const lineHeight = Number.parseFloat(style.lineHeight);
        const contentHeight = input.tagName === 'TEXTAREA'
          ? Math.max(0, outer.height - borderTop - (parseFloat(style.borderBottomWidth) || 0) - paddingTop - paddingBottom)
          : Math.min(Number.isFinite(lineHeight) ? lineHeight : outer.height * 0.6, outer.height - paddingTop - paddingBottom);
        const contentRect = {
          x: outer.x + borderLeft + paddingLeft,
          y: outer.y + Math.max(0, (outer.height - contentHeight) / 2),
          width: measured,
          height: contentHeight,
        };
        add(input, input.value || input.textContent, label, 'form-control', input.type, contentRect);
      }
      for (const element of document.querySelectorAll('body *')) {
        if (element.children.length > 0) continue;
        const text = (element.innerText || '').trim();
        if (/1[3-9]\d{9}|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) {
          const range = document.createRange();
          range.selectNodeContents(element);
          add(element, text, element.getAttribute('aria-label') || '', 'text-pattern', '', range.getBoundingClientRect());
        }
      }
      return out;
    });
    // 视口截图用 client 坐标并裁剪到视口；整页截图换算到文档坐标并裁剪到文档尺寸。
    // 完全落在图像外的元素不会出现在像素里，可以跳过。
    const geometry = await this.collectGeometry({ fullPage });
    const canvas = fullPage ? geometry.documentSize : geometry.viewport;
    const offset = fullPage ? geometry.scroll : { x: 0, y: 0 };
    return candidates
      .map((candidate) => ({ ...candidate, rect: clipRect({ ...candidate.rect, x: candidate.rect.x + offset.x, y: candidate.rect.y + offset.y }, canvas) }))
      .filter((candidate) => candidate.rect);
  }

  /**
   * 等 DOM 连续 quietMs 毫秒无变动（最多 maxMs）。任务截图前调用：动作后的收尾渲染
   * （如回复落地后的逐字补齐）会让前后几何不一致，不等就会把有限的重试次数耗在同一段变化里。
   */
  async waitForQuiet({ quietMs = 400, maxMs = 5000 } = {}) {
    if (!this.page) return 'no-page';
    // 先等数据请求清空（有上限）：流式回复的请求结束前，短暂停顿不能当作完成
    const deadline = Date.now() + maxMs;
    while (this.inflight?.size && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const network = this.inflight?.size ? 'busy' : 'idle';
    let dom;
    try {
      dom = await this.page.evaluate(waitForDomQuiet, { quietMs, maxMs: Math.max(deadline - Date.now(), quietMs) });
    } catch (_) {
      dom = 'error';
    }
    return { dom, network, pendingRequests: this.inflight?.size || 0 };
  }

  /**
   * 截图前后的几何快照。首次调用时安装 MutationObserver 计数器；
   * 截图前后 generation / 滚动 / 尺寸不一致，说明像素与矩形可能不属于同一时刻。
   */
  async collectGeometry({ fullPage = false } = {}) {
    if (!this.page) throw new Error('collectGeometry 之前必须先 open()。');
    const geometry = await this.page.evaluate(() => {
      if (!window.__manualMutation) {
        window.__manualMutation = { generation: 0 };
        // 截图工具为隐藏光标会临时改写表单控件的 style，这不是页面内容变化，不计入。
        const caretOnly = (r) => r.type === 'attributes' && r.attributeName === 'style' && /^(INPUT|TEXTAREA|SELECT)$/.test(r.target.nodeName);
        new MutationObserver((records) => { if (records.some((r) => !caretOnly(r))) window.__manualMutation.generation++; })
          .observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      }
      const doc = document.documentElement;
      return {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: window.scrollX, y: window.scrollY },
        dpr: window.devicePixelRatio,
        documentSize: { width: Math.max(doc.scrollWidth, window.innerWidth), height: Math.max(doc.scrollHeight, window.innerHeight) },
        mutationGeneration: window.__manualMutation.generation,
      };
    });
    return { ...geometry, fullPage };
  }

  /**
   * 截图落盘。
   * @returns {{ path, bytes, meta }}
   */
  async screenshot({ path: outPath, fullPage = false, format = 'png', quality }) {
    if (!this.page) throw new CaptureError(REASON.NAVIGATION_FAILED, 'screenshot 之前必须先 open()。');

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const type = format === 'jpg' ? 'jpeg' : format;
    const shotOptions = { path: outPath, fullPage, type };
    // quality 只对 jpeg 有效，传给 png 会报错
    if (type === 'jpeg') shotOptions.quality = quality == null ? 92 : Number(quality);

    await this.page.screenshot(shotOptions);

    const actualViewport = this.page.viewportSize() || this.profile.viewport;
    return {
      path: outPath,
      bytes: fs.statSync(outPath).size,
      meta: {
        url: this.page.url(),
        viewport: { width: actualViewport.width, height: actualViewport.height },
        deviceScaleFactor: this.profile.deviceScaleFactor,
        fullPage,
        format: type,
        provider: this.id,
        providerType: this.type,
        headless: this.headless,
      },
    };
  }

  /** 导出 cookie 与 localStorage；显式声明 indexedDB 能力时一并导出（Playwright ≥1.51）。 */
  async exportStorageState({ indexedDB = false } = {}) {
    if (!this.context) throw new Error('exportStorageState 之前必须先 launch()。');
    return this.context.storageState(indexedDB ? { indexedDB: true } : undefined);
  }

  /**
   * 轮询整个 Context 的所有标签页，直到任一页回到应用站点且不在登录路径上。
   * 按 host 比较而不是 origin：站点常把 http 301 到 https，按 origin 比较会永远等不到。
   * 轮询而不是 waitForURL：SPA 的 router.push 与新标签页 / 弹窗都能被看到；窗口被关掉时立即报错。
   */
  async waitForAuthentication({ loginUrl, verifyUrl = null, timeout = 300000, pollInterval = 500, onProgress = null }) {
    if (!this.page) throw new Error('waitForAuthentication 之前必须先 open()。');
    const appHost = new URL(verifyUrl || loginUrl).host.replace(/:(80|443)$/, '');
    const hostOf = (parsed) => parsed.host.replace(/:(80|443)$/, '');
    const authenticated = (url) => {
      let parsed;
      try { parsed = new URL(String(url)); } catch (_) { return false; }
      return /^https?:$/.test(parsed.protocol) && hostOf(parsed) === appHost && !LOGIN_PATH_RE.test(parsed.pathname);
    };
    const progress = (message) => { if (typeof onProgress === 'function') onProgress(message); };
    const displayUrl = (value) => {
      try {
        const parsed = new URL(String(value));
        return `${parsed.origin}${LOGIN_PATH_RE.test(parsed.pathname) ? '/login' : '/…'}`;
      } catch (_) { return '(未知页面)'; }
    };

    const deadline = Date.now() + timeout;
    let lastUrls = [];
    progress(`已打开登录页 ${displayUrl(this.page.url())}，请在弹出的浏览器窗口中完成登录（最长等待 ${Math.round(timeout / 1000)} 秒）。`);
    for (;;) {
      const browserGone = this.browser && typeof this.browser.isConnected === 'function' && !this.browser.isConnected();
      const pages = browserGone ? [] : this.context.pages().filter((page) => !page.isClosed());
      if (!pages.length) {
        throw Object.assign(new Error('登录窗口已被关闭，未保存登录状态。请重新运行 manual auth login，并在登录完成后等待命令提示保存成功再关闭窗口。'), { code: 'auth-window-closed' });
      }
      const urls = pages.map((page) => page.url());
      if (urls.join('\n') !== lastUrls.join('\n')) {
        progress(`当前页面：${urls.map(displayUrl).join('，')}`);
        lastUrls = urls;
      }
      const landed = pages.find((page) => authenticated(page.url()));
      if (landed) {
        this.page = landed;
        progress(`检测到已离开登录页：${displayUrl(landed.url())}，正在保存登录状态…`);
        break;
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`等待登录完成超时。最后停留在：${urls.map(displayUrl).join('，')}；登录成功的判据是回到 ${appHost} 且路径不是登录页。`), { code: 'auth-timeout' });
      }
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }
    if (verifyUrl) {
      await this.open(verifyUrl, { timeout: Math.min(timeout, 30000) });
      if (!authenticated(this.page.url())) {
        throw Object.assign(new Error('登录验证失败，验证页面仍然要求登录。'), { code: 'auth-verification-failed' });
      }
    }
    await this.waitUntilReady({ timeout: Math.min(timeout, 30000) });
    return { finalUrl: this.page.url() };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // 逐层关闭，任一层失败都不该掩盖真正的截图错误；借用的 Browser 归 BrowserSession 管理。
    const targets = this.ownsBrowser ? [this.context, this.browser] : [this.context];
    for (const target of targets) {
      if (!target) continue;
      try { await target.close(); } catch (_) { /* 已经关了 */ }
    }
    this.context = null;
    this.browser = null;
    this.page = null;
    this.pages.clear();
  }
}

module.exports = { PlaywrightBrowserProvider, launchBrowser, launchOptionsFor, loadPlaywright, resolvePlaywright, legacyPlaywrightCandidates, FREEZE_CSS };
