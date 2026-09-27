'use strict';

/*
 * `manual capture <page>` —— 用真实浏览器打开页面并截图。
 *
 * 铁律：**页面打不开就不要产出截图**。没有截图是个可见的缺口，
 * 伪造的截图会悄悄混进手册，谁都不知道那页其实是坏的。
 *
 * 这一层不认识 Playwright，只通过 BrowserProvider 契约说话（见 src/browser/）。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { exitCodeFor, exitCodeForCode, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { CaptureError } = require('../browser/errors');
const { DEFAULT_READY_OPTIONS } = require('../browser/provider');
const { displayPath } = require('../util/fsx');
const { validateNavigation } = require('../evidence/validate-page');
const { capturePage, parseParams, resolveRoute, joinUrl } = require('../evidence/capture-page');
const { recordCapture } = require('../runtime/app');
const captureTaskCommand = require('./capture-task');

const KNOWN_FLAGS = new Set([
  'projectRoot', 'params', 'url', 'waitFor', 'timeout', 'quietMs', 'settleMs',
  'fullPage', 'noFreezeAnimations', 'provider', 'profile', 'out', 'json', 'help',
]);
const BOOLEAN_FLAGS = ['fullPage', 'noFreezeAnimations'];

const HELP = `
manual capture —— 用真实浏览器打开页面并截图

用法:
  manual capture <page-id | page:<id> | task:<id> | scenario:<id>> [选项]

  scenario:<id>  采集 .manual/scenarios/<id>.yaml 定义的 Scenario 变体（空状态、错误态、其他角色、
                 Fixture 数据）。mock Fixture 的结果标 simulated；hook Fixture 的测试数据在采集前准备、
                 采集后无论成败都清理；生产或未登记的环境直接拒绝。

做什么:
  从 .manual/pages/<page-id>.yaml 取出 route → 拼出 {baseUrl}{route} → 用配置里的
  Browser Provider 打开真实页面 → 等页面稳定 → 按配置的 viewport 与 DPR 截图 →
  回写页面模型的 browser 状态。

  页面打不开时**不会**产出任何截图，并给出分类的失败原因。

截图前会依次等待:
  load 事件 → 网络空闲 → 指定元素(可选) → Web Font 就绪 → 图片加载完 →
  DOM 连续静止 → 冻结 CSS 动画与过渡 → 静置回流

选项:
  --project-root <路径>    项目根目录，默认当前工作目录
  --params <k=v;k=v>       动态路由的参数值，例如 --params "id=123"
  --url <完整URL>          直接指定要打开的地址，绕过 route 拼接（调试用）
  --wait-for <选择器>      必须出现的元素（超时即失败，不截图），最可靠的「页面好了」信号
  --timeout <毫秒>         单步等待上限，默认 ${DEFAULT_READY_OPTIONS.timeout}
  --quiet-ms <毫秒>        DOM 静止多久算稳定，默认 ${DEFAULT_READY_OPTIONS.quietMs}
  --settle-ms <毫秒>       截图前静置时长，默认 ${DEFAULT_READY_OPTIONS.settleMs}
  --full-page              整页截图（默认只截一屏视口）
  --no-freeze-animations   不冻结动画（默认冻结，保证同页两次截图一致）
  --provider <id>          临时覆盖 config 里的 activeProvider
  --profile <id>           临时覆盖 config 里的 activeProfile
  --out <路径>             临时覆盖输出路径
  --json                   以 JSON 输出结果
  --help                   显示本帮助

示例:
  manual capture chat
  manual capture chat --provider playwright-headed
  manual capture artifact-id --params "id=123"
  manual capture membership --wait-for "text=购买" --full-page
`.trim();

function fail(error, { json }) {
  const payload = error instanceof CaptureError
    ? error.toJSON()
    : { reason: 'error', message: Array.isArray(error) ? error.join(' ') : String(error) };
  const list = Array.isArray(error) ? error : null;

  if (json) {
    process.stdout.write(
      JSON.stringify({ ok: false, ...(list ? { errors: list } : payload) }, null, 2) + '\n'
    );
  } else {
    process.stderr.write('\n[manual capture] 截图失败：\n');
    if (list) {
      for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    } else {
      process.stderr.write(`  ✗ ${payload.message}\n`);
      if (payload.reason && payload.reason !== 'error') {
        process.stderr.write(`    原因分类: ${payload.reason}\n`);
      }
      if (payload.finalUrl) process.stderr.write(`    最终地址: ${payload.finalUrl}\n`);
      if (payload.status) process.stderr.write(`    HTTP 状态: ${payload.status}\n`);
      if (Array.isArray(payload.pageErrors) && payload.pageErrors.length > 0) {
        process.stderr.write('    页面报错:\n');
        for (const pe of payload.pageErrors) process.stderr.write(`      ${pe}\n`);
      }
      if (payload.hint) process.stderr.write(`\n  → ${payload.hint}\n`);
    }
    process.stderr.write('\n  没有产出截图文件（页面打不开时不会伪造截图）。\n\n');
  }
  return exitCodeFor(error);
}

/**
 * 兼容旧接口：根据 HTTP 状态与页面事实判断这次打开是否真的成功。
 * 实际规则在 evidence/validate-page，与任务入口共用。
 */
function assessOutcome({ requestedUrl, openResult, probe }) {
  return validateNavigation({ requestedUrl, openResult, observation: probe });
}

