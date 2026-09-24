'use strict';

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./atomic-write');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * 以 UTF-8 写文本，自动建目录。统一用 LF，避免跨平台 diff 噪音。
 * 通过唯一 temp + fsync + rename 原子替换，失败时旧文件保持不变。
 */
function writeText(filePath, content) {
  writeFileAtomic(filePath, content.replace(/\r\n/g, '\n'));
}

/**
 * 覆盖前备份。返回备份路径；原文件不存在则返回 null。
 * 已有 .bak 会被再次覆盖——备份只保证「上一版还在」，不做历史归档。
 */
function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const backupPath = `${filePath}.bak`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

/** 转成相对 from 的、用 '/' 分隔的展示路径；不在 from 内部时回退成绝对路径。 */
function displayPath(filePath, from) {
  const rel = path.relative(from, filePath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return filePath;
  return rel.replace(/\\/g, '/');
}

module.exports = { ensureDir, writeText, backupFile, displayPath };
