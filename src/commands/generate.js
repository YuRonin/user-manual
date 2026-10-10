'use strict';

/*
 * `manual generate <page>` —— 生成页面的 Markdown 使用手册。
 *
 * 两段式，和 inspect/describe 是同一套分工：
 *
 *   阶段一（程序）  读页面模型 + 真实 capture 数据 → 事实草稿 .manual/drafts/<id>.md
 *   阶段二（AI）    按 references/manual-writing-style.md 把草稿改成自然中文
 *   阶段三（程序）  事实一致性校验 → 通过才写 docs/manual/<id>.md
 *
 * 为什么要留中间草稿：出问题时能一眼判断是事实生成阶段错了，还是中文润色阶段错了。
 * 为什么校验要用程序做：AI 润色时最容易「顺手把事实改通顺」，靠提示词自觉挡不住。
 */

const fs = require('fs');
const path = require('path');

const { parseArgs } = require('../cli/args');
const { exitCodeFor, exitCodeForCode, usageExit } = require('../cli/output');
const { loadConfig } = require('../config/load');
const { extractFacts, formatViolations } = require('../generate/facts');
const { displayPath } = require('../util/fsx');
const { draftPage, preparePageFinal, publishPageFinal } = require('../generate/page-usecase');
const { copyPolicy, planTargets, startRun } = require('../runtime/app');
const { printRun, printRuntimeError } = require('../cli/run-report');

const KNOWN_FLAGS = new Set([
  'projectRoot', 'finalize', 'copy', 'copyDefault', 'acceptReview', 'noScreenshot', 'fallbackDraft', 'force', 'json', 'help',
  'draft', 'plan', 'offline', 'refresh', 'noCache',
]);
const BOOLEAN_FLAGS = ['noScreenshot', 'fallbackDraft', 'acceptReview', 'copyDefault', 'draft', 'plan', 'offline', 'refresh', 'noCache'];

/** 风格规范相对 Skill 根目录的位置。AI 在润色前要读它。 */
const STYLE_GUIDE_RELATIVE = 'references/manual-writing-style.md';

const HELP = `
manual generate —— 生成页面的 Markdown 使用手册

用法:
  manual generate <目标> [更多目标...] [--copy <文案.json> | --copy-default] [--plan] [--offline | --refresh | --no-cache] [--json]
      默认：规划并执行 Runtime —— 按需采集（可复用有效缓存）→ 事实草稿 → 文案 → 发布门槛 → 发布。
      目标：task:<id> / page:<id> / manual:<manualId> / 无前缀的唯一 id。
      需要登录、审批或模型文案时停在 waiting_input（退出码 3），处理后 manual resume <runId>。
  manual generate <page-id> --draft             兼容：阶段一，只出事实草稿
  manual generate <page-id> --finalize <文件>   兼容：阶段三，校验润色稿并定稿

Runtime 选项:
  --plan                  只打印计划（动作、风险边界、需要浏览器的场景数、缓存命中原因），不执行、不创建 Run
  --copy <文案.json>      文案块 { "intro": "..." }；正文由事实包渲染
  --copy-default          不改写文案，使用事实包默认文案（确定性路径，不等待模型）
  --offline               只用历史证据生成，结果标 onlineChecked=false；没有证据时失败，不打开浏览器
  --refresh               不复用已有采集与生成结果（认证快照仍复用），重新采集
  --no-cache              不读也不写缓存索引（不删除历史证据）
  --accept-review         确认新出现的数字 / 单位、业务承诺属实后继续
  --force                 覆盖有人工修改的正式文档

兼容流程（页面三段式）:
  1. manual generate chat --draft
       读页面模型与真实截图数据 → 写 .manual/drafts/chat.md
  2. 按 ${STYLE_GUIDE_RELATIVE} 把草稿改写成自然中文
  3. manual generate chat --finalize <润色后的文件>
       逐项比对事实 → 通过才写 docs/manual/chat.md

事实优先级:
  真实 Browser Capture > Inspect 项目模型 > （不允许有第三档）
  润色阶段只能改句式、语序、冗余表达、翻译腔、AI 套话；
  不能改事实、UI 名称、操作顺序、页面行为、截图引用。

兼容选项:
  --draft                 只生成事实草稿
  --finalize <文件>       润色后的 Markdown，传 - 从 stdin 读
  --no-screenshot         这个页面还没截图时，允许生成纯文字草稿（隐含 --draft）
  --fallback-draft        校验不通过时，用事实草稿原文定稿（保事实、丢润色）

通用选项:
  --project-root <路径>   项目根目录，默认当前工作目录
  --json                  以 JSON 输出结果
  --help                  显示本帮助

示例:
  manual generate task:edit-profile
  manual generate page:chat --copy chat-copy.json
  manual generate chat --plan --json
  manual generate chat --draft
`.trim();

function fail(errors, { json }) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  } else {
    process.stderr.write('\n[manual generate] 未完成：\n');
    for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write('\n用 `manual generate --help` 查看用法。\n');
  }
  return exitCodeFor(list);
}

