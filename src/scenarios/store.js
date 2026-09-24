'use strict';

/*
 * 显式 Scenario：.manual/scenarios/<id>.yaml。
 *
 * 没有显式文件时使用派生的默认 Scenario（scenarios/model.js）。显式文件是用户定义，
 * 读取时做 schema 校验与版本检查；本阶段不自动写入，避免把派生值固化成用户定义。
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { validateScenario } = require('../model/schema');
const { isSafeId } = require('../model/ids');
const { withRevision } = require('./model');

function scenariosDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'scenarios');
}

/** 读取一个显式 Scenario；不存在返回 { ok: true, scenario: null }。 */
function readScenario(stateDirAbs, id, context = {}) {
  if (!isSafeId(id)) return { ok: false, errors: [`Scenario id 非法: ${id}`] };
  const file = path.join(scenariosDirFor(stateDirAbs), `${id}.yaml`);
  if (!fs.existsSync(file)) return { ok: true, scenario: null };
  let parsed;
  try {
    parsed = yaml.load(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`${id}.yaml: ${error.message}`] };
  }
  const checked = validateScenario(parsed, context);
  if (!checked.ok) return { ok: false, errors: checked.errors.map((e) => `${id}.yaml ${e.path}: ${e.code} ${e.message}`) };
  return { ok: true, scenario: withRevision(parsed) };
}

/** 显式定义优先，否则用派生的默认值。 */
function resolveScenario(stateDirAbs, derived, context = {}) {
  const explicit = readScenario(stateDirAbs, derived.id, context);
  if (!explicit.ok) return explicit;
  const scenario = explicit.scenario || derived;
  const checked = validateScenario(scenario, context);
  if (!checked.ok) return { ok: false, errors: checked.errors.map((e) => `Scenario ${scenario.id} ${e.path}: ${e.code} ${e.message}`) };
  return { ok: true, scenario, explicit: !!explicit.scenario };
}

module.exports = { scenariosDirFor, readScenario, resolveScenario };
