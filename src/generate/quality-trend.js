'use strict';

/*
 * 质量趋势（B6-03）：每次发布后把统一质量结果的关键计数记到 .manual/quality/<manualId>.json（只留最近 20 次），
 * generate / status 据此对比本次与上次，区分"单次页面异常"和"系统性回归"。只记数量，不记文本。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../util/atomic-write');

const KEEP = 20;

function fileOf(stateDirAbs, manualId) {
  return path.join(stateDirAbs, 'quality', `${manualId}.json`);
}

/** 质量结果 → 趋势比较用的计数。 */
function countsOf(quality = {}) {
  return {
    requiredMissingFromPlan: quality.planCoverage?.missing ?? null,
    renderFailed: quality.renderCoverage?.failed ?? null,
    documentationMissing: quality.documentationCoverage?.missing ?? null,
    inventoryPending: quality.inventoryReview?.pending ?? null,
    warnings: (quality.warnings || []).length + (quality.gate || []).length,
    claimsFailed: quality.claims?.failed?.length ?? null,
    stepsNotExecuted: quality.steps?.notExecuted ?? null,
    legacyImages: quality.privacy?.legacy ?? null,
  };
}

function readTrend(stateDirAbs, manualId) {
  try { return JSON.parse(fs.readFileSync(fileOf(stateDirAbs, manualId), 'utf8')).entries || []; } catch (_) { return []; }
}

function recordQuality(stateDirAbs, manualId, { releaseId = null, quality = null, at = new Date().toISOString() } = {}) {
  if (!quality) return null;
  const entries = [...readTrend(stateDirAbs, manualId), { at, releaseId, mode: quality.mode || null, verified: !!quality.verified, counts: countsOf(quality) }].slice(-KEEP);
  try {
    fs.mkdirSync(path.dirname(fileOf(stateDirAbs, manualId)), { recursive: true });
    writeFileAtomic(fileOf(stateDirAbs, manualId), JSON.stringify({ manualId, entries }, null, 2) + '\n');
  } catch (_) { return null; /* 趋势记录失败不影响发布 */ }
  return entries;
}

/** 本次相对上次变化的计数：{ key: { previous, current } }，只列出变化项。 */
function compareTrend(entries = []) {
  if (entries.length < 2) return null;
  const [previous, current] = entries.slice(-2);
  const changed = {};
  for (const key of Object.keys(current.counts || {})) {
    if ((previous.counts || {})[key] !== current.counts[key]) changed[key] = { previous: previous.counts?.[key] ?? null, current: current.counts[key] };
  }
  return { previousAt: previous.at, currentAt: current.at, changed, regressed: Object.values(changed).some((v) => Number(v.current) > Number(v.previous || 0)) };
}

/** 人读的一行：质量 vs 上次。 */
function trendLine(manualId, entries) {
  const diff = compareTrend(entries);
  if (!diff) return null;
  const parts = Object.entries(diff.changed).map(([key, v]) => `${key} ${v.previous ?? '∅'}→${v.current ?? '∅'}`);
  return `${manualId}：${parts.length ? parts.join('，') : '与上次相同'}${diff.regressed ? '（有回退）' : ''}`;
}

module.exports = { countsOf, readTrend, recordQuality, compareTrend, trendLine };
