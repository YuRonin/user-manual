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
const { loadConfig } = require('../config/load');
const { extractFacts, formatViolations } = require('../generate/facts');
const { displayPath } = require('../util/fsx');
const { draftPage, preparePageFinal, publishPageFinal } = require('../generate/page-usecase');

const KNOWN_FLAGS = new Set([
  'projectRoot', 'finalize', 'copy', 'acceptReview', 'noScreenshot', 'fallbackDraft', 'force', 'json', 'help',
]);
const BOOLEAN_FLAGS = ['noScreenshot', 'fallbackDraft', 'acceptReview'];

/** 风格规范相对 Skill 根目录的位置。AI 在润色前要读它。 */
const STYLE_GUIDE_RELATIVE = 'references/manual-writing-style.md';

const HELP = `
manual generate —— 生成页面的 Markdown 使用手册

用法:
  manual generate <page-id>                     阶段一：出事实草稿
  manual generate <page-id> --finalize <文件>   阶段三：校验并定稿

流程:
  1. manual generate chat
       读页面模型与真实截图数据 → 写 .manual/drafts/chat.md
  2. 按 ${STYLE_GUIDE_RELATIVE} 把草稿改写成自然中文
  3. manual generate chat --finalize <润色后的文件>
       逐项比对事实 → 通过才写 docs/manual/chat.md

  校验不通过时不会输出正式文档，并逐条列出哪里改动了事实。

事实优先级:
  真实 Browser Capture > Inspect 项目模型 > （不允许有第三档）
  润色阶段只能改句式、语序、冗余表达、翻译腔、AI 套话；
  不能改事实、UI 名称、操作顺序、页面行为、截图引用。

选项:
  --project-root <路径>   项目根目录，默认当前工作目录
  --copy <文案.json>      推荐的定稿方式：只提供文案块 { "intro": "..." }，正文由事实包渲染
  --accept-review         确认新出现的数字 / 单位、业务承诺属实后继续定稿
  --finalize <文件>       润色后的 Markdown，传 - 从 stdin 读
  --no-screenshot         这个页面还没截图时，允许生成纯文字草稿
  --fallback-draft        校验不通过时，用事实草稿原文定稿（保事实、丢润色）
  --force                 覆盖已存在的正式文档
  --json                  以 JSON 输出结果
  --help                  显示本帮助

示例:
  manual generate chat
  manual generate chat --finalize .manual/drafts/chat.polished.md
  manual generate chat --finalize - < polished.md
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
  return 1;
}

// ---------------------------------------------------------------- 阶段一：草稿

function runDraft({ projectRoot, config, pageId, skillRoot, noScreenshot, json }) {
  let built;
  try {
    built = draftPage({ projectRoot, config, pageId, noScreenshot });
  } catch (error) {
    return fail(error.errors || [error.message], { json });
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

function runFinalize({ projectRoot, config, pageId, finalizeInput, copyInput, acceptReview, fallbackDraft, force, json }) {
  let copy = null;
  let markdown = null;
  if (copyInput) {
    try { copy = JSON.parse(fs.readFileSync(path.resolve(copyInput), 'utf8')); } catch (error) { return fail([`--copy 读取失败: ${error.message}`], { json }); }
  } else if (finalizeInput === '-') {
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
    if (error.code !== 'fact-mismatch') return fail(error.errors || [error.message], { json });
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
  if (unknownFlags.length > 0) return fail([`未知参数: ${unknownFlags.join(', ')}`], { json });

  const pageId = positional[0];
  if (!pageId) {
    return fail(['需要指定页面 id，例如 `manual generate chat`。'], { json });
  }
  if (positional.length > 1) {
    return fail([`一次只能生成一个页面，收到: ${positional.join(', ')}`], { json });
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  const skillRoot = path.resolve(__dirname, '..', '..');

  const finalizeInput = values.finalize;
  if (values.copy && finalizeInput) return fail(['--finalize 与 --copy 只能选一个。'], { json });
  if (values.copy || (finalizeInput !== undefined && finalizeInput !== '')) {
    return runFinalize({
      projectRoot, config, pageId, finalizeInput,
      copyInput: values.copy || null,
      acceptReview: values.acceptReview === true,
      fallbackDraft: values.fallbackDraft === true,
      force: values.force === true,
      json,
    });
  }
  if (finalizeInput === '') {
    return fail(['--finalize 需要一个文件路径（或 - 表示从 stdin 读）。'], { json });
  }

  return runDraft({
    projectRoot, config, pageId, skillRoot,
    noScreenshot: values.noScreenshot === true,
    json,
  });
}

module.exports = { run, HELP, KNOWN_FLAGS, STYLE_GUIDE_RELATIVE };
