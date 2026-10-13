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

/**
 * 标注目标定位：有界短等待（B5-14）。元素尚未渲染 / 刚开始显示时最多再试 tries 次，每次间隔 delayMs；
 * 其他错误（歧义、透明、遮挡）立即返回。不改写配置里的定位，备选定位的命中由 resolution 记录。
 */
async function inspectWithRetry(provider, target, { tries = 2, delayMs = 300 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.performAction({ type: 'inspect', target });
    } catch (error) {
      if (error.code !== 'target-not-visible' || attempt >= tries) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** 定位失败的原因码：页面上根本没有该元素记 target-not-found，存在但不可见仍为 target-not-visible（B5-13）。 */
function locateReason(error, fallback = 'target-not-located') {
  if (error?.code === 'target-not-visible' && error.presence === 'absent') return 'target-not-found';
  return error?.code || fallback;
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
async function captureStable(provider, { rawPath, fullPage = false, format = 'png', resolveTargets = async () => [], maxAttempts = MAX_ATTEMPTS, stabilityMs = undefined, assertState = null }) {
  let quiet = null;
  let media = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 先等页面静置再取几何：否则收尾渲染期间的连续重试会全部落在同一段变化里。
    // DOM 在等待上限内仍在变化（如回复仍在逐字输出）时这一轮不截图，进入下一次尝试。
    quiet = provider.waitForQuiet ? await provider.waitForQuiet(stabilityMs ? { maxMs: stabilityMs } : undefined) : null;
    if (quiet?.dom === 'max-wait') continue;
    // 整页截图从页面顶部开始：client 坐标即文档坐标，sticky 元素回到自然位置（B4-04）
    if (fullPage && provider.scrollToTop) await provider.scrollToTop();
    // 截图范围内的图片先加载完：懒加载图片在整页截图里不会进入视口，不处理就是一片空白占位
    media = provider.loadMedia ? await provider.loadMedia({ fullPage }) : null;
    if (media?.pending || media?.broken) continue;
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
      // 截图后复核预期状态（B5-05）：定位标注时的悬停 / 滚动把菜单、弹窗弄没了，这张图就不是声明的状态
      if (assertState) {
        try { await assertState(); } catch (error) {
          throw captureError('scenario-state-lost', `截图后预期状态不再成立（${error.message}）：定位标注时的指针移动或滚动可能关闭了菜单 / 弹窗；不会产出发布图。`);
        }
      }
      // 数据请求在等待上限内仍未结束：不阻断（长轮询页面），但必须在证据中提示
      const warnings = quiet?.network === 'busy' ? [`screenshot-network-busy: 截图时仍有 ${quiet.pendingRequests} 个数据请求未结束，内容可能尚未加载完成。`] : [];
      return { shot, geometry, targets, candidates, attempts: attempt, warnings, demo };
    }
  }
  // 加载失败的图片（如 404）在截图里是一块空白或破图：发布出去读者只会看到空框，不产出发布图
  if (media?.broken) {
    throw captureError('media-broken', `截图范围内有 ${media.broken} 张图片加载失败（共 ${media.total} 张），重试 ${maxAttempts} 次后放弃；不会产出带空白图片的发布图。检查图片地址是否存在（例如页面展示的图片由构建步骤生成，还没重新生成）。`);
  }
  if (media?.pending) {
    throw captureError('media-not-loaded', `截图范围内仍有 ${media.pending} 张图片没有加载完（共 ${media.total} 张），重试 ${maxAttempts} 次后放弃；不会产出空白占位的发布图。检查图片地址与网络守卫是否放行了图片请求。`);
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
  if (captured.figures?.length) {
    const privacy = buildPrivacyRecord({ redactions: detection.redactions, config: { privacy: redactionRules }, demo });
    const image = await sharp(rawPath).metadata();
    if (Math.abs(image.width - Math.round(canvas.width * (geometry.dpr || 1))) > 2 || Math.abs(image.height - Math.round(canvas.height * (geometry.dpr || 1))) > 2) throw captureError('geometry-scale-mismatch', '分类图片的原图与几何不一致');
    return require('./grouped-figures').deriveGrouped({ captured, rawPath, sanitizedPath, publishedPath, theme, redactions: detection.redactions, privacy, canvas });
  }
  // boundingBox 为空的目标不能当作已定位（null 展开成 {} 会被误当作矩形）
  const hasRect = (item) => item.rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(item.rect[key])));
  const locatedTargets = (captured.targets || []).filter(hasRect);
  // 拆图（B4-02）：超过单图上限时按顺序分组，每组一张发布图；编号沿用全局 label，正文与图片仍一一对应
  const maxMarkers = Number.isInteger(theme.maxMarkersPerImage) ? theme.maxMarkersPerImage : Math.max(1, locatedTargets.length);
  const groups = [];
  for (let i = 0; i < locatedTargets.length; i += maxMarkers) groups.push(locatedTargets.slice(i, i + maxMarkers));
  if (!groups.length) groups.push([]);
  const split = groups.length > 1;
  const annotations = [];
  for (const [index, group] of groups.entries()) {
    const layout = layoutAnnotations(group.map((target) => (split ? { ...target, part: index + 1 } : target)), canvas, theme, { avoid: detection.redactions || [] });
    if (!layout.ok) throw captureError('annotation-split-failed', `第 ${index + 1} 张拆分图布局失败：${layout.errors.join('；')}`);
    annotations.push(...layout.annotations);
  }
  const privacy = buildPrivacyRecord({ redactions: detection.redactions, config: { privacy: redactionRules }, demo });
  const image = await sharp(rawPath).metadata();
  // 截图尺寸必须等于画布 × DPR（B4-04）：不一致说明坐标换算不可信，框和遮罩都会错位
  const expected = canvas?.width ? { width: Math.round(canvas.width * (geometry.dpr || 1)), height: Math.round(canvas.height * (geometry.dpr || 1)) } : null;
  if (expected && (Math.abs(image.width - expected.width) > 2 || Math.abs(image.height - expected.height) > 2)) {
    throw captureError('geometry-scale-mismatch', `截图尺寸 ${image.width}×${image.height} 与画布 ${canvas.width}×${canvas.height} × DPR ${geometry.dpr || 1} 不一致，坐标换算不可信；不会产出发布图。`);
  }
  const rendered = renderAnnotationResults(annotations, { width: image.width, height: image.height, dpr: geometry.dpr || 1, redactions: detection.redactions || [], minVisibleRatio: theme.minVisibleRatio ?? 0.8 });
  for (const target of captured.targets || []) if (!hasRect(target)) rendered.push({ feature_id: target.feature_id || null, located: false, outlined: false, intersects: false, drawn: false, reason: target.reason || 'target-not-located' });
  const coverage = captured.inventory ? verifyCoverage({ inventory: captured.inventory, plan: captured.plan || [], rendered, discovered: captured.discovered || captured.inventory, candidates: captured.featureCandidates || [] }) : null;
  // 隐私检测未通过（如高风险项无法定位）时只留私有 sanitized，不向文档目录写发布图。
  const published = privacy.status === 'passed' && (!coverage || coverage.ok) ? publishedPath : null;
  const partPath = (n) => (n === 1 ? published : published.replace(/(\.[a-z]+)$/i, `.part-${n}$1`));
  const parts = split && published ? groups.map((_, index) => ({ part: index + 1, publishedPath: partPath(index + 1), annotations: annotations.filter((item) => item.part === index + 1) })) : null;
  const derived = await deriveImages({
    rawPath, geometry, redactions: detection.redactions, annotations, theme, sanitizedPath, publishedPath: published, parts,
  });
  const quality = require('../generate/quality').imageQuality(captured, detection.redactions, annotations);
  return { redactions: detection.redactions, annotations, rendered, coverage, privacy, quality, derived, published: !!published,
    // 拆图时第 2 张起的发布图（第 1 张即 publishedPath）；调用方把它们作为 part: N 的 published 产物提交
    parts: parts ? parts.map(({ part, publishedPath: file }) => ({ part, file })) : null };
}

module.exports = { captureStable, confirmTargetsShown, derivePublished, demoGate, sameGeometry, inspectWithRetry, locateReason, MAX_ATTEMPTS };
