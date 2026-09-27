'use strict';

/*
 * 缓存查找（契约 C09）。按固定顺序检查，任一步失败都给出 miss reason：
 *
 *   1. key         not-found / input-changed（附 changedFields）
 *   2. schema      entry 版本不被支持 → policy-changed
 *   3. 产物        不可变引用缺失 / hash 不符 → artifact-missing / hash-mismatch
 *   4. 验证范围    所需 scope 未全部通过 → validation-insufficient
 *   5. 隐私        公开发布时 privacy 未知 / 未检测 → validation-insufficient；隐私规则 revision 变了 → policy-changed
 *   6. 新鲜度      软 TTL 过期 → expired（offline 模式仍可用，标 stale）
 *   环境未知（environment 不确定）→ environment-unknown，不复用。
 *
 * 查找只读：命中不写新的 observedAt，返回原观察时间与来源 key（reusedFrom）。
 */

const { verifyOutputRefs } = require('../evidence/integrity');
const { changedFields } = require('./keys');
const { freshnessPolicy } = require('./policy');
const { CACHE_ENTRY_VERSION } = require('./store');

const MISS_REASONS = ['not-found', 'input-changed', 'expired', 'artifact-missing', 'hash-mismatch', 'validation-insufficient', 'policy-changed', 'environment-unknown'];

function miss(reason, extra = {}) {
  return { hit: false, reason, ...extra };
}

/**
 * @param {object} p
 * @param {object} p.store        createCacheStore()
 * @param {{ kind, key, input, uncertainty }} p.keyInfo  keys.buildKey() 的结果
 * @param {string} [p.subject]    逻辑对象标识（解释 input-changed）
 * @param {object} p.mode         policy.resolveMode()
 * @param {string} p.projectRoot
 * @param {string} p.stateDirAbs
 * @param {string[]} [p.requiredScopes]
 * @param {{ audience?, revision? }} [p.privacy]  当前发布受众与隐私规则 revision
 * @param {object} [p.cachePolicy]  项目配置里的 TTL 覆盖
 * @param {() => number} [p.now]
 */
function lookup({ store, keyInfo, subject = null, mode, projectRoot, stateDirAbs, requiredScopes = [], privacy = null, cachePolicy, now = () => Date.now() }) {
  const { kind, key } = keyInfo;
  if (!mode.read) return { hit: false, bypassed: mode.name, reason: null };
  if (keyInfo.uncertainty.includes('environment')) return miss('environment-unknown', { uncertainty: keyInfo.uncertainty });

  const entry = store.get(kind, key);
  if (!entry) {
    const previous = subject ? store.latestForSubject(kind, subject) : null;
    if (previous) return miss('input-changed', { changedFields: changedFields(previous.input, keyInfo.input), previousKey: previous.key });
    return miss('not-found');
  }
  if (entry.version !== CACHE_ENTRY_VERSION) return miss('policy-changed', { detail: 'entry-version' });

  const problems = verifyOutputRefs(projectRoot, stateDirAbs, entry.outputRefs);
  if (problems.length > 0) {
    const reason = problems.some((p) => p.code === 'hash-mismatch' || p.code === 'size-mismatch') ? 'hash-mismatch' : 'artifact-missing';
    return miss(reason, { problems });
  }

  const passed = new Set(entry.validationScopes || []);
  const lacking = requiredScopes.filter((scope) => !passed.has(scope));
  if (lacking.length > 0) return miss('validation-insufficient', { missingScopes: lacking });

  if (privacy && entry.privacy) {
    if (privacy.audience === 'public' && ['unknown', 'not-run', 'uncertain'].includes(entry.privacy.status)) {
      return miss('validation-insufficient', { detail: `privacy-${entry.privacy.status}` });
    }
    if (privacy.revision && entry.privacy.revision && privacy.revision !== entry.privacy.revision) {
      return miss('policy-changed', { detail: 'privacy-revision' });
    }
  }

  const freshness = freshnessPolicy(kind, keyInfo, cachePolicy);
  let stale = false;
  if (freshness.ttlMs !== null) {
    const age = now() - Date.parse(entry.observedAt);
    if (age > freshness.ttlMs) {
      if (!mode.ignoreTtl) return miss('expired', { observedAt: entry.observedAt, ttlMs: freshness.ttlMs });
      stale = true;
    }
  }

  return {
    hit: true,
    entry,
    reusedFrom: entry.key,
    inputHash: key,
    observedAt: entry.observedAt,
    outputRefs: entry.outputRefs,
    // 复用的是历史观察：没有在线确认远端现状。
    onlineChecked: false,
    stale,
    freshness: freshness.basis,
    uncertainty: [...new Set([...(entry.uncertainty || []), ...keyInfo.uncertainty])],
  };
}

/** offline 模式下没有可用证据：明确报错而不是悄悄生成。 */
function offlineMissError(result) {
  const { RuntimeError } = require('../runtime/errors');
  return new RuntimeError('cache-miss-offline', `离线模式下没有可复用的历史证据（${result.reason}）。去掉 --offline 以重新采集。`, { cacheReason: result.reason });
}

module.exports = { MISS_REASONS, lookup, offlineMissError };
