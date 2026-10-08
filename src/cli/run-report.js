'use strict';

/*
 * Run 结果输出（generate / capture / resume 共用）。JSON 给宿主读取；文本给人看。
 * 退出码按 C08：成功 0；等待输入 3；失败 1；冲突 / 漂移 4。
 */

const { EXIT, exitCodeForRun, exitCodeForCode } = require('./output');
const path = require('path');

function publishedDocuments(plan, summary, projectRoot, docsOutputDir) {
  if (!projectRoot) return [];
  if (!docsOutputDir) {
    const loaded = require('../config/load').loadConfig(projectRoot);
    if (!loaded.ok) return [];
    docsOutputDir = loaded.config.docs.outputDir;
  }
  const succeeded = new Set(summary.succeeded || []);
  return (plan?.tasks || [])
    .filter((task) => task.kind === 'publish' && succeeded.has(task.id))
    .map((task) => {
      const subject = task.input?.subject;
      if (!subject || !['page', 'task'].includes(subject.type)) return null;
      const relativePath = path.join(docsOutputDir, ...(subject.type === 'task' ? ['tasks'] : []), `${subject.id}.md`);
      return { subject: `${subject.type}:${subject.id}`, path: path.join(projectRoot, relativePath) };
    })
    .filter(Boolean);
}

function waitingHint(runId, waiting, plan = null) {
  if (waiting.code === 'model-input-required') return `按请求文件处理后：manual run-submit ${runId} --request <requestId> --input <响应.json>，再 manual resume ${runId}`;
  if (waiting.code === 'approval-required' || waiting.code === 'scope-changed') return `确认任务后：manual approve-tasks --input <决定.json>，再 manual resume ${runId}`;
  if (waiting.code === 'fixture-cleanup-required') return `测试数据清理失败：确认测试环境可用后 manual resume ${runId} 重试清理（按命名空间幂等）`;
  if (waiting.code === 'merge-conflict') return `人工修改与新生成冲突：按提案合入正式文档（或把要保留的块标为 owner=human）后 manual resume ${runId}；或加 --force 重新运行覆盖`;
  if (waiting.code === 'document-missing') return `已发布文档不存在：确认重新生成请加 --force 重新运行；要下线请把页面 / 任务标为 retired`;
  if (waiting.code === 'review-required') return `确认文案属实后用 --accept-review 重新运行 generate，或修改文案后 resume --replan`;
  if (['auth-missing', 'auth-expired', 'login-required'].includes(waiting.code)) {
    const profile = plan?.tasks?.find((task) => task.id === waiting.id)?.input?.authProfile;
    return `运行 manual auth login${profile ? ` --profile ${profile}` : ''} --resume ${runId}，登录后自动继续原 Run`;
  }
  return `处理后运行 manual resume ${runId}`;
}

function printRun({ json, result, label = 'generate', projectRoot = null, docsOutputDir = null, extra = {}, lines = [] }) {
  const { runId, summary, plan } = result;
  const code = exitCodeForRun(summary);
  const documents = publishedDocuments(plan, summary, projectRoot, docsOutputDir);
  const warnings = plan?.summary?.warnings || [];
  if (json) {
    process.stdout.write(JSON.stringify({
      ok: summary.status === 'succeeded',
      runId,
      status: summary.status,
      ...(result.predecessor ? { predecessor: result.predecessor } : {}),
      succeeded: summary.succeeded,
      pending: summary.pending,
      waiting: summary.waiting.map((w) => ({ ...w, next: waitingHint(runId, w, plan) })),
      failed: summary.failed,
      interrupted: summary.interrupted,
      cache: plan?.summary?.cache || [],
      riskBoundaries: plan?.summary?.riskBoundaries || [],
      documents,
      warnings,
      ...extra,
    }, null, 2) + '\n');
    return code;
  }
  const L = ['', `[manual ${label}] Run ${runId}：${summary.status}`];
  for (const item of plan?.summary?.cache || []) {
    L.push(`  ${item.hit ? '复用' : '采集'} ${item.subject}：${item.reason}${item.observedAt ? `（观察于 ${item.observedAt}，未在线确认）` : ''}`);
  }
  if (summary.succeeded.length) L.push(`  已完成: ${summary.succeeded.join(', ')}`);
  for (const document of documents) L.push(`  文档 ${document.subject}: ${document.path}`);
  for (const warning of warnings) L.push(`  提示: ${warning}`);
  for (const w of summary.waiting) L.push(`  等待 ${w.id}（${w.code}）: ${w.message}`, `    → ${waitingHint(runId, w, plan)}`);
  for (const f of summary.failed) L.push(`  失败 ${f.id}（${f.code}）: ${f.message}`);
  if (summary.interrupted.length) L.push(`  中断: ${summary.interrupted.join(', ')}（manual resume ${runId} 继续）`);
  if (summary.pending.length && summary.status !== 'succeeded') L.push(`  未开始: ${summary.pending.join(', ')}`);
  L.push(...lines);
  L.push('');
  (code === EXIT.OK ? process.stdout : process.stderr).write(L.join('\n') + '\n');
  return code;
}

/** Runtime 错误（规划失败、输入变化、Run 忙等）。 */
function printRuntimeError({ json, error, label }) {
  const errors = error.errors || [error.message];
  if (json) {
    process.stdout.write(JSON.stringify({ ok: false, code: error.code || 'runtime-error', errors, ...(error.candidates ? { candidates: error.candidates } : {}), ...(error.changed ? { changed: error.changed } : {}) }, null, 2) + '\n');
  } else {
    for (const e of errors) process.stderr.write(`[manual ${label}] ${e}\n`);
  }
  return exitCodeForCode(error.code);
}

module.exports = { printRun, printRuntimeError, waitingHint, publishedDocuments };
