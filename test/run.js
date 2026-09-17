'use strict';

/* 跑全部测试文件。任一失败则整体失败。 */

const { spawnSync } = require('child_process');
const path = require('path');

const FILES = [
  'init.test.js',
  'import-graph.test.js',
  'index-builder.test.js',
  'index-store.test.js',
  'inspect.test.js',
  'capture.test.js',
  'generate.test.js',
];

let failed = 0;
for (const file of FILES) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  process.stdout.write(`\n${failed} 个测试文件失败。\n`);
  process.exitCode = 1;
}
