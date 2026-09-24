'use strict';

/* 跑全部测试文件。任一失败则整体失败。 */

const { spawnSync } = require('child_process');
const path = require('path');

const FILES = [
  'revision.test.js',
  'model-schema.test.js',
  'init.test.js',
  'doctor.test.js',
  'auth-cache.test.js',
  'auth-session.test.js',
  'auth-command.test.js',
  'auth-identity.test.js',
  'import-graph.test.js',
  'source-fingerprint.test.js',
  'index-builder.test.js',
  'index-store.test.js',
  'task-model.test.js',
  'task-store.test.js',
  'project-lock.test.js',
  'project-store.test.js',
  'discover-tasks.test.js',
  'capture-plan.test.js',
  'task-executor.test.js',
  'page-validation.test.js',
  'completion-claims.test.js',
  'scenario-model.test.js',
  'capture-store.test.js',
  'capture-task.test.js',
  'artifacts.test.js',
  'image-pipeline.test.js',
  'publication-paths.test.js',
  'publication-gates.test.js',
  'atomic-write.test.js',
  'finalize-safety.test.js',
  'generate-task.test.js',
  'staleness.test.js',
  'migrate-artifacts.test.js',
  'model-migration.test.js',
  'compat-aliases.test.js',
  'task-first-e2e.test.js',
  'task-rerun.test.js',
  'inspect.test.js',
  'capture.test.js',
  'generate.test.js',
  'gate0.test.js',
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
