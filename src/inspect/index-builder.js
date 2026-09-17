'use strict';

const path = require('path');

function normalizePath(file) {
  return String(file).replace(/\\/g, '/').replace(/^\.\//, '');
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean).map(normalizePath))].sort();
}

function isComponent(file) {
  return /(^|\/)components?\//i.test(file);
}

function isHook(file) {
  const base = path.posix.basename(file).replace(/\.[^.]+$/, '');
  return /(^|\/)hooks?\//i.test(file) || /^use[A-Z0-9]/.test(base);
}

function buildForwardIndex(pages, { docsOutputDir = 'docs/manual' } = {}) {
  const forward = {};
  const orderedPages = [...pages].sort((a, b) => String(a.route).localeCompare(String(b.route)));
  for (const page of orderedPages) {
    const entry = uniqueSorted([page.entry]);
    const files = uniqueSorted([...entry, ...(page.dependencies?.files || [])]);
    forward[page.route] = {
      id: page.id,
      route: page.route,
      entry,
      files,
      components: files.filter(isComponent),
      hooks: files.filter(isHook),
      apis: [],
      scenarios: [],
      screenshot: page.browser?.screenshot ?? null,
      manual: path.posix.join(normalizePath(docsOutputDir), `${page.id}.md`),
      includeInManual: page.includeInManual !== false,
    };
  }
  return forward;
}

function buildReverseIndex(forward) {
  const routesByFile = new Map();
  for (const [route, info] of Object.entries(forward)) {
    for (const file of info.files || []) {
      if (!routesByFile.has(file)) routesByFile.set(file, new Set());
      routesByFile.get(file).add(route);
    }
  }

  const reverse = {};
  for (const file of [...routesByFile.keys()].sort()) {
    reverse[file] = [...routesByFile.get(file)].sort();
  }
  return reverse;
}

function buildIndexes(pages, options) {
  const forward = buildForwardIndex(pages, options);
  return { forward, reverse: buildReverseIndex(forward) };
}

module.exports = {
  buildForwardIndex,
  buildReverseIndex,
  buildIndexes,
  normalizePath,
};
