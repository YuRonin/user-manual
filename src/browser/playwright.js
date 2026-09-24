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
const { neutralMosaicStyle } = require('../privacy/renderer');

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
  return {
    title: document.title || '',
    hasPasswordField: !!document.querySelector('input[type="password"]'),
    bodyTextLength: body && body.innerText ? body.innerText.trim().length : 0,
    elementCount: body ? body.querySelectorAll('*').length : 0,
  };
}

// ---------------------------------------------------------------- Provider

class PlaywrightBrowserProvider extends BrowserProvider {
  constructor(options) {
    super(options);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.pageErrors = [];
    this.closed = false;
  }

  get type() {
    return 'playwright';
  }

  get headless() {
    return this.providerConfig.headless !== false;
  }

  async launch() {
    if (this.browser) return;

    const playwright = loadPlaywright();
    const { viewport, deviceScaleFactor } = this.profile;

    const launchOptions = { headless: this.headless };
    // config 里的 'chromium' 指内置内核，不是 Playwright 的 channel；
    // 只有 chrome / msedge 这类系统浏览器才需要传 channel。
    const channel = this.providerConfig.channel;
    if (channel && channel !== 'chromium') launchOptions.channel = channel;
    if (Array.isArray(this.providerConfig.launchArgs)) launchOptions.args = this.providerConfig.launchArgs;
    if (this.providerConfig.slowMo) launchOptions.slowMo = Number(this.providerConfig.slowMo);

    try {
      this.browser = await playwright.chromium.launch(launchOptions);
    } catch (e) {
      throw new CaptureError(
        REASON.BROWSER_LAUNCH_FAILED,
        `Chromium 启动失败: ${String(e.message).split('\n')[0]}`,
        { headless: this.headless, channel: channel || 'chromium' }
      );
    }

    this.context = await this.browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: deviceScaleFactor,
      isMobile: this.profile.kind === 'mobile' ? true : undefined,
      hasTouch: this.profile.hasTouch,
      userAgent: this.profile.userAgent || undefined,
      colorScheme: this.profile.colorScheme || undefined,
      // 动画对截图是噪音：同一页面两次截图不该因为动画相位不同而不一样
      reducedMotion: 'reduce',
      ...(this.storageState ? { storageState: this.storageState } : {}),
    });

    this.page = await this.context.newPage();
    // 白屏时这些是唯一线索，先收着
    this.page.on('pageerror', (err) => this.pageErrors.push(String(err.message).split('\n')[0]));
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') this.pageErrors.push(msg.text().split('\n')[0]);
    });
  }

  /**
   * 打开页面。
   * @returns {{ status: number|null, finalUrl: string, redirected: boolean }}
   */
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
   * 每一步都有独立上限，任一步超时只记 warning 不中断——宁可截一张略早的图，
   * 也好过因为某个永不空闲的轮询而整页失败。
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
    const networkIdleTimeout = Math.min(opts.timeout, 15000);
    try {
      await page.waitForLoadState('networkidle', { timeout: networkIdleTimeout });
      steps.networkIdle = 'ok';
    } catch (_) {
      steps.networkIdle = 'timeout';
      warnings.push(`网络未在 ${networkIdleTimeout}ms 内空闲（页面可能有轮询或长连接），继续。`);
    }

    // 3. 调用方指定的元素——最可靠的「这页真的好了」信号
    if (opts.waitFor) {
      try {
        await page.waitForSelector(opts.waitFor, { state: 'visible', timeout: opts.timeout });
        steps.waitFor = 'ok';
      } catch (_) {
        steps.waitFor = 'timeout';
        warnings.push(`等待选择器超时: ${opts.waitFor}`);
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

  /** 读页面事实（是否有密码框、body 是否为空等），供上层判断失败原因。 */
  async probe() {
    if (!this.page) return null;
    try {
      const result = await this.page.evaluate(probePage);
      return { ...result, pageErrors: this.pageErrors.slice(0, 5) };
    } catch (_) {
      return { pageErrors: this.pageErrors.slice(0, 5) };
    }
  }

  locatorFor(target) {
    if (!this.page) throw new Error('定位元素之前必须先 open()。');
    if (!target || typeof target !== 'object') throw new Error('缺少语义目标。');
    if (target.role && target.name) return this.page.getByRole(target.role, { name: target.name, exact: true });
    if (target.label) return this.page.getByLabel(target.label, { exact: true });
    if (target.text) return this.page.getByText(target.text, { exact: true });
    if (target.testId) return this.page.getByTestId(target.testId);
    if (target.selector) return this.page.locator(target.selector);
    throw new Error('目标需要 role+name、label、text、testId 或 selector。');
  }

  async uniqueVisibleLocator(target) {
    const locator = this.locatorFor(target);
    const count = await locator.count();
    const visible = [];
    for (let index = 0; index < count; index++) {
      const item = locator.nth(index);
      if (await item.isVisible().catch(() => false)) visible.push(item);
    }
    if (visible.length === 0) throw Object.assign(new Error('目标元素不存在或不可见。'), { code: 'target-not-visible' });
    if (visible.length > 1) throw Object.assign(new Error(`目标元素匹配到 ${visible.length} 个可见结果。`), { code: 'target-ambiguous' });
    return visible[0];
  }

  async performAction(action) {
    if (action.type === 'inspect' && !action.target) return { target: null, rect: null };
    const locator = await this.uniqueVisibleLocator(action.target);
    const rect = await locator.boundingBox();
    if (action.type === 'click') await locator.click();
    else if (action.type === 'fill') await locator.fill(String(action.value ?? ''));
    else if (action.type === 'select') await locator.selectOption(action.value);
    else if (action.type === 'check') await locator.check();
    else if (action.type === 'uncheck') await locator.uncheck();
    else if (action.type !== 'inspect') throw new Error(`不支持的交互类型: ${action.type}`);
    return { target: action.target, rect };
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

  async collectSensitiveElements() {
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
    const viewport = this.page.viewportSize() || this.profile.viewport;
    return candidates.map((candidate) => ({ ...candidate, rect: clipRect(candidate.rect, viewport) })).filter((candidate) => candidate.rect);
  }

  async renderEvidence({ sanitizedPath, annotatedPath, redactions, annotations, theme }) {
    if (!this.page) throw new Error('renderEvidence 之前必须先 open()。');
    fs.mkdirSync(path.dirname(sanitizedPath), { recursive: true });
    fs.mkdirSync(path.dirname(annotatedPath), { recursive: true });
    const overlayId = '__manual_evidence_overlay__';
    const renderedRedactions = redactions.map((item) => ({ ...item, cssText: neutralMosaicStyle(item.rect) }));
    await this.page.evaluate(({ overlayId, redactions }) => {
      document.getElementById(overlayId)?.remove();
      const root = document.createElement('div'); root.id = overlayId; root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
      for (const item of redactions) { const el=document.createElement('div'); el.style.cssText=item.cssText; root.appendChild(el); }
      document.documentElement.appendChild(root);
    }, { overlayId, redactions: renderedRedactions });
    await this.page.screenshot({ path: sanitizedPath, type: 'png' });
    await this.page.evaluate(({ overlayId, annotations, theme }) => {
      const root=document.getElementById(overlayId);
      for(const item of annotations){const box=document.createElement('div'),r=item.target;box.style.cssText=`position:absolute;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;border:${theme.outlineWidth}px solid ${theme.primary};border-radius:${theme.targetRadius}px;box-shadow:0 0 0 5px ${theme.halo}`;root.appendChild(box);const marker=document.createElement('div'),m=item.marker;marker.textContent=String(item.label);marker.style.cssText=`position:absolute;left:${m.x}px;top:${m.y}px;width:${m.size}px;height:${m.size}px;border-radius:50%;background:${theme.primary};color:white;border:2px solid white;display:flex;align-items:center;justify-content:center;font:700 16px sans-serif;box-sizing:border-box`;root.appendChild(marker)}
    }, { overlayId, annotations, theme });
    await this.page.screenshot({ path: annotatedPath, type: 'png' });
    await this.page.evaluate((id) => document.getElementById(id)?.remove(), overlayId);
    return { sanitizedPath, annotatedPath };
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

  async exportStorageState() {
    if (!this.context) throw new Error('exportStorageState 之前必须先 launch()。');
    return this.context.storageState();
  }

  async waitForAuthentication({ loginUrl, verifyUrl = null, timeout = 300000 }) {
    if (!this.page) throw new Error('waitForAuthentication 之前必须先 open()。');
    const expectedOrigin = new URL(verifyUrl || loginUrl).origin;
    const authenticated = (url) => {
      const parsed = new URL(String(url));
      return parsed.origin === expectedOrigin && !LOGIN_PATH_RE.test(parsed.pathname);
    };
    if (!authenticated(this.page.url())) {
      try {
        await this.page.waitForURL((url) => authenticated(url), { timeout });
      } catch (_) {
        throw Object.assign(new Error('等待登录完成超时，请完成登录后重试。'), { code: 'auth-timeout' });
      }
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
    // 逐层关闭，任一层失败都不该掩盖真正的截图错误
    for (const target of [this.context, this.browser]) {
      if (!target) continue;
      try { await target.close(); } catch (_) { /* 已经关了 */ }
    }
    this.context = null;
    this.browser = null;
    this.page = null;
  }
}

module.exports = { PlaywrightBrowserProvider, loadPlaywright, resolvePlaywright, legacyPlaywrightCandidates, FREEZE_CSS };
