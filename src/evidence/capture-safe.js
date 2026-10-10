'use strict';

/*
 * 页面采集与任务采集共用的"稳定截图 + 安全派生"流程（契约 C06）。
 *
 * 1. 截图前读取几何快照（DOM mutation generation、滚动、视口、文档尺寸），
 *    在截图时刻重新解析标注目标并收集敏感元素；
 * 2. 截 raw；再读一次几何。前后不一致就丢弃本次尝试，有限重试后报 geometry-unstable；
 * 3. 离线从同一份 raw 派生 sanitized 与发布图，并生成 privacy 记录。
 * 不声称 DOM 与像素完全原子，只保证检测到变化时不产出发布图。
 */

const { planRedactions } = require('../artifacts/redaction');
const { layoutAnnotations } = require('../artifacts/annotation');
const { buildPrivacyRecord } = require('../publication/validate');
const { deriveImages } = require('./image-pipeline');
const { renderAnnotationResults } = require('./image-pipeline');
const { verifyCoverage } = require('../annotations/coverage');
const sharp = require('sharp');
const { checkpoint } = require('../runtime/faults');

const MAX_ATTEMPTS = 3;
const DEMO_SOURCES = new Set(['explicit', 'text-pattern']);

/**
 * Demo 门禁结论（privacy/demo.js）。captured.demo 由 captureStable 写入：
 *   undefined    没有经过 captureStable 的派生（如旧证据重新派生）：沿用 captured.demoDecision（已通过的原结论）或不做判定
 *   null         Provider 不支持 Demo 替换与网络守卫：fail-closed
 * @returns {object|null} 通过时的结论（写入 privacy.demo）
 */
function demoGate(captured) {
  const { decide, demoGateError } = require('../privacy/demo');
  if (captured.demo === undefined) return captured.demoDecision?.status === 'passed' ? captured.demoDecision : null;
  let decision;
  if (captured.demo === null) {
    decision = { status: 'blocked', reasons: [{ code: 'demo-guard-unavailable', status: 'blocked', detail: '当前 Browser Provider 不支持演示数据替换与网络守卫', hint: '使用 playwright Provider 采集。' }], sources: { public: true, api_mock: 0, dom_replace: 0 } };
  } else {
    const { audit, guard, config } = captured.demo;
    decision = decide({ audit, guard: guard || {}, demo: config || {} });
    decision.surfaces = audit?.surfaces || null;
    decision.hiddenMatches = audit?.hidden || 0;
  }
  if (decision.status !== 'passed') throw demoGateError(decision);
  return decision;
}

function captureError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function sameGeometry(a, b) {
  return a.mutationGeneration === b.mutationGeneration &&
    a.scroll?.x === b.scroll?.x && a.scroll?.y === b.scroll?.y &&
    a.viewport?.width === b.viewport?.width && a.viewport?.height === b.viewport?.height &&
    a.documentSize?.width === b.documentSize?.width && a.documentSize?.height === b.documentSize?.height;
}

/**
 * 指针只能停在一处：有标注目标靠 hover 才显示时，全部定位完再逐个确认仍可见（不再移动指针），
 * 否则后一个 hover 已让前一个消失，图上会框出空白。
 * @param {Array<{ target, label, revealedBy }>} located
 */
async function confirmTargetsShown(provider, located) {
  if (!located.some((item) => item.revealedBy)) return;
  for (const { target, label } of located) {
    try {
      await provider.performAction({ type: 'inspect', target, reveal: false });
    } catch (error) {
      throw captureError('annotation-hover-conflict',
        `标注 ${label} 需要指针悬停才显示，但同一张截图里还有别的悬停目标，二者无法同时出现：${error.message}；把它们拆到不同步骤的截图里。`);
    }
  }
}

/**
 * @param provider
 * @param {object} p
 * @param {string} p.rawPath
 * @param {boolean} [p.fullPage]
 * @param {() => Promise<Array<{label, rect}>>} [p.resolveTargets]  截图时刻的标注目标（CSS 坐标）
 * @returns {{ shot, geometry, targets, candidates, attempts }}
 */
