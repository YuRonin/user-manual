'use strict';

/*
 * BrowserSession：单个 Run（或单个命令）内复用 Browser 进程，每个 Scenario 独立 Context。
 *
 * - Browser 按启动规格（headless / channel / args / slowMo）分组复用；规格不同就用不同的 Browser，
 *   绝不把 headless 场景塞进有头浏览器，反之亦然。
 * - withScenario() 每次创建新的 provider（= 新 Context），注入该 Scenario 的认证快照、视口、DPR、
 *   语言、时区；无论成功失败都在 finally 关闭 Context，共享 Browser 不受影响。
 * - 认证快照：同一认证档案的 Scenario 串行使用凭据，每个 Context 注入前重新读取缓存最新一代；
 *   站点下发新 Cookie（refresh token 轮换）时立即写回，Scenario 结束时无论成败再写回一次
 *   （失败时只在凭据变化时写）。写回前确认仍处于登录状态，写入用 generation CAS。
 *   原因：很多站点每次刷新都轮换 refresh token，复用旧 token 会被视为盗用并吊销该用户全部令牌。
 * - Browser 进程断开（崩溃）时，当前 Scenario 以 browser-crashed 失败（可重试）；该 Browser 从池中
 *   移除，下一次 withScenario 自动启动新进程。
 * - 不使用 persistent userDataDir：Context 之间没有共享的浏览器 profile。
 * - close() 关闭本 session 启动的全部 Browser；必须在 Run 的 finally 中调用。
 */

const { canonical } = require('../util/hash');
const { createProvider } = require('./index');
const { launchBrowser, launchOptionsFor } = require('./playwright');
const { RuntimeError } = require('../runtime/errors');
const { refreshAuth, reloadAuth } = require('../auth/runtime');

// Set-Cookie 往往一次导航里连着来几条，合并成一次写回。
const PERSIST_DEBOUNCE_MS = 300;

function createBrowserSession({ browserType = null, launcher = launchBrowser } = {}) {
  const pool = new Map();
  // navigations / screenshots：性能验收用的调用计数（P3-07），不影响行为
  const stats = { launches: 0, contexts: 0, contextCloses: 0, browserCloses: 0, crashes: 0, navigations: 0, screenshots: 0 };
  let closed = false;
  // 认证档案 → 等待队列尾：同一份凭据同一时刻只在一个 Context 里使用，避免两个 Context 拿同一个 refresh token 各刷一次。
  const authQueues = new Map();

  async function withAuthTurn(auth, fn) {
    if (!auth || auth.status !== 'stored' || !auth.ref) return fn();
    const key = JSON.stringify([auth.ref.root, auth.ref.cacheKey, auth.ref.profile]);
    const previous = authQueues.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    authQueues.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (authQueues.get(key) === tail) authQueues.delete(key);
    }
  }

  async function browserFor(providerConfig) {
    const key = canonical({ type: providerConfig?.type || 'playwright', ...launchOptionsFor(providerConfig) });
    const entry = pool.get(key);
    if (entry && !entry.crashed && entry.browser.isConnected()) return entry;
    if (entry) pool.delete(key);
    const browser = await launcher(providerConfig, { browserType });
    stats.launches += 1;
    // 启动期间 session 已被关闭（例如取消）：这个 Browser 不再有人负责，立即关闭，避免残留进程。
    if (closed) {
      try { await browser.close(); } catch (_) { /* 已经退出 */ }
      stats.browserCloses += 1;
      throw new RuntimeError('session-closed', 'BrowserSession 已在启动浏览器期间关闭。');
    }
    const fresh = { key, browser, crashed: false };
    browser.on('disconnected', () => {
      if (closed || fresh.closing) return;
      fresh.crashed = true;
      stats.crashes += 1;
    });
    pool.set(key, fresh);
    return fresh;
  }

  /**
   * 在一个隔离 Context 中执行 Scenario。
   * @param {object} spec
   * @param {string} spec.id              provider id
   * @param {object} spec.providerConfig
   * @param {object} spec.profile         视口 / DPR / locale / timezoneId 等
   * @param {object} [spec.auth]          prepareAuth() 的结果；status=stored 时注入并在成功后刷新
   * @param {(provider) => Promise<any>} fn
   * @returns {Promise<{ value, warnings: string[] }>}
   */
  async function withScenario({ id = 'default', providerConfig, profile, auth = null }, fn) {
    if (closed) throw new RuntimeError('session-closed', 'BrowserSession 已关闭。');
    return withAuthTurn(auth, () => runScenario({ id, providerConfig, profile, auth }, fn));
  }

  async function runScenario({ id, providerConfig, profile, auth }, fn) {
    const entry = await browserFor(providerConfig);
    const stored = !!(auth && auth.status === 'stored');
    if (stored) reloadAuth(auth);
    const provider = createProvider({
      id, providerConfig, profile, browser: entry.browser,
      storageState: stored ? auth.storageState : null,
    });
    const warnings = [];
    stats.contexts += 1;
    for (const [method, counter] of [['open', 'navigations'], ['screenshot', 'screenshots']]) {
      if (typeof provider[method] !== 'function') continue;
      const original = provider[method].bind(provider);
      provider[method] = (...args) => { stats[counter] += 1; return original(...args); };
    }
    // 写回串行执行：Set-Cookie 触发的即时写回与结束时的写回不能交错。
    let persisting = Promise.resolve(null);
    let timer = null;
    const persist = (options) => {
      persisting = persisting.then(() => refreshAuth(provider, auth, options)).catch(() => null);
      return persisting;
    };
    if (stored) {
      provider.onCredentialChange = () => {
        clearTimeout(timer);
        timer = setTimeout(() => persist({ onlyIfChanged: true }), PERSIST_DEBOUNCE_MS);
      };
    }
    let succeeded = false;
    try {
      const value = await fn(provider);
      if (entry.crashed) throw new RuntimeError('browser-crashed', '浏览器进程在 Scenario 执行期间退出。');
      succeeded = true;
      return { value, warnings };
    } catch (error) {
      if (entry.crashed && error.code !== 'browser-crashed') {
        throw new RuntimeError('browser-crashed', `浏览器进程在 Scenario 执行期间退出：${error.message}`, { cause: error.code || error.reason || null });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      provider.onCredentialChange = null;
      if (stored && !entry.crashed) {
        // 成功时总是刷新快照；失败时只在凭据确实变化（例如 refresh token 已轮换）时写回。
        const refreshed = await persist({ onlyIfChanged: !succeeded });
        if (succeeded && refreshed?.warning) warnings.push(refreshed.warning);
      }
      stats.contextCloses += 1;
      await provider.close();
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    for (const entry of pool.values()) {
      entry.closing = true;
      try { await entry.browser.close(); } catch (_) { /* 已经退出 */ }
      stats.browserCloses += 1;
    }
    pool.clear();
  }

  return { withScenario, close, stats: () => ({ ...stats, browsers: pool.size }) };
}

module.exports = { createBrowserSession };
