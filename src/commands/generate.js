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
const { ANALYSIS, normalizePage, isActivePage } = require('../inspect/model');
const store = require('../inspect/store');
const { readIndexes, findForwardPage } = require('../inspect/index-store');
const { buildDraft } = require('../generate/draft');
const { extractFacts, compareFacts, formatViolations } = require('../generate/facts');
const { writeText, displayPath } = require('../util/fsx');
const { toMarkdownHref } = require('../publication/paths');
const { validateArtifact, validatePublication, formatIssues } = require('../publication/validate');
const { createCaptureStore } = require('../evidence/store');
const { verifyCaptureRecord, describeProblems } = require('../evidence/integrity');

function draftFactsPath(stateDirAbs, pageId) {
  return path.join(stateDirAbs, 'drafts', `${pageId}.facts.json`);
}

const KNOWN_FLAGS = new Set([
  'projectRoot', 'finalize', 'noScreenshot', 'fallbackDraft', 'force', 'json', 'help',
]);
const BOOLEAN_FLAGS = ['noScreenshot', 'fallbackDraft'];

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

/** 读取页面模型并做 generate 需要的前置检查。 */
function loadPage(projectRoot, config, pageId) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const existing = store.readExistingPages(stateDirAbs);

  if (existing.errors.length > 0) {
    return { ok: false, errors: ['已有的页面文件解析失败：', ...existing.errors.map((e) => `  ${e}`)] };
  }
  if (existing.pages.length === 0) {
    return { ok: false, errors: ['.manual/pages/ 里还没有页面。先运行 `manual inspect` 扫描项目。'] };
  }

  const found = existing.pages.find((p) => p.id === pageId);
  if (!found) {
    return {
      ok: false,
      errors: [`找不到页面 "${pageId}"。已有: ${existing.pages.map((p) => p.id).join(', ')}`],
    };
  }

  const page = normalizePage(found);
  const indexes = readIndexes(stateDirAbs);
  const indexContext = indexes.ok
    ? findForwardPage(indexes.forward, { id: page.id, route: page.route })
    : null;

  return { ok: true, page, stateDirAbs, indexContext };
}

// ---------------------------------------------------------------- 阶段一：草稿

/** 从已提交的 Capture 记录取页面发布图；记录缺失、无发布图或产物被改动都拒绝。 */
function publishedFromRecord({ projectRoot, stateDirAbs, captureId }) {
  let record;
  try {
    record = createCaptureStore({ projectRoot, stateDirAbs }).read(captureId);
  } catch (error) {
    return { ok: false, errors: [`${error.code || 'invalid-capture-record'}: ${error.message}`] };
  }
  if (!record) return { ok: false, errors: [`capture-record-missing: 页面引用的 Capture ${captureId} 不存在。`] };
  const artifact = (record.artifacts || []).find((a) => a.kind === 'published');
  if (!artifact) return { ok: false, errors: [`unsafe-page-artifact: Capture ${captureId} 没有通过隐私检测的发布图。`] };
  const integrity = verifyCaptureRecord(projectRoot, record, { kinds: ['published'] });
  if (!integrity.ok) return { ok: false, errors: describeProblems(integrity.problems) };
  return { ok: true, artifactPath: artifact.path, sha256: artifact.sha256, privacy: record.privacy, captureId: record.id };
}

