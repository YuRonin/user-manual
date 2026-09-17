'use strict';

/*
 * `manual describe` —— 把源码分析结果写回页面模型。
 *
 * 为什么单独一条命令：title / purpose / detectedActions 需要读源码理解语义，这是 AI 的活；
 * 但 YAML 的写入格式、字段校验、索引重建应当只有一处实现。所以 AI 产出 JSON，
 * 由本命令校验并落盘，AI 不手工拼 YAML（中文 + 引号转义极易出错）。
 *
 * 写入后该页 confidence 变成 inferred（源码推断）。真实浏览器验证过之后，
 * 由后续版本的 capture/verify 改成 verified。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { CONFIDENCE, ANALYSIS, isBrowserVerified } = require('../inspect/model');
const store = require('../inspect/store');
const { displayPath } = require('../util/fsx');

const KNOWN_FLAGS = new Set(['projectRoot', 'input', 'id', 'title', 'purpose', 'actions', 'source', 'includeInManual', 'json', 'help']);

const HELP = `
manual describe —— 把页面的源码分析结果写回页面模型

用法:
  manual describe --input <分析结果.json>          批量写回（推荐）
  manual describe --id <页面id> --title ... ...    单页写回

做什么:
  校验分析结果 → 写进 .manual/pages/<id>.yaml → 重建 .manual/project.yaml 索引。
  写入后该页 status.sourceAnalysis = completed，confidence = inferred。

--input 的 JSON 结构:
  {
    "pages": [
      {
        "id": "membership",
        "title": "会员计划",
        "purpose": "查看和购买会员套餐。",
        "detectedActions": ["查看套餐", "购买 Pro", "购买 Max"],
        "source": ["app/membership/page.tsx", "components/membership/**"],
        "includeInManual": true
      }
    ]
  }

  id 必填且必须已存在于 .manual/pages/。
  title / purpose / detectedActions / source / includeInManual 都可选，
  只写给出的字段，没给的保持原样。

选项:
  --project-root <路径>       项目根目录，默认当前工作目录
  --input <文件>              分析结果 JSON；传 - 从 stdin 读
  --id <页面id>               单页模式的页面 id
  --title <标题>              单页模式
  --purpose <一句话用途>       单页模式
  --actions <a;b;c>           单页模式，用分号分隔
  --source <a;b>              单页模式，用分号分隔，覆盖 source
  --include-in-manual <bool>  单页模式，true/false
  --json                      以 JSON 输出结果
  --help                      显示本帮助

示例:
  manual describe --input .manual/describe.json
  manual describe --id profile --title 用户中心 --purpose "查看和管理个人资料。" --actions "编辑资料;修改头像"
`.trim();

function fail(errors, { json }) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  } else {
    process.stderr.write('\n[manual describe] 未写入：\n');
    for (const e of list) process.stderr.write(`  ✗ ${e}\n`);
    process.stderr.write('\n用 `manual describe --help` 查看用法。\n');
  }
  return 1;
}

function splitList(raw) {
  return String(raw)
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 从 flags 拼出单页模式的输入。 */
function fromFlags(values) {
  const entry = { id: values.id };
  if (values.title !== undefined) entry.title = values.title;
  if (values.purpose !== undefined) entry.purpose = values.purpose;
  if (values.actions !== undefined) entry.detectedActions = splitList(values.actions);
  if (values.source !== undefined) entry.source = splitList(values.source);
  if (values.includeInManual !== undefined) {
    entry.includeInManual = String(values.includeInManual).toLowerCase() !== 'false';
  }
  return { pages: [entry] };
}

function readInput(inputPath, errors) {
  let raw;
  if (inputPath === '-') {
    try {
      raw = fs.readFileSync(0, 'utf8');
    } catch (e) {
      errors.push(`从 stdin 读取失败: ${e.message}`);
      return null;
    }
  } else {
    const full = path.resolve(inputPath);
    if (!fs.existsSync(full)) {
      errors.push(`--input 文件不存在: ${full}`);
      return null;
    }
    raw = fs.readFileSync(full, 'utf8');
  }

  try {
    return JSON.parse(raw);
  } catch (e) {
    errors.push(`--input 不是合法 JSON: ${e.message}`);
    return null;
  }
}

