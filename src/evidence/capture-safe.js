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
    const before = provider.collectGeometry ? await provider.collectGeometry({ fullPage }) : null;
    const targets = await resolveTargets();
    const candidates = provider.collectSensitiveElements ? await provider.collectSensitiveElements({ fullPage }) : null;
    const shot = await provider.screenshot({ path: rawPath, fullPage, format });
    checkpoint('raw-captured');
    const after = provider.collectGeometry ? await provider.collectGeometry({ fullPage }) : null;
    if (!before || sameGeometry(before, after)) {
      const geometry = after
        ? { ...after, fullPage }
        : { dpr: shot.meta?.deviceScaleFactor || 1, viewport: shot.meta?.viewport, scroll: { x: 0, y: 0 }, documentSize: null, fullPage, mutationGeneration: null };
      // 数据请求在等待上限内仍未结束：不阻断（长轮询页面），但必须在证据中提示
      const warnings = quiet?.network === 'busy' ? [`screenshot-network-busy: 截图时仍有 ${quiet.pendingRequests} 个数据请求未结束，内容可能尚未加载完成。`] : [];
      return { shot, geometry, targets, candidates, attempts: attempt, warnings };
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
  const detection = planRedactions(captured.candidates || [], redactionRules);
  if (!detection.ok) throw captureError('privacy-uncertain', detection.errors.join('；'));
  const { geometry } = captured;
  const canvas = geometry.fullPage && geometry.documentSize ? geometry.documentSize : (geometry.viewport || captured.shot.meta.viewport);
  const locatedTargets = (captured.targets || []).filter((item) => item.rect);
  const maxMarkers = Number.isInteger(theme.maxMarkersPerImage) ? theme.maxMarkersPerImage : locatedTargets.length;
  const overflow = locatedTargets.slice(maxMarkers);
  const layout = layoutAnnotations(locatedTargets.slice(0, maxMarkers), canvas, theme);
  if (!layout.ok) throw captureError('annotation-layout-failed', layout.errors.join('；'));
  const privacy = buildPrivacyRecord({ redactions: detection.redactions, config: { privacy: redactionRules } });
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
