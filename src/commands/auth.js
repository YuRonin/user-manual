'use strict';

const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProvider } = require('../browser');
const cache = require('../auth/cache');
const { establishSession } = require('../auth/session');

const KNOWN_FLAGS = new Set([
  'projectRoot', 'profile', 'loginUrl', 'verifyPath', 'timeout', 'json', 'help',
]);
const HELP = `
manual auth —— 管理可跨 worktree 复用的浏览器认证档案

用法:
  manual auth login [--profile <名称>] [--login-url <url>] [--verify-path <路径>]
  manual auth status [--profile <名称>] [--json]
  manual auth clear [--profile <名称>] [--json]
`.trim();

function cacheRoot() {
  return process.env.MANUAL_AUTH_CACHE_DIR || cache.defaultCacheRoot();
}

function output(payload, { json, action }) {
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else if (action === 'status') process.stdout.write(`[manual auth] ${payload.profile}: ${payload.status}\n`);
  else if (action === 'clear') process.stdout.write(`[manual auth] ${payload.profile}: ${payload.cleared ? '已清除' : '没有缓存'}\n`);
  else process.stdout.write(`[manual auth] ${payload.profile}: 登录状态已保存。\n`);
  return 0;
}

function fail(error, json) {
  const payload = { ok: false, reason: error.code || 'auth-error', message: String(error.message || error) };
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stderr.write(`[manual auth] ${payload.message}\n`);
  return 1;
}

function resolveUrl(baseUrl, value) {
  return value ? new URL(String(value), `${baseUrl}/`).href : null;
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return fail(new Error(`未知参数: ${unknownFlags.join(', ')}`), json);
  const action = positional[0];
  if (!['login', 'status', 'clear'].includes(action) || positional.length !== 1) {
    return fail(new Error('需要指定 login、status 或 clear。'), json);
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(new Error(loaded.errors.join('；')), json);
  const { config } = loaded;
  const profile = String(values.profile || config.auth.activeProfile);
  const ref = { root: cacheRoot(), cacheKey: config.auth.cacheKey, profile };

  if (action === 'status') {
    try {
      const state = cache.readState(ref);
      return output({ ok: true, status: state ? 'ready' : 'missing', profile, ...(state ? cache.publicMetadata(state, cache.cacheFileFor(ref)) : {}) }, { json, action });
    } catch (error) {
      if (error.code === 'auth-corrupt') {
        return output({ ok: true, status: 'corrupt', profile, path: cache.cacheFileFor(ref) }, { json, action });
      }
      return fail(error, json);
    }
  }

  if (action === 'clear') {
    try {
      const cleared = cache.clearState(ref);
      return output({ ok: true, profile, cleared }, { json, action });
    } catch (error) {
      return fail(error, json);
    }
  }

  const profileConfig = config.capture.profiles[config.capture.activeProfile];
  const activeId = config.browser.activeProvider;
  const activeProvider = config.browser.providers[activeId];
  const provider = createProvider({
    id: `${activeId}-auth`,
    profile: profileConfig,
    providerConfig: { ...activeProvider, type: 'playwright', headless: false },
  });
  try {
    const loginUrl = resolveUrl(config.project.baseUrl, values.loginUrl || config.auth.loginUrl);
    const verifyUrl = resolveUrl(config.project.baseUrl, values.verifyPath || config.auth.verifyPath);
    const result = await establishSession({
      provider,
      loginUrl,
      verifyUrl,
      timeout: values.timeout ? Number(values.timeout) : 300000,
    });
    const state = cache.writeState(ref, { origin: new URL(config.project.baseUrl).origin, storageState: result.storageState });
    return output({ ok: true, status: 'ready', profile, finalUrl: result.finalUrl, ...cache.publicMetadata(state, cache.cacheFileFor(ref)) }, { json, action });
  } catch (error) {
    return fail(error, json);
  } finally {
    await provider.close();
  }
}

module.exports = { run, HELP, KNOWN_FLAGS, resolveUrl };
