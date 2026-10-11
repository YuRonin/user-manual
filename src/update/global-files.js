'use strict';

/*
 * 全局文件的分级（B5-09）。全局文件（package.json、lockfile、构建配置）变化原先一律让所有页面重采；
 * 实际上大部分修改与页面渲染无关。这里按内容比较：
 *
 *   package.json  只比较 dependencies / devDependencies / peerDependencies / engines / type / browserslist；
 *                 只改 scripts、description 等不影响运行的字段 → 不扩散，记 global-ignored
 *   package-lock.json  只比较运行关键依赖（框架、UI 运行时）的解析版本；其余依赖升级 → 不扩散
 *   其他全局文件（tsconfig、next / tailwind / postcss 配置、pnpm / yarn / bun lockfile）→ 无法细分，保守扩散
 *
 * 基线内容取自 Git（git show <base>:<file>）；拿不到基线时按变化处理（宁可多报）。
 * 返回 null 表示"有运行影响"，调用方按原规则扩散；返回 { ignored, detail } 表示可以忽略。
 */

const fs = require('fs');
const path = require('path');

const PACKAGE_RUNTIME_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'engines', 'type', 'browserslist', 'workspaces', 'overrides', 'resolutions'];
// 影响页面渲染的运行时依赖（lockfile 中只看它们的解析版本）
const RUNTIME_PACKAGES = ['react', 'react-dom', 'next', 'vue', 'nuxt', '@angular/core', 'svelte', '@sveltejs/kit', 'solid-js', 'preact',
  'tailwindcss', 'postcss', 'antd', '@mui/material', 'element-plus', '@arco-design/web-react', 'styled-components', '@emotion/react'];

function baselineContent(projectRoot, base, file) {
  if (!base) return null;
  try {
    const { execFileSync } = require('child_process');
    return execFileSync('git', ['show', `${base}:${file}`], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, windowsHide: true }).toString('utf8');
  } catch (_) { return null; }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return null; }
}

function lockVersions(lock) {
  const out = {};
  for (const name of RUNTIME_PACKAGES) {
    out[name] = lock?.packages?.[`node_modules/${name}`]?.version ?? lock?.dependencies?.[name]?.version ?? null;
  }
  return out;
}

/**
 * @returns {null | { ignored: true, detail: string }}
 */
function classifyGlobalChange({ projectRoot, base, file }) {
  if (!['package.json', 'package-lock.json'].includes(file)) return null;
  const before = parseJson(baselineContent(projectRoot, base, file));
  let after = null;
  try { after = parseJson(fs.readFileSync(path.join(projectRoot, file), 'utf8')); } catch (_) { after = null; }
  if (!before || !after) return null;
  if (file === 'package.json') {
    const changed = PACKAGE_RUNTIME_FIELDS.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
    if (changed.length) return null;
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null));
    return { ignored: true, detail: `package.json#${touched.join(',') || '(格式)'}` };
  }
  const a = lockVersions(before);
  const b = lockVersions(after);
  const changed = RUNTIME_PACKAGES.filter((name) => a[name] !== b[name]);
  if (changed.length) return null;
  return { ignored: true, detail: 'package-lock.json#(运行关键依赖版本未变)' };
}

/** package.json / package-lock.json 中运行关键依赖的变化说明（用于影响原因，便于解释为什么全量）。 */
function runtimeChangeDetail({ projectRoot, base, file }) {
  if (file === 'package.json') {
    const before = parseJson(baselineContent(projectRoot, base, file));
    let after = null;
    try { after = parseJson(fs.readFileSync(path.join(projectRoot, file), 'utf8')); } catch (_) { after = null; }
    if (!before || !after) return file;
    const changed = PACKAGE_RUNTIME_FIELDS.filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
    return changed.length ? `${file}#${changed.join(',')}` : file;
  }
  if (file === 'package-lock.json') {
    const before = parseJson(baselineContent(projectRoot, base, file));
    let after = null;
    try { after = parseJson(fs.readFileSync(path.join(projectRoot, file), 'utf8')); } catch (_) { after = null; }
    if (!before || !after) return file;
    const a = lockVersions(before);
    const b = lockVersions(after);
    const changed = RUNTIME_PACKAGES.filter((name) => a[name] !== b[name]);
    return changed.length ? `${file}#${changed.map((name) => `${name}@${a[name] || '∅'}→${b[name] || '∅'}`).join(',')}` : file;
  }
  return file;
}

module.exports = { classifyGlobalChange, runtimeChangeDetail, RUNTIME_PACKAGES, PACKAGE_RUNTIME_FIELDS };
