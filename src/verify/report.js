'use strict';

/*
 * 验证报告（P3-03）：每次 verify 生成一份新的不可变记录，不修改历史 Capture / 发布记录。
 *
 *   .manual/verifications/<uuid>.json
 *     { schemaVersion, id, kind: 'live'|'artifacts', manualId, releaseId, target, startedAt, finishedAt,
 *       onlineChecked, inputRevisions, environment, checks[], claims[], sections[], coverage, result, drift? }
 *
 * result: passed / failed / inconclusive。退出码策略（C08）：
 *   passed → 0；failed（与手册不一致：产品行为变化或手册过期）→ 4；
 *   需要登录 / 身份不符 → 3；inconclusive（网络、超时、浏览器崩溃，不能证明产品回归）→ 1。
 */

const fs = require('fs');
const path = require('path');

const { newUuid } = require('../model/ids');
const { writeFileAtomic } = require('../util/atomic-write');
const { EXIT } = require('../cli/output');

const RESULTS = ['passed', 'failed', 'inconclusive'];

// 失败分类：产品 / 手册不一致（failed）与无法下结论（inconclusive）严格分开。
const CLASSIFY = {
  'http-not-found': { category: 'page-not-found', outcome: 'failed' },
  'soft-not-found': { category: 'page-not-found', outcome: 'failed' },
  'target-not-visible': { category: 'ui-changed', outcome: 'failed' },
  'target-ambiguous': { category: 'ui-ambiguous', outcome: 'failed' },
  'state-assertion-failed': { category: 'state-changed', outcome: 'failed' },
  'page-identity-failed': { category: 'page-identity-changed', outcome: 'failed' },
  'unexpected-redirect': { category: 'redirected', outcome: 'failed' },
  'unexpected-page-state': { category: 'state-changed', outcome: 'failed' },
  'blank-page': { category: 'page-blank', outcome: 'failed' },
  'http-error': { category: 'server-error', outcome: 'failed' },
  'login-required': { category: 'role-mismatch', outcome: 'inconclusive', needsInput: true },
  'auth-missing': { category: 'role-mismatch', outcome: 'inconclusive', needsInput: true },
  'auth-expired': { category: 'role-mismatch', outcome: 'inconclusive', needsInput: true },
  'auth-identity-mismatch': { category: 'role-mismatch', outcome: 'failed' },
  'server-unreachable': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'dns-failure': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  timeout: { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'navigation-failed': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'readiness-timeout': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'browser-crashed': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'browser-launch-failed': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'provider-unavailable': { category: 'verification-inconclusive', outcome: 'inconclusive' },
  'session-closed': { category: 'verification-inconclusive', outcome: 'inconclusive' },
};

function classify(code) {
  return CLASSIFY[code] || { category: 'verification-inconclusive', outcome: 'inconclusive' };
}

function verificationsDirFor(stateDirAbs) {
  return path.join(stateDirAbs, 'verifications');
}

/** 写入新的验证报告（id 唯一，不覆盖已有记录）。 */
function writeReport(stateDirAbs, report) {
  const id = report.id || newUuid();
  const body = { schemaVersion: 1, ...report, id };
  const file = path.join(verificationsDirFor(stateDirAbs), `${id}.json`);
  if (fs.existsSync(file)) throw Object.assign(new Error(`验证报告 ${id} 已存在。`), { code: 'immutable-conflict' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(body, null, 2) + '\n');
  return { id, file, report: body };
}

function readReport(stateDirAbs, id) {
  const file = path.join(verificationsDirFor(stateDirAbs), `${id}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function listReports(stateDirAbs) {
  const dir = verificationsDirFor(stateDirAbs);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** 由检查结果得出总体结论：有 failed → failed；否则有 inconclusive → inconclusive；否则 passed。 */
function overall(checks, claims = []) {
  const all = [...checks.map((c) => c.outcome), ...claims.map((c) => c.outcome)];
  if (all.includes('failed')) return 'failed';
  if (all.includes('inconclusive')) return 'inconclusive';
  return 'passed';
}

function exitCodeForReport(report) {
  if (report.result === 'passed') return EXIT.OK;
  if (report.result === 'failed') return EXIT.CONFLICT;
  if (report.checks.some((c) => c.needsInput)) return EXIT.WAITING;
  return EXIT.FAILED;
}

/** 多份报告的退出码：failed > 等待输入 > inconclusive > passed。 */
function exitCodeForReports(reports) {
  const codes = reports.map(exitCodeForReport);
  for (const code of [EXIT.CONFLICT, EXIT.WAITING, EXIT.FAILED]) if (codes.includes(code)) return code;
  return EXIT.OK;
}

module.exports = { RESULTS, CLASSIFY, classify, verificationsDirFor, writeReport, readReport, listReports, overall, exitCodeForReport, exitCodeForReports };
