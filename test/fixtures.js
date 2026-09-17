'use strict';

/*
 * 测试夹具：程序化造出 Next.js 项目目录树。
 *
 * 不把 page.tsx 之类的文件真的放进仓库——它们会被编辑器/lint 当成真代码，
 * 而且扫描器只看路径不看内容，文件里放什么无所谓。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const STUB = 'export default function Page() { return null }\n';

function writeFile(root, rel, content = STUB) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function makeTempDir(prefix = 'manual-fixture-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writePackageJson(root, deps) {
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture', dependencies: deps }, null, 2));
}

/**
 * App Router 夹具。覆盖了正常路由、动态路由、catch-all、路由组，
 * 以及全部应当被跳过的约定（layout/loading、私有目录、并行插槽、拦截路由、API）。
 */
function nextAppFixture() {
  const root = makeTempDir();
  writePackageJson(root, { next: '^15.0.3', react: '^19.0.0' });

  // 应当被识别成页面
  writeFile(root, 'app/page.tsx');                          // /
  writeFile(root, 'app/chat/page.tsx');                     // /chat
  writeFile(root, 'app/skills/page.tsx');                   // /skills
  writeFile(root, 'app/membership/page.tsx');               // /membership
  writeFile(root, 'app/profile/page.tsx');                  // /profile
  writeFile(root, 'app/artifact/[id]/page.tsx');            // /artifact/:id
  writeFile(root, 'app/(marketing)/pricing/page.tsx');      // /pricing  路由组不进 URL
  writeFile(root, 'app/docs/[...slug]/page.tsx');           // /docs/:slug*
  writeFile(root, 'app/blog/[[...slug]]/page.tsx');         // /blog/:slug?
  writeFile(root, 'app/admin/page.tsx');                    // /admin
  writeFile(root, 'app/admin/users/page.tsx');              // /admin/users
  writeFile(root, 'app/settings/page.jsx');                 // /settings  非 tsx 也算

  // 应当被跳过
  writeFile(root, 'app/layout.tsx');
  writeFile(root, 'app/chat/layout.tsx');
  writeFile(root, 'app/chat/loading.tsx');
  writeFile(root, 'app/chat/error.tsx');
  writeFile(root, 'app/not-found.tsx');
  writeFile(root, 'app/chat/components/Button.tsx');
  writeFile(root, 'app/api/health/route.ts');
  writeFile(root, 'app/_internal/page.tsx');                // 私有目录
  writeFile(root, 'app/@modal/photo/page.tsx');             // 并行插槽
  writeFile(root, 'app/(.)preview/page.tsx');               // 拦截路由
  writeFile(root, 'app/chat/page.test.tsx');                // 测试文件
  writeFile(root, 'components/membership/PlanCard.tsx');    // 路由目录之外
  writeFile(root, 'node_modules/next/app/page.tsx');        // 永远不该被走到

  return root;
}

/** Pages Router 夹具，放在 src/ 下以覆盖 src 变体。 */
function nextPagesFixture() {
  const root = makeTempDir();
  writePackageJson(root, { next: '13.5.0', react: '^18.0.0' });

  writeFile(root, 'src/pages/index.tsx');                   // /
  writeFile(root, 'src/pages/about.tsx');                   // /about
  writeFile(root, 'src/pages/user/index.tsx');              // /user
  writeFile(root, 'src/pages/user/[id].tsx');               // /user/:id
  writeFile(root, 'src/pages/posts/[...slug].tsx');         // /posts/:slug*

  writeFile(root, 'src/pages/_app.tsx');
  writeFile(root, 'src/pages/_document.tsx');
  writeFile(root, 'src/pages/_error.tsx');
  writeFile(root, 'src/pages/api/hello.ts');
  writeFile(root, 'src/pages/settings.test.tsx');

  return root;
}

/**
 * capture 用的夹具：路由要和 test/server.js 提供的路径对上，
 * 这样 inspect 扫出来的 page id 就能直接拿去 capture。
 */
function captureFixture() {
  const root = makeTempDir('manual-capture-');
  writePackageJson(root, { next: '^15.0.0' });

  for (const route of [
    '',                     // /
    'chat',
    'slow',
    'blank',
    'login',
    'protected',
    'error500',
    'missing-route',        // 服务器对它返回 404
    'public-with-password',
  ]) {
    writeFile(root, `app/${route ? route + '/' : ''}page.tsx`);
  }
  writeFile(root, 'app/artifact/[id]/page.tsx');   // 动态路由

  return root;
}

/** 非 Next.js 项目，用来验证「暂不支持」的提示是否准确。 */
function vueFixture() {
  const root = makeTempDir();
  writePackageJson(root, { vue: '^3.4.0', 'vue-router': '^4.2.0' });
  writeFile(root, 'src/views/Home.vue', '<template></template>\n');
  return root;
}

/** 认得是 Next.js，但没有任何路由目录。 */
function nextNoRoutesFixture() {
  const root = makeTempDir();
  writePackageJson(root, { next: '^15.0.0' });
  writeFile(root, 'next.config.js', 'module.exports = {}\n');
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = {
  STUB,
  writeFile,
  makeTempDir,
  writePackageJson,
  nextAppFixture,
  nextPagesFixture,
  captureFixture,
  vueFixture,
  nextNoRoutesFixture,
  cleanup,
};
