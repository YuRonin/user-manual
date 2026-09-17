'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');

const KNOWN_FLAGS = new Set(['projectRoot', 'copy', 'json', 'help']);
const HELP = `
manual migrate-artifacts —— 检查并复制旧页面原图

用法:
  manual migrate-artifacts [--project-root <路径>] [--json]
  manual migrate-artifacts --copy [--project-root <路径>] [--json]

默认只报告旧 rawDir 中的文件；--copy 将其复制到
.manual/artifacts/raw/legacy/。不会删除旧文件，也不会覆盖已有目标。
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
  const sourceRoot = path.resolve(projectRoot, loaded.config.artifacts.rawDir);
  const destinationRoot = path.resolve(projectRoot, loaded.config.artifacts.stateDir, 'artifacts', 'raw', 'legacy');
  if (!inside(projectRoot, sourceRoot) || !inside(projectRoot, destinationRoot)) {
    return fail('迁移路径必须位于项目根目录内。', json);
  }

  const relativeFiles = walkFiles(sourceRoot);
  const found = relativeFiles.map((relative) => display(projectRoot, path.join(sourceRoot, relative)));
  const copied = [];
  const skipped = [];
  if (values.copy) {
    for (const relative of relativeFiles) {
      const source = path.join(sourceRoot, relative);
      const destination = path.join(destinationRoot, relative);
      const shown = display(projectRoot, destination);
      if (fs.existsSync(destination)) { skipped.push(shown); continue; }
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      copied.push(shown);
    }
  }

  const output = {
    ok: true,
    mode: values.copy ? 'copy' : 'report',
    found,
    copied,
    skipped,
    deleted: [],
  };
  if (json) process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  else {
    process.stdout.write(`[manual migrate-artifacts] 找到 ${found.length} 个旧原图，复制 ${copied.length} 个，跳过 ${skipped.length} 个；未删除任何文件。\n`);
  }
  return 0;
}

module.exports = { run, HELP, KNOWN_FLAGS, walkFiles, inside };
