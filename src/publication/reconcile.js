'use strict';

/*
 * 发布事务对账（契约 C10）：重启后按 journal 与文档当前 hash 决定继续还是停下。
 *
 *   文档 = newDocHash  → 已安装，继续写发布记录与 current 指针
 *   文档 = oldDocHash  → 尚未安装（或安装前中断），从当前状态继续
 *   第三种内容          → 用户在中途修改过：标为 conflict，保留修改，不回滚也不覆盖
 * 过程幂等：重复运行不会重复写资源或产生第二条发布记录。
 */

const path = require('path');

const { advance, listJournals, writeJournal, fileHash, PublicationError } = require('./publisher');

/** 只读：每个未完成事务的状态与下一步会做什么。 */
function status(projectRoot, stateDirAbs) {
  return listJournals(stateDirAbs)
    .filter((journal) => !['completed', 'aborted'].includes(journal.state))
    .map((journal) => {
      const current = fileHash(path.join(projectRoot, journal.documentPath));
      let next;
      if (journal.state === 'conflict') next = 'manual-resolution';
      else if (current === journal.newDocHash || current === journal.oldDocHash) next = 'resume';
      else next = 'conflict';
      return {
        transactionId: journal.transactionId, manualId: journal.manualId, documentPath: journal.documentPath, state: journal.state,
        document: current === journal.newDocHash ? 'new' : (current === journal.oldDocHash ? 'old' : 'modified'), next,
      };
    });
}

/**
 * 继续或标记冲突。dryRun 时只返回 status。
 * @returns {Array<{ transactionId, from, result: 'completed'|'conflict'|'failed', message? }>}
 */
function repair(projectRoot, stateDirAbs, { dryRun = false, hooks = {} } = {}) {
  if (dryRun) return status(projectRoot, stateDirAbs).map((item) => ({ ...item, dryRun: true }));
  const results = [];
  for (const journal of listJournals(stateDirAbs)) {
    if (['completed', 'conflict', 'aborted'].includes(journal.state)) continue;
    const current = fileHash(path.join(projectRoot, journal.documentPath));
    if (current !== journal.newDocHash && current !== journal.oldDocHash) {
      writeJournal(stateDirAbs, { ...journal, state: 'conflict', conflictAt: new Date().toISOString(), conflictFrom: journal.state });
      results.push({ transactionId: journal.transactionId, from: journal.state, result: 'conflict', message: `${journal.documentPath} 被修改过，已保留修改。` });
      continue;
    }
    try {
      advance(projectRoot, stateDirAbs, journal, hooks);
      results.push({ transactionId: journal.transactionId, from: journal.state, result: 'completed' });
    } catch (error) {
      if (error instanceof PublicationError && error.code === 'publication-conflict') {
        writeJournal(stateDirAbs, { ...journal, state: 'conflict', conflictAt: new Date().toISOString(), conflictFrom: journal.state });
        results.push({ transactionId: journal.transactionId, from: journal.state, result: 'conflict', message: error.message });
      } else {
        results.push({ transactionId: journal.transactionId, from: journal.state, result: 'failed', message: `${error.code || 'error'}: ${error.message}` });
      }
    }
  }
  return results;
}

module.exports = { status, repair };
