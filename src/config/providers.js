'use strict';

/*
 * Browser Provider 注册表。
 *
 * Provider 回答「谁来驱动真实浏览器」。配置里每个 provider 有两层身份：
 *   id   —— 用户在 activeProvider 里引用的名字，同一 type 可以有多个实例
 *   type —— 决定运行时挂哪个 adapter：playwright | computer-use | agent-browser
 *
 * V0.1 只实现 playwright 两种形态。computer-use / agent-browser 的条目以注释示例
 * 形式写进生成的 config.yaml（见 render.js），将来接入时取消注释即可，结构不变。
 */

/** Adapter 类型常量。新增 provider 实现时先在这里登记 type。 */
const PROVIDER_TYPES = {
  PLAYWRIGHT: 'playwright',
  COMPUTER_USE: 'computer-use',
  AGENT_BROWSER: 'agent-browser',
};

const PROVIDERS = {
  'playwright-headless': {
    label: 'Playwright Headless — 无头 Chromium，快、适合批量截图',
    type: PROVIDER_TYPES.PLAYWRIGHT,
    config: { headless: true, channel: 'chromium' },
  },
  'playwright-headed': {
    label: 'Playwright Headed — 有头 Chromium，能看见操作过程，适合调试',
    type: PROVIDER_TYPES.PLAYWRIGHT,
    config: { headless: false, channel: 'chromium' },
  },
};

const DEFAULT_PROVIDER_ID = 'playwright-headless';

/** 可选的 provider id 列表。 */
function providerIds() {
  return Object.keys(PROVIDERS);
}

/** 取出一份 provider 配置的深拷贝（去掉仅用于 CLI 展示的 label）。未知 id 返回 null。 */
function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) return null;
  return { type: provider.type, ...provider.config };
}

module.exports = {
  PROVIDER_TYPES,
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  providerIds,
  getProvider,
};
