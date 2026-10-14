'use strict';

/*
 * React Router 对象路由适配器（L2，docs/MULTI_FRAMEWORK_PLAN.md §6.2）。
 *
 * V1 支持：createBrowserRouter / createHashRouter / createMemoryRouter / useRoutes 的路由数组；
 * 嵌套 children（相对与绝对路径）、index 路由、无 path 的布局路由、Component / element / lazy
 * 三种组件写法（含 dynamic(() => import()) 这类自定义封装）、数组里的 `...xxx` 展开。
 *
 * 明确报告为不支持（不静默扫出 0 条）：JSX <Routes> 声明式路由、framework mode（@react-router/dev）、
 * patchRoutesOnNavigation 运行时补充路由、无法静态求值的路由数组。
 */

const fs = require('fs');
const path = require('path');

const { DISPOSITION, finalizeDiscovery } = require('./records');
const rt = require('./route-table');

const ROUTER_CALLS = ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', 'createRoutesFromElements'];
const PREFILTER = /\b(createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|patchRoutesOnNavigation)\s*\(|<Routes[\s>]/;
const VITE_CONFIGS = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.mts', 'vite.config.cts'];

function detect(ctx) {
  const version = ctx.depVersion('react-router-dom') || ctx.depVersion('react-router');
  if (!version) return { status: 'absent' };
  // v7 framework mode：路由由 app/routes.ts + @react-router/dev 约定生成，不是对象路由
  if (ctx.depVersion('@react-router/dev')) {
    return {
      status: 'unsupported', version,
      reason: '检测到 React Router framework mode（@react-router/dev），V1 只支持对象路由（createBrowserRouter 等）。',
    };
  }
  return { status: 'supported', version, context: { router: 'react-router' } };
}

/** 路由定义文件中的组件表达式：Component 优先，其次 element、lazy。 */
function componentOf(props) {
  for (const key of ['Component', 'element', 'lazy']) if (props.has(key)) return { key, node: props.get(key) };
  return null;
}

/** element: <Navigate to=… /> 视为重定向。 */
function isNavigateElement(node) {
  const n = rt.unwrap(node);
  return n?.type === 'JSXElement' && n.openingElement.name.type === 'JSXIdentifier' && n.openingElement.name.name === 'Navigate';
}

function discover(ctx) {
  const { projectRoot } = ctx;
  const state = rt.newState(ctx);
  if (ctx.routing?.status === 'unsupported') {
    if (ctx.routing.reason) state.diagnostics.push(ctx.routing.reason);
    return finalizeDiscovery({ adapter: 'react-router-objects', records: [], diagnostics: state.diagnostics, detectStatus: 'unsupported', toPage: () => null });
  }

  const candidates = rt.filesMatching(projectRoot, rt.listSourceFiles(projectRoot), PREFILTER);
  let routerCalls = 0;
  for (const file of candidates) {
    const parsed = rt.parseFile(projectRoot, file, state.cache);
    if (parsed.error) { state.diagnostics.push(`${file}: 解析失败（${parsed.error}）`); continue; }
    if (/<Routes[\s>]/.test(parsed.source)) {
      state.diagnostics.push(`${file}: 使用了 JSX <Routes> 声明式路由，V1 不支持，这部分路由未被扫描。`);
      if (state.detectStatus === 'supported') state.detectStatus = 'partial';
    }
    if (/\bpatchRoutesOnNavigation\b/.test(parsed.source)) {
      rt.addRecord(state, { recordId: `${file}#runtime-routes`, location: { file }, disposition: DISPOSITION.UNRESOLVED, reason: 'runtime-routes', detail: 'patchRoutesOnNavigation 会在运行时补充路由' });
    }
    for (const call of rt.findCalls(parsed, ROUTER_CALLS)) {
      if (call.name === 'createRoutesFromElements') {
        state.diagnostics.push(`${file}:${call.node.loc.start.line}: createRoutesFromElements（JSX 路由）V1 不支持。`);
        if (state.detectStatus === 'supported') state.detectStatus = 'partial';
        continue;
      }
      routerCalls++;
      state.routeSources.add(file);
      const arg = call.node.arguments[0];
      const array = arg ? rt.resolveArray(state, parsed, arg) : null;
      if (!array) {
        rt.addRecord(state, {
          recordId: `${file}#${call.name}@${call.node.loc.start.line}`, location: { file, line: call.node.loc.start.line },
          disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-path', detail: `${call.name} 的参数不是可静态求值的路由数组`,
        });
        continue;
      }
      state.routeSources.add(array.file);
      rt.walkRoutes(state, array, { parentPath: '/', layoutChain: [], keyPath: `${file}#` }, visitRoute);
    }
  }
  if (routerCalls === 0 && state.detectStatus === 'supported') {
    state.detectStatus = state.diagnostics.length ? 'partial' : 'unsupported';
    state.diagnostics.push('依赖里有 React Router，但没有找到 createBrowserRouter / createHashRouter / createMemoryRouter / useRoutes 的路由数组。');
  }

  rt.demoteShadowedLayouts(state.records);
  const result = finalizeDiscovery({
    adapter: 'react-router-objects',
    records: state.records,
    routeSources: [...state.routeSources],
    diagnostics: state.diagnostics,
    detectStatus: state.detectStatus,
    toPage: rt.pageFromRecord('react-router-objects', 'react-router'),
  });
  return result;
}

function visitRoute(state, object, scope) {
  const parsed = rt.parseFile(state.projectRoot, object.file, state.cache);
  const { props } = rt.objectProps(object.node);
  const line = object.node.loc.start.line;
  const location = { file: object.file, line };
  const rawPathNode = props.get('path');
  const rawPath = rawPathNode ? rt.staticString(rawPathNode) : null;
  const isIndex = rt.staticValue(props.get('index')) === true;
  const label = isIndex ? '(index)' : rawPath ?? '(layout)';
  const recordId = rt.childId(scope.keyPath, label);

  if (rawPathNode && rawPath === null) {
    rt.addRecord(state, { recordId, location, disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-path', detail: 'path 不是字符串字面量' });
    return;
  }
  const fullPath = isIndex || rawPath === null ? scope.parentPath : rt.joinPath(scope.parentPath, rawPath);
  const childrenNode = props.get('children');
  const children = childrenNode ? rt.resolveArray(state, parsed, childrenNode) : null;
  const component = componentOf(props);
  let entry = null;
  let unresolvedComponent = null;
  if (component && !(component.key === 'element' && isNavigateElement(component.node))) {
    const resolved = rt.resolveComponent(state, parsed, component.node);
    if (resolved.entry) entry = resolved.entry;
    else unresolvedComponent = resolved;
  }
  const base = { recordId, location, rawPath, fullPath, layoutChain: scope.layoutChain, props: null };

  if (childrenNode && !children) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.UNRESOLVED, reason: 'unresolved-spread', detail: 'children 不是可静态追踪的数组' });
    return;
  }
  if (component?.key === 'element' && isNavigateElement(component.node)) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.SKIPPED, reason: 'redirect' });
    return;
  }
  if (rawPath === '*' || (rawPath && /(^|\/)\*$/.test(rawPath) && rawPath.replace(/\/?\*$/, '') === '')) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.SKIPPED, reason: 'catch-all', ...(entry ? { entry } : {}) });
    return;
  }
  if (unresolvedComponent) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.UNRESOLVED, reason: unresolvedComponent.reason, detail: unresolvedComponent.detail });
    if (children) rt.walkRoutes(state, children, { parentPath: fullPath, layoutChain: scope.layoutChain, keyPath: recordId }, visitRoute);
    return;
  }

  if (children) {
    const childLayout = entry ? [...scope.layoutChain, entry] : scope.layoutChain;
    const hasIndexChild = children.node.elements.some((el) => {
      const obj = el && el.type !== 'SpreadElement' ? rt.resolveObject(state, parsed, el) : null;
      if (!obj) return false;
      const p = rt.objectProps(obj.node).props;
      return rt.staticValue(p.get('index')) === true || rt.staticString(p.get('path')) === '';
    });
    // 有自己的组件与 path、且没有 index 子路由：父路由本身也是一个页面（访问父 URL 渲染它 + 空 Outlet）
    if (entry && rawPath !== null && !hasIndexChild) {
      rt.addRecord(state, { ...base, entry, isLayout: true, disposition: DISPOSITION.PAGE });
    } else {
      rt.addRecord(state, { ...base, ...(entry ? { entry } : {}), isLayout: true, disposition: DISPOSITION.SKIPPED, reason: 'layout-only' });
    }
    rt.walkRoutes(state, children, { parentPath: fullPath, layoutChain: childLayout, keyPath: recordId }, visitRoute);
    return;
  }
  if (!entry) {
    rt.addRecord(state, { ...base, disposition: DISPOSITION.UNRESOLVED, reason: 'dynamic-component', detail: '路由没有 Component / element / lazy' });
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
  id: 'react-router-objects',
  label: 'React Router（对象路由）',
  level: 'ast',
  recordsInFingerprint: true,
  capability: 'route:react-router-objects',
  detect,
  discover,
  implicitDependencies,
  globalFiles,
};
