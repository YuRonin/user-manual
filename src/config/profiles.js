'use strict';

/*
 * 截图规格（capture profile）注册表。
 *
 * 一个 profile 描述「用什么样的画布去截图」：视口、DPR、以及是否模拟移动端。
 * `kind` 从第一版就存在（desktop | mobile），后续加移动端规格是纯增量，不改结构。
 *
 * 新增预设 = 往 PRESETS 里加一项；用户临时自定义走 buildCustomProfile()。
 */

const PRESETS = {
  'desktop-standard': {
    label: 'Desktop Standard — 1440x900 @2x',
    kind: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  'desktop-wide': {
    label: 'Desktop Wide — 1920x1080 @1x',
    kind: 'desktop',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  },
  laptop: {
    label: 'Laptop — 1280x800 @2x',
    kind: 'desktop',
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
  },
};

const DEFAULT_PROFILE_ID = 'desktop-standard';

/** 用户自定义规格时用的 profile id。 */
const CUSTOM_PROFILE_ID = 'custom';

// 视口的合理区间。上界按 8K 宽 / 4K 高留足余量，主要用于挡住手滑输入的 14400 之类。
const VIEWPORT_LIMITS = {
  width: { min: 320, max: 7680 },
  height: { min: 240, max: 4320 },
};
const DPR_LIMITS = { min: 0.5, max: 4 };

/** 可选的 profile id 列表（不含 custom）。 */
function presetIds() {
  return Object.keys(PRESETS);
}

/**
 * 取出一份预设的深拷贝（去掉仅用于 CLI 展示的 label）。
 * 未知 id 返回 null，由调用方决定报错文案。
 */
function getPreset(id) {
  const preset = PRESETS[id];
  if (!preset) return null;
  return {
    kind: preset.kind,
    viewport: { ...preset.viewport },
    deviceScaleFactor: preset.deviceScaleFactor,
  };
}

/** 组装一份自定义 profile。入参已由 validate 层校验过。 */
function buildCustomProfile({ width, height, deviceScaleFactor, kind = 'desktop' }) {
  return {
    kind,
    viewport: { width, height },
    deviceScaleFactor,
  };
}

module.exports = {
  PRESETS,
  DEFAULT_PROFILE_ID,
  CUSTOM_PROFILE_ID,
  VIEWPORT_LIMITS,
  DPR_LIMITS,
  presetIds,
  getPreset,
  buildCustomProfile,
};
