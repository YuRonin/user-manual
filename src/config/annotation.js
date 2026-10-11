'use strict';

/*
 * 标注主题。所有视觉参数都由渲染器消费（B4-03）：
 *   primary 框线与编号底色；halo / haloWidth 框外光晕；labelBackground / markerStrokeWidth 编号圆点的描边；
 *   markerText 编号文字颜色；markerSize 编号直径，fontScale 字号 = markerSize × fontScale；
 *   outlineWidth / targetPadding / targetRadius 目标框；maxMarkersPerImage 单图编号上限，超出时自动拆成多张图（B4-02）。
 * 已弃用（没有消费者，仍可读取但会提示）：primaryDark、labelText、focusMask、fallbackColor。
 */
const DEPRECATED_KEYS = ['primaryDark', 'labelText', 'focusMask', 'fallbackColor'];
const DEFAULT_THEME = {
  primary: '#E86349',
  halo: 'rgba(232, 99, 73, 0.16)',
  haloWidth: 10,
  labelBackground: 'rgba(255, 255, 255, 0.96)',
  markerText: '#FFFFFF',
  markerStrokeWidth: 2,
  fontScale: 0.53,
  markerSize: 30,
  outlineWidth: 3,
  targetPadding: 5,
  targetRadius: 8,
  maxMarkersPerImage: 5,
  // 目标在截图里至少露出这么大比例才算"标到了"（B2-08）；样例验证前先作为可配置的候选值
  minVisibleRatio: 0.8,
};
const DEFAULT_ANNOTATION = { activeTheme: 'default', themes: { default: DEFAULT_THEME } };
const COLOR_KEYS = ['primary', 'halo', 'labelBackground', 'markerText'];

function resolveAnnotationConfig(raw = {}) {
  const themes = { default: { ...DEFAULT_THEME } };
  for (const [id, theme] of Object.entries(raw.themes || {})) themes[id] = { ...(themes[id] || DEFAULT_THEME), ...theme };
  const config = { activeTheme: raw.activeTheme || 'default', themes };
  const errors = [];
  const warnings = [];
  for (const [id, theme] of Object.entries(raw.themes || {})) {
    const used = DEPRECATED_KEYS.filter((key) => theme && key in theme);
    if (used.length) warnings.push(`annotation-theme-deprecated: annotation.themes.${id} 中的 ${used.join('、')} 已不再使用，可以删除。`);
  }
  if (!themes[config.activeTheme]) errors.push(`annotation.activeTheme 指向不存在的主题: ${config.activeTheme}`);
  for (const [id, theme] of Object.entries(themes)) {
    for (const key of COLOR_KEYS) if (typeof theme[key] !== 'string' || theme[key].trim() === '') errors.push(`annotation.themes.${id}.${key} 需要是颜色字符串。`);
    if (!Number.isFinite(theme.markerSize) || theme.markerSize < 20 || theme.markerSize > 64) errors.push(`annotation.themes.${id}.markerSize 需在 20-64 之间。`);
    if (!Number.isInteger(theme.maxMarkersPerImage) || theme.maxMarkersPerImage < 1 || theme.maxMarkersPerImage > 10) errors.push(`annotation.themes.${id}.maxMarkersPerImage 需在 1-10 之间。`);
    if (!Number.isFinite(theme.targetPadding) || theme.targetPadding < 0 || theme.targetPadding > 20) errors.push(`annotation.themes.${id}.targetPadding 需在 0-20 之间。`);
    if (!Number.isFinite(theme.minVisibleRatio) || theme.minVisibleRatio < 0.1 || theme.minVisibleRatio > 1) errors.push(`annotation.themes.${id}.minVisibleRatio 需在 0.1-1 之间。`);
    const range = (key, min, max) => { if (!Number.isFinite(theme[key]) || theme[key] < min || theme[key] > max) errors.push(`annotation.themes.${id}.${key} 需在 ${min}-${max} 之间。`); };
    range('outlineWidth', 1, 12);
    range('targetRadius', 0, 32);
    range('haloWidth', 0, 24);
    range('markerStrokeWidth', 0, 6);
    range('fontScale', 0.3, 0.8);
  }
  return errors.length ? { ok: false, errors } : { ok: true, config, warnings };
}

module.exports = { DEFAULT_THEME, DEFAULT_ANNOTATION, DEPRECATED_KEYS, resolveAnnotationConfig };
