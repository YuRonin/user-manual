'use strict';

/*
 * Run 事件日志（events.jsonl）。
 *
 * - 只用于诊断；恢复以 task 快照为准，日志丢失或损坏不影响恢复，也不改项目事实。
 * - 逐事件 append 一行 JSON；进程在写入中途死亡只会留下不完整的最后一行，读取时丢弃并报告 truncated。
 * - 字段白名单：浏览器对象、请求体、Cookie 等一律不进日志；message 经去敏。
 */

const fs = require('fs');
const path = require('path');

const { sanitizeMessage } = require('./errors');

const EVENT_FIELDS = ['type', 'runId', 'taskId', 'kind', 'pageId', 'scenarioId', 'captureId', 'attempt', 'phase',
  'from', 'to', 'durationMs', 'result', 'code', 'cacheReason', 'message'];

function sanitizeEvent(event, now) {
  const out = { at: new Date(now).toISOString() };
  for (const field of EVENT_FIELDS) {
    const value = event?.[field];
    if (value === undefined || value === null) continue;
    if (field === 'message') out.message = sanitizeMessage(value);
    else if (field === 'attempt' || field === 'durationMs') { if (Number.isFinite(value)) out[field] = value; }
    else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[field] = typeof value === 'string' ? sanitizeMessage(value) : value;
  }
  return out;
}

/** 追加一条事件。写日志失败只返回 false，不影响调用方（日志不是状态源）。 */
function appendEvent(file, event, { now = Date.now() } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(sanitizeEvent(event, now)) + '\n');
    return true;
  } catch (_) {
    return false;
  }
}

/** 读取事件；跳过无法解析的行（通常是被中断的最后一行）。 */
function readEvents(file) {
  if (!fs.existsSync(file)) return { events: [], truncated: false, skipped: 0 };
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const truncated = text.length > 0 && !text.endsWith('\n');
  const events = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch (_) { skipped++; }
  }
  return { events, truncated, skipped };
}

module.exports = { EVENT_FIELDS, appendEvent, readEvents, sanitizeEvent };
