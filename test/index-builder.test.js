'use strict';

const assert = require('assert');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`);
  }
}

function page(overrides) {
  return {
    id: 'login',
    route: '/login',
    entry: 'src/app/login/page.tsx',
    includeInManual: true,
    dependencies: {
      files: [
        'src/components/LoginForm.tsx',
        'src/components/Input.tsx',
        'src/hooks/useAuth.ts',
      ],
      unresolved: [],
    },
    browser: { screenshot: 'docs/manual/images/raw/login.png' },
    ...overrides,
  };
}

process.stdout.write('\nindex builder\n');

test('生成页面正索引与共享文件逆索引', () => {
  const { buildIndexes } = require('../src/inspect/index-builder');
  const pages = [
    page({}),
    page({
      id: 'settings',
      route: '/settings',
      entry: 'src/app/settings/page.tsx',
      dependencies: {
        files: ['src/components/Input.tsx', 'src/components/SettingsForm.tsx'],
        unresolved: [],
      },
      browser: { screenshot: null },
    }),
  ];

  const { forward, reverse } = buildIndexes(pages, { docsOutputDir: 'docs/manual' });

  assert.deepStrictEqual(forward['/login'], {
    id: 'login',
    route: '/login',
    entry: ['src/app/login/page.tsx'],
    files: [
      'src/app/login/page.tsx',
      'src/components/Input.tsx',
      'src/components/LoginForm.tsx',
      'src/hooks/useAuth.ts',
    ],
    components: [
      'src/components/Input.tsx',
      'src/components/LoginForm.tsx',
    ],
    hooks: ['src/hooks/useAuth.ts'],
    apis: [],
    scenarios: [],
    screenshot: 'docs/manual/images/raw/login.png',
    manual: 'docs/manual/login.md',
    includeInManual: true,
  });
  assert.deepStrictEqual(reverse['src/components/Input.tsx'], ['/login', '/settings']);
  assert.deepStrictEqual(reverse['src/app/login/page.tsx'], ['/login']);
});

test('输入顺序和 Windows 路径不影响索引序列化结果', () => {
  const { buildIndexes } = require('../src/inspect/index-builder');
  const login = page({
    entry: 'src\\app\\login\\page.tsx',
    dependencies: {
      files: [
        'src\\hooks\\useAuth.ts',
        'src\\components\\Input.tsx',
        'src/components/Input.tsx',
      ],
      unresolved: [],
    },
  });
  const admin = page({
    id: 'admin',
    route: '/admin',
    entry: 'src/app/admin/page.tsx',
    includeInManual: false,
    dependencies: { files: ['src\\components\\Input.tsx'], unresolved: [] },
  });

  const first = buildIndexes([login, admin], { docsOutputDir: 'docs\\manual' });
  const second = buildIndexes([admin, login], { docsOutputDir: 'docs/manual' });

  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
  assert.ok(first.forward['/admin'], '不发布的页面仍需进入影响范围索引');
  assert.deepStrictEqual(first.reverse['src/components/Input.tsx'], ['/admin', '/login']);
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) process.exitCode = 1;
