'use strict';

/*
 * P3-01：Git 变更检测。
 * 临时 Git 仓库覆盖 A/M/D/R、含空格 / 中文路径、staged + unstaged、untracked、无共同祖先的基线、
 * 非 Git 目录；NUL 输出解析与排除规则单独测试。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fx = require('./fixtures');
const gc = require('../src/update/git-changes');

let passed = 0;
const failures = [];
function test(name, fn) {
  const root = fx.makeTempDir('manual-git-');
  try {
    if (!fx.hasGit() && fn.length > 0 && !name.startsWith('[no-git]')) { process.stdout.write(`  - ${name}（跳过：没有 git）\n`); return; }
    fn(root); passed++; process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
  finally { fx.cleanup(root); }
}

function byPath(result, file) {
  return result.changes.find((c) => c.path === file);
}

process.stdout.write('\ngit changes\n');

test('parseNameStatus：NUL 分隔、rename 保留旧新路径与相似度', () => {
  const out = 'M\0a b.tsx\0R087\0old/名.tsx\0new/名.tsx\0D\0gone.ts\0A\0x\ny.ts\0';
  assert.deepStrictEqual(gc.parseNameStatus(out), [
    { status: 'M', path: 'a b.tsx' },
    { status: 'R', path: 'new/名.tsx', oldPath: 'old/名.tsx', score: 87 },
    { status: 'D', path: 'gone.ts' },
    { status: 'A', path: 'x\ny.ts' },
  ]);
});

test('A/M/D/R + 空格与中文文件名 + staged / unstaged / untracked 全部计入', (root) => {
  fx.writeFile(root, 'components/Old Name.tsx', 'export const A = 1 // 足够长的内容让 rename 可被识别\n'.repeat(5));
  fx.writeFile(root, 'components/按钮.tsx', 'export const B = 1\n');
  fx.writeFile(root, 'lib/remove.ts', 'export const C = 1\n');
  fx.writeFile(root, 'lib/staged.ts', 'export const D = 1\n');
  const base = fx.gitInit(root);

  fx.git(root, ['mv', 'components/Old Name.tsx', 'components/New Name.tsx']);    // R（staged）
  fx.writeFile(root, 'components/按钮.tsx', 'export const B = 2\n');              // M（unstaged）
  fs.rmSync(path.join(root, 'lib/remove.ts'));                                     // D（unstaged）
  fx.writeFile(root, 'lib/staged.ts', 'export const D = 2\n');
  fx.git(root, ['add', 'lib/staged.ts']);                                          // M（staged）
  fx.writeFile(root, 'lib/新 文件.ts', 'export const E = 1\n');                    // untracked

  const result = gc.gitChanges(root, base);
  assert.strictEqual(result.mode, 'git');
  assert.strictEqual(result.base, base);
  const renamed = byPath(result, 'components/New Name.tsx');
  assert.ok(renamed, JSON.stringify(result.changes));
  assert.strictEqual(renamed.status, 'R');
  assert.strictEqual(renamed.oldPath, 'components/Old Name.tsx');
  assert.strictEqual(byPath(result, 'components/按钮.tsx').status, 'M');
  assert.strictEqual(byPath(result, 'lib/remove.ts').status, 'D');
  assert.strictEqual(byPath(result, 'lib/staged.ts').status, 'M');
  assert.strictEqual(byPath(result, 'lib/新 文件.ts').status, '?');
  assert.ok(result.staged.includes('lib/staged.ts'));
  assert.ok(result.unstaged.includes('components/按钮.tsx'));
  assert.ok(result.untracked.includes('lib/新 文件.ts'));
});

test('已提交的变化也计入（基线之后的多个提交）', (root) => {
  fx.writeFile(root, 'a.ts', '1\n');
  const base = fx.gitInit(root);
  fx.writeFile(root, 'a.ts', '2\n');
  fx.gitCommit(root, 'second');
  fx.writeFile(root, 'b.ts', '1\n');
  fx.gitCommit(root, 'third');
  const result = gc.gitChanges(root, base);
  assert.deepStrictEqual(result.changes.map((c) => `${c.status}:${c.path}`), ['M:a.ts', 'A:b.ts']);
});

test('无共同祖先的基线（orphan 分支）仍能比较', (root) => {
  fx.writeFile(root, 'a.ts', 'main\n');
  fx.gitInit(root);
  fx.git(root, ['checkout', '-q', '--orphan', 'other']);
  fx.git(root, ['rm', '-rq', '--cached', '.']);
  fs.rmSync(path.join(root, 'a.ts'));
  fx.writeFile(root, 'z.ts', 'other\n');
  const orphan = fx.gitCommit(root, 'orphan');
  fx.git(root, ['checkout', '-q', 'main']);
  const result = gc.detectChanges({ projectRoot: root, base: orphan });
  assert.strictEqual(result.mode, 'git');
  assert.deepStrictEqual(result.changes.map((c) => `${c.status}:${c.path}`).sort(), ['A:a.ts', 'D:z.ts']);
});

test('项目根是仓库子目录：路径相对项目根，根外变化不计入', (root) => {
  fx.writeFile(root, 'web/app/page.tsx', 'x\n');
  fx.writeFile(root, 'server/main.go', 'package main\n');
  const base = fx.gitInit(root);
  fx.writeFile(root, 'web/app/page.tsx', 'y\n');
  fx.writeFile(root, 'server/main.go', 'package main // changed\n');
  fx.writeFile(root, 'web/new.ts', 'z\n');
  const result = gc.gitChanges(path.join(root, 'web'), base);
  assert.deepStrictEqual(result.changes.map((c) => `${c.status}:${c.path}`), ['M:app/page.tsx', '?:new.ts']);
});

test('--base 非法 / 不在 Git 仓库：明确报错，不静默当作无变化', (root) => {
  fx.writeFile(root, 'a.ts', '1\n');
  assert.throws(() => gc.detectChanges({ projectRoot: root, base: 'HEAD' }), (e) => e.code === 'git-unavailable');
  fx.gitInit(root);
  assert.throws(() => gc.detectChanges({ projectRoot: root, base: 'no-such-ref' }), (e) => e.code === 'git-base-invalid');
  assert.throws(() => gc.detectChanges({ projectRoot: root, base: '--output=/tmp/x' }), (e) => e.code === 'git-base-invalid');
});

test('[no-git] 非 Git 项目：用基线图逐文件比较内容；无基线 → full-rebuild-required', (root) => {
  fx.writeFile(root, 'a.ts', '1\n');
  fx.writeFile(root, 'b.ts', '1\n');
  fx.writeFile(root, 'c.ts', '1\n');
  const { hashFile } = require('../src/inspect/fingerprint');
  const graph = { pages: { p: { files: { 'a.ts': hashFile(root, 'a.ts'), 'b.ts': hashFile(root, 'b.ts'), 'c.ts': hashFile(root, 'c.ts') } } }, globals: {} };
  fx.writeFile(root, 'a.ts', '2\n');
  fs.rmSync(path.join(root, 'b.ts'));
  fx.writeFile(root, 'package.json', '{}\n');
  const result = gc.detectChanges({ projectRoot: root, baseline: { graph } });
  assert.strictEqual(result.mode, 'snapshot');
  assert.deepStrictEqual(result.changes.map((c) => `${c.status}:${c.path}`), ['M:a.ts', 'D:b.ts', 'A:package.json']);

  const none = gc.detectChanges({ projectRoot: root, baseline: {} });
  assert.strictEqual(none.mode, 'none');
  assert.strictEqual(none.fallback, 'full-rebuild-required');
  assert.deepStrictEqual(none.changes, []);
});

test('基线提交已不存在（rebase 后）：降级到内容快照并给出警告', (root) => {
  fx.writeFile(root, 'a.ts', '1\n');
  fx.gitInit(root);
  const { hashFile } = require('../src/inspect/fingerprint');
  const graph = { pages: { p: { files: { 'a.ts': hashFile(root, 'a.ts') } } }, globals: {} };
  fx.writeFile(root, 'a.ts', '2\n');
  const result = gc.detectChanges({ projectRoot: root, baseline: { gitCommit: 'f'.repeat(40), graph } });
  assert.strictEqual(result.mode, 'snapshot');
  assert.ok(result.warnings.some((w) => w.includes('已不存在')));
  assert.deepStrictEqual(result.changes.map((c) => c.path), ['a.ts']);
});

test('Git 基线 + 图快照：发布时未提交、后来被还原的修改也能发现', (root) => {
  fx.writeFile(root, 'a.ts', 'committed\n');
  const base = fx.gitInit(root);
  // 发布时工作区是 dirty 的：图里记录的是未提交内容
  fx.writeFile(root, 'a.ts', 'dirty-at-release\n');
  const { hashFile } = require('../src/inspect/fingerprint');
  const graph = { pages: { p: { files: { 'a.ts': hashFile(root, 'a.ts') } } }, globals: {} };
  // 之后被还原成提交内容：git diff 为空，但与发布时的内容不同
  fx.writeFile(root, 'a.ts', 'committed\n');
  const result = gc.detectChanges({ projectRoot: root, baseline: { gitCommit: base, graph } });
  assert.strictEqual(result.mode, 'git');
  assert.deepStrictEqual(result.changes.map((c) => `${c.status}:${c.path}:${c.via || 'git'}`), ['M:a.ts:snapshot']);
});

test('filterChanges：默认排除生成物 / docs / 状态目录，显式依赖保留', () => {
  const changes = [
    { status: 'M', path: 'app/page.tsx' },
    { status: 'M', path: 'docs/manual/chat.md' },
    { status: 'M', path: 'docs/manual/data.json' },
    { status: 'A', path: '.manual/runs/x.json' },
    { status: 'M', path: 'node_modules/react/index.js' },
    { status: 'R', path: 'docs/manual/moved.tsx', oldPath: 'src/moved.tsx' },
  ];
  const out = gc.filterChanges(changes, { excludes: ['docs/manual', '.manual'], keep: new Set(['docs/manual/data.json']) });
  assert.deepStrictEqual(out.changes.map((c) => c.path), ['app/page.tsx', 'docs/manual/data.json', 'docs/manual/moved.tsx']);
  assert.deepStrictEqual(out.excluded.map((c) => c.path), ['docs/manual/chat.md', '.manual/runs/x.json', 'node_modules/react/index.js']);
});

test('gitState：记录 HEAD 与 dirty；非 Git 返回 null', (root) => {
  fx.writeFile(root, 'a.ts', '1\n');
  assert.deepStrictEqual(gc.gitState(root), { gitCommit: null, gitDirty: null });
  const head = fx.gitInit(root);
  assert.deepStrictEqual(gc.gitState(root), { gitCommit: head, gitDirty: false });
  fx.writeFile(root, 'a.ts', '2\n');
  assert.strictEqual(gc.gitState(root).gitDirty, true);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exitCode = 1;
