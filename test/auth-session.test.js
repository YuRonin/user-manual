'use strict';

const assert = require('assert');
const http = require('http');

const { createProvider } = require('../src/browser');

const profile = {
  kind: 'desktop',
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
};
const providerConfig = { type: 'playwright', headless: true, channel: 'chromium' };

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

function startAuthServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/seed') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'manual_sid=cookie-secret; HttpOnly; Path=/; SameSite=Lax',
      });
      res.end('<script>localStorage.setItem("manual_token", "local-secret")</script><p>ready</p>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<p>check</p>');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

async function main() {
  process.stdout.write('\nauth session\n');

  await test('provider factory 保留待导入的 storageState', async () => {
    const storageState = { cookies: [], origins: [] };
    const provider = createProvider({ id: 'test', providerConfig, profile, storageState });
    assert.strictEqual(provider.storageState, storageState);
    await provider.close();
  });

  await test('cookie 与 localStorage 可导出并恢复到新 context', async () => {
    const server = await startAuthServer();
    const first = createProvider({ id: 'test', providerConfig, profile });
    let second = null;
    try {
      await first.open(`${server.baseUrl}/seed`);
      const exported = await first.exportStorageState();
      assert.ok(exported.cookies.some((item) => item.name === 'manual_sid' && item.value === 'cookie-secret'));
      assert.ok(exported.origins.some((item) => item.localStorage.some((entry) => entry.name === 'manual_token' && entry.value === 'local-secret')));

      second = createProvider({ id: 'test', providerConfig, profile, storageState: exported });
      await second.open(`${server.baseUrl}/check`);
      const restored = await second.exportStorageState();
      assert.ok(restored.cookies.some((item) => item.name === 'manual_sid' && item.value === 'cookie-secret'));
      assert.ok(restored.origins.some((item) => item.localStorage.some((entry) => entry.name === 'manual_token' && entry.value === 'local-secret')));
    } finally {
      await first.close();
      if (second) await second.close();
      await server.close();
    }
  });

  process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
