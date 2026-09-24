'use strict';

/*
 * BrowserProvider —— 上层截图流程与「谁在驱动浏览器」之间的唯一接口。
 *
 * capture 命令只认这四个方法，不认 Playwright。以后接 agent-browser /
 * ChatGPT Desktop / Computer Use 时，实现同样的契约即可，上层一行不用改。
 *
 *   open(url)            打开页面。返回 { status, finalUrl, redirected }
 *   waitUntilReady(opts) 等到可以截图：DOM、字体、图片、异步内容、动画
 *   screenshot(opts)     截图落盘。返回 { path, bytes, meta }
 *   currentObservation() 等待后的当前 URL 与页面事实（可选）
 *   close()              释放资源。必须可以重复调用
 *
 * 约定：
 * - open() 打不开必须抛 CaptureError（分类的），不能返回一个「空页面」让上层以为成功。
 * - screenshot() 之前上层保证已经 waitUntilReady()。
 * - 所有实现都必须尊重构造时传入的 profile（viewport + deviceScaleFactor）。
 */

const { CaptureError, REASON } = require('./errors');

/** waitUntilReady 的默认节奏。都可以被命令行覆盖。 */
const DEFAULT_READY_OPTIONS = {
  timeout: 30000,       // 单步等待上限
  quietMs: 500,         // DOM 连续这么久没变动才算「稳定」
  settleMs: 300,        // 最后再静置一小会儿，等布局/字体回流落定
  freezeAnimations: true,
  waitFor: null,        // 必须出现的选择器；超时即 readiness-timeout
};

class BrowserProvider {
  /**
   * @param {object} options
   * @param {object} options.profile        截图规格 { kind, viewport:{width,height}, deviceScaleFactor, ... }
   * @param {object} options.providerConfig 该 provider 在 config.yaml 里的配置
   * @param {string} options.id             provider 在配置里的 id，仅用于报错和元数据
   */
  constructor({ profile, providerConfig, id, storageState = null }) {
    if (!profile || !profile.viewport) {
      throw new CaptureError(REASON.PROVIDER_UNAVAILABLE, 'BrowserProvider 需要一个带 viewport 的截图规格。');
    }
    this.profile = profile;
    this.providerConfig = providerConfig || {};
    this.id = id || 'unknown';
    this.storageState = storageState;
  }

  /** provider 类型，用于元数据。子类覆盖。 */
  get type() {
    return 'abstract';
  }

  async open(_url) {
    throw new Error(`${this.constructor.name} 没有实现 open()`);
  }

  async waitUntilReady(_options) {
    throw new Error(`${this.constructor.name} 没有实现 waitUntilReady()`);
  }

  async screenshot(_options) {
    throw new Error(`${this.constructor.name} 没有实现 screenshot()`);
  }

  async performAction(_action) {
    throw new Error(`${this.constructor.name} 没有实现 performAction()`);
  }

  async assertCondition(_assertion) {
    throw new Error(`${this.constructor.name} 没有实现 assertCondition()`);
  }

  /**
   * 可选：读取页面事实（标题、是否有密码框、body 是否为空等），供上层判断失败原因。
   * 无法内省页面的 provider 返回 null，上层会跳过相应检查。
   */
  async probe() {
    return null;
  }

  /**
   * 可选：等待结束后重新读取的页面事实 { url, title, hasPasswordField, bodyTextLength,
   * elementCount, notFoundHint, busy, errorAlert, pageErrors }。页面身份判断以它为准，
   * 而不是 open() 返回的旧 finalUrl。无法内省页面的 provider 返回 null。
   */
  async currentObservation() {
    return null;
  }

  async exportStorageState() {
    return null;
  }

  async close() {
    // 默认无操作；子类按需覆盖。必须能被重复调用。
  }
}

module.exports = { BrowserProvider, DEFAULT_READY_OPTIONS };
