'use strict';

/*
 * BrowserSession：单个 Run（或单个命令）内复用 Browser 进程，每个 Scenario 独立 Context。
 *
 * - Browser 按启动规格（headless / channel / args / slowMo）分组复用；规格不同就用不同的 Browser，
 *   绝不把 headless 场景塞进有头浏览器，反之亦然。
 * - withScenario() 每次创建新的 provider（= 新 Context），注入该 Scenario 的认证快照、视口、DPR、
 *   语言、时区；无论成功失败都在 finally 关闭 Context，共享 Browser 不受影响。
 * - Scenario 正常结束时才刷新认证快照（身份仍正确才写回），失败的 Scenario 不写认证缓存。
 * - Browser 进程断开（崩溃）时，当前 Scenario 以 browser-crashed 失败（可重试）；该 Browser 从池中
 *   移除，下一次 withScenario 自动启动新进程。
 * - 不使用 persistent userDataDir：Context 之间没有共享的浏览器 profile。
 * - close() 关闭本 session 启动的全部 Browser；必须在 Run 的 finally 中调用。
 */

const { canonical } = require('../util/hash');
const { createProvider } = require('./index');
const { launchBrowser, launchOptionsFor } = require('./playwright');
const { RuntimeError } = require('../runtime/errors');
const { refreshAuth } = require('../auth/runtime');

function createBrowserSession({ browserType = null, launcher = launchBrowser } = {}) {
  const pool = new Map();
  const stats = { launches: 0, contexts: 0, contextCloses: 0, browserCloses: 0, crashes: 0 };
  let closed = false;

  async function browserFor(providerConfig) {
    const key = canonical({ type: providerConfig?.type || 'playwright', ...launchOptionsFor(providerConfig) });
    const entry = pool.get(key);
    if (entry && !entry.crashed && entry.browser.isConnected()) return entry;
    if (entry) pool.delete(key);
    const browser = await launcher(providerConfig, { browserType });
    stats.launches += 1;
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
    const entry = await browserFor(providerConfig);
    const provider = createProvider({
      id, providerConfig, profile, browser: entry.browser,
      storageState: auth && auth.status === 'stored' ? auth.storageState : null,
    });
    const warnings = [];
    stats.contexts += 1;
    try {
      const value = await fn(provider);
      if (entry.crashed) throw new RuntimeError('browser-crashed', '浏览器进程在 Scenario 执行期间退出。');
      if (auth && auth.status === 'stored') {
        const refreshed = await refreshAuth(provider, auth);
        if (refreshed?.warning) warnings.push(refreshed.warning);
      }
      return { value, warnings };
    } catch (error) {
      if (entry.crashed && error.code !== 'browser-crashed') {
        throw new RuntimeError('browser-crashed', `浏览器进程在 Scenario 执行期间退出：${error.message}`, { cause: error.code || error.reason || null });
      }
      throw error;
    } finally {
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
