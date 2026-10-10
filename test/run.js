'use strict';

/*
 * 跑测试文件。任一失败则整体失败。
 *
 *   node test/run.js                  全部
 *   node test/run.js --group unit     不启动浏览器的测试（快，CI 先跑）
 *   node test/run.js --group browser  需要 Chromium / 本地测试服务器的集成测试
 *   node test/run.js --list [--group] 只列出文件
 */

const { spawnSync } = require('child_process');
const path = require('path');

const FILES = [
  'annotation-coverage.test.js',
  'manual-quality.test.js',
  'catalog.test.js',
  'style-lint.test.js',
  'doc-meta.test.js',
  'revision.test.js',
  'model-schema.test.js',
  'init.test.js',
  'doctor.test.js',
  'auth-cache.test.js',
  'auth-session.test.js',
  'auth-wait.test.js',
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
  'task-guide.test.js',
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
  'publication-recovery.test.js',
  'generate-task.test.js',
  'staleness.test.js',
  'migrate-artifacts.test.js',
  'model-migration.test.js',
  'compat-aliases.test.js',
  'task-first-e2e.test.js',
  'task-rerun.test.js',
  'inspect.test.js',
  'capture.test.js',
  'fact-pack.test.js',
  'markdown-validation.test.js',
  'generate.test.js',
  'gate0.test.js',
  'gate1.test.js',
  'run-store.test.js',
  'runtime-errors.test.js',
  'browser-session.test.js',
  'cache-keys.test.js',
  'cache-policy.test.js',
  'runtime-planner.test.js',
  'runtime-runner.test.js',
  'model-handoff.test.js',
  'runtime-cli.test.js',
  'runtime-recovery.test.js',
  'runtime-failure-matrix.test.js',
  'gate2.test.js',
  'git-changes.test.js',
  'impact-analysis.test.js',
  'manual-merge.test.js',
  'update-cli.test.js',
  'incremental-update.test.js',
  'live-verify.test.js',
  'drift-report.test.js',
  'scenario-fixtures.test.js',
  'ci-workflow.test.js',
  'install-smoke.test.js',
  'performance.test.js',
  'retention.test.js',
  'site.test.js',
  'docs-consistency.test.js',
  'gate3.test.js',
];

// 启动真实 Chromium 或测试服务器的文件；其余为 unit。新增浏览器测试时加到这里（ci-workflow.test 会核对）。
const BROWSER = new Set([
  'auth-identity.test.js', 'browser-session.test.js', 'cache-policy.test.js', 'capture.test.js', 'drift-report.test.js',
  'gate0.test.js', 'gate1.test.js', 'gate2.test.js', 'gate3.test.js', 'generate.test.js', 'image-pipeline.test.js',
  'incremental-update.test.js', 'install-smoke.test.js', 'live-verify.test.js', 'model-handoff.test.js', 'page-validation.test.js',
  'performance.test.js', 'run-store.test.js', 'runtime-cli.test.js', 'runtime-planner.test.js', 'runtime-recovery.test.js',
  'runtime-runner.test.js', 'runtime-failure-matrix.test.js', 'scenario-fixtures.test.js', 'task-executor.test.js',
  'task-first-e2e.test.js', 'task-rerun.test.js', 'retention.test.js',
]);

function groupOf(file) {
  return BROWSER.has(file) ? 'browser' : 'unit';
}

function selected(argv) {
  const at = argv.indexOf('--group');
  const group = at === -1 ? null : argv[at + 1];
  if (group !== null && !['unit', 'browser'].includes(group)) throw new Error(`未知分组: ${group}（unit / browser）`);
  return FILES.filter((file) => !group || groupOf(file) === group);
}

module.exports = { FILES, BROWSER, groupOf };

if (require.main !== module) return;

const files = selected(process.argv.slice(2));
if (process.argv.includes('--list')) {
  process.stdout.write(files.join('\n') + '\n');
  return;
}

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  process.stdout.write(`\n${failed} 个测试文件失败。\n`);
  process.exitCode = 1;
}
