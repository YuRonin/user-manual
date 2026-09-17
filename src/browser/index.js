'use strict';

/*
 * Browser Provider 工厂。
 *
 * capture 只通过这里拿 provider，永远不 require playwright。加新 provider =
 * 写一个实现 BrowserProvider 契约的类，在 ADAPTERS 里登记它的 type，上层零改动。
 */

const { BrowserProvider, DEFAULT_READY_OPTIONS } = require('./provider');
const { PlaywrightBrowserProvider } = require('./playwright');
const { CaptureError, REASON } = require('./errors');
const { PROVIDER_TYPES } = require('../config/providers');

/** type → 实现类。config.yaml 里 provider 的 `type` 字段决定挂哪个。 */
const ADAPTERS = {
  [PROVIDER_TYPES.PLAYWRIGHT]: PlaywrightBrowserProvider,
  // [PROVIDER_TYPES.COMPUTER_USE]:  待实现
  // [PROVIDER_TYPES.AGENT_BROWSER]: 待实现
};

/** 已实现的 provider 类型。 */
function availableTypes() {
  return Object.keys(ADAPTERS);
}

/**
 * 按配置造一个 provider。
 * @param {object} options
 * @param {string} options.id             provider 在 config.yaml 里的 id
 * @param {object} options.providerConfig 该 provider 的配置（含 type）
 * @param {object} options.profile        截图规格
 */
function createProvider({ id, providerConfig, profile }) {
  const type = providerConfig && providerConfig.type;

  if (!type) {
    throw new CaptureError(
      REASON.PROVIDER_UNAVAILABLE,
      `Browser Provider "${id}" 没有 type 字段，无法决定用哪个实现。`
    );
  }

  const Adapter = ADAPTERS[type];
  if (!Adapter) {
    throw new CaptureError(
      REASON.PROVIDER_UNAVAILABLE,
      `Browser Provider "${id}" 的 type 是 "${type}"，当前版本还没有实现。`,
      { available: availableTypes() }
    );
  }

  return new Adapter({ id, providerConfig, profile });
}

module.exports = { createProvider, availableTypes, ADAPTERS, BrowserProvider, DEFAULT_READY_OPTIONS };
