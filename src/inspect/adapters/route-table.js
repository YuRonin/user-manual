'use strict';

/*
 * 路由表静态解析底座（docs/MULTI_FRAMEWORK_PLAN.md §6.2，L2）。
 *
 * React Router 与 Vue Router 的「对象路由」共用这里：解析 JS/TS 文件、追踪 import 与常量绑定、
 * 展开数组里的 `...xxx`、在组件表达式里找第一个 `import('…')`。框架语义（哪些键是组件、
 * 子路由路径怎么拼、什么算重定向）由各适配器通过 hooks 提供。
 *
 * 能确定的才下结论；表达式不是字面量、绑定追不到时返回 null，由调用方记成 unresolved，
 * 不猜、不静默丢弃。@babel/parser 延迟加载：Next 项目不会加载它。
 */

const fs = require('fs');
const path = require('path');

const { resolveModuleSpecifier, SOURCE_EXTENSIONS } = require('../import-graph');

const MAX_SPREAD_DEPTH = 2;
const MAX_SCAN_FILES = 5000;
const MAX_FILE_BYTES = 1024 * 1024;
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', '.manual', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.output', '__tests__', '__mocks__']);

let babelParser = null;
function parser() {
  if (!babelParser) babelParser = require('@babel/parser');
  return babelParser;
}

function toPosix(value) {
  return value.replace(/\\/g, '/');
}

/** 解析一个源码文件。.ts 不开 jsx（避免与 `<T>x` 类型断言冲突）。解析失败返回 { error }。 */
function parseFile(projectRoot, rel, cache) {
  if (cache.has(rel)) return cache.get(rel);
  let result;
  try {
    const source = fs.readFileSync(path.join(projectRoot, rel), 'utf8');
    const ext = path.extname(rel).toLowerCase();
    const plugins = ext === '.ts' || ext === '.mts' || ext === '.cts' ? ['typescript'] : ext === '.tsx' ? ['typescript', 'jsx'] : ['jsx'];
    const ast = parser().parse(source, {
      sourceType: 'unambiguous', errorRecovery: true, allowImportExportEverywhere: true, allowReturnOutsideFunction: true,
      plugins: [...plugins, 'decorators-legacy', 'importAttributes', 'topLevelAwait'],
    });
    result = { file: rel, ast, source, bindings: collectBindings(ast) };
  } catch (error) {
    result = { file: rel, error: error.message };
  }
  cache.set(rel, result);
  return result;
}

/** 文件顶层绑定：import（含 default / named / namespace）、const / let / var 声明、export default。 */
function collectBindings(ast) {
  const imports = new Map();
  const locals = new Map();
  let exportDefault = null;
  const namedExports = new Map();
  for (const statement of ast.program.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const spec of statement.specifiers) {
        const imported = spec.type === 'ImportDefaultSpecifier' ? 'default'
          : spec.type === 'ImportNamespaceSpecifier' ? '*'
            : (spec.imported.name ?? spec.imported.value);
        imports.set(spec.local.name, { source: statement.source.value, imported });
      }
      continue;
    }
    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
    if (declaration?.type === 'VariableDeclaration') {
      for (const d of declaration.declarations) {
        if (d.id.type === 'Identifier' && d.init) {
          locals.set(d.id.name, d.init);
          if (statement.type === 'ExportNamedDeclaration') namedExports.set(d.id.name, d.init);
        }
      }
    } else if (declaration?.type === 'FunctionDeclaration' && declaration.id) {
      locals.set(declaration.id.name, declaration);
    }
    if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) {
      for (const spec of statement.specifiers || []) {
        if (spec.type === 'ExportSpecifier') namedExports.set(spec.exported.name ?? spec.exported.value, { type: 'Identifier', name: spec.local.name });
      }
    }
    if (statement.type === 'ExportDefaultDeclaration') exportDefault = statement.declaration;
  }
  return { imports, locals, exportDefault, namedExports };
}

/** 去掉 TS 包装：`x as T`、`x satisfies T`、`<T>x`、`x!`、括号。 */
function unwrap(node) {
  let current = node;
  while (current && ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion', 'TSNonNullExpression', 'ParenthesizedExpression'].includes(current.type)) {
    current = current.expression;
  }
  return current;
}

/** 静态字符串：字符串字面量，或没有插值的模板字符串。其余返回 null。 */
function staticString(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'StringLiteral') return n.value;
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis.map((q) => q.value.cooked).join('');
  return null;
}

