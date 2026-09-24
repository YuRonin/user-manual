'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { listMarkdownImages } = require('../publication/paths');
const { legacyRawPrefixes } = require('../publication/validate');

const KNOWN_FLAGS = new Set(['projectRoot', 'copy', 'json', 'help']);
const HELP = `
manual migrate-artifacts —— 检查并复制旧页面原图

用法:
  manual migrate-artifacts [--project-root <路径>] [--json]
  manual migrate-artifacts --copy [--project-root <路径>] [--json]

默认只报告文档目录下旧原图位置中的文件；--copy 将其复制到
.manual/artifacts/raw/legacy/。不会删除旧文件，也不会覆盖已有目标。
pending 列出复制之外仍需处理的事项（旧配置、文档中的原图引用、需重新采集）。
`.trim();

function fail(errors, json) {
  const list = Array.isArray(errors) ? errors : [errors];
  if (json) process.stdout.write(JSON.stringify({ ok: false, errors: list }, null, 2) + '\n');
  else list.forEach((error) => process.stderr.write(`[manual migrate-artifacts] ${error}\n`));
  return 1;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function walkFiles(directory, base = directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(full, base));
    else if (entry.isFile()) files.push(path.relative(base, full));
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function display(projectRoot, file) {
  return path.relative(projectRoot, file).replace(/\\/g, '/');
}

/** 列出复制之外仍需人工处理的事项：旧配置、仍引用原图的文档、需要重新采集的原图。 */
function pendingItems(projectRoot, config, found) {
  const pending = [];
  const prefixes = legacyRawPrefixes(config);
  const rawPrefix = String(config.artifacts.rawDir).replace(/\\/g, '/').replace(/\/$/, '') + '/';
  if (prefixes.includes(rawPrefix)) {
    pending.push({
      code: 'legacy-raw-config',
      path: '.manual/config.yaml',
      message: `artifacts.rawDir 仍为 ${config.artifacts.rawDir}，请改为 ${config.artifacts.stateDir}/artifacts/raw/pages。`,
    });
  }
  const docsRoot = path.resolve(projectRoot, config.docs.outputDir);
  for (const relative of walkFiles(docsRoot).filter((file) => file.endsWith('.md'))) {
    const manualFile = path.join(docsRoot, relative);
    for (const image of listMarkdownImages(fs.readFileSync(manualFile, 'utf8'))) {
      const target = display(projectRoot, path.resolve(path.dirname(manualFile), image.src || ''));
      if (prefixes.some((prefix) => target.startsWith(prefix))) {
        pending.push({
          code: 'legacy-raw-reference',
          path: display(projectRoot, manualFile),
          message: `${display(projectRoot, manualFile)} 引用了原图 ${image.src}，需要重新 capture 并 generate。`,
        });
      }
    }
  }
  if (found.length > 0) {
    pending.push({
      code: 'recapture-required',
      path: null,
      message: `${found.length} 张旧原图未经隐私处理，不能直接发布；请重新 capture 生成发布图。`,
    });
  }
  return pending;
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, {
    known: KNOWN_FLAGS,
    booleans: ['copy'],
  });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  if (unknownFlags.length > 0) return fail(`未知参数: ${unknownFlags.join(', ')}`, json);
  if (positional.length > 0) return fail('此命令不接受位置参数。', json);

  const projectRoot = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(projectRoot);
  if (!loaded.ok) return fail(loaded.errors, json);
  const { config } = loaded;
  // 旧原图可能在旧默认位置（<docs>/images/raw），也可能在仍指向文档目录的 rawDir 下。
  const sourceRoots = [...new Set(legacyRawPrefixes(config).map((prefix) => path.resolve(projectRoot, prefix)))];
  const destinationRoot = path.resolve(projectRoot, config.artifacts.stateDir, 'artifacts', 'raw', 'legacy');
  if (sourceRoots.some((root) => !inside(projectRoot, root)) || !inside(projectRoot, destinationRoot)) {
    return fail('迁移路径必须位于项目根目录内。', json);
  }

  const entries = sourceRoots.flatMap((sourceRoot) => walkFiles(sourceRoot).map((relative) => ({ sourceRoot, relative })));
  const found = entries.map(({ sourceRoot, relative }) => display(projectRoot, path.join(sourceRoot, relative)));
  const copied = [];
  const skipped = [];
  if (values.copy) {
    for (const { sourceRoot, relative } of entries) {
      const source = path.join(sourceRoot, relative);
      const destination = path.join(destinationRoot, relative);
      const shown = display(projectRoot, destination);
      if (fs.existsSync(destination)) { skipped.push(shown); continue; }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      copied.push(shown);
    }
  }

  const pending = pendingItems(projectRoot, config, found);
  const output = {
    ok: true,
    mode: values.copy ? 'copy' : 'report',
    found,
    copied,
    skipped,
    deleted: [],
    // 复制原图不等于迁移完成：配置与文档引用仍需处理，发布图需重新采集生成。
    pending,
    complete: pending.length === 0,
  };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else {
    process.stdout.write(`[manual migrate-artifacts] 找到 ${found.length} 个旧原图，复制 ${copied.length} 个，跳过 ${skipped.length} 个；未删除任何文件。\n`);
    for (const item of pending) process.stdout.write(`  待处理 ${item.code}: ${item.message}\n`);
  }
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, walkFiles, inside };
