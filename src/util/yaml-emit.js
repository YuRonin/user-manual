'use strict';

/*
 * 通用 block-style YAML 输出。
 *
 * 只覆盖本项目实际会写的类型：标量、字符串数组、对象数组、嵌套对象。
 * 不用 js-yaml.dump 是因为它对中文长文本的折行和引号处理不够可控；
 * js-yaml 只用来把产物解析回来自检（见 commands/*.js）。
 */

// YAML 里会被解析成非字符串的裸量，遇到这些必须加引号
const AMBIGUOUS_PLAIN = new Set(['true', 'false', 'yes', 'no', 'on', 'off', 'null', '~', '']);

/** 折叠标量的目标行宽。CJK 没有空格可断行，会自然退化成一整行，这是允许的。 */
const FOLD_WIDTH = 76;

/** 标量渲染：需要时才加引号，保持文件可读。多行字符串交给 blockScalar 处理。 */
function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);

  const s = String(value);
  const needsQuote =
    AMBIGUOUS_PLAIN.has(s.toLowerCase()) ||
    s !== s.trim() ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(s) ||
    /:\s/.test(s) ||
    /\s#/.test(s) ||
    /[\n\r\t]/.test(s) ||
    // 纯数字样式的字符串（如版本号 "1.0"）需要引号才能保持字符串类型
    /^[-+]?(\d[\d_]*)(\.\d*)?([eE][-+]?\d+)?$/.test(s) ||
    // YAML 1.1 会把 2026-09-16T08:17:04.123Z 解析成 Date 对象，读回来就不是字符串了。
    // 时间戳必须加引号才能原样往返。
    /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(s);

  if (!needsQuote) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

/** 按空格在 width 处软换行。没有空格可断（如中文）时整段不动。 */
function wrap(text, width) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line === '') line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line !== '') lines.push(line);
  return lines;
}

/**
 * 长文本/多行文本用块标量输出，避免一行拖到几百字符。
 * - 含换行 → `|-` 字面块，原样保留换行
 * - 单行但过长 → `>-` 折叠块，读回来时折行被还原成空格
 * 返回 null 表示该值不适合用块标量，调用方退回普通标量。
 */
function blockScalar(value, indent) {
  if (typeof value !== 'string') return null;
  const pad = ' '.repeat(indent + 2);

  if (/[\n\r]/.test(value)) {
    const body = value.replace(/\r\n/g, '\n').replace(/\s+$/, '');
    return ['|-', ...body.split('\n').map((l) => pad + l)].join('\n');
  }

  // 折叠块要求内容里没有连续空格、行首没有多余缩进，先归一化
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (normalized.length <= FOLD_WIDTH) return null;
  return ['>-', ...wrap(normalized, FOLD_WIDTH).map((l) => pad + l)].join('\n');
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 把对象渲染成 block-style YAML 行数组。
 * `undefined` 的键会被跳过；要显式写 null 就传 null。
 */
function emitLines(obj, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${pad}${key}: []`); continue; }
      lines.push(`${pad}${key}:`);
      for (const item of value) {
        if (isPlainObject(item)) {
          const sub = emitLines(item, indent + 4);
          // 数组里的对象：第一行挂在 `- ` 后面，其余保持缩进
          lines.push(`${pad}  - ${sub[0].trimStart()}`);
          lines.push(...sub.slice(1));
        } else {
          lines.push(`${pad}  - ${scalar(item)}`);
        }
      }
      continue;
    }

    if (isPlainObject(value)) {
      if (Object.keys(value).length === 0) { lines.push(`${pad}${key}: {}`); continue; }
      lines.push(`${pad}${key}:`);
      lines.push(...emitLines(value, indent + 2));
      continue;
    }

    const block = blockScalar(value, indent);
    if (block !== null) {
      const [head, ...rest] = block.split('\n');
      lines.push(`${pad}${key}: ${head}`);
      lines.push(...rest);
      continue;
    }

    lines.push(`${pad}${key}: ${scalar(value)}`);
  }

  return lines;
}

/** 渲染成完整 YAML 文本（结尾带换行）。 */
function emit(obj, indent = 0) {
  return emitLines(obj, indent).join('\n') + '\n';
}

module.exports = { emit, emitLines, scalar, blockScalar, wrap, FOLD_WIDTH };
