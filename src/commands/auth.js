'use strict';

const path = require('path');

const { parseArgs } = require('../cli/args');
const { exitCodeFor, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { createProvider } = require('../browser');
const cache = require('../auth/cache');
const { establishSession } = require('../auth/session');
const { authDisabled, resolveCapabilities } = require('../auth/identity');
const { checkAuthOnline } = require('../auth/check');
const { probeRedirect, redirectWarning } = require('../util/redirect-probe');
const { openProject, resumeRun, changedInputs } = require('../runtime/app');
const { printRun, printRuntimeError } = require('../cli/run-report');

const KNOWN_FLAGS = new Set([
  'projectRoot', 'profile', 'loginUrl', 'verifyPath', 'path', 'timeout', 'resume', 'json', 'help',
]);
const HELP = `
manual auth —— 管理可跨 worktree 复用的浏览器认证档案

用法:
  manual auth login [--profile <名称>] [--login-url <url>] [--verify-path <路径>] [--resume <Run ID>]
  manual auth status [--profile <名称>] [--json]
  manual auth check [--profile <名称>] [--path <受保护路径>] [--json]
  manual auth clear [--profile <名称>] [--json]
`.trim();

function cacheRoot() {
  return process.env.MANUAL_AUTH_CACHE_DIR || cache.defaultCacheRoot();
}

function output(payload, { json, action }) {
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else if (action === 'status') process.stdout.write(`[manual auth] ${payload.profile}: ${payload.storageStatus || payload.status}（验证: ${payload.validationStatus || 'unknown'}${payload.lastValidatedAt ? ` @ ${payload.lastValidatedAt}` : ''}）\n`);
  else if (action === 'check') process.stdout.write(`[manual auth] ${payload.profile}: ${payload.status}（在线已检查；${payload.validationStatus}）\n`);
  else if (action === 'clear') process.stdout.write(`[manual auth] ${payload.profile}: ${payload.cleared ? '已清除' : '没有缓存'}\n`);
  else process.stdout.write(`[manual auth] ${payload.profile}: 登录状态已保存。\n`);
  return 0;
}

function fail(error, json) {
  const payload = { ok: false, reason: error.code || error.reason || 'auth-error', message: String(error.message || error), ...(error.hint ? { hint: error.hint } : {}) };
  if (json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else process.stderr.write(`[manual auth] ${payload.message}${payload.hint ? `\n[manual auth] ${payload.hint}` : ''}\n`);
  return exitCodeFor(error);
}

function resolveUrl(baseUrl, value) {
  return value ? new URL(String(value), `${baseUrl}/`).href : null;
}

function authRecoveryTarget(state, profile, defaultProfile) {
  const planTasks = new Map((state?.plan?.tasks || []).map((task) => [task.id, task]));
  return (state?.tasks || []).find((task) =>
    task.effectiveStatus === 'waiting_input' &&
    ['auth-missing', 'auth-expired', 'login-required'].includes(task.error?.code) &&
    (planTasks.get(task.id)?.input?.authProfile || defaultProfile) === profile);
}

async function run(argv, services = {}) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length) return usageExit(fail(new Error(`未知参数: ${unknownFlags.join(', ')}`), json));
  const action = positional[0];
  if (!['login', 'status', 'check', 'clear'].includes(action) || positional.length !== 1) {
    return usageExit(fail(new Error('需要指定 login、status、check 或 clear。'), json));
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(new Error(loaded.errors.join('；')), json);
  const { config } = loaded;
  const profile = String(values.profile || config.auth.activeProfile);
  const ref = { root: cacheRoot(), cacheKey: config.auth.cacheKey, profile };

  if (values.resume === '') return fail(Object.assign(new Error('--resume 缺少 Run ID。'), { code: 'invalid-arguments' }), json);
  if (values.resume && action !== 'login') return fail(Object.assign(new Error('--resume 只适用于 auth login。'), { code: 'invalid-arguments' }), json);

  if (values.resume) {
    try {
      const project = (services.openProject || openProject)(projectRoot);
      const state = project.runStore.read(String(values.resume));
      if (!state) throw Object.assign(new Error(`找不到 Run ${values.resume}。`), { code: 'run-not-found' });
      if (!authRecoveryTarget(state, profile, config.auth.activeProfile)) {
        throw Object.assign(new Error(`Run ${values.resume} 没有等待认证档案 ${profile} 的任务；先用 manual status ${values.resume} 查看等待原因。`), { code: 'auth-resume-unavailable' });
      }
      const { changed } = (services.changedInputs || changedInputs)({ projectRoot, project, state });
      if (changed.length) throw Object.assign(new Error(`Run ${values.resume} 的输入已变化（${changed.join(', ')}）。先运行 manual resume ${values.resume} --replan；未打开登录窗口。`), { code: 'run-input-changed' });
    } catch (error) { return fail(error, json); }
  }

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

  if (action === 'check') {
    try {
      const result = await checkAuthOnline({ config, profile, path: values.path || values.verifyPath || config.auth.verifyPath });
      return output({ ok: true, profile, ...result }, { json, action });
    } catch (error) { return fail(error, json); }
  }

  let capabilities;
  try { capabilities = resolveCapabilities(config); } catch (error) { return fail(error, json); }
  const profileConfig = config.capture.profiles[config.capture.activeProfile];
  const activeId = config.browser.activeProvider;
  const activeProvider = config.browser.providers[activeId];
  // 先查 baseUrl 是否被重定向到另一个协议 / 主机：这是登录后"CLI 一直等不到"的头号原因，打开浏览器前就说清楚。
  const preflight = [];
  const redirect = redirectWarning(config.project.baseUrl, await (services.probeRedirect || probeRedirect)(config.project.baseUrl));
  if (redirect) {
    preflight.push(redirect);
    process.stderr.write(`[manual auth] ⚠ ${redirect}\n`);
  }
  const provider = (services.createProvider || createProvider)({
    id: `${activeId}-auth`,
    profile: profileConfig,
    providerConfig: { ...activeProvider, type: 'playwright', headless: false },
  });
  let saved;
  try {
    const loginUrl = resolveUrl(config.project.baseUrl, values.loginUrl || config.auth.loginUrl);
    const verifyUrl = resolveUrl(config.project.baseUrl, values.verifyPath || config.auth.verifyPath);
    const result = await (services.establishSession || establishSession)({
      provider,
      loginUrl,
      verifyUrl,
      timeout: values.timeout ? Number(values.timeout) : 300000,
      config,
      profile,
      capabilities,
      onProgress: (message) => process.stderr.write(`[manual auth] ${message}\n`),
    });
    const state = cache.writeState(ref, {
      origin: new URL(config.project.baseUrl).origin,
      storageState: result.storageState,
      identityRevision: result.identityRevision,
      validatedAt: result.validatedAt,
    });
    const warnings = [...preflight, ...(result.validationStatus === 'validated' ? [] : ['未配置 auth.identityAssertions：登录状态已保存，但未经身份断言确认（validationStatus=unvalidated）。'])];
    saved = { ok: true, status: 'stored', profile, warnings, ...cache.publicMetadata(state, cache.cacheFileFor(ref)) };
  } catch (error) {
    if (redirect && error.code === 'auth-timeout') error.message += ` 另外：${redirect}`;
    return fail(error, json);
  } finally {
    await provider.close();
  }
  if (!values.resume) return output(saved, { json, action });
  if (!json) output(saved, { json: false, action });
  try {
    return printRun({ json, result: await (services.resumeRun || resumeRun)({ projectRoot, runId: String(values.resume) }), label: 'resume', projectRoot,
      extra: { auth: { status: 'stored', profile, validationStatus: saved.validationStatus } } });
  } catch (error) {
    return printRuntimeError({ json, error, label: 'resume' });
  }
}

module.exports = { run, HELP, KNOWN_FLAGS, resolveUrl, authRecoveryTarget };
