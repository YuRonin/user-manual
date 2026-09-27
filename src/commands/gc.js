'use strict';

/*
 * `manual gc` —— 按保留策略回收不再需要的产物（P3-08）。默认 dry-run，只列出拟清理对象。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { EXIT, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { planRetention, applyRetention } = require('../store/retention');

const KNOWN_FLAGS = new Set(['projectRoot', 'apply', 'expect', 'json', 'help']);

const HELP = `
manual gc —— 按保留策略回收不再需要的产物

用法:
  manual gc [--json]                          只列出拟清理对象（默认，不删除任何文件）
  manual gc --apply [--expect <planHash>]     在项目锁内重新核对后删除；给了 --expect 时计划必须与审阅时一致

保留（永不回收）:
  全部发布记录（当前与历史）及其引用的 Capture、发布图、生成正文与源码图快照；当前引用（latest / 页面与任务投影）；
  当前草稿引用的图片；未结束或仍在执行的 Run；config.retention.pinnedCaptures 固定的 Capture。

回收（未被引用且超过天数，均可在 config.retention 中调整）:
  stagingDays 7              未提交的采集临时目录
  diagnosticsDays 7          私有诊断截图
  runLogDays 30              已结束 Run 的目录（事件日志、模型交接、暂存文档）
  rawDays 30                 原图 raw / sanitized——被引用的 Capture 也适用：发布图与记录保留，
                             但原图删除后不能再重新标注，隐私规则或标注主题变化需要重新采集
  unreferencedCaptureDays 30 没有任何引用的 Capture 记录及其产物、源码图快照
  未被发布记录引用的生成正文 blob

安全: 只删除 .manual 与配置的产物目录内的对象；指向外部的链接只删除链接本身；不调用 shell 递归删除。
`.trim();

function fail(message, { json, code = 'gc-failed' }) {
  if (json) process.stdout.write(JSON.stringify({ ok: false, code, errors: [message] }, null, 2) + '\n');
  else process.stderr.write(`[manual gc] ${message}\n`);
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['apply'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length || positional.length) { fail(`未知参数: ${[...unknownFlags, ...positional].join(', ')}`, { json, code: 'invalid-arguments' }); return usageExit(); }
  if (values.expect !== undefined && (typeof values.expect !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(values.expect))) {
    fail('--expect 需要 dry-run 输出的 planHash（sha256:…）。', { json, code: 'invalid-arguments' });
    return usageExit();
  }
  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot)) { fail(`--project-root 不存在: ${projectRoot}`, { json }); return EXIT.FAILED; }
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) { fail(loaded.errors.join('；'), { json, code: 'invalid-config' }); return EXIT.FAILED; }
  const config = loaded.config;

  if (!values.apply) {
    const plan = planRetention({ projectRoot, config });
    if (json) process.stdout.write(JSON.stringify({ ok: true, dryRun: true, ...plan }, null, 2) + '\n');
    else {
      const L = ['', `[manual gc] 拟清理 ${plan.summary.objects} 个对象，共 ${(plan.summary.bytes / 1024).toFixed(1)} KB（未删除任何文件）`];
      for (const item of plan.items) L.push(`  ${item.kind.padEnd(18)} ${item.path}  （${item.reason}）`);
      L.push(`  计划 ${plan.planHash}`, `  确认后：manual gc --apply --expect ${plan.planHash}`, '');
      process.stdout.write(L.join('\n') + '\n');
    }
    return 0;
  }

  let result;
  try {
    result = applyRetention({ projectRoot, config, expectedPlanHash: values.expect || null });
  } catch (error) {
    fail(error.message, { json, code: error.code || 'gc-failed' });
    return error.code === 'gc-plan-changed' || error.code === 'lock-timeout' ? EXIT.CONFLICT : EXIT.FAILED;
  }
  if (json) process.stdout.write(JSON.stringify({ ok: result.skipped.length === 0, planHash: result.planHash, removed: result.removed, skipped: result.skipped, summary: result.summary }, null, 2) + '\n');
  else {
    process.stdout.write(`[manual gc] 已删除 ${result.removed.length} 个对象。\n`);
    for (const s of result.skipped) process.stdout.write(`  跳过 ${s.path}（${s.reason}）\n`);
  }
  return result.skipped.length ? EXIT.FAILED : 0;
}

module.exports = { run, HELP, KNOWN_FLAGS };
