'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mdx'];

function toPosix(file) {
  return file.replace(/\\/g, '/');
}

function extractSpecifiers(source) {
  const found = [];
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) found.push(match[1]);
  }
  return [...new Set(found)];
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

function loadAliasConfig(projectRoot) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(projectRoot, name);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(fs.readFileSync(file, 'utf8')));
      const compiler = parsed.compilerOptions || {};
      return {
        baseUrl: path.resolve(projectRoot, compiler.baseUrl || '.'),
        paths: compiler.paths && typeof compiler.paths === 'object' ? compiler.paths : {},
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

function buildImportGraph(projectRoot, entry) {
  const root = path.resolve(projectRoot);
  const entryAbs = path.resolve(root, entry);
  const aliasConfig = loadAliasConfig(root);
  const visited = new Set([entryAbs]);
  const files = new Set();
  const unresolved = new Set();

  function visit(file) {
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (_) {
      unresolved.add(toPosix(path.relative(root, file)));
      return;
    }

    for (const specifier of extractSpecifiers(source)) {
      if (hasIgnoredExtension(specifier)) continue;
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

  visit(entryAbs);
  return {
    files: [...files].sort(),
    unresolved: [...unresolved].sort(),
  };
}

module.exports = {
  SOURCE_EXTENSIONS,
  buildImportGraph,
  extractSpecifiers,
  resolveLocalImport,
  loadAliasConfig,
  resolveConfiguredImport,
};
