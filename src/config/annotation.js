'use strict';

const DEFAULT_THEME = {
  primary: '#E86349',
  primaryDark: '#B84331',
  halo: 'rgba(232, 99, 73, 0.16)',
  labelBackground: 'rgba(255, 255, 255, 0.96)',
  labelText: '#252C38',
  focusMask: 'rgba(33, 50, 113, 0.10)',
  fallbackColor: '#213271',
  markerSize: 30,
  outlineWidth: 3,
  targetPadding: 5,
  targetRadius: 8,
  maxMarkersPerImage: 5,
};
const DEFAULT_ANNOTATION = { activeTheme: 'default', themes: { default: DEFAULT_THEME } };
const COLOR_KEYS = ['primary', 'primaryDark', 'halo', 'labelBackground', 'labelText', 'focusMask', 'fallbackColor'];

function resolveAnnotationConfig(raw = {}) {
  const themes = { default: { ...DEFAULT_THEME } };
  for (const [id, theme] of Object.entries(raw.themes || {})) themes[id] = { ...(themes[id] || DEFAULT_THEME), ...theme };
  const config = { activeTheme: raw.activeTheme || 'default', themes };
  const errors = [];
  if (!themes[config.activeTheme]) errors.push(`annotation.activeTheme 指向不存在的主题: ${config.activeTheme}`);
  for (const [id, theme] of Object.entries(themes)) {
    for (const key of COLOR_KEYS) if (typeof theme[key] !== 'string' || theme[key].trim() === '') errors.push(`annotation.themes.${id}.${key} 需要是颜色字符串。`);
    if (!Number.isFinite(theme.markerSize) || theme.markerSize < 20 || theme.markerSize > 64) errors.push(`annotation.themes.${id}.markerSize 需在 20-64 之间。`);
    if (!Number.isInteger(theme.maxMarkersPerImage) || theme.maxMarkersPerImage < 1 || theme.maxMarkersPerImage > 10) errors.push(`annotation.themes.${id}.maxMarkersPerImage 需在 1-10 之间。`);
    if (!Number.isFinite(theme.targetPadding) || theme.targetPadding < 0 || theme.targetPadding > 20) errors.push(`annotation.themes.${id}.targetPadding 需在 0-20 之间。`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, config };
}

module.exports = { DEFAULT_THEME, DEFAULT_ANNOTATION, resolveAnnotationConfig };
