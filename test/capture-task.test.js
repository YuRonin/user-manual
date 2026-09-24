'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-capture-task-'));
try {
  let result = spawnSync(process.execPath, [CLI, 'init', '--project-root', root, '--base-url', 'http://localhost:1'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  const stateDir = path.join(root, '.manual');
  require('../src/inspect/store').writeModel(stateDir, { name: 'x', framework: 'nextjs', router: 'app', generatedAt: new Date().toISOString() }, [{
    id: 'profile', route: '/profile', dynamic: false, params: [], title: '个人中心', purpose: '管理资料', detectedActions: [], entry: 'app/profile/page.tsx', source: [], dependencies: { files: [], unresolved: [] }, includeInManual: true, confidence: 'inferred', browser: { verified: false }, states: { default: { description: '初始状态', assertions: [{ type: 'url', value: '/profile' }] } }, status: { router: 'app', sourceAnalysis: 'completed' },
  }], { docsOutputDir: 'docs/manual' });
  require('../src/tasks/store').writeTask(stateDir, {
    id: 'edit-profile', title: '修改资料', goal: '修改资料', entryPage: 'profile', preconditions: ['已登录'], risk: 'read', status: 'candidate', steps: [{ id: 'inspect', instruction: '查看资料', page: 'profile', action: { type: 'inspect' }, capture: { timing: 'after' } }], completion: { description: '看到资料', verification: 'verified' },
  });
  result = spawnSync(process.execPath, [CLI, 'capture-task', 'edit-profile', '--project-root', root, '--json'], { encoding: 'utf8' });
  assert.strictEqual(result.status, 1);
  assert.match(result.stdout, /approval-required/);
  process.stdout.write('\ncapture task\n  ✓ candidate 在启动浏览器前被阻止\n\n1 passed, 0 failed\n');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
