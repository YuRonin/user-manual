'use strict';

/*
 * Vue Router 对象路由适配器（L2，docs/MULTI_FRAMEWORK_PLAN.md §6.2）。
 *
 * V1 支持：createRouter({ routes }) / new VueRouter({ routes })；routes 可以是同文件常量或从别的文件导入；
 * 嵌套 children（相对路径拼接，也接受绝对路径）、`...xxxRoutes` 展开、component: () => import() /
 * 直接引用的组件 / components.default、redirect、/:pathMatch(.*)* 兜底、静态 props 与 meta。
 *
 * 明确报告：router.addRoute()（运行时补充路由 → partial）、unplugin-vue-router 文件路由（unsupported）、
 * Vue 2（vue-router 3，按 partial 处理并提示）。
 */

const fs = require('fs');
const path = require('path');

const { DISPOSITION, finalizeDiscovery } = require('./records');
const rt = require('./route-table');
const { SOURCE_EXTENSIONS } = require('../import-graph');

const PREFILTER = /\b(createRouter|VueRouter|addRoute)\b/;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'];
const VUE_EXTENSIONS = [...SOURCE_EXTENSIONS, '.vue'];

function majorOf(version) {
  const m = /(\d+)/.exec(String(version || ''));
  return m ? Number(m[1]) : null;
}

function detect(ctx) {
  const version = ctx.depVersion('vue-router');
  if (!version) return { status: 'absent' };
  if (ctx.depVersion('unplugin-vue-router')) {
    return { status: 'unsupported', version, reason: '检测到 unplugin-vue-router（文件路由），V1 只支持在代码里定义的路由表（createRouter({ routes })）。' };
  }
  if (majorOf(version) !== null && majorOf(version) < 4) {
    return { status: 'partial', version, context: { router: 'vue-router' }, reason: `vue-router ${version}（Vue 2）：路由表按 V1 规则扫描，但 V1 只承诺 Vue 3，结果标为不完整。` };
  }
  return { status: 'supported', version, context: { router: 'vue-router' } };
}

/** createRouter({ routes }) 与 new VueRouter({ routes }) 的配置对象里的 routes 表达式。 */
function routerCalls(parsed) {
  const out = [];
  rt.walk(parsed.ast.program, (n) => {
    const isCall = n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'createRouter';
    const isNew = n.type === 'NewExpression' && n.callee.type === 'Identifier' && /^(VueRouter|Router)$/.test(n.callee.name);
    if (isCall || isNew) out.push(n);
    return true;
  });
  return out;
}

/** router.addRoute(...)：运行时补充的路由，静态分析看不到。 */
function addRouteCalls(parsed) {
  const out = [];
  rt.walk(parsed.ast.program, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed
      && n.callee.property.type === 'Identifier' && n.callee.property.name === 'addRoute') out.push(n);
    return true;
  });
  return out;
}

/** 兜底路由：任一段带 `(.*)` 正则（/:pathMatch(.*)*、/:catchAll(.*)）或是裸 `*`（Vue Router 3）。 */
function isCatchAll(rawPath) {
  return rawPath === '*' || /:[\w$]+\(\.\*\)/.test(rawPath);
}

function discover(ctx) {
  const { projectRoot } = ctx;
  const state = rt.newState(ctx, { extensions: VUE_EXTENSIONS });
  if (ctx.routing?.reason) state.diagnostics.push(ctx.routing.reason);
  if (ctx.routing?.status === 'unsupported') {
    return finalizeDiscovery({ adapter: 'vue-router-objects', records: [], diagnostics: state.diagnostics, detectStatus: 'unsupported', toPage: () => null });
  }

  const candidates = rt.filesMatching(projectRoot, rt.listSourceFiles(projectRoot), PREFILTER);
  let calls = 0;
  for (const file of candidates) {
    const parsed = rt.parseFile(projectRoot, file, state.cache);
    if (parsed.error) { state.diagnostics.push(`${file}: 解析失败（${parsed.error}）`); continue; }
    for (const call of addRouteCalls(parsed)) {
      rt.addRecord(state, {
        recordId: `${file}#addRoute@${call.loc.start.line}`, location: { file, line: call.loc.start.line },
        disposition: DISPOSITION.UNRESOLVED, reason: 'runtime-routes', detail: 'router.addRoute() 在运行时补充路由',
      });
    }
    for (const call of routerCalls(parsed)) {
      calls++;
      state.routeSources.add(file);
      const options = call.arguments[0] ? rt.resolveObject(state, parsed, call.arguments[0]) : null;
      const routesNode = options ? rt.objectProps(options.node).props.get('routes') : null;
      const optionsParsed = options ? rt.parseFile(projectRoot, options.file, state.cache) : parsed;
      const array = routesNode ? rt.resolveArray(state, optionsParsed, routesNode) : null;
      if (!array) {
        rt.addRecord(state, {
          recordId: `${file}#router@${call.loc.start.line}`, location: { file, line: call.loc.start.line },
          disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-path', detail: 'routes 不是可静态求值的路由数组',
        });
        continue;
      }
      state.routeSources.add(array.file);
      rt.walkRoutes(state, array, { parentPath: '/', layoutChain: [], keyPath: `${array.file}#` }, visitRoute);
    }
  }
  if (calls === 0) {
    state.detectStatus = 'unsupported';
    state.diagnostics.push('依赖里有 vue-router，但没有找到 createRouter({ routes }) / new VueRouter({ routes })。');
  }

  rt.demoteShadowedLayouts(state.records);
  return finalizeDiscovery({
    adapter: 'vue-router-objects',
    records: state.records,
    routeSources: [...state.routeSources],
    diagnostics: state.diagnostics,
    detectStatus: state.detectStatus,
    toPage: rt.pageFromRecord('vue-router-objects', 'vue-router'),
  });
}

