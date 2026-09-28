'use strict';

/**
 * 探测 baseUrl 是否被服务器重定向到另一个协议或主机（最常见：http 301 到 https）。
 * 配置里的地址和浏览器实际停留的地址不一致时，登录判定、缓存 origin、截图 URL 都会对不上，
 * 所以 init / auth login / doctor 都先做这一步，而不是等浏览器超时再猜。
 * 网络不通时返回 null：连不上由各命令自己的错误分类负责，这里不重复报错。
 */
async function probeRedirect(url, { timeout = 5000, maxHops = 5, fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const start = new URL(url);
  let current = start;
  const hops = [];
  for (let i = 0; i < maxHops; i += 1) {
    let response;
    try {
      response = await fetchImpl(current.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    } catch (_) {
      return null;
    }
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (!location) break;
    const next = new URL(location, current);
    hops.push({ status: response.status, from: current.href, to: next.href });
    current = next;
  }
  return {
    finalUrl: current.href,
    hops,
    schemeChanged: current.protocol !== start.protocol,
    hostChanged: current.host !== start.host,
  };
}

/** 只有协议或主机变了才值得提醒；同站内跳到 /login 之类是正常行为。 */
function redirectWarning(baseUrl, probe) {
  if (!probe || (!probe.schemeChanged && !probe.hostChanged)) return null;
  const target = new URL(probe.finalUrl).origin;
  return `baseUrl ${new URL(baseUrl).origin} 会被服务器重定向到 ${target}（${probe.hops.map((h) => h.status).join(' → ')}）。`
    + `建议把 .manual/config.yaml 的 project.baseUrl 改成 ${target}，否则登录判定、认证缓存和截图地址可能对不上。`;
}

module.exports = { probeRedirect, redirectWarning };
