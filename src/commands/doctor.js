'use strict';

/*
 * manual doctor —— 只读环境诊断。
 *
 * 不安装依赖、不启动业务服务器、不写任何文件，也不输出认证内容；
 * 每项检查给出 ok/warn/fail/skip 与可执行的修复建议。
 */

const fs = require('fs');
const path = require('path');

const pkg = require('../../package.json');
const { parseArgs } = require('../cli/args');
const { loadConfig, configPathFor } = require('../config/load');
const cache = require('../auth/cache');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'help']);
const HELP = `
manual doctor —— 只读检查运行环境

用法:
  manual doctor [--project-root <路径>] [--json]

检查 Node 版本、固定依赖、Playwright 与 Chromium、项目配置、输出目录可写性
以及认证缓存元数据。不安装任何东西，不打印凭据；有 fail 项时退出码为 1。
`.trim();

const BROWSER_INSTALL_HINT = 'npx playwright install chromium（网络受限时可加 PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright）';

function check(id, status, message, extra = {}) {
  return { id, status, message, ...extra };
}

function parseVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual, minimum) {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== m[i]) return a[i] > m[i];
  }
  return true;
}

function checkNode(nodeVersion) {
  const range = pkg.engines && pkg.engines.node;
  const minimum = String(range || '').replace(/^>=\s*/, '');
  if (!minimum || versionAtLeast(nodeVersion, minimum)) {
    return check('node', 'ok', `Node ${nodeVersion} 满足 ${range}`, { version: nodeVersion, required: range });
  }
  return check('node', 'fail', `Node ${nodeVersion} 低于要求 ${range}`, {
    version: nodeVersion, required: range, hint: `升级 Node 到 ${minimum} 或更高版本。`,
  });
}

/** 有 exports 限制的包（如 sharp）不暴露 package.json，从入口文件向上查找。 */
function installedVersion(name, requireImpl) {
  let dir = path.dirname(requireImpl.resolve(name));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (parsed.name === name) return parsed.version;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`找不到 ${name} 的 package.json`);
    dir = parent;
  }
}

function checkDependencies(requireImpl) {
  return Object.entries(pkg.dependencies || {}).map(([name, pinned]) => {
    let version;
    try {
      version = installedVersion(name, requireImpl);
    } catch (_) {
      return check(`dependency:${name}`, 'fail', `缺少依赖 ${name}`, { pinned, hint: '在工具目录运行 npm ci。' });
    }
    if (/^\d+\.\d+\.\d+$/.test(pinned) && version !== pinned) {
      return check(`dependency:${name}`, 'fail', `${name} 版本 ${version} 与固定版本 ${pinned} 不一致`, {
        pinned, version, hint: '在工具目录运行 npm ci 恢复 lockfile 固定版本。',
      });
    }
    return check(`dependency:${name}`, 'ok', `${name} ${version}`, { pinned, version });
  });
}

function checkBrowser({ env, resolvePlaywrightImpl, existsSync }) {
  let resolved;
  try {
    resolved = resolvePlaywrightImpl({ env });
  } catch (error) {
    return [
      check('playwright', 'fail', error.message, { hint: '在工具目录运行 npm ci，或设置 MANUAL_PLAYWRIGHT_PATH。' }),
      check('chromium', 'skip', '未找到 Playwright，跳过浏览器检查。'),
    ];
  }
  let version = null;
  try {
    const manifest = path.join(path.dirname(resolved.path), 'package.json');
    version = JSON.parse(fs.readFileSync(manifest, 'utf8')).version;
  } catch (_) { /* 版本只作展示 */ }
  const results = [check('playwright', 'ok', `Playwright ${version || '未知版本'}（来源: ${resolved.source}）`, {
    version, source: resolved.source, path: resolved.path,
  })];
  if (resolved.source === 'legacy') {
    results[0].status = 'warn';
    results[0].hint = '正在使用个人目录中的旧副本；运行 npm ci 后可关闭 MANUAL_PLAYWRIGHT_LEGACY_SEARCH。';
  }
  let executable = null;
  try {
    executable = resolved.playwright.chromium.executablePath();
  } catch (_) { /* 落到下面 */ }
  if (executable && existsSync(executable)) {
    results.push(check('chromium', 'ok', 'Chromium 可执行文件存在', { executable }));
  } else {
    results.push(check('chromium', 'fail', 'Chromium 可执行文件不存在', { executable, hint: BROWSER_INSTALL_HINT }));
  }
  return results;
}

/** 向上找到第一个已存在的目录，检查其可写性；doctor 不创建目录。 */
function checkWritable(id, target) {
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  try {
    fs.accessSync(probe, fs.constants.W_OK);
    return check(id, 'ok', `可写: ${target}`, { path: target, checked: probe });
  } catch (_) {
    return check(id, 'fail', `不可写: ${target}`, { path: target, checked: probe, hint: '检查目录权限或更换输出位置。' });
  }
}

function checkProject(projectRoot) {
  if (!fs.existsSync(configPathFor(projectRoot))) {
    return { loaded: null, checks: [check('config', 'skip', '当前目录尚未初始化（没有 .manual/config.yaml）。', { hint: 'manual init --base-url <地址>' })] };
  }
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) {
    return { loaded: null, checks: [check('config', 'fail', '配置无效', { errors: loaded.errors, hint: '按错误修正 .manual/config.yaml。' })] };
  }
  const results = [check('config', loaded.warnings.length ? 'warn' : 'ok', '配置可读取且通过校验', { warnings: loaded.warnings })];
  results.push(checkWritable('output:state', path.resolve(projectRoot, loaded.config.artifacts.stateDir)));
  if (loaded.config.docs && loaded.config.docs.outputDir) {
    results.push(checkWritable('output:docs', path.resolve(projectRoot, loaded.config.docs.outputDir)));
  }
  return { loaded, checks: results };
}

