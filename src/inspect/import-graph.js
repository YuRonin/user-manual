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

function extractSpecifiers(source) {
  const found = [];
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
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
function countDynamicSpecifiers(source) {
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

function resolveSourceFile(candidate) {
  const attempts = [candidate];
  if (!SOURCE_EXTENSIONS.includes(path.extname(candidate))) {
    for (const ext of SOURCE_EXTENSIONS) attempts.push(candidate + ext);
    for (const ext of SOURCE_EXTENSIONS) attempts.push(path.join(candidate, 'index' + ext));
  }

  for (const file of attempts) {
    try {
      if (fs.statSync(file).isFile() && SOURCE_EXTENSIONS.includes(path.extname(file))) return file;
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

function resolveLocalImport(projectRoot, importer, specifier) {
  if (!specifier.startsWith('.')) return null;
  const candidate = path.resolve(path.dirname(importer), specifier);
  if (!isInside(path.resolve(projectRoot), candidate)) return null;
  return resolveSourceFile(candidate);
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

function loadAliasConfig(projectRoot) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const jsonc = stripJsonComments(fs.readFileSync(file, 'utf8'));
      const parsed = JSON.parse(stripTrailingCommas(jsonc));
      const compiler = parsed.compilerOptions || {};
      return {
        file: name,
        baseUrl: path.resolve(projectRoot, compiler.baseUrl || '.'),
        paths: compiler.paths && typeof compiler.paths === 'object' ? compiler.paths : {},
        // extends 链里的 paths 本解析器不跟随：结果按"部分覆盖"记录，而不是假装完整
        extends: parsed.extends || null,
      };
    } catch (_) {
      return null;
    }
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

function resolveConfiguredImport(projectRoot, config, specifier) {
  if (!config) return { matched: false, resolved: null };
  for (const [pattern, targets] of Object.entries(config.paths)) {
    const capture = matchAlias(pattern, specifier);
    if (capture === null) continue;
    for (const target of Array.isArray(targets) ? targets : []) {
      const replaced = target.replace('*', capture);
      const candidate = path.resolve(config.baseUrl, replaced);
      if (!isInside(path.resolve(projectRoot), candidate)) continue;
      const resolved = resolveSourceFile(candidate);
      if (resolved) return { matched: true, resolved };
    }
    return { matched: true, resolved: null };
  }

  const candidate = path.resolve(config.baseUrl, specifier);
  if (isInside(path.resolve(projectRoot), candidate)) {
    const resolved = resolveSourceFile(candidate);
    if (resolved) return { matched: true, resolved };
  }
  return { matched: false, resolved: null };
}

function hasIgnoredExtension(specifier) {
  const ext = path.posix.extname(specifier);
  return ext !== '' && !SOURCE_EXTENSIONS.includes(ext);
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
 * @returns {{ files, assets, unresolved, completeness: 'complete'|'partial' }}
 */
function buildImportGraph(projectRoot, entry) {
  const root = path.resolve(projectRoot);
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

    const dynamicCount = countDynamicSpecifiers(source);
    if (dynamicCount > 0) unresolved.add(`${toPosix(path.relative(root, file))}: ${dynamicCount} 处动态 import/require（无法静态解析）`);

    for (const specifier of extractSpecifiers(source)) {
      if (hasIgnoredExtension(specifier)) {
        if (!ASSET_EXTENSIONS.includes(path.posix.extname(specifier).toLowerCase())) continue;
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
        resolved = resolveLocalImport(root, file, specifier);
        shouldReport = true;
      } else {
        const configured = resolveConfiguredImport(root, aliasConfig, specifier);
        resolved = configured.resolved;
        shouldReport = configured.matched;
      }
      if (!resolved) {
        if (shouldReport) unresolved.add(`${toPosix(path.relative(root, file))}: ${specifier}`);
        continue;
      }
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

module.exports = {
  SOURCE_EXTENSIONS,
  ASSET_EXTENSIONS,
  countDynamicSpecifiers,
  buildImportGraph,
  extractSpecifiers,
  resolveLocalImport,
  loadAliasConfig,
  resolveConfiguredImport,
};
