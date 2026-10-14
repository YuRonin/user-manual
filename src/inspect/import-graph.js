'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mdx'];
// 被源码直接引用、会影响页面外观或文案的本地资源：样式、翻译 / 数据 JSON、图片、字体。
// 它们不再向下遍历，但内容变化必须进入页面指纹。
const ASSET_EXTENSIONS = ['.css', '.scss', '.sass', '.less', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf'];

function toPosix(file) {
  return file.replace(/\\/g, '/');
}

/**
 * 去掉 JS / TS 注释（保留换行，字符串与模板字符串原样跳过）。被注释掉的 import 不是依赖：
 * 否则 `// import { X } from './gone'` 会被当成无法解析的依赖，把页面错标为覆盖不完整。
 */
function stripJsComments(source) {
  let out = '';
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      out += char;
      if (char === '\\') { out += next ?? ''; i++; }
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; out += char; continue; }
    if (char === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) { if (source[i] === '\n') out += '\n'; i++; }
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

function extractSpecifiers(rawSource) {
  const source = stripJsComments(rawSource);
  const found = [];
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    // export * / export * as ns / export { a } / export type { T } from
    /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  }
  return [...new Set(found)];
}

/** 无法静态解析的动态引用：import(expr) / require(expr) / 模板字符串。数量用于标记覆盖不完整。 */
function countDynamicSpecifiers(rawSource) {
  const source = stripJsComments(rawSource);
  const patterns = [
    /\bimport\s*\(\s*(?!['"])[^)\s]/g,
    /\brequire\s*\(\s*(?!['"])[^)\s]/g,
  ];
  let count = 0;
  for (const pattern of patterns) count += (source.match(pattern) || []).length;
  return count;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

/** 依赖图使用的源码扩展名：基线 + 已启用的语言（vue-sfc → .vue）。 */
function extensionsFor(languages = []) {
  return languages.includes('vue-sfc') ? [...SOURCE_EXTENSIONS, '.vue'] : SOURCE_EXTENSIONS;
}

function resolveSourceFile(candidate, exts = SOURCE_EXTENSIONS) {
  const attempts = [candidate];
  if (!exts.includes(path.extname(candidate))) {
    for (const ext of exts) attempts.push(candidate + ext);
    for (const ext of exts) attempts.push(path.join(candidate, 'index' + ext));
  }

  for (const file of attempts) {
    try {
      if (fs.statSync(file).isFile() && exts.includes(path.extname(file))) return file;
    } catch (_) {
      // Try the next supported extension/index candidate.
    }
  }
  return null;
}

/** 本地资源文件（存在才算）。 */
function resolveAssetFile(candidate) {
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch (_) {
    return null;
  }
}

function resolveLocalImport(projectRoot, importer, specifier, exts = SOURCE_EXTENSIONS) {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(importer), specifier);
  if (!isInside(path.resolve(projectRoot), candidate)) return null;
  return resolveSourceFile(candidate, exts);
}

function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) inString = false;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (char === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === ',') {
      let next = i + 1;
      while (/\s/.test(text[next] || '')) next++;
      if (text[next] === '}' || text[next] === ']') continue;
    }
    out += char;
  }
  return out;
}

function readJsonc(file) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(fs.readFileSync(file, 'utf8'))));
}

function aliasFrom(projectRoot, file, parsed) {
  const compiler = parsed.compilerOptions || {};
  return {
    file: toPosix(path.relative(projectRoot, file)),
    baseUrl: path.resolve(path.dirname(file), compiler.baseUrl || '.'),
    paths: compiler.paths && typeof compiler.paths === 'object' ? compiler.paths : {},
    // extends 链里的 paths 本解析器不跟随：结果按"部分覆盖"记录，而不是假装完整
    extends: parsed.extends || null,
  };
}

