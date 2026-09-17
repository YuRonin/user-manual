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

/**
 * Playwright 不在全局。按候选路径解析，策略沿用 manual-shot/scripts/shot.js 里
 * 验证过的那套（~/gstack 自带的副本最稳），避免为本 Skill 再装一份浏览器内核。
 */
function loadPlaywright() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'gstack', 'node_modules', 'playwright'),
    path.join(home, '.claude', 'skills', 'gstack', 'node_modules', 'playwright'),
    path.join(process.cwd(), 'node_modules', 'playwright'),
  ];

  const npxRoot = path.join(home, 'npm-cache', '_npx');
  try {
    for (const dir of fs.readdirSync(npxRoot)) {
      candidates.push(path.join(npxRoot, dir, 'node_modules', 'playwright'));
    }
  } catch (_) { /* npx 缓存可能不存在 */ }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch (_) { /* 换下一个 */ }
  }
  try { return require('playwright'); } catch (_) { /* 落到下面报错 */ }

  throw new CaptureError(
    REASON.PROVIDER_UNAVAILABLE,
    '找不到 playwright 包。',
    { searched: candidates }
  );
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

module.exports = { PlaywrightBrowserProvider, loadPlaywright, FREEZE_CSS };
