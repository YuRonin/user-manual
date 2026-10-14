'use strict';

/*
 * Vue 单文件组件（.vue）的依赖提取（docs/MULTI_FRAMEWORK_PLAN.md §7.1、§7.3）。
 *
 * 用官方 @vue/compiler-sfc 拆块，而不是用正则切分 .vue：
 *   <script> / <script setup>   → 交给 JS/TS 的 import 提取（与其他语言共用一套规则）
 *   <script src> / <style src>  → 直接依赖
 *   <style> 里的 @import        → 资源依赖
 *   <template> 里的组件标签      → 本文件没有 import 的标签，按 unplugin-vue-components 的
 *                                 components.d.ts 映射到本地组件文件
 *
 * 检测到 unplugin-vue-components 却找不到 components.d.ts 时，无法确认模板里的组件来自哪里：
 * 记为未解析，页面依赖覆盖降为 partial，update 遇到无法归属的改动会保守扩散，
 * 不会给出「无需更新」的确定结论。编译器延迟加载：非 Vue 项目不会加载它。
 */

const fs = require('fs');
const path = require('path');

let compiler = null;
function sfcCompiler() {
  if (!compiler) compiler = require('@vue/compiler-sfc');
  return compiler;
}

// compiler-core 的 NodeTypes / ElementTypes（数值稳定，避免为两个常量再依赖 compiler-core）
const NODE_ELEMENT = 1;
const TAG_COMPONENT = 1;
const BUILTIN_COMPONENTS = new Set([
  'component', 'transition', 'transition-group', 'keep-alive', 'teleport', 'suspense', 'slot', 'template',
  'router-view', 'router-link', 'RouterView', 'RouterLink', 'Transition', 'TransitionGroup', 'KeepAlive', 'Teleport', 'Suspense', 'Component',
]);

const autoImportCache = new Map();

function toPascal(tag) {
  return tag.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
}

/**
 * 项目的自动导入组件映射：{ enabled, map: Map<PascalName, 绝对路径>, file }。
 * 只收本地组件（`import('./src/...')`），第三方组件库（ant-design-vue 等）不进依赖图。
 */
function autoImportsFor(projectRoot) {
  if (autoImportCache.has(projectRoot)) return autoImportCache.get(projectRoot);
  let enabled = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    enabled = ['dependencies', 'devDependencies'].some((field) => pkg?.[field]?.['unplugin-vue-components']);
  } catch (_) { enabled = false; }
  const map = new Map();
  let file = null;
  for (const candidate of ['components.d.ts', 'src/components.d.ts', 'types/components.d.ts', 'src/types/components.d.ts']) {
    const full = path.join(projectRoot, candidate);
    if (!fs.existsSync(full)) continue;
    file = candidate;
    const text = fs.readFileSync(full, 'utf8');
    const pattern = /^\s*([A-Za-z_$][\w$]*)\s*:\s*typeof\s+import\(\s*['"]([^'"]+)['"]\s*\)/gm;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[2].startsWith('.')) map.set(m[1], path.resolve(path.dirname(full), m[2]));
    }
    break;
  }
  const result = { enabled, map, file };
  autoImportCache.set(projectRoot, result);
  return result;
}

/** 模板 AST 里的组件标签（去重）。 */
function templateComponents(ast) {
  const tags = new Set();
  const visit = (node) => {
    if (!node) return;
    if (node.type === NODE_ELEMENT && node.tagType === TAG_COMPONENT && !BUILTIN_COMPONENTS.has(node.tag)) tags.add(node.tag);
    for (const child of node.children || []) visit(child);
    for (const branch of node.branches || []) visit(branch);
  };
  visit(ast);
  return [...tags];
}

/** 本文件 <script> 里声明的标识符（import 绑定与顶层声明）：模板用到它们就不是自动导入。 */
function scriptBindings(scriptSource) {
  const names = new Set();
  const importPattern = /\bimport\s+([^'";]+?)\s+from\s+['"][^'"]+['"]/g;
  let m;
  while ((m = importPattern.exec(scriptSource)) !== null) {
    for (const part of m[1].replace(/[{}]/g, ',').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().replace(/^type\s+/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  const declPattern = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = declPattern.exec(scriptSource)) !== null) names.add(m[1]);
  // Options API：components: { Foo, Bar }
  const componentsBlock = /\bcomponents\s*:\s*\{([^}]*)\}/.exec(scriptSource);
  if (componentsBlock) for (const part of componentsBlock[1].split(',')) { const n = part.split(':')[0].trim(); if (n) names.add(n); }
  return names;
}

/**
 * @param {string} projectRoot  绝对路径
 * @param {string} file         .vue 文件绝对路径
 * @param {string} source       文件内容
 * @returns {{ script, srcSpecifiers, styleSpecifiers, autoImported: string[], unresolved: string[] }}
 */
function extractVueDependencies(projectRoot, file, source) {
  const rel = path.relative(projectRoot, file).replace(/\\/g, '/');
  const { descriptor, errors } = sfcCompiler().parse(source, { filename: file, sourceMap: false, ignoreEmpty: true });
  const unresolved = [];
  if (errors && errors.length) unresolved.push(`${rel}: .vue 解析报错（${String(errors[0].message || errors[0]).split('\n')[0]}）`);

  const scripts = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
  const script = scripts.map((block) => block.content).join('\n');
  const srcSpecifiers = scripts.map((block) => block.src).filter(Boolean);
  if (descriptor.template?.src) srcSpecifiers.push(descriptor.template.src);
  const styleSpecifiers = [];
  for (const style of descriptor.styles || []) {
    if (style.src) styleSpecifiers.push(style.src);
    const importPattern = /@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = importPattern.exec(style.content || '')) !== null) styleSpecifiers.push(m[1]);
  }

  const autoImported = [];
  const ast = descriptor.template?.ast;
  if (ast) {
    const bindings = scriptBindings(script);
    const auto = autoImportsFor(projectRoot);
    const unknown = [];
    for (const tag of templateComponents(ast)) {
      const pascal = toPascal(tag);
      if (bindings.has(tag) || bindings.has(pascal)) continue;
      const target = auto.map.get(pascal);
      if (target) { autoImported.push(target); continue; }
      if (auto.enabled && !auto.file) unknown.push(tag);
    }
    if (unknown.length) {
      unresolved.push(`${rel}: 模板组件 ${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''} 可能由 unplugin-vue-components 自动导入，但找不到 components.d.ts，无法确认来源`);
    }
  }
  return { script, srcSpecifiers, styleSpecifiers, autoImported: [...new Set(autoImported)].sort(), unresolved };
}

module.exports = { extractVueDependencies, autoImportsFor, templateComponents, toPascal };
