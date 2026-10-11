'use strict';

/*
 * 标注失败的定向修复规划（B5-15 / B5-16 / B5-17）。
 *
 * 上次采集标注覆盖失败（缓存 miss: annotation-incomplete）时，不再一律整张重拍，而是按失败类别
 * （annotations/coverage.FAILURE_CATEGORY）选最小代价的动作：
 *
 *   derive   只有 draw 类失败（编号拥挤、出图、压在遮罩上）且主题 / 渲染器已经变了：沿用原图重新派生，
 *            不重新登录、不重新执行任务
 *   review   清单 / 计划 / 说明缺失（plan / inventory / description），或 draw / privacy 类失败而图像输入没变：
 *            重拍结果必然相同，交给人修定义或主题，不盲采
 *   relocate 定位 / 可见性失败：重新采集这个主体（页面或任务），有界短等待已在采集里做过
 *   replay   状态丢失（悬停冲突、截图后状态不再成立）：重新回放 Scenario / 步骤
 *   unrepairable  已用完修复预算，或需要回放的任务包含写步骤（不能在副作用未确认时自动重放）
 *
 * 修复预算独立于通用重试：每个采集主体在采集输入不变时最多连续定向修复 budget 次（默认 2）。
 */

const { categoryOf } = require('../annotations/coverage');

const DEFAULT_BUDGET = 2;

function featuresOf(failures) {
  return [...new Set(failures.map((f) => `${f.feature_id}:${f.reason}`))];
}

/**
 * @param {object} p
 * @param {Array<{ feature_id, reason, category? }>} p.failures  上次采集的覆盖失败
 * @param {number} [p.attempts]          已连续定向修复的次数
 * @param {number} [p.budget]
 * @param {boolean} [p.executesWrites]   任务包含写步骤
 * @param {boolean} [p.imageInputsChanged] 主题 / 隐私 / 渲染器自上次采集后变了
 * @returns {{ action, categories, features, message }}
 */
function repairDecision({ failures = [], attempts = 0, budget = DEFAULT_BUDGET, executesWrites = false, imageInputsChanged = false }) {
  const categories = [...new Set(failures.map((f) => f.category || categoryOf(f.reason)))].sort();
  const features = featuresOf(failures);
  const list = features.join('、') || '（没有逐项记录）';
  if (attempts >= budget) {
    return { action: 'unrepairable', categories, features,
      message: `annotation-unrepairable: 已连续定向修复 ${attempts} 次仍失败（${list}）。检查功能目标的定位、页面状态与标注主题后用 generate --refresh 重新采集。` };
  }
  if (categories.some((c) => ['plan', 'inventory', 'description'].includes(c))) {
    return { action: 'review', categories, features,
      message: `annotation-review-required: 标注失败来自功能清单 / 标注计划 / 说明（${list}），重新采集结果不变；用 manual describe 补齐功能与目标后再生成。` };
  }
  if (categories.length && categories.every((c) => c === 'draw' || c === 'privacy')) {
    if (imageInputsChanged && categories.every((c) => c === 'draw')) {
      return { action: 'derive', categories, features, message: `annotation-repair: 只有绘制失败（${list}），图像输入已变化，沿用原图重新派生。` };
    }
    return { action: 'review', categories, features,
      message: `annotation-review-required: ${categories.includes('privacy') ? '目标被隐私遮罩盖住' : '编号无法排版'}（${list}），重新采集同一画面结果不变；${categories.includes('privacy') ? '调整隐私规则或演示数据' : '调小主题的 maxMarkersPerImage 让它拆图，或调整 markerSize'}后再生成。` };
  }
  const replay = categories.includes('state');
  if (executesWrites) {
    return { action: 'unrepairable', categories, features,
      message: `annotation-unrepairable: 任务包含写步骤，不能为修复标注（${list}）自动重放；确认业务状态后用 generate --refresh 显式重新采集。` };
  }
  return { action: replay ? 'replay' : 'relocate', categories, features,
    message: `annotation-repair: ${replay ? '页面状态丢失，重新回放 Scenario' : '目标定位 / 可见性失败，重新采集'}（${list}；第 ${attempts + 1}/${budget} 次）。` };
}

module.exports = { DEFAULT_BUDGET, repairDecision };
