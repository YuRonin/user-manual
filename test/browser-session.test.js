'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createBrowserSession } = require('../src/browser/session');
const { capabilitiesFor, requireCapabilities } = require('../src/browser/capabilities');
const { ADAPTERS, BrowserProvider } = require('../src/browser');
const cache = require('../src/auth/cache');

const profile = { kind: 'desktop', viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 };
const providerConfig = { type: 'playwright', headless: true, channel: 'chromium' };

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  ✗ ${name}\n    ${error.stack || error}\n`); }
}

// ---------------------------------------------------------------- 假 browserType：只计数，不启动真实进程

function fakeBrowserType() {
  const counts = { launches: 0, contexts: 0, contextCloses: 0, browserCloses: 0, launchOptions: [] };
  const browsers = [];
  const browserType = {
    async launch(options) {
      counts.launches += 1;
      counts.launchOptions.push(options);
      const browser = new EventEmitter();
      let connected = true;
      browser.isConnected = () => connected;
      browser.crash = () => { connected = false; browser.emit('disconnected'); };
      browser.close = async () => { if (connected) { connected = false; counts.browserCloses += 1; browser.emit('disconnected'); } };
      browser.newContext = async (options) => {
        counts.contexts += 1;
        const context = new EventEmitter();
        context.options = options;
        context.close = async () => { counts.contextCloses += 1; };
        context.newPage = async () => {
          const page = new EventEmitter();
          page.goto = async () => { if (!connected) throw new Error('Target closed'); return { status: () => 200 }; };
          page.url = () => 'http://app.test/';
          return page;
        };
        return context;
      };
      browsers.push(browser);
      return browser;
    },
  };
  return { browserType, counts, browsers };
}

function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.url === '/popup-source') {
      res.end('<a href="/popup-target" target="_blank">打开帮助</a>');
      return;
    }
    if (req.url === '/popup-target') {
      res.end('<h1>帮助中心</h1>');
      return;
    }
    if (req.url === '/hover-source') {
      res.end('<button aria-label="云盘" onmouseenter="document.querySelector(\'#search\').hidden=false">云盘</button><input id="search" placeholder="搜索我的文件" hidden>');
      return;
    }
    res.end('<h1>首页</h1>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

function storageFor(baseUrl, role) {
  const { hostname } = new URL(baseUrl);
  return {
    cookies: [{ name: 'role', value: role, domain: hostname, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }],
    origins: [{ origin: baseUrl, localStorage: [{ name: 'role', value: role }] }],
  };
}

(async () => {
  process.stdout.write('\nbrowser session\n');

  await test('同启动规格 3 个 Scenario：1 次 Browser launch、3 个 Context、3 次 Context close、1 次 Browser close', async () => {
    const fake = fakeBrowserType();
    const session = createBrowserSession({ browserType: fake.browserType });
    for (const scenario of ['member', 'admin', 'guest']) {
      await session.withScenario({ id: scenario, providerConfig, profile }, async (provider) => {
        await provider.open('http://app.test/');
      });
    }
    assert.deepStrictEqual([fake.counts.launches, fake.counts.contexts, fake.counts.contextCloses, fake.counts.browserCloses], [1, 3, 3, 0]);
    await session.close();
    assert.strictEqual(fake.counts.browserCloses, 1);
    assert.strictEqual(fake.counts.launchOptions[0].headless, true);
    assert.strictEqual(fake.counts.launchOptions[0].channel, undefined);
  });

  await test('启动规格不同（有头 / channel）使用不同 Browser；Scenario 失败仍关闭 Context、不关共享 Browser', async () => {
    const fake = fakeBrowserType();
    const session = createBrowserSession({ browserType: fake.browserType });
    await session.withScenario({ providerConfig, profile }, async (provider) => provider.open('http://app.test/'));
    await session.withScenario({ providerConfig: { ...providerConfig, headless: false }, profile }, async (provider) => provider.open('http://app.test/'));
    await session.withScenario({ providerConfig: { ...providerConfig, channel: 'chrome' }, profile }, async (provider) => provider.open('http://app.test/'));
    assert.strictEqual(fake.counts.launches, 3);
    await assert.rejects(session.withScenario({ providerConfig, profile }, async (provider) => {
      await provider.open('http://app.test/');
      throw Object.assign(new Error('断言失败'), { code: 'state-assertion-failed' });
    }), (e) => e.code === 'state-assertion-failed');
    assert.strictEqual(fake.counts.launches, 3);
    assert.strictEqual(fake.counts.contextCloses, fake.counts.contexts);
    assert.ok(fake.browsers[0].isConnected());
    await session.close();
    assert.strictEqual(fake.counts.browserCloses, 3);
  });

  await test('Browser 崩溃：当前 Scenario 以 browser-crashed（可重试）失败，下一个 Scenario 启动新进程', async () => {
    const fake = fakeBrowserType();
    const session = createBrowserSession({ browserType: fake.browserType });
    await assert.rejects(session.withScenario({ providerConfig, profile }, async (provider) => {
      await provider.open('http://app.test/');
      fake.browsers[0].crash();
      await provider.open('http://app.test/next');
    }), (e) => e.code === 'browser-crashed');
    await session.withScenario({ providerConfig, profile }, async (provider) => provider.open('http://app.test/'));
    assert.strictEqual(fake.counts.launches, 2);
    assert.strictEqual(session.stats().crashes, 1);
    await session.close();
  });

  await test('启动浏览器期间 session 被关闭（取消）：新启动的 Browser 立即关闭，不残留进程', async () => {
    const fake = fakeBrowserType();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const slowType = { launch: async (options) => { await gate; return fake.browserType.launch(options); } };
    const session = createBrowserSession({ browserType: slowType });
    const pending = session.withScenario({ providerConfig, profile }, async (provider) => provider.open('http://app.test/'));
    await session.close();
    release();
    await assert.rejects(pending, (e) => e.code === 'session-closed');
    assert.strictEqual(fake.counts.launches, 1);
    assert.strictEqual(fake.counts.browserCloses, 1);
    assert.strictEqual(fake.browsers[0].isConnected(), false);
  });

  await test('Context 注入 viewport / DPR / locale / timezone 与认证快照；匿名 Scenario 不注入', async () => {
    const fake = fakeBrowserType();
    const session = createBrowserSession({ browserType: fake.browserType });
    const contexts = [];
    const auth = { status: 'stored', storageState: { cookies: [], origins: [] }, capabilities: [] };
    await session.withScenario({ providerConfig, profile: { ...profile, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'Asia/Shanghai' }, auth }, async (provider) => {
      await provider.open('http://app.test/');
      contexts.push(provider.context.options);
      provider.exportStorageState = async () => null;
    });
    await session.withScenario({ providerConfig, profile, auth: { status: 'disabled', storageState: null } }, async (provider) => {
      await provider.open('http://app.test/');
      contexts.push(provider.context.options);
    });
    assert.strictEqual(contexts[0].deviceScaleFactor, 2);
    assert.strictEqual(contexts[0].locale, 'en-US');
    assert.strictEqual(contexts[0].timezoneId, 'Asia/Shanghai');
    assert.ok(contexts[0].storageState);
    assert.strictEqual(contexts[1].storageState, undefined);
    assert.strictEqual(contexts[1].locale, undefined);
    await session.close();
  });

  await test('能力声明：Playwright 全部能力为真；未声明的 provider 在执行前报 capability-missing', async () => {
    assert.deepStrictEqual(capabilitiesFor(providerConfig), { capture: true, semanticActions: true, assertions: true, storageExport: true, privacyGeometry: true, popups: true, routeMocking: true });
    class ScreenshotOnly extends BrowserProvider { static get capabilities() { return { capture: true }; } }
    ADAPTERS['screenshot-only'] = ScreenshotOnly;
    try {
      assert.throws(() => requireCapabilities({ type: 'screenshot-only' }, ['capture', 'semanticActions', 'popups'], { id: 'shot' }),
        (e) => e.code === 'capability-missing' && e.missing.join() === 'semanticActions,popups');
      assert.ok(requireCapabilities({ type: 'screenshot-only' }, ['capture']).capture);
    } finally {
      delete ADAPTERS['screenshot-only'];
    }
  });

  await test('真实 Chromium：member / admin 的 cookie 与 localStorage 不混用；弹窗按别名切换；共享 Browser 直到 session 关闭', async () => {
    const server = await startServer();
    const session = createBrowserSession();
    let sharedBrowser = null;
    try {
      const seen = {};
      for (const role of ['member', 'admin']) {
        await session.withScenario({ id: role, providerConfig, profile, auth: { status: 'stored', storageState: storageFor(server.baseUrl, role), capabilities: [] } }, async (provider) => {
          provider.exportStorageState = async () => null; // 本用例不写真实认证缓存
          await provider.open(`${server.baseUrl}/`);
          seen[role] = await provider.page.evaluate(() => ({ cookie: document.cookie, local: localStorage.getItem('role'), extra: localStorage.getItem('extra') }));
          await provider.page.evaluate((r) => localStorage.setItem('extra', r), role);
          sharedBrowser = sharedBrowser || provider.browser;
          assert.strictEqual(provider.browser, sharedBrowser);
        });
        assert.ok(sharedBrowser.isConnected(), 'Scenario 关闭后共享 Browser 仍在');
      }
      assert.deepStrictEqual(seen.member, { cookie: 'role=member', local: 'member', extra: null });
      assert.deepStrictEqual(seen.admin, { cookie: 'role=admin', local: 'admin', extra: null });

      await session.withScenario({ id: 'popup', providerConfig, profile: { ...profile, locale: 'en-US' } }, async (provider) => {
        await provider.open(`${server.baseUrl}/popup-source`);
        assert.strictEqual(await provider.page.evaluate(() => navigator.language), 'en-US');
        await provider.performAction({ type: 'click', target: { role: 'link', name: '打开帮助' } });
        await provider.performAction({ type: 'inspect', page: 'popup-1', target: { role: 'heading', name: '帮助中心' } });
        assert.deepStrictEqual(provider.pageAliases(), ['main', 'popup-1']);
        await provider.usePage('main');
        await provider.assertCondition({ type: 'visible', target: { role: 'link', name: '打开帮助' } });
        await assert.rejects(provider.usePage('popup-9', { timeout: 100 }), (e) => e.code === 'page-alias-missing');
      });
      assert.strictEqual(session.stats().launches, 1);
    } finally {
      await session.close();
      await server.close();
    }
    assert.strictEqual(sharedBrowser.isConnected(), false);
  });

  await test('真实 Chromium：hover 动作展开子菜单而不点击', async () => {
    const server = await startServer();
    const session = createBrowserSession();
    try {
      await session.withScenario({ id: 'hover', providerConfig, profile }, async (provider) => {
        await provider.open(`${server.baseUrl}/hover-source`);
        await provider.performAction({ type: 'hover', target: { role: 'button', name: '云盘' } });
        assert.strictEqual(await provider.page.getByPlaceholder('搜索我的文件').isVisible(), true);
      });
    } finally {
      await session.close();
      await server.close();
    }
  });

  await test('凭据未变化的失败 Scenario 不写认证缓存；成功时刷新（generation CAS）', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-session-auth-'));
    const server = await startServer();
    const session = createBrowserSession();
    try {
      const ref = { root, cacheKey: 'demo', profile: 'member' };
      const initial = cache.writeState(ref, { origin: server.baseUrl, storageState: storageFor(server.baseUrl, 'member') });
      const auth = () => {
        const state = cache.readState(ref);
        return { ref, status: 'stored', storageState: state.storageState, generation: state.generation, expectedOrigin: server.baseUrl, identityRevision: null, capabilities: [] };
      };
      await assert.rejects(session.withScenario({ providerConfig, profile, auth: auth() }, async (provider) => {
        await provider.open(`${server.baseUrl}/`);
        throw Object.assign(new Error('断言失败'), { code: 'state-assertion-failed' });
      }));
      assert.strictEqual(cache.readState(ref).generation, initial.generation);
      const ok = await session.withScenario({ providerConfig, profile, auth: auth() }, async (provider) => {
        await provider.open(`${server.baseUrl}/`);
        return 'done';
      });
      assert.strictEqual(ok.value, 'done');
      assert.deepStrictEqual(ok.warnings, []);
      assert.strictEqual(cache.readState(ref).generation, initial.generation + 1);
    } finally {
      await session.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // 模拟轮换 refresh token 的站点（如 NeoAgent）：每次请求都换发新 token；旧 token 被复用 → 吊销全部。
  function startRotatingServer() {
    const state = { current: 't0', issued: 0, revokedAll: false, reuse: 0 };
    const server = http.createServer((req, res) => {
      const token = /(?:^|;\s*)rt=([^;]+)/.exec(req.headers.cookie || '')?.[1] || null;
      if (req.url === '/login') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>登录</h1>'); return; }
      if (state.revokedAll || !token) { res.writeHead(302, { location: '/login' }); res.end(); return; }
      if (token !== state.current) {
        state.reuse += 1;
        state.revokedAll = true;
        res.writeHead(302, { location: '/login' }); res.end(); return;
      }
      state.issued += 1;
      state.current = `t${state.issued}`;
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `rt=${state.current}; Path=/; HttpOnly; Max-Age=86400` });
      res.end('<h1>应用</h1>');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
      state,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    })));
  }

  function rotatingAuth(root, baseUrl) {
    const ref = { root, cacheKey: 'rotating', profile: 'member' };
    const host = new URL(baseUrl).hostname;
    const initial = cache.writeState(ref, {
      origin: baseUrl,
      storageState: { cookies: [{ name: 'rt', value: 't0', domain: host, path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] },
    });
    return { ref, auth: { ref, status: 'stored', storageState: initial.storageState, generation: initial.generation, expectedOrigin: baseUrl, identityRevision: null, capabilities: [] } };
  }

  await test('refresh token 轮换：失败的 Scenario 也写回新令牌，重试不会复用旧令牌', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-session-rotate-'));
    const server = await startRotatingServer();
    const session = createBrowserSession();
    try {
      const { ref, auth } = rotatingAuth(root, server.baseUrl);
      // 第一次：站点已轮换令牌，但 Scenario 因别的原因失败（例如目标不可见）
      await assert.rejects(session.withScenario({ providerConfig, profile, auth }, async (provider) => {
        await provider.open(`${server.baseUrl}/app`);
        throw Object.assign(new Error('目标不可见'), { code: 'target-not-visible' });
      }));
      assert.strictEqual(cache.readState(ref).storageState.cookies.find((c) => c.name === 'rt').value, 't1', '失败时也写回轮换后的令牌');
      // 重试：同一个 auth 对象（Runtime 重试就是这样），必须注入最新令牌
      const retried = await session.withScenario({ providerConfig, profile, auth }, async (provider) => (await provider.open(`${server.baseUrl}/app`)).finalUrl);
      assert.ok(!retried.value.endsWith('/login'), '重试不应被踢回登录页');
      assert.strictEqual(server.state.reuse, 0, '不得复用已作废的 refresh token');
      assert.strictEqual(cache.readState(ref).storageState.cookies.find((c) => c.name === 'rt').value, 't2');
    } finally {
      await session.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  await test('同一认证档案的并发 Scenario 串行使用凭据，不触发复用吊销', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-session-rotate-'));
    const server = await startRotatingServer();
    const session = createBrowserSession();
    try {
      const { auth } = rotatingAuth(root, server.baseUrl);
      const open = () => session.withScenario({ providerConfig, profile, auth }, async (provider) => (await provider.open(`${server.baseUrl}/app`)).finalUrl);
      const results = await Promise.all([open(), open(), open()]);
      assert.ok(results.every((r) => !r.value.endsWith('/login')), JSON.stringify(results.map((r) => r.value)));
      assert.strictEqual(server.state.reuse, 0);
      assert.strictEqual(server.state.issued, 3);
    } finally {
      await session.close();
      await server.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
})();
