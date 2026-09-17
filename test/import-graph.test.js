'use strict';

const assert = require('assert');

const fx = require('./fixtures');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  }
}

async function main() {
  process.stdout.write('\nimport graph\n');

  await test('递归收集 import、re-export、side-effect import 与 literal require', () => {
    const root = fx.makeTempDir('manual-import-graph-');
    try {
      fx.writeFile(root, 'src/app/login/page.tsx', [
        "import LoginForm from '../../components/LoginForm'",
        "import '../../setup/client'",
        'export { metadata } from \'../../metadata/login\'',
        'export default function Page() { return <LoginForm /> }',
      ].join('\n'));
      fx.writeFile(root, 'src/components/LoginForm.tsx', [
        "import Input from './Input'",
        "const useAuth = require('../hooks/useAuth')",
        'export default function LoginForm() { return Input(useAuth) }',
      ].join('\n'));
      fx.writeFile(root, 'src/components/Input.tsx', 'export default function Input() {}\n');
      fx.writeFile(root, 'src/hooks/useAuth.ts', 'module.exports = function useAuth() {}\n');
      fx.writeFile(root, 'src/setup/client.js', 'globalThis.ready = true\n');
      fx.writeFile(root, 'src/metadata/login.ts', 'export const metadata = {}\n');

      const { buildImportGraph } = require('../src/inspect/import-graph');
      const result = buildImportGraph(root, 'src/app/login/page.tsx');

      assert.deepStrictEqual(result.files, [
        'src/components/Input.tsx',
        'src/components/LoginForm.tsx',
        'src/hooks/useAuth.ts',
        'src/metadata/login.ts',
        'src/setup/client.js',
      ]);
      assert.deepStrictEqual(result.unresolved, []);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('循环依赖只访问一次并忽略第三方包、静态资源与动态表达式', () => {
    const root = fx.makeTempDir('manual-import-cycle-');
    try {
      fx.writeFile(root, 'src/page.tsx', [
        "import React from 'react'",
        "import A from './A'",
        "import './page.css'",
        "import icon from './icon.png'",
        'const lazy = import(dynamicPath)',
        'export default A',
      ].join('\n'));
      fx.writeFile(root, 'src/A.ts', "import B from './B'\nexport default B\n");
      fx.writeFile(root, 'src/B.ts', "import A from './A'\nexport default A\n");
      fx.writeFile(root, 'src/page.css', 'body {}\n');
      fx.writeFile(root, 'src/icon.png', 'not-a-real-png');

      const { buildImportGraph } = require('../src/inspect/import-graph');
      const result = buildImportGraph(root, 'src/page.tsx');

      assert.deepStrictEqual(result.files, ['src/A.ts', 'src/B.ts']);
      assert.deepStrictEqual(result.unresolved, []);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('解析 tsconfig baseUrl/paths 别名并报告未解析的项目别名', () => {
    const root = fx.makeTempDir('manual-import-alias-');
    try {
      fx.writeFile(root, 'tsconfig.json', `{
        // JSONC comments are valid in tsconfig files.
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["src/*"] }
        }
      }\n`);
      fx.writeFile(root, 'src/app/page.tsx', [
        "import Input from '@/components/Input'",
        "import missing from '@/components/Missing'",
        'export default Input',
      ].join('\n'));
      fx.writeFile(root, 'src/components/Input/index.tsx', 'export default function Input() {}\n');

      const { buildImportGraph } = require('../src/inspect/import-graph');
      const result = buildImportGraph(root, 'src/app/page.tsx');

      assert.deepStrictEqual(result.files, ['src/components/Input/index.tsx']);
      assert.deepStrictEqual(result.unresolved, ['src/app/page.tsx: @/components/Missing']);
    } finally {
      fx.cleanup(root);
    }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`测试运行器出错: ${error.stack || error}\n`);
  process.exitCode = 1;
});