function runDraft({ projectRoot, config, page, stateDirAbs, skillRoot, indexContext, noScreenshot, json }) {
  const errors = [];

  // 事实优先级第一条：没有真实截图就没有可信的手册
  if (!page.browser?.screenshot && !noScreenshot) {
    errors.push(
      `"${page.id}" 还没有截图，生成的手册会缺少界面。先运行 \`manual capture ${page.id}\`。`,
      '确实要出纯文字版的话，加 --no-screenshot。'
    );
  }
  if (page.status?.sourceAnalysis !== ANALYSIS.COMPLETED) {
    errors.push(
      `"${page.id}" 还没完成源码分析（当前 ${page.status?.sourceAnalysis || '未知'}），缺少标题或用途。`,
      `先用 \`manual describe --id ${page.id} --title ... --purpose ...\` 补上。`
    );
  }
  if (!isActivePage(page)) {
    errors.push(`page-not-active: "${page.id}" 当前是 ${page.lifecycle}，不能生成当前手册（历史发布仍保留）。`);
  }
  if (page.includeInManual === false) {
    errors.push(`"${page.id}" 标记为 includeInManual: false，不在手册范围内。`);
  }
  if (errors.length > 0) return fail(errors, { json });

  const finalPath = path.join(projectRoot, config.docs.outputDir, `${page.id}.md`);

  // 手册只能引用经过发布门槛的页面发布图（page.browser.published）；原图不能直接进文档。
  let image = null;
  if (!noScreenshot) {
    const published = page.browser?.published;
    if (!published) {
      return fail(
        [
          `unsafe-page-artifact: "${page.id}" 只有未经隐私处理的原始截图（${page.browser.screenshot}），不能进入手册。`,
          '当前版本尚未为页面截图生成经隐私检测的发布图；需要文字版手册可以加 --no-screenshot。',
        ],
        { json }
      );
    }
    // 有 Capture 记录时以记录为准（页面 browser 块只是投影）；旧项目没有记录时沿用投影并由发布门槛核对 hash。
    const source = page.browser?.latestCaptureId
      ? publishedFromRecord({ projectRoot, stateDirAbs, captureId: page.browser.latestCaptureId })
      : { ok: true, artifactPath: published.artifactPath, sha256: published.sha256 || null, privacy: published.privacy || null, captureId: null };
    if (!source.ok) return fail([...source.errors, `重新截一张: \`manual capture ${page.id}\``], { json });
    const artifactFile = path.resolve(projectRoot, source.artifactPath);
    // 截图记录在模型里但文件被删了——这属于事实缺失，必须说出来而不是生成一个坏链接
    if (!fs.existsSync(artifactFile)) {
      return fail([`页面模型记录的截图不存在: ${source.artifactPath}`, `重新截一张: \`manual capture ${page.id}\``], { json });
    }
    image = {
      artifactPath: source.artifactPath,
      markdownHref: toMarkdownHref({ manualFile: finalPath, artifactFile }),
      sha256: source.sha256,
      privacy: source.privacy,
      ...(source.captureId ? { captureId: source.captureId } : {}),
    };
    const issues = validateArtifact(image, { projectRoot, config });
    if (issues.length > 0) return fail(formatIssues(issues), { json });
  }

  const { markdown, facts } = buildDraft(page, {
    docsOutputDir: config.docs.outputDir,
    pageFilePath: `.manual/pages/${page.id}.yaml`,
    includeScreenshot: !noScreenshot,
    indexContext,
    image,
  });

  const draftPath = path.join(stateDirAbs, 'drafts', `${page.id}.md`);
  writeText(draftPath, markdown);
  // 发布事实与草稿一起落盘：finalize 用它核对图片 hash 与隐私记录，而不是信任润色稿。
  writeText(draftFactsPath(stateDirAbs, page.id), JSON.stringify({ pageId: page.id, images: image ? [image] : [] }, null, 2) + '\n');

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

function runFinalize({ projectRoot, config, page, stateDirAbs, finalizeInput, fallbackDraft, force, json }) {
  const draftPath = path.join(stateDirAbs, 'drafts', `${page.id}.md`);
  if (!fs.existsSync(draftPath)) {
    return fail(
      [`找不到事实草稿: ${displayPath(draftPath, projectRoot)}`, `先运行 \`manual generate ${page.id}\`。`],
      { json }
    );
  }

  let polished;
  if (finalizeInput === '-') {
    try {
      polished = fs.readFileSync(0, 'utf8');
    } catch (e) {
      return fail([`从 stdin 读取失败: ${e.message}`], { json });
    }
  } else {
    // 相对当前工作目录解析，和 `describe --input` 保持一致。
    // 按 projectRoot 解析会让「从别处指定 --project-root」的用法很意外。
    const inputAbs = path.resolve(finalizeInput);
    if (!fs.existsSync(inputAbs)) return fail([`--finalize 文件不存在: ${inputAbs}`], { json });
    polished = fs.readFileSync(inputAbs, 'utf8');
  }

  if (!polished.trim()) return fail(['润色后的内容是空的。'], { json });

  const draftMarkdown = fs.readFileSync(draftPath, 'utf8');
  const result = compareFacts(extractFacts(draftMarkdown), extractFacts(polished));

  const finalPath = path.join(projectRoot, config.docs.outputDir, `${page.id}.md`);
  if (fs.existsSync(finalPath) && !force) {
    return fail(
      [`正式文档已存在: ${displayPath(finalPath, projectRoot)}`, '加 --force 覆盖。'],
      { json }
    );
  }

  // 事实校验没过：默认拒绝落盘，让润色重来。
  // --fallback-draft 则按「事实优先」兜底——宁可文字生硬，也不能让手册说假话。
  if (!result.ok && !fallbackDraft) {
    if (json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: false,
            stage: 'finalize',
            pageId: page.id,
            reason: 'fact-mismatch',
            violations: result.violations,
            draftPath,
            hint: '润色只能改句式与语序。按 violations 修正后重新 --finalize，或加 --fallback-draft 用草稿原文定稿。',
          },
          null,
          2
        ) + '\n'
      );
    } else {
      process.stderr.write('\n[manual generate] 事实校验未通过，没有输出正式文档：\n\n');
      process.stderr.write(formatViolations(result.violations) + '\n');
      process.stderr.write('\n  润色阶段只能改句式、语序、冗余表达、翻译腔、AI 套话。\n');
      process.stderr.write('  按上面各条修正后重新 --finalize；\n');
      process.stderr.write('  或者加 --fallback-draft，用事实草稿原文定稿（保事实、丢润色）。\n\n');
    }
    return 1;
  }

  const content = result.ok ? polished : draftMarkdown;
  const body = content.replace(/\s*$/, '') + '\n';

  // 统一发布门槛（含 --fallback-draft）：图片引用、hash、产物位置与隐私记录都以草稿 facts 为准。
  const factsFile = draftFactsPath(stateDirAbs, page.id);
  if (!fs.existsSync(factsFile)) {
    return fail([`缺少草稿事实文件: ${displayPath(factsFile, projectRoot)}`, `重新运行 \`manual generate ${page.id}\`。`], { json });
  }
  const draftImages = JSON.parse(fs.readFileSync(factsFile, 'utf8')).images || [];
  const gate = validatePublication({ projectRoot, manualFile: finalPath, markdown: body, images: draftImages, config });
  if (!gate.ok) return fail(formatIssues(gate.errors), { json });
  // 所有检查都已在写入前完成；原子替换失败（如文件被占用）时旧文档保持不变。
  try {
    writeText(finalPath, body);
  } catch (error) {
    return fail([`${error.code || 'write-failed'}: 正式文档未改变。${error.message}`], { json });
  }

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          stage: 'finalize',
          pageId: page.id,
          finalPath,
          draftPath,
          factCheck: result.ok ? 'passed' : 'failed-used-draft',
          violations: result.violations,
          bytes: Buffer.byteLength(body, 'utf8'),
        },
        null,
        2
      ) + '\n'
    );
  } else {
    const L = [''];
    if (result.ok) {
      L.push('[manual generate] 事实校验通过，已输出正式文档。');
    } else {
      L.push('[manual generate] 事实校验未通过，已按 --fallback-draft 用草稿原文定稿。');
      L.push('');
      L.push(formatViolations(result.violations));
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

  const pageResult = loadPage(projectRoot, config, pageId);
  if (!pageResult.ok) return fail(pageResult.errors, { json });
  const { page, stateDirAbs, indexContext } = pageResult;

  const skillRoot = path.resolve(__dirname, '..', '..');

  const finalizeInput = values.finalize;
  if (finalizeInput !== undefined && finalizeInput !== '') {
    return runFinalize({
      projectRoot, config, page, stateDirAbs, finalizeInput,
      fallbackDraft: values.fallbackDraft === true,
      force: values.force === true,
      json,
    });
  }
  if (finalizeInput === '') {
    return fail(['--finalize 需要一个文件路径（或 - 表示从 stdin 读）。'], { json });
  }

  return runDraft({
    projectRoot, config, page, stateDirAbs, skillRoot, indexContext,
    noScreenshot: values.noScreenshot === true,
    json,
  });
}

module.exports = { run, HELP, KNOWN_FLAGS, STYLE_GUIDE_RELATIVE };
