'use strict';

/*
 * 等待预算（capture.waits）。慢环境可以放宽，但每一项都有上限：
 * 接口迟迟不返回时要明确报告等待超时，不能无限等待，也不能靠"静置"提前通过（B1-10）。
 *
 *   readinessMs   打开页面后等待就绪（加载中 / 指定元素 / 网络空闲）的上限
 *   stabilityMs   截图前等待 DOM 静止、数据请求结束的上限（每次尝试）
 *   authCheckMs   登录检查打开验证页的上限
 *   reloadOnStuckLoading  入口页在就绪上限后仍"加载中"时，有记录地刷新一次（只用于入口，从不重放动作）
 */

const DEFAULT_WAITS = { readinessMs: 30000, stabilityMs: 5000, authCheckMs: 15000, reloadOnStuckLoading: true };
const LIMITS = { readinessMs: [1000, 300000], stabilityMs: [500, 120000], authCheckMs: [1000, 300000] };

function validateWaits(waits, errors) {
  if (waits === undefined) return;
  if (!waits || typeof waits !== 'object' || Array.isArray(waits)) { errors.push('capture.waits 需要是对象。'); return; }
  for (const [field, [min, max]] of Object.entries(LIMITS)) {
    const value = waits[field];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) errors.push(`capture.waits.${field} 需要是 ${min}-${max} 之间的整数（毫秒）。`);
  }
  if (waits.reloadOnStuckLoading !== undefined && typeof waits.reloadOnStuckLoading !== 'boolean') errors.push('capture.waits.reloadOnStuckLoading 需要是布尔值。');
}

/** 合并默认值；手写的测试配置没有 capture.waits 时也可用。 */
function resolveWaits(config) {
  return { ...DEFAULT_WAITS, ...(config?.capture?.waits || {}) };
}

module.exports = { DEFAULT_WAITS, validateWaits, resolveWaits };
