'use strict';

/*
 * 缓存策略（契约 C09）。
 *
 * 新鲜度：
 *   - image / manual / source：纯内容寻址，输入不变就可复用，无时间 TTL。
 *   - capture：部署 build 与数据 revision 都已知（fixture / 静态）→ 按内容版本复用，无 TTL；
 *     任一未知（live 数据）→ 软 TTL，默认 15 分钟。
 *   - identity：同 Run 身份验证最长复用 5 分钟。
 * TTL 未过只表示"策略允许复用历史观察"，不证明远端没变：命中结果一律 onlineChecked=false。
 *
 * 模式：
 *   default     读 + 写，按 TTL 判断
 *   offline     只用历史证据：过期仍可用但标 stale；没有证据 → cache-miss-offline；不启动浏览器
 *   refresh     不复用 Capture / 生成结果（认证快照仍可复用），新结果照常写入缓存
 *   no-cache    不读也不写缓存索引；不删除任何历史 Capture
 */

const { RuntimeError } = require('../runtime/errors');

const DEFAULT_CACHE_POLICY = {
  captureTtlMs: 15 * 60 * 1000,
  identityTtlMs: 5 * 60 * 1000,
};

/** @returns {{ ttlMs: number|null, basis: 'content'|'soft-ttl' }} */
function freshnessPolicy(kind, { uncertainty = [] } = {}, config = DEFAULT_CACHE_POLICY) {
  const policy = { ...DEFAULT_CACHE_POLICY, ...(config || {}) };
  if (kind === 'identity') return { ttlMs: policy.identityTtlMs, basis: 'soft-ttl' };
  if (kind === 'capture') {
    const live = uncertainty.includes('deployedBuild') || uncertainty.includes('dataRevision');
    return live ? { ttlMs: policy.captureTtlMs, basis: 'soft-ttl' } : { ttlMs: null, basis: 'content' };
  }
  return { ttlMs: null, basis: 'content' };
}

/**
 * 命令行开关 → 读写语义。
 * @returns {{ name, read: boolean, write: boolean, ignoreTtl: boolean, browserAllowed: boolean, reuseAuth: boolean }}
 */
function resolveMode({ offline = false, refresh = false, noCache = false } = {}) {
  const chosen = [offline && 'offline', refresh && 'refresh', noCache && 'no-cache'].filter(Boolean);
  if (chosen.length > 1) {
    throw new RuntimeError('invalid-arguments', `--${chosen.join(' 与 --')} 不能同时使用。`);
  }
  if (offline) return { name: 'offline', read: true, write: false, ignoreTtl: true, browserAllowed: false, reuseAuth: true };
  if (refresh) return { name: 'refresh', read: false, write: true, ignoreTtl: false, browserAllowed: true, reuseAuth: true };
  if (noCache) return { name: 'no-cache', read: false, write: false, ignoreTtl: false, browserAllowed: true, reuseAuth: true };
  return { name: 'default', read: true, write: true, ignoreTtl: false, browserAllowed: true, reuseAuth: true };
}

module.exports = { DEFAULT_CACHE_POLICY, freshnessPolicy, resolveMode };