function loadAliasConfig(projectRoot) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    let parsed;
    try {
      parsed = readJsonc(file);
    } catch (_) {
      return null;
    }
    const own = aliasFrom(projectRoot, file, parsed);
    // 根配置只有 references（create-vue / Vite 模板）：别名写在被引用的子配置里（如 tsconfig.app.json）
    if (Object.keys(own.paths).length === 0 && !own.extends && Array.isArray(parsed.references)) {
      for (const ref of parsed.references) {
        if (!ref || typeof ref.path !== 'string') continue;
        let refFile = path.resolve(projectRoot, ref.path);
        if (fs.existsSync(refFile) && fs.statSync(refFile).isDirectory()) refFile = path.join(refFile, 'tsconfig.json');
        if (!isInside(path.resolve(projectRoot), refFile) || !fs.existsSync(refFile)) continue;
        try {
          const child = aliasFrom(projectRoot, refFile, readJsonc(refFile));
          if (Object.keys(child.paths).length > 0 || child.extends) return child;
        } catch (_) {
          // 子配置解析失败：继续看下一个引用
        }
      }
    }
    return own;
  }
  return null;
}

function matchAlias(pattern, specifier) {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function resolveConfiguredImport(projectRoot, config, specifier, exts = SOURCE_EXTENSIONS) {
  if (!config) return { matched: false, resolved: null };
  for (const [pattern, targets] of Object.entries(config.paths)) {
    const capture = matchAlias(pattern, specifier);
    if (capture === null) continue;
    for (const target of Array.isArray(targets) ? targets : []) {
      const replaced = target.replace('*', capture);
      const candidate = path.resolve(config.baseUrl, replaced);
      if (!isInside(path.resolve(projectRoot), candidate)) continue;
      const resolved = resolveSourceFile(candidate, exts);
      if (resolved) return { matched: true, resolved };
    }
    return { matched: true, resolved: null };
  }

  const candidate = path.resolve(config.baseUrl, specifier);
  if (isInside(path.resolve(projectRoot), candidate)) {
    const resolved = resolveSourceFile(candidate, exts);
    if (resolved) return { matched: true, resolved };
  }
  return { matched: false, resolved: null };
}

/** 资源引用只认已知资源扩展名；`./api.client`、`@/lib/date.utils` 这类带点的模块名按源码解析，不能静默跳过。 */
function isAssetSpecifier(specifier) {
  return ASSET_EXTENSIONS.includes(path.posix.extname(specifier).toLowerCase());
}

/** 资源引用（相对路径或 tsconfig 别名）→ 项目内绝对路径；第三方包返回 null（由 lockfile 指纹覆盖）。 */
function assetCandidate(root, importer, aliasConfig, specifier) {
  if (specifier.startsWith('.')) return path.resolve(path.dirname(importer), specifier);
  if (!aliasConfig) return null;
  for (const [pattern, targets] of Object.entries(aliasConfig.paths)) {
    const capture = matchAlias(pattern, specifier);
    if (capture !== null && Array.isArray(targets) && targets[0]) return path.resolve(aliasConfig.baseUrl, targets[0].replace('*', capture));
  }
  return null;
}

/**
 * @param {string} projectRoot
 * @param {string|string[]} entry  入口文件；数组时第一个是页面入口，其余是框架约定依赖（layout、_app 等）
 * @param {object} [options]
 * @param {string[]} [options.boundary]  不计入依赖、也不向下遍历的文件（项目根相对路径）。用于路由定义文件：
 *   页面组件常 import router 做跳转，若把路由表当普通依赖，改一条路由会让所有页面指纹变化（§8）。
 * @returns {{ files, assets, unresolved, completeness: 'complete'|'partial' }}
 */
function buildImportGraph(projectRoot, entry, { boundary = [], languages = [] } = {}) {
  const root = path.resolve(projectRoot);
  const boundarySet = new Set(boundary.map((file) => path.resolve(root, file)));
  const exts = extensionsFor(languages);
  const roots = (Array.isArray(entry) ? entry : [entry]).map((file) => path.resolve(root, file));
  const entryAbs = roots[0];
  const aliasConfig = loadAliasConfig(root);
  const visited = new Set(roots);
  const files = new Set(roots.slice(1).map((file) => toPosix(path.relative(root, file))));
  const assets = new Set();
  const unresolved = new Set();
  if (aliasConfig?.extends) unresolved.add(`${aliasConfig.file}: extends ${aliasConfig.extends}（未跟随，别名可能不完整）`);

  function visit(file) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (_) {
      unresolved.add(toPosix(path.relative(root, file)));
      return;
    }

    // .vue：拆出 <script> 交给同一套 import 提取；<script src> / <style> 引用与模板里的自动导入组件另行登记
    let specifiers;
    if (path.extname(file) === '.vue' && exts.includes('.vue')) {
      let sfc;
      try {
        sfc = require('./lang/vue-sfc').extractVueDependencies(root, file, source);
      } catch (error) {
        unresolved.add(`${toPosix(path.relative(root, file))}: .vue 解析失败（${String(error.message).split('\n')[0]}）`);
        return;
      }
      for (const item of sfc.unresolved) unresolved.add(item);
      source = sfc.script;
      specifiers = [...extractSpecifiers(sfc.script), ...sfc.srcSpecifiers, ...sfc.styleSpecifiers];
      for (const target of sfc.autoImported) {
        if (!isInside(root, target) || !fs.existsSync(target) || boundarySet.has(target)) continue;
        if (target !== entryAbs) files.add(toPosix(path.relative(root, target)));
        if (!visited.has(target)) { visited.add(target); visit(target); }
      }
    } else {
      specifiers = extractSpecifiers(source);
    }

    const dynamicCount = countDynamicSpecifiers(source);
    if (dynamicCount > 0) unresolved.add(`${toPosix(path.relative(root, file))}: ${dynamicCount} 处动态 import/require（无法静态解析）`);

    // Vite 等打包器的查询 / 片段后缀（`./a.svg?url`、`./b.css?inline`）不属于文件路径
    for (const specifier of [...new Set(specifiers.map((item) => item.replace(/[?#].*$/, '')).filter(Boolean))]) {
      if (isAssetSpecifier(specifier)) {
        const candidate = assetCandidate(root, file, aliasConfig, specifier);
        if (!candidate) continue;
        const asset = isInside(root, candidate) ? resolveAssetFile(candidate) : null;
        if (asset) assets.add(toPosix(path.relative(root, asset)));
        else unresolved.add(`${toPosix(path.relative(root, file))}: ${specifier}`);
        continue;
      }
      let resolved;
      let shouldReport = false;
      if (specifier.startsWith('.')) {
        resolved = resolveLocalImport(root, file, specifier, exts);
        shouldReport = true;
      } else {
        const configured = resolveConfiguredImport(root, aliasConfig, specifier, exts);
        resolved = configured.resolved;
        shouldReport = configured.matched;
      }
      if (!resolved) {
        // 其他扩展名的本地文件（.md、.graphql 等）原样存在时按资源计入指纹，不再静默忽略
        const literal = shouldReport ? assetCandidate(root, file, aliasConfig, specifier) : null;
        const asset = literal && isInside(root, literal) && path.posix.extname(specifier) ? resolveAssetFile(literal) : null;
        if (asset) { assets.add(toPosix(path.relative(root, asset))); continue; }
        if (shouldReport) unresolved.add(`${toPosix(path.relative(root, file))}: ${specifier}`);
        continue;
      }
      if (boundarySet.has(resolved)) continue;
      if (resolved !== entryAbs) files.add(toPosix(path.relative(root, resolved)));
      if (visited.has(resolved)) continue;
      visited.add(resolved);
      visit(resolved);
    }
  }

  for (const start of roots) visit(start);
  files.delete(toPosix(path.relative(root, entryAbs)));
  return {
    files: [...files].sort(),
    assets: [...assets].sort(),
    unresolved: [...unresolved].sort(),
    completeness: unresolved.size > 0 ? 'partial' : 'complete',
  };
}

const aliasCache = new Map();

/**
 * 解析一个模块说明符为项目内源码文件（绝对路径）；第三方包与解析不到的返回 null。
 * 路由表解析用：与依赖图同一套相对路径、目录 index、tsconfig 别名规则。
 */
function resolveModuleSpecifier(projectRoot, importerAbs, specifier, { extensions = SOURCE_EXTENSIONS } = {}) {
  const root = path.resolve(projectRoot);
  if (specifier.startsWith('.')) return resolveLocalImport(root, importerAbs, specifier, extensions);
  if (!aliasCache.has(root)) aliasCache.set(root, loadAliasConfig(root));
  return resolveConfiguredImport(root, aliasCache.get(root), specifier, extensions).resolved;
}

module.exports = {
  resolveModuleSpecifier,
  extensionsFor,
  SOURCE_EXTENSIONS,
  ASSET_EXTENSIONS,
  countDynamicSpecifiers,
  buildImportGraph,
  extractSpecifiers,
  resolveLocalImport,
  loadAliasConfig,
  resolveConfiguredImport,
};
