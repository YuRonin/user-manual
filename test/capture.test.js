'use strict';

/*
 * `manual capture` 的端到端测试。
 *
 * 全程是真的：真 HTTP 服务器、真 Chromium、真 PNG 文件。
 * capture 的整个价值就是「不伪造」，所以测试也不能用 mock 糊过去。
 */

const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const fx = require('./fixtures');
const { startServer } = require('./server');
const authCache = require('../src/auth/cache');

const CLI = path.resolve(__dirname, '..', 'bin', 'manual.js');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failures.push({ name, error: e });
    process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`);
  }
}

/*
 * 必须是异步 spawn，不能用 spawnSync。
 * 测试服务器跑在本进程里，spawnSync 会阻塞事件循环 —— 服务器就没法响应
 * 被测浏览器的请求，整个测试直接死锁。这个坑踩过一次。
 */
function run(cmd, root, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, cmd, ...args, '--project-root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`命令超时: manual ${cmd} ${args.join(' ')}`));
    }, 120000);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

function pageYaml(root, id) {
  return yaml.load(fs.readFileSync(path.join(root, '.manual', 'pages', `${id}.yaml`), 'utf8'));
}

// 原图按内容寻址安装：<rawDir>/<page-id>--<sha256 前 16 位>.png，路径以页面投影为准。
const RAW_CHAT = /^\.manual\/artifacts\/raw\/pages\/chat--[0-9a-f]{16}\.png$/;

function rawShot(root, id) {
  return path.join(root, pageYaml(root, id).browser.screenshot);
}

/** 失败时：没有任何该页原图、没有已提交的 Capture 记录、也没有残留 staging。 */
function noShot(root, id) {
  const rawDir = path.join(root, '.manual', 'artifacts', 'raw', 'pages');
  const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).filter((f) => f.startsWith(`${id}--`) || f === `${id}.png`) : [];
  const evidence = path.join(root, '.manual', 'evidence');
  const records = fs.existsSync(path.join(evidence, 'captures')) ? fs.readdirSync(path.join(evidence, 'captures')) : [];
  const staging = fs.existsSync(path.join(evidence, 'staging')) ? fs.readdirSync(path.join(evidence, 'staging')) : [];
  return files.length === 0 && records.length === 0 && staging.length === 0;
}

function projectYaml(root) {
  return yaml.load(fs.readFileSync(path.join(root, '.manual', 'project.yaml'), 'utf8'));
}

/** 直接读 PNG 的 IHDR 拿真实像素尺寸——验证 DPR 有没有生效。 */
function readPngSize(file) {
  const buf = fs.readFileSync(file);
  assert.strictEqual(buf.slice(1, 4).toString('ascii'), 'PNG', `${file} 不是 PNG`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 建好一个「已 init + 已 inspect」的项目，baseUrl 指向测试服务器。 */
async function prepareProject(baseUrl, initArgs = []) {
  const root = fx.captureFixture();
  const init = await run('init', root, ['--base-url', baseUrl, ...initArgs]);
  assert.strictEqual(init.status, 0, `init 失败: ${init.stderr}`);
  const inspect = await run('inspect', root, []);
  assert.strictEqual(inspect.status, 0, `inspect 失败: ${inspect.stderr}`);
  return root;
}

async function main() {
  const server = await startServer();
  process.stdout.write(`\nmanual capture  (测试服务器 ${server.baseUrl})\n`);

  // ------------------------------------------------------------ 成功路径
  await test('截出真实 PNG，并按 viewport × DPR 得到高清尺寸', async () => {
    const root = await prepareProject(server.baseUrl); // 默认 desktop-standard 1440x900 @2x
    try {
      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 0, r.stderr);

      const out = rawShot(root, 'chat');
      assert.ok(fs.existsSync(out), `截图未生成: ${out}`);

      // 1440x900 @2x → 2880x1800 像素
      const size = readPngSize(out);
      assert.deepStrictEqual(size, { width: 2880, height: 1800 });
      assert.ok(fs.statSync(out).size > 1000, '截图文件太小，可能是空图');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('输出路径是 .manual/artifacts/raw/pages/<page-id>.png（原图不进文档目录）', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['chat', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.match(out.screenshot, RAW_CHAT);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('capture 优先使用 forward index 中的当前路由', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const pageFile = path.join(root, '.manual', 'pages', 'chat.yaml');
      fs.writeFileSync(
        pageFile,
        fs.readFileSync(pageFile, 'utf8').replace('route: /chat', 'route: /stale-chat'),
        'utf8'
      );

      const r = await run('capture', root, ['chat', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).url, `${server.baseUrl}/chat`);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('索引缺失或损坏时 capture 回退页面 YAML', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      fs.rmSync(path.join(root, '.manual', 'index'), { recursive: true });
      let r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 0, r.stderr);

      fs.writeFileSync(path.join(root, '.manual', 'index', 'forward.json'), '{broken', 'utf8');
      r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(pageYaml(root, 'chat').browser.url, `${server.baseUrl}/chat`);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('capture 后回写页面模型的 browser 状态', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const before = pageYaml(root, 'chat');
      assert.strictEqual(before.browser.verified, false);

      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 0, r.stderr);

      const after = pageYaml(root, 'chat');
      assert.strictEqual(after.browser.verified, true);
      assert.match(after.browser.screenshot, RAW_CHAT);
      assert.strictEqual(after.browser.url, `${server.baseUrl}/chat`);
      assert.strictEqual(after.browser.viewport, '1440x900');
      assert.strictEqual(after.browser.deviceScaleFactor, 2);
      assert.strictEqual(after.browser.provider, 'playwright-headless');
      assert.ok(
        /^\d{4}-\d{2}-\d{2}T/.test(after.browser.lastCapture),
        `lastCapture 应是 ISO 时间戳: ${after.browser.lastCapture}`
      );
      // 扫描字段一个都不能被动
      assert.strictEqual(after.route, '/chat');
      assert.strictEqual(after.entry, 'app/chat/page.tsx');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('project.yaml 索引同步更新', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('capture', root, ['chat']);
      const proj = projectYaml(root);
      assert.strictEqual(proj.summary.browserVerified, 1);
      assert.strictEqual(proj.summary.captured, 1);
      const chat = proj.pages.find((p) => p.id === 'chat');
      assert.strictEqual(chat.browserVerified, true);
      assert.match(chat.screenshot, RAW_CHAT);

      const forward = JSON.parse(fs.readFileSync(
        path.join(root, '.manual', 'index', 'forward.json'),
        'utf8'
      ));
      assert.match(forward['/chat'].screenshot, RAW_CHAT);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('分析完成的页面截图后 confidence 升级为 verified', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('describe', root, ['--id', 'chat', '--title', '工作台', '--purpose', '与助手对话。']);
      assert.strictEqual(pageYaml(root, 'chat').confidence, 'inferred');

      await run('capture', root, ['chat']);
      assert.strictEqual(pageYaml(root, 'chat').confidence, 'verified');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('未分析的页面截图后 confidence 不会虚报成 verified', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('capture', root, ['chat']);
      const p = pageYaml(root, 'chat');
      assert.strictEqual(p.browser.verified, true, '浏览器确实验证过了');
      assert.strictEqual(p.confidence, 'none', '但语义还没分析，不该是 verified');
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 等待策略
  await test('等异步内容：不会拍到「加载中…」', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['chat', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.readySteps.load, 'ok');
      assert.strictEqual(out.readySteps.fonts, 'ready');
      assert.strictEqual(out.readySteps.domQuiet, 'quiet');
      // 到这一步图片必须全部加载完。多数情况下 load/networkidle 已经等过了，
      // 所以这里通常是 none-pending；只有 load 之后才插入的图片才会走到 loaded。
      // 两者都表示「没有图片还在加载」，都算通过。
      assert.ok(
        ['none-pending', 'loaded'].includes(out.readySteps.images.status),
        `不该有图片仍在加载，实际: ${JSON.stringify(out.readySteps.images)}`
      );
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--wait-for 能等到迟到 900ms 的内容', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['slow', '--wait-for', '[data-ready="true"]', '--json']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.strictEqual(JSON.parse(r.stdout).readySteps.waitFor, 'ok');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('冻结动画：无限旋转的 spinner 被处理掉', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['chat', '--json']);
      const out = JSON.parse(r.stdout);
      assert.ok(
        typeof out.readySteps.animationsFrozen === 'number' && out.readySteps.animationsFrozen >= 1,
        `应至少冻结 1 个动画，实际: ${out.readySteps.animationsFrozen}`
      );
    } finally {
      fx.cleanup(root);
    }
  });

  await test('同一页面连续两次截图，字节完全一致（可重复）', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('capture', root, ['chat']);
      const firstPage = pageYaml(root, 'chat');
      const first = fs.readFileSync(rawShot(root, 'chat'));
      await run('capture', root, ['chat']);
      const secondPage = pageYaml(root, 'chat');
      const second = fs.readFileSync(rawShot(root, 'chat'));
      assert.ok(first.equals(second), '两次截图不一致，说明还有未冻结的不确定性');
      // 内容相同 → 复用同一个内容寻址文件；但这是两次观察，各有自己的 Capture 记录
      assert.strictEqual(secondPage.browser.screenshot, firstPage.browser.screenshot);
      assert.notStrictEqual(secondPage.browser.latestCaptureId, firstPage.browser.latestCaptureId);
      const records = fs.readdirSync(path.join(root, '.manual', 'evidence', 'captures'));
      assert.strictEqual(records.length, 2);
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 规格与 Provider
  await test('--profile 覆盖截图规格，尺寸随之改变', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['chat', '--profile', 'desktop-wide']);
      assert.strictEqual(r.status, 0, r.stderr);
      // desktop-wide = 1920x1080 @1x
      const size = readPngSize(rawShot(root, 'chat'));
      assert.deepStrictEqual(size, { width: 1920, height: 1080 });
    } finally {
      fx.cleanup(root);
    }
  });

  await test('init 选的 laptop 规格被 capture 正确沿用', async () => {
    const root = await prepareProject(server.baseUrl, ['--profile', 'laptop']);
    try {
      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 0, r.stderr);
      // laptop = 1280x800 @2x → 2560x1600
      const size = readPngSize(rawShot(root, 'chat'));
      assert.deepStrictEqual(size, { width: 2560, height: 1600 });
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--full-page 截出比视口更高的整页', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      await run('capture', root, ['public-with-password', '--full-page']);
      const size = readPngSize(
        rawShot(root, 'public-with-password')
      );
      assert.strictEqual(size.width, 2880);
      assert.ok(size.height > 1800, `整页高度应超过一屏，实际 ${size.height}`);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('未实现的 provider type 给出明确错误而非崩溃', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const cfgPath = path.join(root, '.manual', 'config.yaml');
      fs.writeFileSync(
        cfgPath,
        fs.readFileSync(cfgPath, 'utf8').replace(
          '  activeProvider: playwright-headless',
          '  activeProvider: future-thing'
        ).replace(
          '    playwright-headless:\n      type: playwright',
          '    future-thing:\n      type: computer-use\n    playwright-headless:\n      type: playwright'
        )
      );
      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /computer-use/);
      assert.match(r.stderr, /还没有实现/);
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 失败路径：绝不伪造截图
  await test('项目没启动：报「连不上」且不产出截图', async () => {
    // 先占一个端口再释放，拿到一个确定关闭、且不在 Chromium 屏蔽名单里的端口。
    // 直接写 :1 会撞上 ERR_UNSAFE_PORT，测到的就不是「连不上」这条路径了。
    const probe = await startServer();
    const deadPort = probe.port;
    await probe.close();

    const root = await prepareProject(`http://127.0.0.1:${deadPort}`);
    try {
      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /连不上/);
      assert.match(r.stderr, /server-unreachable/);
      assert.match(r.stderr, /没在跑|启动开发服务器/);
      assert.ok(
        noShot(root, 'chat'),
        '失败时绝不能产出截图'
      );
      assert.strictEqual(pageYaml(root, 'chat').browser.verified, false, '失败不该标记为已验证');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('页面返回 404：报 404 并提示模型可能过期', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['missing-route']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /404/);
      assert.match(r.stderr, /http-not-found/);
      assert.match(r.stderr, /manual inspect/);
      assert.ok(noShot(root, 'missing-route'));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('被重定向到登录页：报「需要登录」', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['protected']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /auth-missing/);
      assert.match(r.stderr, /重定向到了登录页/);
      assert.match(r.stderr, /manual auth login --profile default/);
      assert.ok(noShot(root, 'protected'));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('认证缓存中的 cookie 与 localStorage 可用于受保护页面并被刷新', async () => {
    const root = await prepareProject(server.baseUrl);
    const cacheRoot = path.join(root, '.auth-cache');
    try {
      const config = yaml.load(fs.readFileSync(path.join(root, '.manual', 'config.yaml'), 'utf8'));
      const origin = new URL(server.baseUrl).origin;
      const ref = { root: cacheRoot, cacheKey: config.auth.cacheKey, profile: 'default' };
      const seeded = authCache.writeState(ref, {
        origin,
        storageState: {
          cookies: [{ name: 'manual_sid', value: 'cookie-secret', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }],
          origins: [{ origin, localStorage: [{ name: 'manual_token', value: 'local-secret' }] }],
        },
      }, { now: () => new Date('2026-01-01T00:00:00.000Z') });
      const r = await run('capture', root, ['protected', '--json'], { MANUAL_AUTH_CACHE_DIR: cacheRoot });
      assert.strictEqual(r.status, 0, r.stderr || r.stdout);
      assert.ok(!r.stdout.includes('cookie-secret'));
      assert.ok(!r.stdout.includes('local-secret'));
      assert.ok(authCache.readState(ref).updatedAt > seeded.updatedAt);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('存在但无效的认证缓存分类为 auth-expired', async () => {
    const root = await prepareProject(server.baseUrl);
    const cacheRoot = path.join(root, '.auth-cache');
    try {
      const config = yaml.load(fs.readFileSync(path.join(root, '.manual', 'config.yaml'), 'utf8'));
      authCache.writeState({ root: cacheRoot, cacheKey: config.auth.cacheKey, profile: 'default' }, {
        origin: new URL(server.baseUrl).origin,
        storageState: { cookies: [], origins: [] },
      });
      const r = await run('capture', root, ['protected'], { MANUAL_AUTH_CACHE_DIR: cacheRoot });
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /auth-expired/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('登录页本身可以正常截图，不会自我误判', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['login']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(fs.existsSync(rawShot(root, 'login')));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('正文很长的页面即使有密码框也不误判为登录页', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['public-with-password']);
      assert.strictEqual(r.status, 0, r.stderr);
      assert.ok(
        fs.existsSync(rawShot(root, 'public-with-password'))
      );
    } finally {
      fx.cleanup(root);
    }
  });

  await test('HTTP 500：报错并不产出截图', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['error500']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /HTTP 500/);
      assert.ok(noShot(root, 'error500'));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('白屏页面：报 blank-page 而不是截一张白图', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['blank']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /blank-page/);
      assert.ok(noShot(root, 'blank'));
    } finally {
      fx.cleanup(root);
    }
  });

  await test('加载超时：报 timeout 且不产出截图', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['chat', '--url', `${server.baseUrl}/hang`, '--timeout', '2000']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /timeout|超时/);
      assert.ok(noShot(root, 'chat'));
    } finally {
      fx.cleanup(root);
    }
  });

  // ------------------------------------------------------------ 参数与动态路由
  await test('动态路由缺参数：明确告诉用户缺什么、怎么补', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['artifact-id']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /动态路由/);
      assert.match(r.stderr, /缺少: id/);
      assert.match(r.stderr, /--params "id=<值>"/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--params 填上后动态路由能拼出真实地址', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      // /artifact/123 在测试服务器上是 404——这里要验证的是 URL 拼对了
      const r = await run('capture', root, ['artifact-id', '--params', 'id=123']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, new RegExp(`${server.baseUrl.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/artifact/123`));
      assert.match(r.stderr, /404/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('未知 page id：列出可用的页面', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['nope']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /找不到页面/);
      assert.match(r.stderr, /chat/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('没 init 就 capture：提示先 init', async () => {
    const root = fx.captureFixture();
    try {
      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /manual init/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('没 inspect 就 capture：提示先 inspect', async () => {
    const root = fx.captureFixture();
    try {
      await run('init', root, ['--base-url', server.baseUrl]);
      const r = await run('capture', root, ['chat']);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /manual inspect/);
    } finally {
      fx.cleanup(root);
    }
  });

  await test('--json 失败时也是结构化输出，含 reason 与 hint', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const r = await run('capture', root, ['missing-route', '--json']);
      assert.strictEqual(r.status, 1);
      const out = JSON.parse(r.stdout);
      assert.strictEqual(out.ok, false);
      assert.strictEqual(out.reason, 'http-not-found');
      assert.strictEqual(out.status, 404);
      assert.ok(out.hint && out.hint.length > 0, '失败必须带可操作的建议');
    } finally {
      fx.cleanup(root);
    }
  });

  await test('capture --help 可用', async () => {
    const r = spawnSync(process.execPath, [CLI, 'capture', '--help'], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /--params/);
    assert.match(r.stdout, /--wait-for/);
  });

  // ------------------------------------------------------------ 零侵入
  await test('capture 不碰业务代码，只写截图与 .manual/', async () => {
    const root = await prepareProject(server.baseUrl);
    try {
      const appBefore = fs.readFileSync(path.join(root, 'app', 'chat', 'page.tsx'), 'utf8');
      const pkgBefore = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

      await run('capture', root, ['chat']);

      assert.strictEqual(fs.readFileSync(path.join(root, 'app', 'chat', 'page.tsx'), 'utf8'), appBefore);
      assert.strictEqual(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), pkgBefore);
    } finally {
      fx.cleanup(root);
    }
  });

  await server.close();

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`测试运行器出错: ${e.stack || e}\n`);
  process.exitCode = 1;
});