// ---------------------------------------------------------------- 阶段一：草稿

function runDraft({ projectRoot, config, pageId, skillRoot, noScreenshot, json }) {
  let built;
  try {
    built = draftPage({ projectRoot, config, pageId, noScreenshot });
  } catch (error) {
    fail(error.errors || [error.message], { json });
    return exitCodeForCode(error.code);
  }
  const { page, draftPath, finalPath, markdown, facts, image, indexContext } = built;
  const draftFacts = extractFacts(markdown);
  const styleGuidePath = path.join(skillRoot, STYLE_GUIDE_RELATIVE);

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          stage: 'draft',
          pageId: page.id,
          draftPath,
          styleGuidePath,
          finalPath,
          language: config.docs.language,
          facts,
          indexContext,
          // 这些是润色阶段一个字都不能动的东西
          protected: {
            images: draftFacts.images.map((i) => i.src),
            uiTerms: [...new Set(draftFacts.uiTerms)],
            codeSpans: [...new Set(draftFacts.codeSpans)],
            numbers: [...new Set(draftFacts.numbers)],
            steps: draftFacts.steps,
            title: facts.title,
          },
          nextCommand: `manual generate ${page.id} --finalize <润色后的文件>`,
        },
        null,
        2
      ) + '\n'
    );
  } else {
    const L = [''];
    L.push('[manual generate] 事实草稿已生成。');
    L.push('');
    L.push(`  页面        ${page.id}  ${page.title}`);
    L.push(`  草稿        ${displayPath(draftPath, projectRoot)}`);
    L.push(`  截图        ${image ? image.artifactPath : '（无）'}`);
    L.push(`  操作步骤    ${facts.actionCount} 条`);
    L.push('');
    L.push('  下一步：');
    L.push(`    1. 读 ${STYLE_GUIDE_RELATIVE}`);
    L.push('    2. 把草稿改写成自然中文——只改句式语序，不改事实与 UI 名称');
    L.push(`    3. manual generate ${page.id} --finalize <润色后的文件>`);
    L.push('');
    if (draftFacts.uiTerms.length > 0) {
      L.push(`  受保护的 UI 原文: ${[...new Set(draftFacts.uiTerms)].map((t) => `「${t}」`).join(' ')}`);
      L.push('');
    }
    process.stdout.write(L.join('\n') + '\n');
  }

  return 0;
}

// ---------------------------------------------------------------- 阶段三：定稿

function runFinalize({ projectRoot, config, pageId, finalizeInput, acceptReview, fallbackDraft, force, json }) {
  const copy = null;
  let markdown = null;
  if (finalizeInput === '-') {
    try {
      markdown = fs.readFileSync(0, 'utf8');
    } catch (e) {
      return fail([`从 stdin 读取失败: ${e.message}`], { json });
    }
  } else {
    // 相对当前工作目录解析，和 `describe --input` 保持一致。
    // 按 projectRoot 解析会让「从别处指定 --project-root」的用法很意外。
    const inputAbs = path.resolve(finalizeInput);
    if (!fs.existsSync(inputAbs)) return fail([`--finalize 文件不存在: ${inputAbs}`], { json });
    markdown = fs.readFileSync(inputAbs, 'utf8');
  }

  let prepared;
  let published;
  try {
    prepared = preparePageFinal({ projectRoot, config, pageId, copy, markdown, acceptReview, fallbackDraft, force });
    published = publishPageFinal({ projectRoot, config, prepared, force });
  } catch (error) {
    if (error.code !== 'fact-mismatch') {
      fail(error.errors || [error.message], { json });
      return exitCodeForCode(error.code);
    }
    // 事实校验没过：默认拒绝落盘，让润色重来。
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            stage: 'finalize',
            pageId: error.pageId,
            reason: 'fact-mismatch',
            violations: error.violations,
            draftPath: error.draftPath,
            hint: '润色只能改句式与语序。按 violations 修正后重新 --finalize，或加 --fallback-draft 用草稿原文定稿。',
          },
          null,
          2
        ) + '\n'
      );
    } else {
      process.stderr.write('\n[manual generate] 事实校验未通过，没有输出正式文档：\n\n');
      process.stderr.write(formatViolations(error.violations) + '\n');
      process.stderr.write('\n  润色阶段只能改句式、语序、冗余表达、翻译腔、AI 套话。\n');
      process.stderr.write('  按上面各条修正后重新 --finalize；\n');
      process.stderr.write('  或者加 --fallback-draft，用事实草稿原文定稿（保事实、丢润色）。\n\n');
    }
    return 1;
  }

  const { page, body, finalPath, draftPath, factCheck, violations } = prepared;
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          stage: 'finalize',
          pageId: page.id,
          finalPath,
          draftPath,
          factCheck,
          releaseId: published.release.id,
          violations,
          bytes: Buffer.byteLength(body, 'utf8'),
        },
        null,
        2
      ) + '\n'
    );
  } else {
    const L = [''];
    if (factCheck === 'passed') {
      L.push('[manual generate] 事实校验通过，已输出正式文档。');
    } else {
      L.push('[manual generate] 事实校验未通过，已按 --fallback-draft 用草稿原文定稿。');
      L.push('');
      L.push(formatViolations(violations));
    }
    L.push('');
    L.push(`  页面        ${page.id}  ${page.title}`);
    L.push(`  正式文档    ${displayPath(finalPath, projectRoot)}`);
    L.push(`  事实草稿    ${displayPath(draftPath, projectRoot)}（保留，便于回溯）`);
    L.push('');
    process.stdout.write(L.join('\n') + '\n');
  }

  return 0;
}

