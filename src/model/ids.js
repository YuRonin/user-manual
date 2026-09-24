'use strict';

/*
 * 标识规则（契约 C01）。
 *
 * 业务 ID（page / userTask / scenario / step / assertion / claim）是安全 slug：
 * 可以直接进入文件名，首次可由 route 建议，之后不随路由变化重算。
 * 运行 ID（project / run / capture / release）是随机 UUID，不能用时间戳充当唯一性。
 */

const crypto = require('crypto');

const SAFE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_ID_MAX = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// 未显式声明 id 的断言由执行器生成 <page>:<state>#<index>，只允许在引用侧出现。
const GENERATED_ASSERTION_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*#\d+$/;

function isSafeId(value) {
  return typeof value === 'string' && value.length <= SAFE_ID_MAX && SAFE_ID_RE.test(value);
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isAssertionRef(value) {
  return isSafeId(value) || (typeof value === 'string' && GENERATED_ASSERTION_ID_RE.test(value));
}

function newUuid() {
  return crypto.randomUUID();
}

/** 把任意文字建议成 slug；结果为空时回退到 fallback。只用于"首次建议"，不用于重算身份。 */
function suggestSlug(text, fallback = 'item') {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SAFE_ID_MAX)
    .replace(/-+$/, '');
  return slug || fallback;
}

module.exports = {
  SAFE_ID_RE,
  SAFE_ID_MAX,
  UUID_RE,
  isSafeId,
  isUuid,
  isAssertionRef,
  newUuid,
  suggestSlug,
};
