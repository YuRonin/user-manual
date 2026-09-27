'use strict';

/*
 * Fixture 执行策略（P3-05）：在任何 setup / 请求拦截之前确认目标环境允许使用测试数据。
 *
 *   config.fixtures.environments = { <name>: { origins: ['http://127.0.0.1:*', ...], tenant? } }
 *
 * 规则（全部满足才允许）：
 *   - Scenario 的 environment 已在 config 中登记，且不是生产（名称 prod / production / live，或标了 production: true）；
 *   - 当前 baseUrl 的 origin 匹配该环境登记的 origins（端口可写 *）；
 *   - Fixture 自己的 environments 允许该环境；声明了 tenant 的环境必须与 fixture 的 tenant 一致；
 *   - hook 类 Fixture 的副作用等级只能是 isolated-test-data（写入按 Run 命名空间隔离的测试数据）。
 * 不满足时抛 fixture-policy-denied：不执行 setup、不安装拦截、不打开浏览器。
 */

const { RuntimeError } = require('../runtime/errors');

const PRODUCTION_NAMES = new Set(['prod', 'production', 'live', 'prd']);

function originMatches(pattern, origin) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`).test(origin);
}

function isProduction(name, envConfig = {}) {
  return PRODUCTION_NAMES.has(String(name).toLowerCase()) || envConfig.production === true;
}

/**
 * @param {object} p
 * @param {object} p.fixture    fixtures.readFixture() 的定义
 * @param {object} p.scenario
 * @param {object} p.config
 * @returns {{ ok: true, environment } | never}
 */
function checkFixtureAllowed({ fixture, scenario, config }) {
  const envName = scenario.environment || 'local';
  const registered = config.fixtures?.environments || {};
  const envConfig = registered[envName];
  const origin = new URL(config.project.baseUrl).origin;
  const errors = [];
  if (isProduction(envName, envConfig || {})) errors.push(`环境 ${envName} 是生产环境，禁止执行 Fixture。`);
  else if (!envConfig) errors.push(`环境 ${envName} 没有在 config.fixtures.environments 中登记，禁止执行 Fixture。`);
  else {
    const origins = Array.isArray(envConfig.origins) ? envConfig.origins : [];
    if (!origins.some((pattern) => originMatches(pattern, origin))) errors.push(`当前地址 ${origin} 不在环境 ${envName} 登记的 origins 中（${origins.join(', ') || '空'}）。`);
    if (envConfig.tenant && fixture.tenant && envConfig.tenant !== fixture.tenant) errors.push(`Fixture ${fixture.id} 属于租户 ${fixture.tenant}，环境 ${envName} 是 ${envConfig.tenant}。`);
  }
  if (!(fixture.environments || []).includes(envName)) errors.push(`Fixture ${fixture.id} 只允许在 ${(fixture.environments || []).join(', ') || '（无）'} 使用，当前环境 ${envName}。`);
  if (fixture.kind === 'hook' && fixture.sideEffectClass !== 'isolated-test-data') errors.push(`hook 类 Fixture 的 sideEffectClass 必须是 isolated-test-data（收到 ${fixture.sideEffectClass}）。`);
  if (errors.length) {
    throw new RuntimeError('fixture-policy-denied', `fixture-policy-denied: ${errors.join(' ')}`, { errors: errors.map((e) => `fixture-policy-denied: ${e}`) });
  }
  return { ok: true, environment: envName };
}

module.exports = { PRODUCTION_NAMES, originMatches, isProduction, checkFixtureAllowed };