/** 校验一条页面分析。errors 累积，返回归一化后的补丁或 null。 */
function validateEntry(entry, index, knownIds, errors) {
  const where = `pages[${index}]`;

  if (!entry || typeof entry !== 'object') {
    errors.push(`${where} 不是对象。`);
    return null;
  }
  if (!entry.id || typeof entry.id !== 'string') {
    errors.push(`${where} 缺少 id。`);
    return null;
  }
  if (!knownIds.has(entry.id)) {
    errors.push(
      `${where} 的 id "${entry.id}" 在 .manual/pages/ 里不存在。` +
      `已有: ${[...knownIds].join(', ') || '(空，先跑 manual inspect)'}`
    );
    return null;
  }

  const patch = { id: entry.id };
  let touched = false;

  if (entry.title !== undefined) {
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      errors.push(`${where}.title 需要是非空字符串。`);
    } else {
      patch.title = entry.title.trim();
      touched = true;
    }
  }

  if (entry.purpose !== undefined) {
    if (typeof entry.purpose !== 'string' || entry.purpose.trim() === '') {
      errors.push(`${where}.purpose 需要是非空字符串。`);
    } else {
      patch.purpose = entry.purpose.trim();
      touched = true;
    }
  }

  if (entry.detectedActions !== undefined) {
    if (!Array.isArray(entry.detectedActions) || entry.detectedActions.some((a) => typeof a !== 'string')) {
      errors.push(`${where}.detectedActions 需要是字符串数组。`);
    } else {
      patch.detectedActions = entry.detectedActions.map((a) => a.trim()).filter(Boolean);
      touched = true;
    }
  }

  if (entry.source !== undefined) {
    if (!Array.isArray(entry.source) || entry.source.some((s) => typeof s !== 'string')) {
      errors.push(`${where}.source 需要是字符串数组。`);
    } else {
      patch.source = entry.source.map((s) => s.trim()).filter(Boolean);
      touched = true;
    }
  }

  if (entry.includeInManual !== undefined) {
    if (typeof entry.includeInManual !== 'boolean') {
      errors.push(`${where}.includeInManual 需要是 true 或 false。`);
    } else {
      patch.includeInManual = entry.includeInManual;
      touched = true;
    }
  }

  if (!touched) {
    errors.push(`${where} 没有给出任何可写入的字段。`);
    return null;
  }

  return patch;
}

/** 把补丁合并进页面。entry（扫描字段）永远不动。 */
function applyPatch(page, patch) {
  const next = {
    ...page,
    title: patch.title !== undefined ? patch.title : page.title,
    purpose: patch.purpose !== undefined ? patch.purpose : page.purpose,
    detectedActions: patch.detectedActions !== undefined ? patch.detectedActions : (page.detectedActions || []),
    includeInManual: patch.includeInManual !== undefined ? patch.includeInManual : page.includeInManual !== false,
  };

  if (patch.source !== undefined) {
    // 入口文件是扫描的事实，不允许被分析结果挤掉
    next.source = patch.source.includes(page.entry) ? patch.source : [page.entry, ...patch.source];
  }

  // 分析完成的判据是「有标题且说得清用途」，缺一个就还算 pending
  const complete = Boolean(next.title) && Boolean(next.purpose);
  next.status = {
    ...page.status,
    sourceAnalysis: complete ? ANALYSIS.COMPLETED : ANALYSIS.PENDING,
  };
  // 已经过浏览器验证的页面，补完分析后直接是 verified；否则只是源码推断
  next.confidence = complete ? CONFIDENCE.INFERRED : CONFIDENCE.NONE;
  if (complete && isBrowserVerified(page)) next.confidence = CONFIDENCE.VERIFIED;

  return next;
}

