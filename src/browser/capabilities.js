'use strict';

/*
 * Provider 能力声明。
 *
 * 每个 provider 类用静态 capabilities 显式声明能做什么；planner 在执行前按任务需要检查，
 * 缺能力时在计划阶段就给出 capability-missing，而不是执行到一半才发现某个方法不存在。
 *
 *   capture          能导航并截图
 *   semanticActions  能按 role/name/label 等语义目标执行交互
 *   assertions       能执行页面状态断言
 *   storageExport    能导出 cookie / localStorage（认证刷新需要）
 *   privacyGeometry  能读取敏感元素几何（公开截图遮罩需要）
 *   popups           能跟踪同一流程里打开的弹窗 / 新标签
 */

const { adapterFor } = require('./index');
const { RuntimeError } = require('../runtime/errors');

const CAPABILITY_NAMES = ['capture', 'semanticActions', 'assertions', 'storageExport', 'privacyGeometry', 'popups'];

/** 某个 provider 配置声明的能力（全部键都有布尔值）。 */
function capabilitiesFor(providerConfig, id = providerConfig?.id || 'default') {
  const declared = adapterFor(id, providerConfig).capabilities || {};
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, declared[name] === true]));
}

/** 缺少的能力列表。 */
function missingCapabilities(capabilities, needed) {
  return needed.filter((name) => capabilities[name] !== true);
}

/** 缺能力时抛 capability-missing（C08：fail，不可重试）。 */
function requireCapabilities(providerConfig, needed, { id } = {}) {
  const capabilities = capabilitiesFor(providerConfig, id);
  const missing = missingCapabilities(capabilities, needed);
  if (missing.length > 0) {
    throw new RuntimeError('capability-missing', `Browser Provider "${id || providerConfig?.type}" 不支持: ${missing.join(', ')}。`, { missing });
  }
  return capabilities;
}

module.exports = { CAPABILITY_NAMES, capabilitiesFor, missingCapabilities, requireCapabilities };