/** 静态 JSON 值（对象 / 数组 / 字面量）；含函数、变量等不可静态求值的部分时返回 undefined。 */
function staticValue(node) {
  const n = unwrap(node);
  if (!n) return undefined;
  switch (n.type) {
    case 'StringLiteral': return n.value;
    case 'NumericLiteral': return n.value;
    case 'BooleanLiteral': return n.value;
    case 'NullLiteral': return null;
    case 'TemplateLiteral': return n.expressions.length === 0 ? staticString(n) : undefined;
    case 'ArrayExpression': {
      const out = [];
      for (const el of n.elements) {
        const v = staticValue(el);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case 'ObjectExpression': {
      const out = {};
      for (const prop of n.properties) {
        if (prop.type !== 'ObjectProperty' || prop.computed) return undefined;
        const key = propKey(prop);
        const v = staticValue(prop.value);
        if (key === null || v === undefined) return undefined;
        out[key] = v;
      }
      return out;
    }
    default: return undefined;
  }
}

function propKey(prop) {
  if (prop.computed) return null;
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'StringLiteral') return prop.key.value;
  return null;
}

/** 对象字面量的属性表（只取普通属性与方法；spread 单独返回）。 */
function objectProps(node) {
  const props = new Map();
  const spreads = [];
  for (const prop of node.properties) {
    if (prop.type === 'SpreadElement') { spreads.push(prop); continue; }
    const key = prop.type === 'ObjectProperty' || prop.type === 'ObjectMethod' ? propKey(prop) : null;
    if (key !== null) props.set(key, prop.type === 'ObjectMethod' ? prop : prop.value);
  }
  return { props, spreads };
}

/** 遍历 AST 子树（不依赖 @babel/traverse）。visitor 返回 false 时不进入该节点的子节点。 */
function walk(node, visitor) {
  if (!node || typeof node.type !== 'string') return;
  if (visitor(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'extra') continue;
    const value = node[key];
    if (Array.isArray(value)) { for (const item of value) walk(item, visitor); }
    else if (value && typeof value.type === 'string') walk(value, visitor);
  }
}

/** 子树里第一个 `import('字面量')`。 */
function firstDynamicImport(node) {
  let found = null;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === 'CallExpression' && n.callee.type === 'Import' && n.arguments.length > 0) {
      const spec = staticString(n.arguments[0]);
      if (spec !== null) { found = spec; return false; }
    }
    if (n.type === 'ImportExpression') {
      const spec = staticString(n.source);
      if (spec !== null) { found = spec; return false; }
    }
    return true;
  });
  return found;
}

/**
 * 解析模块说明符为项目内源码文件（项目根相对路径）。第三方包与解析不到的返回 null。
 * 扩展名表允许额外的语言（例如 .vue）。
 */
function resolveSpecifier(ctx, fromFile, specifier) {
  const resolved = resolveModuleSpecifier(ctx.projectRoot, path.join(ctx.projectRoot, fromFile), specifier, { extensions: ctx.extensions });
  return resolved ? toPosix(path.relative(ctx.projectRoot, resolved)) : null;
}

/**
 * 标识符 → 它在源码中的定义。沿 import 跨文件追（最多 depth 层）。
 * @returns {{ kind: 'node', node, file } | { kind: 'module', file, imported } | null}
 *   kind=module：标识符是从另一个本地模块导入的组件（不再往下追组件内部）。
 */
function resolveIdentifier(ctx, parsed, name, { depth = MAX_SPREAD_DEPTH, followImports = true } = {}) {
  if (parsed.bindings.locals.has(name)) return { kind: 'node', node: parsed.bindings.locals.get(name), file: parsed.file };
  const imported = parsed.bindings.imports.get(name);
  if (!imported) return null;
  const file = resolveSpecifier(ctx, parsed.file, imported.source);
  if (!file) return null;
  if (!followImports || depth <= 0) return { kind: 'module', file, imported: imported.imported };
  if (!/\.(m|c)?(t|j)sx?$/.test(file)) return { kind: 'module', file, imported: imported.imported };
  const target = parseFile(ctx.projectRoot, file, ctx.cache);
  if (target.error) return { kind: 'module', file, imported: imported.imported };
  let node = null;
  if (imported.imported === 'default') node = target.bindings.exportDefault;
  else if (imported.imported !== '*') node = target.bindings.namedExports.get(imported.imported) || null;
  if (!node) return { kind: 'module', file, imported: imported.imported };
  node = unwrap(node);
  if (node.type === 'Identifier') {
    const inner = resolveIdentifier(ctx, target, node.name, { depth: depth - 1, followImports });
    return inner || { kind: 'module', file, imported: imported.imported };
  }
  return { kind: 'node', node, file };
}

/** 表达式 → 数组字面量（直接、同文件常量、跨文件导出）。返回 { node, file } 或 null。 */
function resolveArray(ctx, parsed, node, depth = MAX_SPREAD_DEPTH) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'ArrayExpression') return { node: n, file: parsed.file };
  if (n.type === 'Identifier') {
    const found = resolveIdentifier(ctx, parsed, n.name, { depth });
    if (found?.kind !== 'node') return null;
    const target = found.file === parsed.file ? parsed : parseFile(ctx.projectRoot, found.file, ctx.cache);
    return resolveArray(ctx, target, found.node, depth - 1);
  }
  return null;
}

