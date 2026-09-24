'use strict';

const path = require('path');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProvider } = require('../browser');
const cache = require('../auth/cache');
const { establishSession } = require('../auth/session');
const { authDisabled, resolveCapabilities } = require('../auth/identity');

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
  else if (action === 'status') process.stdout.write(`[manual auth] ${payload.profile}: ${payload.storageStatus || payload.status}（验证: ${payload.validationStatus || 'unknown'}${payload.lastValidatedAt ? ` @ ${payload.lastValidatedAt}` : ''}）\n`);
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

  if (authDisabled(config, profile)) {
    // 匿名 / 未启用认证：不读、不写、不清理任何认证缓存。
    if (action === 'login') return fail(Object.assign(new Error('当前档案未启用认证（auth.enabled=false 或匿名档案），无需登录。'), { code: 'auth-disabled' }), json);
    return output({ ok: true, status: 'disabled', storageStatus: 'disabled', validationStatus: 'not-applicable', profile, cleared: false }, { json, action });
  }

  if (action === 'status') {
    // stored 只表示文件可读，不代表线上仍有效；lastValidatedAt 记录最近一次身份断言通过时间。
    try {
      const state = cache.readState(ref);
      if (!state) return output({ ok: true, status: 'missing', storageStatus: 'missing', validationStatus: 'unknown', profile }, { json, action });
      return output({ ok: true, status: 'stored', profile, ...cache.publicMetadata(state, cache.cacheFileFor(ref)) }, { json, action });
    } catch (error) {
      if (error.code === 'auth-corrupt') {
        return output({ ok: true, status: 'corrupt', storageStatus: 'corrupt', validationStatus: 'unknown', profile, path: cache.cacheFileFor(ref) }, { json, action });
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

  let capabilities;
  try { capabilities = resolveCapabilities(config); } catch (error) { return fail(error, json); }
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
      config,
      profile,
      capabilities,
    });
    const state = cache.writeState(ref, {
      origin: new URL(config.project.baseUrl).origin,
      storageState: result.storageState,
      identityRevision: result.identityRevision,
      validatedAt: result.validatedAt,
    });
    const warnings = result.validationStatus === 'validated' ? [] : ['未配置 auth.identityAssertions：登录状态已保存，但未经身份断言确认（validationStatus=unvalidated）。'];
    return output({ ok: true, status: 'stored', profile, finalUrl: result.finalUrl, warnings, ...cache.publicMetadata(state, cache.cacheFileFor(ref)) }, { json, action });
  } catch (error) {
    return fail(error, json);
  } finally {
    await provider.close();
  }
}

module.exports = { run, HELP, KNOWN_FLAGS, resolveUrl };