/**
 * 认证缓存目录权限。POSIX 检查目录 0700 / 文件 0600；Windows 上 chmod 不代表 ACL，
 * 只能确认目录位于当前用户目录下（继承用户 ACL），覆盖到共享位置时给出风险提示。
 */
function checkAuthPermissions(root, { platform = process.platform, env = process.env, home = require('os').homedir() } = {}) {
  if (!fs.existsSync(root)) return check('auth:permissions', 'skip', '认证缓存目录尚未创建。', { cacheRoot: root });
  if (platform === 'win32') {
    const userRoots = [env.LOCALAPPDATA, env.APPDATA, home].filter(Boolean).map((p) => path.resolve(p).toLowerCase());
    const resolved = path.resolve(root).toLowerCase();
    if (userRoots.some((base) => resolved === base || resolved.startsWith(base + path.sep))) {
      return check('auth:permissions', 'ok', '认证缓存位于当前用户目录下，继承用户 ACL（未逐项验证 ACL）。', { cacheRoot: root, acl: 'inherited-unverified' });
    }
    return check('auth:permissions', 'warn', `认证缓存目录不在当前用户目录下，无法确认只有当前用户可读: ${root}`, {
      cacheRoot: root, acl: 'unverified', hint: '把 MANUAL_AUTH_CACHE_DIR 指向 %LOCALAPPDATA% 下的目录，或用 icacls 限制为仅当前用户访问。',
    });
  }
  const loose = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const mode = fs.statSync(full).mode & 0o777;
      if (mode & 0o077) loose.push(`${full} (${mode.toString(8)})`);
      if (entry.isDirectory()) walk(full);
    }
  };
  if (fs.statSync(root).mode & 0o077) loose.push(`${root} (${(fs.statSync(root).mode & 0o777).toString(8)})`);
  walk(root);
  if (loose.length) {
    return check('auth:permissions', 'warn', '认证缓存存在组/其他用户可访问的权限。', { cacheRoot: root, loose, hint: `chmod -R go-rwx "${root}"` });
  }
  return check('auth:permissions', 'ok', '认证缓存目录与文件仅当前用户可访问。', { cacheRoot: root });
}

function checkAuth(loaded, env) {
  const root = env.MANUAL_AUTH_CACHE_DIR || cache.defaultCacheRoot({ env });
  if (loaded && loaded.config.auth.enabled !== false) return [...checkAuthState(loaded, env, root), checkAuthPermissions(root, { env })];
  return checkAuthState(loaded, env, root);
}

function checkAuthState(loaded, env, root) {
  if (!loaded) return [check('auth', 'skip', '无可用配置，跳过认证缓存检查。', { cacheRoot: root })];
  const auth = loaded.config.auth;
  if (auth.enabled === false) return [check('auth', 'skip', 'auth.enabled=false，不检查认证缓存。', { cacheRoot: root })];
  const ref = { root, cacheKey: auth.cacheKey, profile: auth.activeProfile };
  // 只报告元数据：状态、时间与路径，从不输出 cookie/localStorage 内容。
  try {
    const state = cache.readState(ref);
    if (!state) {
      return [check('auth', 'warn', `认证档案 ${auth.activeProfile} 尚未保存`, { profile: auth.activeProfile, storageStatus: 'missing', cacheRoot: root, hint: `manual auth login --profile ${auth.activeProfile}` })];
    }
    return [check('auth', 'ok', `认证档案 ${auth.activeProfile} 已保存（未做线上验证）`, {
      profile: auth.activeProfile, storageStatus: 'stored', updatedAt: state.updatedAt, cacheRoot: root,
    })];
  } catch (error) {
    return [check('auth', 'fail', `认证档案 ${auth.activeProfile} 无法读取`, {
      profile: auth.activeProfile, storageStatus: 'corrupt', code: error.code, cacheRoot: root, hint: `manual auth login --profile ${auth.activeProfile}`,
    })];
  }
}

/**
 * 收集全部检查项。依赖可注入，便于测试。
 */
function collectChecks({
  projectRoot,
  env = process.env,
  nodeVersion = process.versions.node,
  requireImpl = require,
  resolvePlaywrightImpl = require('../browser/playwright').resolvePlaywright,
  existsSync = fs.existsSync,
} = {}) {
  const checks = [
    check('tool', 'ok', `${pkg.name} ${pkg.version}`, { version: pkg.version }),
    checkNode(nodeVersion),
    ...checkDependencies(requireImpl),
    ...checkBrowser({ env, resolvePlaywrightImpl, existsSync }),
  ];
  const project = checkProject(projectRoot);
  checks.push(...project.checks, ...checkAuth(project.loaded, env));
  return { ok: checks.every((item) => item.status !== 'fail'), projectRoot, checks };
}

const MARK = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length > 0 || positional.length > 0) {
    const errors = [...unknownFlags.map((flag) => `未知参数: ${flag}`), ...(positional.length ? ['此命令不接受位置参数。'] : [])];
    if (json) process.stdout.write(JSON.stringify({ ok: false, errors }, null, 2) + '\n');
    else errors.forEach((error) => process.stderr.write(`[manual doctor] ${error}\n`));
    return 2;
  }
  const report = collectChecks({ projectRoot: path.resolve(values.projectRoot || process.cwd()) });
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    for (const item of report.checks) {
      process.stdout.write(`  ${MARK[item.status]} ${item.id}: ${item.message}\n`);
      if (item.hint && item.status !== 'ok') process.stdout.write(`      → ${item.hint}\n`);
    }
  }
  return report.ok ? 0 : 1;
}

module.exports = { run, HELP, KNOWN_FLAGS, collectChecks, versionAtLeast, checkAuthPermissions };
