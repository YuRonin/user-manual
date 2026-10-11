'use strict';

/*
 * verify 的 Demo 结果：与标注覆盖率分开报告。
 *
 *   demo_privacy  手册引用的截图是否都通过了 Demo 门禁（privacy.demo.status = passed）；
 *                 没有 privacy.demo 的旧证据记为 legacy（采集于 Demo 之前，遮罩规则沿用旧版），不算通过也不伪造失败
 *   write_safety  这些截图采集期间的网络计数：被中止的写请求必须为 0；放行 / 授权 / Mock 的数量如实列出
 * 只读 Capture 记录，不读取任何图片或页面文本。
 */

/**
 * 可量化指标（Demo 方案 §7 "必须给出的客观数据"）：只用记录里的计数，不读图片与页面文本。
 *   maskedArea      每张图被遮罩的面积占比上界（旧证据的马赛克 / 仍需遮罩的表单控件）：平均值与最大值
 *   mock            Fixture 路由命中次数与声明了却没命中的规则（Fixture 是否已过期）
 *   uncoveredReads  没有 Fixture 也没有登记的数据读取次数（只出现在没有敏感区域的页面上，否则门禁不放行）
 *   realDataInBrowser 真实数据曾进入浏览器（已在画面上证明替换）的截图数
 *   gateFailures    最近一次采集被 Demo 门禁阻断的主体数与原因码分布（来自 demo-gate 记录）
 */
function demoMetrics(records = [], gateFailures = []) {
  const shots = records.filter(Boolean);
  const ratios = shots.map((r) => r.quality?.maskedAreaUpperBound).filter((v) => typeof v === 'number');
  const demos = shots.map((r) => r.privacy?.demo).filter(Boolean);
  const routes = demos.flatMap((d) => d.mock?.routes || []);
  const reasons = {};
  for (const failure of gateFailures) for (const code of failure.reasons || []) reasons[code] = (reasons[code] || 0) + 1;
  return {
    maskedArea: ratios.length ? { mean: Number((ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(4)), max: Number(Math.max(...ratios).toFixed(4)), heavilyRedacted: ratios.filter((v) => v > 0.15).length } : null,
    mock: { rules: routes.length, hits: routes.reduce((sum, r) => sum + Number(r.hits || 0), 0), unhit: [...new Set(demos.flatMap((d) => d.mock?.unhit || []))].sort() },
    uncoveredReads: demos.reduce((sum, d) => sum + Number(d.network?.uncovered || 0), 0),
    realDataInBrowser: demos.filter((d) => d.realDataInBrowser).length,
    gateFailures: { total: gateFailures.length, blocked: gateFailures.filter((f) => f.status === 'blocked').length, needsFixture: gateFailures.filter((f) => f.status === 'needs_fixture').length, reasons },
  };
}

function summarizeDemoSafety(records = [], { gateFailures = [] } = {}) {
  const shots = records.filter(Boolean);
  const passed = shots.filter((r) => r.privacy?.demo?.status === 'passed');
  const legacy = shots.filter((r) => !r.privacy?.demo);
  const failed = shots.length - passed.length - legacy.length;
  const sum = (field) => passed.reduce((total, r) => total + Number(r.privacy.demo.network?.[field] || 0), 0);
  const sources = (field) => passed.reduce((total, r) => total + Number(r.privacy.demo.sources?.[field] || 0), 0);
  const blocked = sum('blocked');
  return {
    demo_privacy: {
      status: failed > 0 ? 'failed' : legacy.length > 0 ? 'legacy' : 'passed',
      total: shots.length,
      passed: passed.length,
      legacy: legacy.length,
      failed,
      sources: { api_mock: sources('api_mock'), dom_replace: sources('dom_replace') },
      unverifiedSurfaces: passed.reduce((total, r) => total + Number(r.privacy.demo.surfaces?.iframe || 0) + Number(r.privacy.demo.surfaces?.canvas || 0), 0),
    },
    write_safety: {
      status: blocked > 0 ? 'failed' : legacy.length === shots.length && shots.length > 0 ? 'unknown' : 'passed',
      blockedWrites: blocked,
      mocked: sum('mocked'),
      allowed: sum('allowed'),
      authorized: sum('authorized'),
      suppressed: sum('suppressed'),
    },
    metrics: demoMetrics(shots, gateFailures),
  };
}

/** 手册引用图片（facts.images：{ captureId }）对应 Capture 记录的 Demo 结果。没有 captureId 的图片按 legacy 计。 */
function demoSafetyForImages(root, config, images = []) {
  const path = require('path');
  const { listGateFailures } = require('../evidence/demo-gate-log');
  const { createCaptureStore } = require('../evidence/store');
  const store = createCaptureStore({ projectRoot: root, stateDirAbs: path.join(root, config.artifacts.stateDir) });
  const records = images.map((image) => (image.captureId ? store.read(image.captureId) : null) || { privacy: null });
  // 只统计这份手册涉及的主体：页面 page--<id>--*，任务步骤 task--<taskId>--*
  const subjects = new Set(records.map((r) => (r.subject?.taskId ? `task--${r.subject.taskId}--` : r.subject?.pageId ? `page--${r.subject.pageId}--` : null)).filter(Boolean));
  const gateFailures = listGateFailures(path.join(root, config.artifacts.stateDir)).filter((f) => [...subjects].some((prefix) => String(f.subject).startsWith(prefix)));
  return summarizeDemoSafety(records, { gateFailures });
}

/** 只有记录本身显示门禁失败或写请求被中止才算错误；legacy 只提示。 */
function demoSafetyErrors(result) {
  const errors = [];
  if (result?.demo_privacy?.status === 'failed') errors.push(`demo-privacy-failed: ${result.demo_privacy.failed} 张图的 Demo 门禁结论不是 passed，不能作为正式手册图片。`);
  if (result?.write_safety?.status === 'failed') errors.push(`write-safety-failed: 采集期间有 ${result.write_safety.blockedWrites} 个写请求被中止，截图状态不可信。`);
  return errors;
}

module.exports = { summarizeDemoSafety, demoMetrics, demoSafetyForImages, demoSafetyErrors };
