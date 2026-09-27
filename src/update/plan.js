'use strict';

/*
 * `manual update` 的计划（P3-02）。
 *
 *   影响分析（impact.analyzeProject，只读）
 *     → 受影响手册 → Runtime 目标（page:<id> / task:<id>）
 *     → 逐个目标试规划：有规划错误的目标单独报告为 blocked，不拖住其他目标
 *     → 页面已删除 / retired：只给出下线建议（pending-retirement），不删用户文件与旧图片
 *     → 基线缺失的已发布手册：保守地全部重建（full-rebuild-required）
 *
 * --plan 使用内存中的刷新后模型规划，不提交模型、不创建 Run；执行时先 refreshModel 提交源码指纹，
 * 再用已提交模型规划，确保缓存 key 反映源码变化（源码变了但文案没变，也要重新采集所需 Scene）。
 */

const fs = require('fs');
const path = require('path');

const { analyzeProject } = require('./impact');
const { collectPlanningInputs, plan: planSnapshot } = require('../runtime/planner');
const { resolveMode } = require('../cache/policy');
const releases = require('../publication/release-store');
const { sha256Hex } = require('../util/hash');

function targetOf(manualId) {
  const match = /^(page|task)-(.+)$/.exec(manualId);
  return match ? { type: match[1], id: match[2], ref: `${match[1]}:${match[2]}` } : null;
}

/** 正式文档相对上次发布的状态：unchanged / edited（将三方合并）/ missing（document-missing，需要决定）。 */
function documentState(projectRoot, stateDirAbs, manualId) {
  const release = releases.readCurrentRelease(stateDirAbs, manualId);
  if (!release) return { state: 'unpublished', documentPath: null };
  const file = path.join(projectRoot, release.documentPath);
  if (!fs.existsSync(file)) return { state: 'missing', documentPath: release.documentPath };
  const hash = sha256Hex(fs.readFileSync(file));
  return { state: hash === String(release.documentHash).replace(/^sha256:/, '') ? 'unchanged' : 'edited', documentPath: release.documentPath };
}

/**
 * 从影响分析得到候选目标、下线建议与阻塞项（不规划）。
 */
function selectTargets({ projectRoot, stateDirAbs, analysis }) {
  const candidates = new Map();
  const retirement = [];
  const blocked = [];
  for (const section of analysis.sections) {
    const target = targetOf(section.manualId);
    if (!target) continue;
    if (section.retirement) {
      retirement.push({
        manualId: section.manualId,
        documentPath: section.documentPath,
        status: 'pending-retirement',
        suggestion: `页面 ${target.id} 已不存在：确认下线后删除或重定向 ${section.documentPath}；工具不会自动删除文档和旧图片。`,
      });
      continue;
    }
    if (section.brokenReference) {
      blocked.push({ manualId: section.manualId, target: target.ref, code: 'page-not-active', errors: [`任务 ${target.id} 引用的页面已被删除：需要调整任务步骤或下线该任务，旧文档保留不变。`] });
      continue;
    }
    if (!candidates.has(section.manualId)) {
      candidates.set(section.manualId, { target: target.ref, manualId: section.manualId, confidence: section.confidence, reasonPaths: [], source: 'impact' });
    }
    const entry = candidates.get(section.manualId);
    entry.reasonPaths.push(...section.reasonPaths);
    if (section.confidence === 'conservative') entry.confidence = 'conservative';
  }
  for (const manualId of analysis.fullRebuild?.manualIds || []) {
    const target = targetOf(manualId);
    if (!target || candidates.has(manualId) || blocked.some((b) => b.manualId === manualId)) continue;
    candidates.set(manualId, { target: target.ref, manualId, confidence: 'conservative', reasonPaths: [['(no-baseline)', manualId]], source: 'full-rebuild' });
  }
  const targets = [...candidates.values()].sort((a, b) => a.manualId.localeCompare(b.manualId))
    .map((entry) => ({ ...entry, document: documentState(projectRoot, stateDirAbs, entry.manualId) }));
  return { targets, retirement, blocked };
}

/**
 * 逐个目标试规划，再把可规划的目标合成一个计划。
 * @param {object} p.base       { model, modelRevision }（--plan 用内存刷新后的模型，执行用已提交模型）
 */
function planUpdateTargets({ projectRoot, config, base, targets, flags = {}, copy = { mode: 'model' }, acceptReview = false, force = false, cacheStore = null }) {
  const mode = resolveMode(flags);
  const policy = { command: 'update', copy, acceptReview, force };
  const ok = [];
  const blocked = [];
  for (const target of targets) {
    try {
      const snapshot = collectPlanningInputs({ projectRoot, config, base, targets: [target.target], mode, cacheStore });
      const single = planSnapshot(snapshot, policy);
      if (single.errors.length) blocked.push({ manualId: target.manualId, target: target.target, code: codeOf(single.errors[0]), errors: single.errors });
      else ok.push(target);
    } catch (error) {
      blocked.push({ manualId: target.manualId, target: target.target, code: error.code || 'invalid-plan', errors: error.errors || [error.message] });
    }
  }
  if (ok.length === 0) return { ok, blocked, plan: null, planHash: null, errors: [], mode };
  const snapshot = collectPlanningInputs({ projectRoot, config, base, targets: ok.map((t) => t.target), mode, cacheStore });
  const combined = planSnapshot(snapshot, policy);
  return { ok, blocked, plan: combined.plan, planHash: combined.planHash, errors: combined.errors, mode, snapshot };
}

function codeOf(message) {
  return /^([a-z][a-z0-9-]+):/.exec(String(message || ''))?.[1] || 'invalid-plan';
}

/**
 * 只读计划（--plan）：影响分析 + 内存刷新后模型的规划。不写 .manual，不改正式文档。
 */
function previewUpdate({ projectRoot, config, base = null, flags, copy, acceptReview, force, cacheStore }) {
  const stateDirAbs = path.join(projectRoot, config.artifacts.stateDir);
  const analysis = analyzeProject({ projectRoot, config, base });
  const selected = selectTargets({ projectRoot, stateDirAbs, analysis });
  let planned = { ok: [], blocked: [], plan: null, planHash: null, errors: [] };
  if (selected.targets.length && analysis.model) {
    const { createProjectStore } = require('../store/project');
    const committed = createProjectStore({ stateDirAbs, docsOutputDir: config.docs.outputDir }).readCommitted();
    planned = planUpdateTargets({
      projectRoot, config, base: { model: { ...committed.model, pages: analysis.model.pages }, modelRevision: committed.modelRevision },
      targets: selected.targets, flags, copy, acceptReview, force, cacheStore,
    });
  }
  return { analysis, ...selected, planned };
}

module.exports = { targetOf, documentState, selectTargets, planUpdateTargets, previewUpdate };