async function captureStable(provider, { rawPath, fullPage = false, format = 'png', resolveTargets = async () => [], maxAttempts = MAX_ATTEMPTS, stabilityMs = undefined }) {
  let quiet = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 先等页面静置再取几何：否则收尾渲染期间的连续重试会全部落在同一段变化里。
    // DOM 在等待上限内仍在变化（如回复仍在逐字输出）时这一轮不截图，进入下一次尝试。
    quiet = provider.waitForQuiet ? await provider.waitForQuiet(stabilityMs ? { maxMs: stabilityMs } : undefined) : null;
    if (quiet?.dom === 'max-wait') continue;
    // Demo：截图前把 data-redact 区域换成演示值；之后的几何快照以替换后的 DOM 为基准
    if (provider.applyDemo) await provider.applyDemo();
    const before = provider.collectGeometry ? await provider.collectGeometry({ fullPage }) : null;
    const targets = await resolveTargets();
    const candidates = provider.collectSensitiveElements ? await provider.collectSensitiveElements({ fullPage }) : null;
    const shot = await provider.screenshot({ path: rawPath, fullPage, format });
    checkpoint('raw-captured');
    const after = provider.collectGeometry ? await provider.collectGeometry({ fullPage }) : null;
    if (!before || sameGeometry(before, after)) {
      // 截图后只读审计：DOM 计数与截图后一致才代表截图时刻；替换被页面改回时重拍
      const audit = provider.auditDemo ? await provider.auditDemo() : null;
      if (audit && after && typeof audit.generation === 'number' && audit.generation !== after.mutationGeneration) {
        if (attempt < maxAttempts) continue;
        // 最后一次仍无法确认审计对应截图时刻：按替换不稳定处理，不能当作通过
        audit.reverted = Math.max(1, audit.reverted || 0);
      }
      if (audit && audit.reverted > 0 && attempt < maxAttempts) continue;
      // null：Provider 不支持 Demo，派生时按 fail-closed 处理
      const demo = audit ? { audit, guard: provider.demoGuardState ? provider.demoGuardState() : null, config: provider.demo || null } : null;
      const geometry = after
        ? { ...after, fullPage }
        : { dpr: shot.meta?.deviceScaleFactor || 1, viewport: shot.meta?.viewport, scroll: { x: 0, y: 0 }, documentSize: null, fullPage, mutationGeneration: null };
      // 数据请求在等待上限内仍未结束：不阻断（长轮询页面），但必须在证据中提示
      const warnings = quiet?.network === 'busy' ? [`screenshot-network-busy: 截图时仍有 ${quiet.pendingRequests} 个数据请求未结束，内容可能尚未加载完成。`] : [];
      return { shot, geometry, targets, candidates, attempts: attempt, warnings, demo };
    }
  }
  const state = quiet?.dom === 'max-wait' ? `DOM 持续变化${quiet.network === 'busy' ? `，仍有 ${quiet.pendingRequests} 个数据请求未结束` : ''}` : '截图前后几何不一致';
  throw captureError('geometry-unstable', `截图前页面一直不稳定（${state}），重试 ${maxAttempts} 次后放弃；不会产出发布图。`);
}

/**
 * 从 raw 派生发布图并生成隐私记录。
 * @returns {{ redactions, annotations, privacy, derived }}
 */
async function derivePublished({ captured, rawPath, sanitizedPath, publishedPath, theme, redactionRules = {} }) {
  // Demo 门禁先于一切派生：未通过时抛出，调用方中止 staging，原图与派生图都不留下
  const demo = demoGate(captured);
  // data-redact 区域与可见文本中的联系方式由门禁负责（替换或阻断），不再整块打码；表单 / 凭据等仍按原规则遮罩
  const candidates = demo ? (captured.candidates || []).filter((item) => !DEMO_SOURCES.has(item.source)) : (captured.candidates || []);
  const detection = planRedactions(candidates, redactionRules);
  if (!detection.ok) throw captureError('privacy-uncertain', detection.errors.join('；'));
  const { geometry } = captured;
  const canvas = geometry.fullPage && geometry.documentSize ? geometry.documentSize : (geometry.viewport || captured.shot.meta.viewport);
  const locatedTargets = (captured.targets || []).filter((item) => item.rect);
  const maxMarkers = Number.isInteger(theme.maxMarkersPerImage) ? theme.maxMarkersPerImage : locatedTargets.length;
  const overflow = locatedTargets.slice(maxMarkers);
  const layout = layoutAnnotations(locatedTargets.slice(0, maxMarkers), canvas, theme);
  if (!layout.ok) throw captureError('annotation-layout-failed', layout.errors.join('；'));
  const privacy = buildPrivacyRecord({ redactions: detection.redactions, config: { privacy: redactionRules }, demo });
  const image = await sharp(rawPath).metadata();
  const rendered = renderAnnotationResults(layout.annotations, { width: image.width, height: image.height, dpr: geometry.dpr || 1, redactions: detection.redactions || [], minVisibleRatio: theme.minVisibleRatio ?? 0.8 });
  for (const target of overflow) rendered.push({ feature_id: target.feature_id || null, located: true, outlined: false, intersects: false, drawn: false, reason: 'marker-limit-exceeded' });
  for (const target of captured.targets || []) if (!target.rect) rendered.push({ feature_id: target.feature_id || null, located: false, outlined: false, intersects: false, drawn: false, reason: target.reason || 'target-not-located' });
  const coverage = captured.inventory ? verifyCoverage({ inventory: captured.inventory, plan: captured.plan || [], rendered, discovered: captured.discovered || captured.inventory, candidates: captured.featureCandidates || [] }) : null;
  // 隐私检测未通过（如高风险项无法定位）时只留私有 sanitized，不向文档目录写发布图。
  const published = privacy.status === 'passed' && (!coverage || coverage.ok) ? publishedPath : null;
  const derived = await deriveImages({
    rawPath, geometry, redactions: detection.redactions, annotations: layout.annotations, theme, sanitizedPath, publishedPath: published,
  });
  const quality = require('../generate/quality').imageQuality(captured, detection.redactions, layout.annotations);
  return { redactions: detection.redactions, annotations: layout.annotations, rendered, coverage, privacy, quality, derived, published: !!published };
}

module.exports = { captureStable, confirmTargetsShown, derivePublished, sameGeometry, MAX_ATTEMPTS };
