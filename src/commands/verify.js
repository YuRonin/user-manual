'use strict';

/*
 * `manual verify` —— 检查已发布的手册。两个范围严格分开：
 *
 *   --artifacts（默认）离线产物验证：文档与发布记录一致、图片 hash、隐私与发布门槛、结构事实。
 *   --live              在线验证：真实导航并逐条回放页面身份、任务步骤与完成声明；
 *                       写 / 破坏性步骤不执行，报告验证覆盖与停止边界。
 *
 * 每次验证都写一份新的不可变报告（.manual/verifications/<id>.json）；不改历史 Capture 与发布记录。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { exitCodeFor, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { createBrowserSession } = require('../browser/session');
const { publishedManualIds } = require('../update/baseline');
const { loadVerify, prepareVerify, verifyPageArtifacts, checksFromErrors } = require('../verify/artifacts');
const { verifyLive } = require('../verify/live');
const { writeReport, exitCodeForReports } = require('../verify/report');
const releases = require('../publication/release-store');

const KNOWN_FLAGS = new Set(['projectRoot', 'live', 'artifacts', 'all', 'json', 'help']);

const HELP = `
manual verify —— 检查已发布的手册

用法:
  manual verify <目标> [--artifacts | --live] [--json]
  manual verify --all [--artifacts | --live] [--json]
      目标：task:<id> / page:<id> / manual:<manualId> / 无前缀 id（先按任务、再按页面解析）

范围:
  --artifacts   （默认）离线产物验证：正式文档与发布记录一致、图片存在且 hash 相符、隐私与发布门槛通过、
                结构化事实与证据一致。不访问浏览器——通过只说明"文档与发布时的证据一致"，不代表当前网页行为未变。
  --live        在线验证：每次都真实打开页面，按手册的章节回放页面身份、任务步骤与完成声明的断言；
                不从旧截图或缓存返回结果。写 / 破坏性步骤不执行，对应声明报告为 not_run，并给出验证覆盖与停止边界。
                失败分类：page-not-found / ui-changed / state-changed / role-mismatch / redirected /
                verification-inconclusive（网络、超时——不能证明产品回归）。
                页面手册还会与发布时的采集比较：语义摘要（标题 / 按钮 / 链接等可访问名称）不同 → content-changed（drift）；
                只有像素不同 → visual-only（报告差异比例与差异图，不否定已验证行为）；浏览器 / 视口 / DPR 等规格不同 →
                environment-incompatible（不比较）。动态区域用 config 的 verify.visual.dynamicRegions 声明，只用于比较。

输出:
  每次验证写入新的不可变报告 .manual/verifications/<id>.json（基线发布、观察时间、输入 revision、逐条检查与结果）。

退出码: 0 通过（含 visual-only）；4 与手册不一致（failed / drift）；3 需要登录 / 身份不符；1 无法下结论（inconclusive）或其它失败；2 参数错误。
`.trim();

function resolveTargets(root, config, raw, all) {
  const state = path.join(root, config.artifacts.stateDir);
  if (all) {
    return publishedManualIds(state).map((manualId) => {
      const match = /^(page|task)-(.+)$/.exec(manualId);
      return match ? { type: match[1], id: match[2] } : null;
    }).filter(Boolean);
  }
  const text = String(raw);
  const prefixed = /^(page|task):(.+)$/.exec(text);
  if (prefixed) return [{ type: prefixed[1], id: prefixed[2] }];
  const manual = /^manual:(page|task)-(.+)$/.exec(text);
  if (manual) return [{ type: manual[1], id: manual[2] }];
  // 无前缀：兼容旧用法（任务 id），其次页面
  if (releases.readCurrentRelease(state, `task-${text}`) || fs.existsSync(path.join(state, 'tasks', `${text}.yaml`))) return [{ type: 'task', id: text }];
  if (releases.readCurrentRelease(state, `page-${text}`)) return [{ type: 'page', id: text }];
  return [{ type: 'task', id: text }];
}

/** 离线产物验证单个目标；任务沿用旧的状态投影提交。 */
function artifactsFor(root, config, target) {
  const startedAt = new Date().toISOString();
  const state = path.join(root, config.artifacts.stateDir);
  const manualId = releases.manualIdFor(target.type, target.id);
  let errors = [];
  let extra = {};
  if (target.type === 'page') {
    const result = verifyPageArtifacts({ root, config, pageId: target.id });
    if (!result.ok) errors = result.errors;
    else extra = { manual: result.manual, images: result.images, annotationCoverage: require('../verify/artifacts').annotationCoverageForImages(root, config, result.release.facts?.images || []) };
  } else {
    const input = loadVerify(root, config, target.id);
    if (!input.ok) errors = input.errors;
    else {
      const prepared = prepareVerify({ root, config, ...input });
      if (!prepared.ok) errors = prepared.errors;
      else {
        try {
          input.projectStore.commit({ base: input.base, kind: 'observation', changes: { tasks: [prepared.nextTask] } });
        } catch (error) {
          errors = [`${error.code || 'write-failed'}: 验证通过，但任务状态写入失败。${error.message}`];
        }
        extra = { manual: input.manual, images: (input.facts.images || []).map((image) => image.artifactPath), annotationCoverage: require('../verify/artifacts').annotationCoverageForImages(root, config, input.facts.images || []) };
      }
    }
  }
  const release = releases.readCurrentRelease(state, manualId);
  const checks = checksFromErrors(errors);
  const report = {
    kind: 'artifacts', manualId, releaseId: release?.id || null, target: `${target.type}:${target.id}`,
    startedAt, finishedAt: new Date().toISOString(), onlineChecked: false,
    checks, result: errors.length ? 'failed' : 'passed', annotationCoverage: extra.annotationCoverage || null,
  };
  let written = null;
  if (release) written = writeReport(state, report);
  return { report: written?.report || report, file: written?.file || null, errors, extra };
}