function renderSummary({ page, url, outPath, shot, ready, projectRoot, provider, profileId, profile }) {
  const L = [''];
  L.push('[manual capture] 截图完成。');
  L.push('');
  L.push(`  页面        ${page.id}${page.title ? `  ${page.title}` : ''}`);
  L.push(`  地址        ${url}`);
  L.push(`  规格        ${profileId} (${profile.viewport.width}x${profile.viewport.height} @${profile.deviceScaleFactor}x)`);
  L.push(`  Provider    ${provider.id} (${provider.type}, ${provider.headless ? '无头' : '有头'})`);
  L.push(`  输出        ${displayPath(outPath, projectRoot)}  ${(shot.bytes / 1024).toFixed(0)} KB`);
  L.push('');

  const s = ready.steps;
  const imageNote = s.images && typeof s.images === 'object' ? `${s.images.status}(${s.images.waited})` : s.images;
  L.push(`  等待过程    load=${s.load}  network=${s.networkIdle}  fonts=${s.fonts}  images=${imageNote}  dom=${s.domQuiet}`);
  if (s.animationsFrozen !== undefined) L.push(`              已冻结动画 ${s.animationsFrozen} 个`);

  if (ready.warnings.length > 0) {
    L.push('');
    L.push('  ⚠ 等待过程中的提示:');
    for (const w of ready.warnings) L.push(`    - ${w}`);
  }

  L.push('');
  L.push('  页面模型已更新: browser.verified = true');
  L.push('');
  return L.join('\n');
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, {
    known: KNOWN_FLAGS,
    booleans: BOOLEAN_FLAGS,
  });
  const json = values.json === true;

  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) return usageExit(fail([`未知参数: ${unknownFlags.join(', ')}`], { json }));

  const pageId = positional[0];
  if (!pageId) {
    return usageExit(fail(['需要指定页面 id，例如 `manual capture chat`。用 `manual inspect` 看有哪些页面。'], { json }));
  }
  if (positional.length > 1) {
    return usageExit(fail([`一次只能截一个页面，收到: ${positional.join(', ')}`], { json }));
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  // task:<id> 与 capture-task 走同一个用例；capture 只推进到证据提交，不生成文档。
  if (pageId.startsWith('task:')) return captureTaskCommand.captureTaskTarget({ projectRoot, config, taskId: pageId.slice(5), json });
  // scenario:<id>：Scenario 变体（空状态 / 错误态 / 其他角色 / Fixture 数据）走 Runtime，
  // hook Fixture 的 setup / cleanup 作为独立任务执行，中断后可 resume 清理。
  if (pageId.startsWith('scenario:')) {
    const { startRun } = require('../runtime/app');
    const { printRun, printRuntimeError } = require('../cli/run-report');
    try {
      return printRun({ json, result: await startRun({ projectRoot, command: 'capture', targets: [pageId], copy: { mode: 'default' } }), label: 'capture' });
    } catch (error) {
      return printRuntimeError({ json, error, label: 'capture' });
    }
  }
  const overrides = ['profile', 'provider', 'url', 'params', 'fullPage', 'timeout', 'quietMs', 'settleMs', 'noFreezeAnimations', 'waitFor'].filter((k) => values[k] !== undefined && values[k] !== false);

  let result;
  try {
    result = await capturePage({
      projectRoot,
      config,
      pageId: pageId.replace(/^page:/, ''),
      options: {
        profile: values.profile, provider: values.provider, url: values.url, params: values.params,
        fullPage: values.fullPage === true, timeout: values.timeout, quietMs: values.quietMs, settleMs: values.settleMs,
        noFreezeAnimations: values.noFreezeAnimations === true, waitFor: values.waitFor,
      },
    });
  } catch (e) {
    if (e instanceof CaptureError) return fail(e, { json });
    fail(e.errors || [e.message], { json });
    return exitCodeForCode(e.code);
  }
  const { page, updatedPage, record, shot, ready, navigation, identity, safe, url, effectiveRoute, profileId, profile, providerId, capturedAt, screenshotRelative, published } = result;
  // 按默认规格采集的证据登记进缓存，之后 manual generate 可以复用；自定义地址 / 规格的采集不登记。
  if (overrides.length === 0) recordCapture({ projectRoot, subject: { type: 'page', id: page.id }, captureIds: [record.id], observedAt: record.observedAt });

  // --out 只额外导出一份原图副本；权威产物是内容寻址安装的 Capture。
  const outPath = values.out ? path.resolve(projectRoot, values.out) : null;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, screenshotRelative), outPath);
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          pageId,
          route: effectiveRoute,
          url: shot.meta.url,
          captureId: record.id,
          screenshot: screenshotRelative,
          screenshotAbsolute: path.join(projectRoot, screenshotRelative),
          exported: outPath,
          bytes: shot.bytes,
          capturedAt,
          profile: profileId,
          viewport: shot.meta.viewport,
          deviceScaleFactor: shot.meta.deviceScaleFactor,
          provider: { id: providerId, type: shot.meta.providerType, headless: shot.meta.headless },
          fullPage: shot.meta.fullPage,
          readySteps: ready.steps,
          identity,
          actualRoute: navigation.actualRoute,
          published,
          // 只含类型与区域，不含敏感原文
          redactions: safe ? safe.redactions.map(({ kind, rect, result: r }) => ({ kind, rect, result: r })) : [],
          validations: navigation.validations,
          warnings: ready.warnings,
          confidence: updatedPage.confidence,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(
      renderSummary({
        page, url, outPath: path.join(projectRoot, screenshotRelative), shot, ready, projectRoot, profileId, profile,
        provider: { id: providerId, type: shot.meta.providerType, headless: shot.meta.headless },
      }) + '\n'
    );
  }

  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, resolveRoute, parseParams, joinUrl, assessOutcome };