/** 表达式 → 对象字面量（直接或同文件 / 跨文件常量）。 */
function resolveObject(ctx, parsed, node, depth = MAX_SPREAD_DEPTH) {
  const n = unwrap(node);
  if (!n) return null;
  if (n.type === 'ObjectExpression') return { node: n, file: parsed.file };
  if (n.type === 'Identifier' && depth > 0) {
    const found = resolveIdentifier(ctx, parsed, n.name, { depth });
    if (found?.kind !== 'node') return null;
    const target = found.file === parsed.file ? parsed : parseFile(ctx.projectRoot, found.file, ctx.cache);
    return resolveObject(ctx, target, found.node, depth - 1);
  }
  return null;
}

/**
 * 组件表达式 → 入口文件。依次尝试：
 *   1. 子树里第一个 import('…')（覆盖 () => import()、lazy(() => import())、dynamic(() => import()) 等封装）
 *   2. 标识符：沿 import 找到组件所在模块；同文件定义的组件 → 当前文件
 *   3. JSX 元素 <Foo />：按标识符 Foo 处理
 * @returns {{ entry } | { entry: null, reason }}
 */
function resolveComponent(ctx, parsed, node) {
  const n = unwrap(node);
  if (!n) return { entry: null, reason: 'dynamic-component' };
  const dynamic = firstDynamicImport(n);
  if (dynamic) {
    const entry = resolveSpecifier(ctx, parsed.file, dynamic);
    return entry ? { entry } : { entry: null, reason: 'dynamic-component', detail: `无法解析 import('${dynamic}')` };
  }
  let name = null;
  if (n.type === 'Identifier') name = n.name;
  else if (n.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier') name = n.openingElement.name.name;
  if (name) {
    const found = resolveIdentifier(ctx, parsed, name, { followImports: false });
    if (found?.kind === 'module') return { entry: found.file };
    if (found?.kind === 'node') return { entry: parsed.file };
    return { entry: null, reason: 'dynamic-component', detail: `组件 ${name} 不是本地模块（第三方组件或未解析的别名）` };
  }
  return { entry: null, reason: 'dynamic-component', detail: `无法静态确定的组件表达式（${n.type}）` };
}

/** 列出项目里可能含路由定义的源码文件（跳过依赖与产物目录）。 */
function listSourceFiles(projectRoot, extensions = SOURCE_EXTENSIONS) {
  const out = [];
  const walkDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walkDir(full);
      } else if (entry.isFile() && extensions.includes(path.extname(entry.name).toLowerCase())) {
        if (/\.(test|spec|stories)\.[^.]+$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
        try { if (fs.statSync(full).size > MAX_FILE_BYTES) continue; } catch (_) { continue; }
        out.push(toPosix(path.relative(projectRoot, full)));
      }
    }
  };
  const srcDir = path.join(projectRoot, 'src');
  walkDir(fs.existsSync(srcDir) ? srcDir : projectRoot);
  return out.sort();
}

/** 先用文本预筛，只解析可能相关的文件。 */
function filesMatching(projectRoot, files, pattern) {
  return files.filter((rel) => {
    try { return pattern.test(fs.readFileSync(path.join(projectRoot, rel), 'utf8')); } catch (_) { return false; }
  });
}

/** 找调用：callee 是标识符（或成员表达式的属性）名在 names 中的 CallExpression。 */
function findCalls(parsed, names) {
  const out = [];
  walk(parsed.ast.program, (n) => {
    if (n.type !== 'CallExpression') return true;
    const callee = n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property : n.callee;
    if (callee.type === 'Identifier' && names.includes(callee.name)) out.push({ node: n, name: callee.name });
    return true;
  });
  return out;
}

/** 规范化 URL 路径：合并重复斜杠、去掉非根路由的结尾斜杠。 */
function normalizeUrl(route) {
  const cleaned = `/${route}`.replace(/\/{2,}/g, '/');
  return cleaned.length > 1 ? cleaned.replace(/\/$/, '') : '/';
}

function joinPath(parent, child) {
  if (child.startsWith('/')) return normalizeUrl(child);
  return normalizeUrl(`${parent || ''}/${child}`);
}

/**
 * 路由路径里的参数：`:id`、`:id?`、`:id(\\d+)`、`:pathMatch(.*)*`、`*`（splat）。
 * @returns {{ route, dynamic, params }}  route 统一成 `:name` / `:name?` / `:name*` 形式
 */
