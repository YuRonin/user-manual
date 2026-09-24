'use strict';

/* 跑全部测试文件。任一失败则整体失败。 */

const { spawnSync } = require('child_process');
const path = require('path');

const FILES = [
  'init.test.js',
  'doctor.test.js',
  'auth-cache.test.js',
  'auth-session.test.js',
  'auth-command.test.js',
  'import-graph.test.js',
  'index-builder.test.js',
  'index-store.test.js',
  'task-model.test.js',
  'task-store.test.js',
  'discover-tasks.test.js',
  'capture-plan.test.js',
  'task-executor.test.js',
  'page-validation.test.js',
  'completion-claims.test.js',
  'capture-task.test.js',
  'artifacts.test.js',
  'publication-paths.test.js',
  'publication-gates.test.js',
  'generate-task.test.js',
  'staleness.test.js',
  'migrate-artifacts.test.js',
  'compat-aliases.test.js',
  'task-first-e2e.test.js',
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