/** component / components.default 的组件表达式。 */
function componentNode(state, parsed, props) {
  if (props.has('component')) return props.get('component');
  if (props.has('components')) {
    const components = rt.resolveObject(state, parsed, props.get('components'));
    if (components) return rt.objectProps(components.node).props.get('default') || null;
  }
  return null;
}

function visitRoute(state, object, scope) {
  const parsed = rt.parseFile(state.projectRoot, object.file, state.cache);
  const { props } = rt.objectProps(object.node);
  const location = { file: object.file, line: object.node.loc.start.line };
  const rawPathNode = props.get('path');
  const rawPath = rawPathNode ? rt.staticString(rawPathNode) : null;
  const recordId = rt.childId(scope.keyPath, rawPath ?? '(no path)');

  if (rawPath === null) {
    rt.addRecord(state, { recordId, location, disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-path', detail: rawPathNode ? 'path 不是字符串字面量' : '路由缺少 path' });
    return;
  }
  const fullPath = rawPath === '' ? scope.parentPath : rt.joinPath(scope.parentPath, rawPath);
  const childrenNode = props.get('children');
  const children = childrenNode ? rt.resolveArray(state, parsed, childrenNode) : null;
  const component = componentNode(state, parsed, props);
  // 静态 props / meta 区分同一组件的多个页面（如 CourseList 的 module: writing / grammar / reading），进记录 hash
  const staticProps = props.has('props') ? rt.staticValue(props.get('props')) : null;
  const staticMeta = props.has('meta') ? rt.staticValue(props.get('meta')) : null;
  const base = {
    recordId, location, rawPath, fullPath, layoutChain: scope.layoutChain,
    props: staticProps === undefined ? { dynamic: true } : staticProps,
    meta: staticMeta === undefined ? { dynamic: true } : staticMeta,
  };

  let entry = null;
  let unresolvedComponent = null;
  if (component) {
    const resolved = rt.resolveComponent(state, parsed, component);
    if (resolved.entry) entry = resolved.entry;
    else unresolvedComponent = resolved;
  }

  if (childrenNode && !children) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.UNRESOLVED, reason: 'unresolved-spread', detail: 'children 不是可静态追踪的数组' });
    return;
  }
  if (isCatchAll(rawPath)) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.SKIPPED, reason: 'catch-all', ...(entry ? { entry } : {}) });
    return;
  }
  const redirects = props.has('redirect');
  if (unresolvedComponent) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.UNRESOLVED, reason: unresolvedComponent.reason, detail: unresolvedComponent.detail });
    if (children) rt.walkRoutes(state, children, { parentPath: fullPath, layoutChain: scope.layoutChain, keyPath: recordId }, visitRoute);
    return;
  }
  if (children) {
    const childLayout = entry ? [...scope.layoutChain, entry] : scope.layoutChain;
    const hasEmptyChild = children.node.elements.some((el) => {
      const obj = el && el.type !== 'SpreadElement' ? rt.resolveObject(state, parsed, el) : null;
      return obj ? rt.staticString(rt.objectProps(obj.node).props.get('path')) === '' : false;
    });
    // 访问父 URL 会重定向，或由 path:'' 子路由承接：父路由只是布局
    if (entry && !redirects && !hasEmptyChild) {
      rt.addRecord(state, { ...base, entry, isLayout: true, disposition: DISPOSITION.PAGE });
    } else {
      rt.addRecord(state, { ...base, ...(entry ? { entry } : {}), isLayout: true, disposition: DISPOSITION.SKIPPED, reason: 'layout-only' });
    }
    rt.walkRoutes(state, children, { parentPath: fullPath, layoutChain: childLayout, keyPath: recordId }, visitRoute);
    return;
  }
  if (redirects) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.SKIPPED, reason: 'redirect' });
    return;
  }
  if (!entry) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-component', detail: '路由没有 component / components.default' });
    return;
  }
  rt.addRecord(state, { ...base, entry, disposition: DISPOSITION.PAGE });
}

function implicitDependencies(ctx, page) {
  return rt.layoutDependencies(page);
}

function globalFiles(ctx) {
  return [...VITE_CONFIGS, 'index.html'].filter((file) => fs.existsSync(path.join(ctx.projectRoot, file)));
}

module.exports = {
  id: 'vue-router-objects',
  label: 'Vue Router',
  level: 'ast',
  recordsInFingerprint: true,
  capability: 'route:vue-router-objects',
  detect,
  discover,
  implicitDependencies,
  globalFiles,
};
