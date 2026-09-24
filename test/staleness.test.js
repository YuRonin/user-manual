'use strict';

const assert = require('assert');
const { markAffectedTasks } = require('../src/tasks/staleness');

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

process.stdout.write('\nstaleness\n');

const tasks = [
  { id: 'a', status: 'verified', entryPage: 'profile', steps: [{ page: 'profile' }], evidence: [{ file: 'components/Profile.tsx' }] },
  { id: 'b', status: 'approved', entryPage: 'home', steps: [{ page: 'home' }], evidence: [] },
  { id: 'c', status: 'candidate', entryPage: 'profile', steps: [{ page: 'profile' }], evidence: [] },
];

test('页面变化只标记关联任务，不改写 status（stale 不是死路）', () => {
  const result = markAffectedTasks(tasks, { pageIds: ['profile'], files: [], at: '2026-09-24T00:00:00.000Z' });
  assert.deepStrictEqual(result.staleIds, ['a']);
  assert.strictEqual(result.tasks[0].status, 'verified');
  assert.deepStrictEqual(result.tasks[0].stale, { reasons: ['page-changed:profile'], detectedAt: '2026-09-24T00:00:00.000Z' });
  assert.strictEqual(result.tasks[1].stale, undefined);
  assert.strictEqual(result.tasks[2].stale, undefined, '候选任务没有证据，不标记');
});

test('源文件变化带原因；重复标记合并原因', () => {
  const once = markAffectedTasks(tasks, { files: ['components\\Profile.tsx'] }).tasks;
  const twice = markAffectedTasks(once, { pageIds: ['profile'] }).tasks;
  assert.deepStrictEqual(twice[0].stale.reasons, ['source-changed:components/Profile.tsx', 'page-changed:profile']);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
