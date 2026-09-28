'use strict';

// 登录等待与 baseUrl 重定向预检：不启动浏览器，用假的 page / context 驱动轮询。
const assert = require('assert');

const { createProvider } = require('../src/browser');
const { probeRedirect, redirectWarning } = require('../src/util/redirect-probe');

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

function fakePage(url) {
  return { current: url, closed: false, url() { return this.current; }, isClosed() { return this.closed; } };
}

function providerWith(pages) {
  const provider = createProvider({
    id: 'auth-wait-test',
    profile: { kind: 'desktop', viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 },
    providerConfig: { type: 'playwright', headless: true },
  });
  provider.page = pages[0];
  provider.context = { pages: () => pages };
  provider.waitUntilReady = async () => ({ steps: {}, warnings: [] });
  return provider;
}

function fakeFetch(routes) {
  return async (url) => {
    const hit = routes[url];
    if (!hit) throw new Error(`unreachable ${url}`);
    return { status: hit.status, headers: { get: (name) => (name === 'location' ? hit.location || null : null) } };
  };
}

async function main() {
  await test('http 登录页被 301 到 https 后，回到应用页仍判定为已登录', async () => {
    const page = fakePage('https://app.test/login');
    const provider = providerWith([page]);
    setTimeout(() => { page.current = 'https://app.test/chat'; }, 30);
    const result = await provider.waitForAuthentication({ loginUrl: 'http://app.test/login', timeout: 2000, pollInterval: 10 });
    assert.strictEqual(result.finalUrl, 'https://app.test/chat');
  });

  await test('在新标签页完成登录也能被发现，并切换到该页', async () => {
    const first = fakePage('https://app.test/login');
    const pages = [first];
    const provider = providerWith(pages);
    setTimeout(() => { pages.push(fakePage('https://app.test/home')); }, 30);
    const result = await provider.waitForAuthentication({ loginUrl: 'https://app.test/login', timeout: 2000, pollInterval: 10 });
    assert.strictEqual(result.finalUrl, 'https://app.test/home');
    assert.strictEqual(provider.page, pages[1]);
  });

  await test('停在第三方 SSO 主机不算登录完成', async () => {
    const page = fakePage('https://sso.other.test/authorize');
    const provider = providerWith([page]);
    await assert.rejects(
      provider.waitForAuthentication({ loginUrl: 'https://app.test/login', timeout: 60, pollInterval: 10 }),
      (error) => error.code === 'auth-timeout' && error.message.includes('https://sso.other.test/authorize'),
    );
  });

  await test('窗口在保存前被关闭时立即报 auth-window-closed', async () => {
    const page = fakePage('https://app.test/login');
    const provider = providerWith([page]);
    setTimeout(() => { page.closed = true; }, 20);
    const started = Date.now();
    await assert.rejects(
      provider.waitForAuthentication({ loginUrl: 'https://app.test/login', timeout: 5000, pollInterval: 10 }),
      (error) => error.code === 'auth-window-closed',
    );
    assert.ok(Date.now() - started < 1000, '不应等到超时');
  });

  await test('等待过程输出进度', async () => {
    const page = fakePage('https://app.test/login');
    const provider = providerWith([page]);
    const messages = [];
    setTimeout(() => { page.current = 'https://app.test/chat'; }, 30);
    await provider.waitForAuthentication({ loginUrl: 'https://app.test/login', timeout: 2000, pollInterval: 10, onProgress: (m) => messages.push(m) });
    assert.ok(messages.some((m) => m.includes('已打开登录页')));
    assert.ok(messages.some((m) => m.includes('检测到已离开登录页')));
  });

  await test('probeRedirect 识别 http → https 并给出修改建议', async () => {
    const probe = await probeRedirect('http://app.test', {
      fetchImpl: fakeFetch({ 'http://app.test/': { status: 301, location: 'https://app.test/' }, 'https://app.test/': { status: 200 } }),
    });
    assert.strictEqual(probe.schemeChanged, true);
    const warning = redirectWarning('http://app.test', probe);
    assert.ok(warning.includes('https://app.test'));
  });

  await test('同站内跳到 /login 不提醒；连不上返回 null', async () => {
    const probe = await probeRedirect('https://app.test', {
      fetchImpl: fakeFetch({ 'https://app.test/': { status: 302, location: '/login' }, 'https://app.test/login': { status: 200 } }),
    });
    assert.strictEqual(redirectWarning('https://app.test', probe), null);
    assert.strictEqual(await probeRedirect('https://down.test', { fetchImpl: fakeFetch({}) }), null);
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