async function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['live', 'artifacts', 'all'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  const fail = (e) => {
    const a = Array.isArray(e) ? e : [e];
    if (json) process.stdout.write(JSON.stringify({ ok: false, errors: a }, null, 2) + '\n');
    else a.forEach((x) => process.stderr.write(`[manual verify] ${x}\n`));
    return exitCodeFor(a);
  };
  if (unknownFlags.length) return usageExit(fail(`未知参数: ${unknownFlags.join(', ')}`));
  if (values.live && values.artifacts) return usageExit(fail('--live 与 --artifacts 只能选一个。'));
  if (values.all ? positional.length !== 0 : positional.length !== 1) return usageExit(fail('需要一个目标（task:<id> / page:<id>），或用 --all 验证全部已发布手册。'));
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors);
  const config = loaded.config;
  const targets = resolveTargets(root, config, positional[0], values.all === true);
  if (targets.length === 0) return fail('not-published: 还没有已发布的手册。');

  if (!values.live) {
    const results = targets.map((target) => artifactsFor(root, config, target));
    if (!values.all) {
      const [only] = results;
      if (only.errors.length) return fail(only.errors);
      if (json) process.stdout.write(JSON.stringify({ ok: true, status: 'artifact-verified', scope: 'artifacts', onlineChecked: false, businessVerified: false, verificationId: only.report.id || null, ...only.extra }, null, 2) + '\n');
      else {
        process.stdout.write(`[manual verify] ${only.report.target} 产物验证通过（离线：不代表当前网页行为未变，在线检查用 --live）。\n`);
        const unknown = (only.extra.annotationCoverage?.captures || []).filter((item) => item.status === 'unknown').length;
        if (unknown) process.stdout.write(`[manual verify] ${unknown} 张图没有标注覆盖记录（旧证据，覆盖度未知）；重新采集后可得到覆盖结果。
`);
        for (const item of only.extra.annotationCoverage?.captures || []) if (item.coverage?.pending?.length) process.stdout.write(`[manual verify] 标注待确认: ${item.coverage.pending.map((candidate) => candidate.label).join('、')}\n`);
      }
      return 0;
    }
    const body = { ok: results.every((r) => !r.errors.length), scope: 'artifacts', onlineChecked: false, reports: results.map((r) => ({ target: r.report.target, result: r.report.result, verificationId: r.report.id || null, annotationCoverage: r.report.annotationCoverage || null, errors: r.errors })) };
    if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
    else for (const r of body.reports) process.stdout.write(`[manual verify] ${r.target}: ${r.result}${r.errors.length ? `（${r.errors[0]}）` : ''}\n`);
    return body.ok ? 0 : exitCodeFor(results.flatMap((r) => r.errors));
  }

  // ---- --live：同一次验证复用一个 Browser，每个 Scenario 独立 Context
  const session = createBrowserSession();
  const reports = [];
  const errors = [];
  try {
    for (const target of targets) {
      try {
        const report = await verifyLive({ projectRoot: root, config, target, session });
        reports.push(writeReport(path.join(root, config.artifacts.stateDir), report).report);
      } catch (error) {
        errors.push(`${error.code || 'verify-failed'}: ${error.message}`);
      }
    }
  } finally {
    await session.close().catch(() => {});
  }
  const body = {
    ok: errors.length === 0 && reports.every((r) => r.result === 'passed'),
    scope: 'live',
    onlineChecked: true,
    reports: reports.map((r) => ({
      verificationId: r.id, target: r.target, releaseId: r.releaseId, result: r.result, coverage: r.coverage,
      failures: r.checks.filter((c) => c.outcome !== 'passed').map(({ id, scope, outcome, code, category, message, stepId }) => ({ id, scope, outcome, code, category, message, stepId })),
      claims: r.claims, sections: r.sections, drift: r.drift,
    })),
    errors,
  };
  if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  else {
    for (const r of body.reports) {
      process.stdout.write(`[manual verify --live] ${r.target}: ${r.result}（声明 ${r.coverage.claims.verified}/${r.coverage.claims.total} 已验证，步骤 ${r.coverage.steps.executed}/${r.coverage.steps.total} 已执行${r.coverage.stoppedAt ? `，在 ${r.coverage.stoppedAt.stepId} 前停止（${r.coverage.stoppedAt.reason}）` : ''}）\n`);
      for (const f of r.failures) process.stdout.write(`    ${f.outcome} ${f.category || ''} ${f.id}: ${f.message || ''}\n`);
      if (r.drift && r.drift.classification !== 'none') {
        process.stdout.write(`    漂移: ${r.drift.classification}`);
        if (r.drift.semantic?.status === 'changed') process.stdout.write(`（新增 ${r.drift.semantic.added.join('、') || '无'}；消失 ${r.drift.semantic.removed.join('、') || '无'}）`);
        if (r.drift.visual?.diffPath) process.stdout.write(`（像素差异 ${(r.drift.visual.ratio * 100).toFixed(2)}%，${r.drift.visual.diffPath}）`);
        process.stdout.write('\n');
      }
    }
    for (const e of errors) process.stderr.write(`[manual verify] ${e}\n`);
  }
  if (errors.length && reports.length === 0) return exitCodeFor(errors);
  const code = exitCodeForReports(reports);
  return code || (errors.length ? exitCodeFor(errors) : 0);
}

module.exports = { run, HELP, KNOWN_FLAGS, prepareVerify };
