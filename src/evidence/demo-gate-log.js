'use strict';

/*
 * Demo 门禁失败记录（.manual/evidence/demo-gate/<主体>.json）。
 *
 * 门禁失败时 staging 被整体丢弃，不会留下 Capture 记录；没有这份记录，"最近一次重新采集被阻断"
 * 就无从得知，generate 会默默继续使用上一张旧截图。这里按采集主体只保留最近一次失败：
 *   { subject, at, status, reasons: [原因码] }
 * 只写原因码，不写 detail（detail 可能含接口路径以外的信息）、页面文本或网络内容。
 * 同一主体之后采集成功即删除。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../util/atomic-write');

function dirOf(stateDirAbs) {
  return path.join(stateDirAbs, 'evidence', 'demo-gate');
}

/** 主体键：page--<pageId>--<scenarioId> 或 task--<taskId>--<stepId>--<timing>（只含安全字符）。 */
function subjectKey(parts) {
  return parts.map((p) => String(p ?? '-').replace(/[^A-Za-z0-9._-]/g, '_')).join('--');
}

function recordGateFailure(stateDirAbs, key, error) {
  if (!error?.demo || !/^demo-(blocked|needs-fixture)$/.test(String(error.code || ''))) return null;
  const entry = {
    subject: key,
    at: new Date().toISOString(),
    status: error.demo.status,
    reasons: [...new Set((error.demo.reasons || []).map((r) => r.code))].sort(),
  };
  try {
    fs.mkdirSync(dirOf(stateDirAbs), { recursive: true });
    writeFileAtomic(path.join(dirOf(stateDirAbs), `${key}.json`), JSON.stringify(entry, null, 2) + '\n');
  } catch (_) { return null; /* 记录失败不能掩盖门禁失败本身 */ }
  return entry;
}

function clearGateFailure(stateDirAbs, key) {
  try { fs.rmSync(path.join(dirOf(stateDirAbs), `${key}.json`), { force: true }); } catch (_) { /* 不影响采集结果 */ }
}

function readGateFailure(stateDirAbs, key) {
  const file = path.join(dirOf(stateDirAbs), `${key}.json`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function listGateFailures(stateDirAbs) {
  const dir = dirOf(stateDirAbs);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; }
  }).filter(Boolean);
}

/** 手册引用的截图之后，同一主体又有一次被门禁阻断的重新采集：返回那次失败，否则 null。 */
function recaptureBlocked(stateDirAbs, key, observedAt) {
  const failure = readGateFailure(stateDirAbs, key);
  if (!failure) return null;
  if (observedAt && String(failure.at) <= String(observedAt)) return null;
  return { at: failure.at, status: failure.status, reasons: failure.reasons };
}

module.exports = { subjectKey, recordGateFailure, clearGateFailure, readGateFailure, listGateFailures, recaptureBlocked };