function run(argv) {
  const { values, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS });
  const json = values.json === true;

  if (values.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (unknownFlags.length > 0) {
    return fail([`未知参数: ${unknownFlags.join(', ')}`], { json });
  }

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    return fail([`--project-root 不是一个存在的目录: ${projectRoot}`], { json });
  }

  const hasInput = values.input !== undefined && values.input !== '';
  const hasId = values.id !== undefined && values.id !== '';
  if (hasInput && hasId) {
    return fail(['--input 与 --id 是两种模式，只能用其中一种。'], { json });
  }
  if (!hasInput && !hasId) {
    return fail(['需要 --input <分析结果.json>（批量）或 --id <页面id>（单页）。'], { json });
  }

  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, { json });
  const { config } = loaded;

  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const existing = store.readExistingPages(stateDirAbs);
  if (existing.errors.length > 0) {
    return fail(['已有的页面文件解析失败：', ...existing.errors.map((e) => `  ${e}`)], { json });
  }
  if (existing.pages.length === 0) {
    return fail(['.manual/pages/ 里还没有页面。先运行 `manual inspect` 扫描项目。'], { json });
  }

  const inputErrors = [];
  const payload = hasInput ? readInput(values.input, inputErrors) : fromFlags(values);
  if (inputErrors.length > 0) return fail(inputErrors, { json });

  if (!payload || !Array.isArray(payload.pages)) {
    return fail(['分析结果需要形如 { "pages": [ ... ] }。'], { json });
  }
  if (payload.pages.length === 0) {
    return fail(['pages 为空，没有要写入的内容。'], { json });
  }

  const byId = new Map(existing.pages.map((p) => [p.id, p]));
  const errors = [];
  const patches = [];
  const seen = new Set();

  payload.pages.forEach((entry, i) => {
    const patch = validateEntry(entry, i, new Set(byId.keys()), errors);
    if (!patch) return;
    if (seen.has(patch.id)) {
      errors.push(`pages[${i}] 的 id "${patch.id}" 重复出现。`);
      return;
    }
    seen.add(patch.id);
    patches.push(patch);
  });

  // 全部校验通过才落盘，避免写一半留下不一致的状态
  if (errors.length > 0) return fail(errors, { json });

  const updated = [];
  for (const patch of patches) {
    const next = applyPatch(byId.get(patch.id), patch);
    byId.set(patch.id, next);
    updated.push(next);
  }

  // 项目元信息沿用现有 project.yaml（describe 不重新探测框架），读不到就退化成 config 里的信息
  const projectFilePath = store.projectFileFor(stateDirAbs);
  let meta = {
    name: config.project.name,
    framework: null,
    frameworkVersion: null,
    router: null,
    appDir: null,
    pagesDir: null,
  };
  if (fs.existsSync(projectFilePath)) {
    try {
      const prev = yaml.load(fs.readFileSync(projectFilePath, 'utf8'));
      if (prev?.project) meta = { ...meta, ...prev.project };
    } catch (_) {
      // 索引坏了不影响写页面，下面会用当前信息重建
    }
  }
  meta.generatedAt = new Date().toISOString();

  const allPages = [...byId.values()].sort((a, b) => String(a.route).localeCompare(String(b.route)));
  const { projectFile } = store.writeModel(stateDirAbs, meta, allPages, {
    docsOutputDir: config.docs.outputDir,
  });

  const remaining = allPages.filter(
    (p) => p.includeInManual !== false && p.status?.sourceAnalysis !== ANALYSIS.COMPLETED
  );

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          projectFile,
          updated: updated.map((p) => ({
            id: p.id,
            route: p.route,
            title: p.title,
            sourceAnalysis: p.status.sourceAnalysis,
            confidence: p.confidence,
          })),
          remaining: remaining.map((p) => ({ id: p.id, route: p.route })),
        },
        null,
        2
      ) + '\n'
    );
  } else {
    const L = [''];
    L.push(`[manual describe] 已写回 ${updated.length} 个页面。`);
    L.push('');
    for (const p of updated) {
      const mark = p.status.sourceAnalysis === ANALYSIS.COMPLETED ? '✓' : '·';
      L.push(`  ${mark} ${p.id.padEnd(20)} ${p.title || '（无标题）'}   ${p.route}`);
      if (p.status.sourceAnalysis !== ANALYSIS.COMPLETED) {
        L.push('      ↑ title 与 purpose 都写了才算分析完成');
      }
    }
    L.push('');
    L.push(`  索引已重建  ${displayPath(projectFile, projectRoot)}`);
    if (remaining.length > 0) {
      L.push(`  还剩 ${remaining.length} 个页面待分析: ${remaining.map((p) => p.id).join(', ')}`);
    } else {
      L.push('  所有纳入手册的页面都已完成源码分析。');
    }
    L.push('');
    process.stdout.write(L.join('\n') + '\n');
  }

  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, validateEntry, applyPatch };
