'use strict';

const DEFAULT_MOSAIC = {
  base: '#E7ECF3',
  cellA: '#D5DDE8',
  cellB: '#EEF2F7',
  cellSize: 8,
  radius: 4,
};

function number(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function neutralMosaicStyle(rect, theme = {}) {
  const colors = { ...DEFAULT_MOSAIC, ...theme };
  return [
    'position:absolute',
    `left:${number(rect.x)}px`,
    `top:${number(rect.y)}px`,
    `width:${Math.max(number(rect.width), 24)}px`,
    `height:${Math.max(number(rect.height), 8)}px`,
    `background-color:${colors.base}`,
    `background-image:repeating-conic-gradient(${colors.cellA} 0 25%, ${colors.cellB} 0 50%)`,
    `background-size:${number(colors.cellSize)}px ${number(colors.cellSize)}px`,
    `border-radius:${number(colors.radius)}px`,
    'box-sizing:border-box',
  ].join(';');
}

module.exports = { DEFAULT_MOSAIC, neutralMosaicStyle };