function routeParams(fullPath) {
  const params = [];
  const segments = fullPath.split('/').map((seg) => {
    if (seg === '*') { params.push('splat'); return ':splat*'; }
    const m = /^:([A-Za-z_$][\w$]*)(?:\([^)]*\))?([?*+]?)$/.exec(seg);
    if (!m) return seg;
    params.push(m[1]);
    return `:${m[1]}${m[2] === '+' ? '*' : m[2]}`;
  });
  return { route: normalizeUrl(segments.join('/')), dynamic: params.length > 0, params };
}


// ---------------------------------------------------------------- 路由树遍历（各适配器共用）

const { DISPOSITION } = require('./records');

/** 发现过程的可变状态：记录、路由定义文件、诊断、AST 缓存。 */
function newState(ctx, { extensions = SOURCE_EXTENSIONS } = {}) {
  return {
    projectRoot: ctx.projectRoot, cache: new Map(), extensions,
    records: [], routeSources: new Set(), diagnostics: [], ids: new Map(), detectStatus: ctx.routing?.status || 'supported',
  };
}

/** recordId：定义文件 + 嵌套路径链；同一层同名时加序号。不含行号（格式化不应改变身份）。 */
function uniqueId(state, base) {
  const n = (state.ids.get(base) || 0) + 1;
  state.ids.set(base, n);
  return n === 1 ? base : `${base}~${n}`;
}

function addRecord(state, record) {
  state.records.push({ layoutChain: [], isLayout: false, source: 'L2', ...record, recordId: uniqueId(state, record.recordId) });
}

/** 子记录 id：父 id + ' > ' + 本层标签；顶层直接接在 `文件#` 后面。 */
function childId(keyPath, label) {
  return `${keyPath}${keyPath.endsWith('#') ? '' : ' > '}${label}`;
}

/**
 * 遍历一层路由数组：展开 `...xxx`，把每个对象字面量交给适配器的 visit。
 * 无法静态追踪的展开 / 非对象路由项记为 unresolved，不静默丢弃。
 * @param {{ node, file }} array
 * @param {{ parentPath, layoutChain, keyPath }} scope
 * @param {(state, object, scope) => void} visit
 */
function walkRoutes(state, array, scope, visit) {
  const parsed = parseFile(state.projectRoot, array.file, state.cache);
  for (const element of array.node.elements) {
    if (!element) continue;
    if (element.type === 'SpreadElement') {
      const spread = resolveArray(state, parsed, element.argument);
      if (!spread) {
        addRecord(state, {
          recordId: childId(scope.keyPath, '...'), location: { file: array.file, line: element.loc.start.line },
          disposition: DISPOSITION.UNRESOLVED, reason: 'unresolved-spread', detail: '展开的路由数组无法静态追踪',
        });
        continue;
      }
      state.routeSources.add(spread.file);
      walkRoutes(state, spread, scope, visit);
      continue;
    }
    const object = resolveObject(state, parsed, element);
    if (!object) {
      addRecord(state, {
        recordId: childId(scope.keyPath, '?'), location: { file: array.file, line: element.loc.start.line },
        disposition: DISPOSITION.UNRESOLVED, reason: 'unsupported-syntax', detail: `路由项不是对象字面量（${element.type}）`,
      });
      continue;
    }
    if (object.file !== array.file) state.routeSources.add(object.file);
    visit(state, object, scope);
  }
}

/** 布局路由的 URL 已由另一条普通页面记录提供：它只是布局（如 path:'/' 的鉴权壳），不另算页面。 */
function demoteShadowedLayouts(records) {
  const leafPaths = new Set(records.filter((r) => r.disposition === DISPOSITION.PAGE && !r.isLayout).map((r) => r.fullPath));
  for (const record of records) {
    if (record.disposition === DISPOSITION.PAGE && record.isLayout && leafPaths.has(record.fullPath)) {
      record.disposition = DISPOSITION.SKIPPED;
      record.reason = 'layout-only';
    }
  }
}

/** 页面记录 → DiscoveredPage（适配器共用）。 */
function pageFromRecord(adapter, router) {
  return (record) => {
    const { route, dynamic, params } = routeParams(record.fullPath);
    return {
      route, dynamic, params, entry: record.entry, router,
      layoutChain: record.layoutChain,
      routeRecord: { adapter, recordId: record.recordId, recordHash: record.recordHash, source: record.source, file: record.location?.file || null },
    };
  };
}

/** 父路由及其布局链之外的隐式依赖：布局组件随页面一起渲染。 */
function layoutDependencies(page) {
  return [...new Set(page.layoutChain || [])].filter((file) => file !== page.entry);
}

module.exports = {
  newState, addRecord, childId, walkRoutes, demoteShadowedLayouts, pageFromRecord, layoutDependencies,
  parseFile, staticString, staticValue, objectProps, unwrap, walk, firstDynamicImport,
  resolveSpecifier, resolveIdentifier, resolveArray, resolveObject, resolveComponent,
  listSourceFiles, filesMatching, findCalls, normalizeUrl, joinPath, routeParams, propKey,
};