// ---------------------------------------------------------------- Runtime（默认）

async function runRuntime({ projectRoot, values, targets, json }) {
  const flags = { offline: values.offline === true, refresh: values.refresh === true, noCache: values.noCache === true };
  try {
    const copy = copyPolicy({ copy: typeof values.copy === 'string' ? values.copy : null, copyDefault: values.copyDefault === true });
    // 源码新鲜度：刚改过源码直接 generate 时，缓存 key 必须反映新指纹（B1-06）
    const options = { projectRoot, command: 'generate', targets, flags, copy, acceptReview: values.acceptReview === true, force: values.force === true, freshSource: true };
    if (values.plan) return printPlan({ json, planned: planTargets(options) });
    return printRun({ json, result: await startRun(options), label: 'generate', projectRoot });
  } catch (error) {
    return printRuntimeError({ json, error, label: 'generate' });
  }
}

/** --plan：只读计划；规划错误（离线无证据、能力不足、审批被拒）照样报告但不执行。 */
function printPlan({ json, planned }) {
  const { plan, planHash, errors } = planned;
  const body = {
    ok: errors.length === 0,
    dryRun: true,
    planHash,
    targets: plan.targets,
    tasks: plan.tasks.map((t) => ({ id: t.id, kind: t.kind, dependsOn: t.dependsOn, reason: t.reason, reuse: t.reuse })),
    summary: plan.summary,
    errors,
  };
  if (json) process.stdout.write(JSON.stringify(body, null, 2) + '\n');
  else {
    const L = ['', `[manual generate] 计划 ${planHash.slice(7, 19)}（未执行）`];
    for (const t of plan.tasks) L.push(`  ${t.id.padEnd(14)} ${t.kind.padEnd(12)} ${t.reason}${t.dependsOn.length ? `  ← ${t.dependsOn.join(', ')}` : ''}`);
    L.push(`  需要浏览器的场景: ${plan.summary.browserScenarios}`);
    for (const b of plan.summary.riskBoundaries) L.push(`  风险边界: ${b.subject} 在步骤 ${b.stepId} 前停止（${b.execution}）`);
    for (const w of plan.summary.waitingFor) L.push(`  可能等待: ${w.message}`);
    for (const warning of plan.summary.warnings || []) L.push(`  提示: ${warning}`);
    for (const e of errors) L.push(`  ✗ ${e}`);
    L.push('');
    process.stdout.write(L.join('\n') + '\n');
  }
  return errors.length ? exitCodeFor(errors) : 0;
}

// ---------------------------------------------------------------- 入口

function run(argv) {
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

  const legacy = values.draft === true || values.noScreenshot === true || values.fallbackDraft === true || values.finalize !== undefined;
  if (!positional[0]) {
    return usageExit(fail(['需要指定目标，例如 `manual generate task:edit-profile` 或 `manual generate chat --draft`。'], { json }));
  }
  if (legacy && positional.length > 1) return usageExit(fail(['兼容分阶段命令一次只能处理一个页面；直接运行 `manual generate <目标> [更多目标...]` 可批量生成。'], { json }));
  if (values.copy && positional.length > 1) return usageExit(fail(['批量生成请用 --copy-default 或默认模型文案流程；--copy 文件只适用于单个目标。'], { json }));

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }
  if (!legacy) return runRuntime({ projectRoot, values, targets: positional, json });

  const pageId = positional[0].replace(/^page:/, '');
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  const skillRoot = path.resolve(__dirname, '..', '..');

  const finalizeInput = values.finalize;
  if (values.copy) return usageExit(fail(['兼容阶段不接受 --copy：直接运行 `manual generate <目标> --copy <文件>`。'], { json }));
  if (finalizeInput !== undefined && finalizeInput !== '' && finalizeInput !== true) {
    return runFinalize({
      projectRoot, config, pageId, finalizeInput,
      acceptReview: values.acceptReview === true,
      fallbackDraft: values.fallbackDraft === true,
      force: values.force === true,
      json,
    });
  }
  if (finalizeInput !== undefined) {
    return usageExit(fail(['--finalize 需要一个文件路径（或 - 表示从 stdin 读）。'], { json }));
  }

  return runDraft({
    projectRoot, config, pageId, skillRoot,
    noScreenshot: values.noScreenshot === true,
    json,
  });
}

module.exports = { run, HELP, KNOWN_FLAGS, STYLE_GUIDE_RELATIVE };
