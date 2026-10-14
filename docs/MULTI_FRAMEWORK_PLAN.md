# 多框架支持改造计划

> 状态：四个阶段已实施（2026-10-14）。实施结果与真实项目核对见 §17。
> 范围：`inspect` 的源码发现层与 `update` 依赖的源码关系图。Capture / Generate / Verify / Site 不在本次改造范围内。
> 首批验证项目：`console-web`（Vite + React Router 6）、`neo-knowledge`（Vite + Vue 3 + Vue Router 4）。

## 1. 目标与非目标

**目标**：DocWitness 不再依赖某个具体框架，也能建立可靠的「页面 → 源码依赖」关系。新增一个技术栈时，最多只需增加一个轻量的路由发现适配器和必要的语言解析扩展，后续手册流程不改动。

**非目标**：

- 不为每个框架维护独立的页面模型、索引或手册流程。
- 不把 AI 当作路由事实的主要来源。能用代码规则确定的部分交给程序，需要理解业务语义的交给 AI，无法确定的保留证据并明确暴露不确定性。
- 不在本轮开发第三方插件系统。适配器只是仓库内部的注册表。
- 不在本轮把 JS/TS 的 import 提取整体改为 AST（见 §7.1）。

## 2. 现状（已对照源码核实）

| 位置 | 现状 | 对扩展的影响 |
|---|---|---|
| `src/inspect/detect.js` | 只识别 Next.js；其他框架只用于给出「暂不支持」提示 | 需要改为识别路由体系和源码语言 |
| `src/inspect/source-graph.js:20` | 写死调用 `scanNextjs()` → `frameworkDependencies()` → `buildImportGraph()` | 框架选择与依赖分析耦合在一条固定流水线上 |
| `src/inspect/nextjs.js` | 纯文件约定扫描，输出 `{ pages, skipped, conflicts }` | 可以直接成为第一个适配器 |
| `src/inspect/framework-dependencies.js` | 按 `page.router === 'app' / 'pages'` 收集 layout、`_app` | 隐式依赖规则需要由适配器提供 |
| `src/inspect/import-graph.js` | 用正则提取 import；`SOURCE_EXTENSIONS` 不含 `.vue`；别名只读 `tsconfig.json` / `jsconfig.json` 的 `paths`；已有 `completeness: complete \| partial` | JS/TS 可以复用；Vue 需要扩展 |
| `src/inspect/fingerprint.js:19` | 全局 `PARSER_VERSION = 'regex-import-graph-3'`，参与每个页面的 revision 计算 | 只要升级任何一种语言的规则，所有页面都会失效 |
| `src/inspect/fingerprint.js:22` | `GLOBAL_FILES` 只列了 Next / Tailwind / PostCSS 配置 | 缺少 `vite.config.*`；构建配置应由适配器补充 |
| `src/inspect/model.js` | 页面按路由匹配；改名靠唯一入口或 `routeBindings`；`route / dynamic / params / entry / router` 是扫描拥有的字段，每次 inspect 都会重写 | 合并逻辑与框架无关，**保留** |
| `src/update/impact.js:150` | 无法归属的源码文件会保守扩散到依赖覆盖不完整的页面；`impactReport` 已能识别页面的新增、删除和指纹变化 | 路由定义文件需要单独分类，否则会误扩散 |
| `docs/ARCHITECTURE.md` | `.manual/pages/*.yaml` 是事实来源；`project.yaml` 和 `index/*.json` 是派生产物 | 新设计必须遵守，不能引入第二个事实来源 |

结论：页面模型、正逆索引、指纹机制、增量影响分析都可以保留。需要改造的只有三处：**框架检测、路由发现、源码依赖解析**。

## 3. 设计原则

1. **统一页面模型。** 所有发现方式最终都输出同一种 `DiscoveredPage`，下游只处理这个统一结构。
2. **单一事实来源。** `pages/*.yaml` 仍是页面事实。AI 候选和人工 override 只作为**扫描的输入**，在 discover 阶段合并进结果，不直接写进页面 YAML（否则下次 inspect 会把它们覆盖掉）。
3. **宁可报告未知，也不报告成功。** 每条路由记录都必须有明确去向，发现的完整性单独报告。漏掉页面却显示扫描成功，是最需要避免的失败模式。
4. **路由结构变化与页面源码变化分开处理。** 路由定义文件变化时，触发重新发现和路由差异比较，不作为普通依赖扩散到全部页面。
5. **解析器按语言能力扩展，而不是按路由库扩展。** 同一个 JS/TS 解析器同时服务 Next.js、React Router、Vue Router 的 `.ts` 文件。
6. **兼容优先。** 每个阶段的验收都包含：现有 Next.js 项目的扫描结果、索引、指纹与改造前一致。

## 4. 目标架构

```
                        ┌──────────────── Detection ────────────────┐
                        │ 路由体系（nextjs / react-router / vue-router / unknown）
                        │ 源码语言（js-ts / vue-sfc）                 │
                        └──────────────────┬────────────────────────┘
                                           ▼
  ┌───────────────────────── Route Discovery（四级）──────────────────────────┐
  │ L1 约定式扫描   nextjs（现有 nextjs.js）                                    │
  │ L2 AST 静态解析 react-router-objects、vue-router-objects                   │
  │ L3 AI 兜底      仅处理 L1/L2 的 unresolved；宿主 AI 提交结构化候选，CLI 校验 │
  │ L4 人工 override + 可选浏览器审计（只发现缺口，不替代源码解析）            │
  └──────────────────────────────────┬────────────────────────────────────────┘
                                     ▼
                     RouteDiscoveryResult（统一结构 + 完整性报告）
                                     ▼
  ┌──────────────── Source Dependency Graph ────────────────┐
  │ Language Parsers：js-ts（现有正则）、vue-sfc（新增）       │
  │ Module Resolver：相对路径 / 扩展名 / 目录入口 / 别名       │
  │ Implicit Deps：适配器提供（layout、父路由组件、自动注册组件）│
  │ Graph Builder：正逆索引、指纹（按能力区分版本）            │
  └──────────────────────────────────┬──────────────────────┘
                                     ▼
              reconcile → pages/*.yaml → Capture / Generate / Verify / Update（不变）
```

四级发现**不是每个项目都要跑四遍**。正常情况下 L1 或 L2 就结束，只有 L2 报告的 unresolved 项才交给 L3。L4 是可选的。

## 5. 核心数据结构

### 5.1 适配器接口

```js
/**
 * @typedef {object} RouteAdapter
 * @property {string} id                 例如 'nextjs' | 'react-router-objects' | 'vue-router-objects'
 * @property {string} level              'convention' | 'ast'
 * @property {(ctx) => DetectResult} detect
 * @property {(ctx) => RouteDiscoveryResult} discover
 * @property {(ctx) => string[]} [globalFiles]               适配器额外贡献的全局文件，例如 vite.config.*
 * @property {(ctx, page) => string[]} [implicitDependencies] 替代 framework-dependencies.js 的分支
 */
```

适配器**只负责**：判断自己能不能分析当前项目，以及产出标准化的发现结果和隐式依赖。截图、AI 描述、文件写入、增量更新都与它无关。

`detect()` 的返回值区分三种情况：

- `supported`：可以完整处理。
- `partial`：识别出了路由体系，但存在已知不支持的写法，例如对象路由和 JSX `<Routes>` 混用。
- `unsupported`：识别出了路由体系，但写法不在支持范围内，例如 React Router framework mode。

`unsupported` 不能静默退化为「扫描到 0 条路由」。

### 5.2 路由记录与去向

```js
/**
 * @typedef {object} RouteRecord
 * @property {string} recordId        稳定 id：定义文件 + 规范化后的嵌套路径（不使用行号，避免格式化后变化）
 * @property {{ file, line, column }} location
 * @property {string|null} rawPath    源码中的原始 path（可能是相对路径）
 * @property {string|null} fullPath   与祖先路径拼接、规范化之后的结果
 * @property {'page'|'skipped'|'unresolved'} disposition
 * @property {string} [reason]        skipped / unresolved 的原因，取值见下表
 * @property {string} [entry]         页面入口文件（disposition=page 时必有）
 * @property {string[]} layoutChain   祖先布局组件的文件路径（从外到内）
 * @property {boolean} isLayout       是否有子路由并渲染 Outlet / router-view（可以同时是 page）
 * @property {string} recordHash      规范化后记录内容的 hash（path、entry、props、meta、layoutChain）
 * @property {'L1'|'L2'|'L3'|'L4'} source
 */
```

**不变式（写进单元测试）**：每条路由记录恰好有一个去向。

```
routeRecords = 产出页面的记录 + skipped + unresolved
```

- 一条记录可以既是 `page` 又是 `isLayout`，比如 console-web 的 `/help` 既有自己的组件又有子路由。`isLayout` 是属性，不是去向。
- 多条记录规范化后指向同一个 URL 时记入 `conflicts`。这时 `pages` 可能少于产出页面的记录数，但每条记录仍然有去向。

`skipped.reason` 取值：

| reason | 含义 | 例子 |
|---|---|---|
| `redirect` | 只有重定向，没有组件 | React Router 的 `element: <Navigate>`；Vue Router 只有 `redirect` 的路由 |
| `catch-all` | 通配兜底页（优先于 redirect 判定） | console-web 的 `*` → not-found；neo-knowledge 的 `/:pathMatch(.*)*` → `/personal` |
| `layout-only` | 只有布局，没有自己的页面内容（无 path 或无 index） | console-web 的 `Guard` 父路由 |
| `excluded` | 命中 `config.inspect.exclude` | — |
| `framework-file` / `private-*` / `api-route` / `intercepting` / `parallel-slot` | Next 现有原因，保持不变 | — |

`unresolved.reason` 取值：`dynamic-path`（path 不是字面量）、`dynamic-component`（组件无法静态定位）、`unresolved-spread`（展开的数组追踪不到）、`unsupported-syntax`、`runtime-routes`（检测到 `addRoute` / `patchRoutesOnNavigation`）。

### 5.3 发现结果

```js
/**
 * @typedef {object} RouteDiscoveryResult
 * @property {string} adapter
 * @property {'complete'|'partial'|'unsupported'} completeness
 * @property {RouteRecord[]} records
 * @property {DiscoveredPage[]} pages        由 disposition=page 的记录规范化得到
 * @property {Array<{route, entries}>} conflicts
 * @property {string[]} routeSources         参与发现的路由定义文件（含被展开引用的文件）
 * @property {object} counts                 { routeRecords, pages, skipped, unresolved, conflicts }
 * @property {string[]} diagnostics
 */
```

判定规则：

- `complete`：不变式成立，且 `unresolved = 0`，且 `detect()` 没有报告不支持的写法。
- `partial`：存在 unresolved 项，或者检测到运行时路由、混用写法。
- `unsupported`：无法给出任何可信结果。

完整性**不以路由数量为判据**。人工验收时逐条核对每条记录的去向是否正确，不检查「扫出来的页面数是否等于某个预期值」。

### 5.4 DiscoveredPage（向下兼容）

在现有 `{ route, dynamic, params, entry, router }` 的基础上**只做增量扩展**：

```js
{
  route, dynamic, params, entry,
  router,          // 'app' | 'pages' | 'react-router' | 'vue-router'
  layoutChain,     // 新增：祖先布局文件，作为 scope 依赖
  recordHash,      // 新增：参与页面指纹（见 §8）
  routeProps,      // 新增，可选：vue-router 的静态 props / meta，用来区分同一入口文件的多个页面
  discovery: { adapter, source, recordId },  // 新增：来源追溯
}
```

`model.js` 的合并逻辑不需要修改。需要确认的一点：同一入口文件对应多条路由时（neo-knowledge 的 `CourseList.vue` 通过 `props.module` 分成三个页面），`reconcile` 的改名判断只在「唯一入口」时触发，现有逻辑已经能正确处理，但要补充测试用例（见 §11）。

## 6. 四级路由发现

### 6.1 L1 约定式扫描

把 `nextjs.js` 包装成 `nextjs` 适配器：

- `discover()` 输出 §5.3 的结构。Next 的每个 `page.*` 文件对应一条记录，现有的 `skipped` 映射为 `disposition=skipped`。
- `implicitDependencies()` 迁入 `framework-dependencies.js` 现有的 App / Pages Router 规则。
- `globalFiles()` 返回 `next.config.*`，从 `GLOBAL_FILES` 中移出，由适配器贡献；最终合并出的集合必须与现在一致。

### 6.2 L2 AST 静态解析

共用一个解析底座：`@babel/parser`（plugins：`typescript`、`jsx`），随 DocWitness 一起安装，**在需要时才加载**。

**React Router（`react-router-objects`）V1 支持范围**：

| 支持 | 明确报告为不支持（partial / unsupported） |
|---|---|
| `createBrowserRouter` / `createHashRouter` / `createMemoryRouter` 的字面量数组参数 | JSX `<Routes>` / `<Route>` 声明式路由 |
| 嵌套 `children`、相对路径与绝对路径（console-web 的子路由是绝对路径） | `useRoutes(x)` 的参数不是字面量 |
| `index: true` 路由 | v7 framework mode（`app/routes.ts` + `@react-router/dev`） |
| 无 path 的布局路由 | `patchRoutesOnNavigation` / 运行时拼接 |
| `Component` / `element` / `lazy` 三种组件写法；值中第一个 `import('…')` 字面量即为入口，因此 `dynamic(() => import())` 这类自定义封装也能覆盖 | 组件是变量，且无法沿 import 追到文件 |
| 直接引用的标识符：沿顶部 import 追到文件 | |
| 数组字面量中的 `...xxx`：沿 import 追到对方文件 `export default` 的字面量数组（最多追两层） | |
| v7 data mode（写法与 v6 相同） | |

**Vue Router（`vue-router-objects`）V1 支持范围**：

| 支持 | 明确报告为不支持 |
|---|---|
| `createRouter({ routes: [...] })` 字面量；`routes` 是同文件常量，或从其他文件 import 的数组 | `router.addRoute()`（检测到后标为 partial，原因 `runtime-routes`） |
| 嵌套 `children`（相对路径拼接） | 路由由函数动态生成 |
| `component: () => import('…')`、直接引用的标识符、`components: { default }` | `unplugin-vue-router` 等文件路由插件（以后作为 L1 适配器单独实现） |
| `redirect` → skipped；`/:pathMatch(.*)*` → catch-all | |
| `...specialPracticeRoutes` 展开（neo-knowledge 实际用到） | |
| 静态 `props` 对象 → `routeProps` | |

**路由定义文件定位**：先按常见位置查找（`src/router/**`、`src/routes.*`、`src/router.*`），找不到时再看 `main.*` 里传给 `RouterProvider` 或 `app.use(router)` 的 import 链。都找不到时，适配器返回 `unsupported`，并提示可以用 L3 或 L4 补充。

### 6.3 L3 AI 兜底

只处理 L2 报告的 `unresolved` 记录，以及 `detect()` 返回 `unsupported` 的项目。

流程与 `describe` 保持同一条职责边界：**AI 理解，程序校验**。

1. `inspect` 输出 unresolved 清单（定义文件、位置、原因、相关源码片段的路径），并在 `--json` 中提示 `model-input-required`。
2. 宿主 AI 读取源码，提交结构化候选。命令为 `manual inspect --routes-input <候选.json>`，输入约定与 `describe` 对齐。
3. CLI 校验：入口文件存在、路径语法合法、`recordId` 对应真实的 unresolved 项或新增声明、不与 L1/L2 结果冲突。
4. 校验通过的候选保存为扫描输入 `.manual/routes.candidates.yaml`（派生文件，带 `source: L3` 和对应源码文件的 hash）。下次 inspect 时，如果相关源码文件 hash 变了，候选会自动标记为过期，重新进入 unresolved。

AI **不直接修改** `pages/*.yaml`，也不为了截图去编造动态参数的取值。

### 6.4 L4 人工 override 与浏览器审计

- **override**：`.manual/routes.override.yaml`，由人维护，作为扫描输入。可以声明新增路由、排除某条记录、修正入口文件。每条都必须写 `reason`。优先级：override > L3 > L2 / L1。
- **浏览器审计**（本轮实现，命令按需执行）：用已授权的认证档案登录测试环境，收集运行时观察到的 URL，与静态发现结果对照，只报告差异，不自动合入。观察来源分两类：
  - **通用（所有框架）**：从已登录页面中提取站内链接（`<a href>`，以及菜单、导航中的链接），按路由模式匹配。匹配不上的 URL 记为「疑似遗漏」。
  - **Vue Router 增强**：通过 `__vue_app__.config.globalProperties.$router.getRoutes()` 读取完整的运行时路由表，能发现 `addRoute()` 动态添加的路由。React Router 没有公开的全局入口，只能使用通用来源。
  - 审计结果是诊断，不改变 completeness，也不写入页面模型。用户确认后通过 override 补充。

## 7. 源码依赖层

### 7.1 语言解析器

| 解析器 | 负责 | 本轮做法 |
|---|---|---|
| `js-ts` | `.js/.jsx/.ts/.tsx/.mjs/.cjs/.mdx` | **沿用现有正则实现**。改为 AST 是独立的后续任务，到时用现有 `import-graph.test.js` 作对照 |
| `vue-sfc` | `.vue` | 用 `@vue/compiler-sfc` 的 `parse` 取出 `<script>` / `<script setup>` 内容，交给 `js-ts` 的 import 提取；模板 AST 只用于识别组件标签（§7.3）；`<style>` 中的 `@import` / `url()` 按资源依赖处理 |

**依赖与加载策略**：

- `@babel/parser` 和 `@vue/compiler-sfc` 都写进 DocWitness 自己的 `dependencies`，并精确固定版本，与 playwright、sharp 的做法一致。
- 代码中延迟 `require`，只在检测到相应路由体系或语言时才加载。非 Vue 项目不会加载 Vue 编译器。
- **不使用 `optionalDependencies`**（它默认照样安装，只是失败时不中断，省不了体积）；**也不从目标项目解析它自带的 `vue/compiler-sfc`**。DocWitness 是独立安装的 Skill，不能假设能从自己的模块目录解析到目标项目的 Vue，也不应该把行为绑定到对方的 Vue 版本和 monorepo 结构上。
- 如果以后安装体积成为实际问题，再考虑拆出独立的可选 Vue 解析包。
- V1 只承诺 **Vue 3 SFC**。Vue 2.7 项目标为 partial 并给出提示。

### 7.2 模块解析

复用 `import-graph.js` 现有的相对路径、扩展名、目录 `index`、tsconfig `paths` 逻辑，补充：

- 扩展名列表按已启用的语言解析器动态生成（启用 Vue 后加入 `.vue`）。
- tsconfig 的 `references` 子项目（neo-knowledge 的 `tsconfig.app.json`）：根 `tsconfig.json` 没有 `paths` 时，依次读取 references 里的配置。neo-knowledge 和 console-web 的根 tsconfig 都已配置 `@/*`，所以这不是首批项目的阻塞项。
- tsconfig `extends`：沿用现有的保守规则，只要所选配置有 `extends` 就记一条未解析（`paths` 与 `baseUrl` 可能来自被继承的配置）。create-vue 生成的 `tsconfig.app.json` 会因此让页面标为 partial，这只影响 `update` 对无法归属改动的扩散范围，不影响页面发现。
- `vite.config` 的 `resolve.alias`：V1 **不解析**（需要执行配置文件或做复杂的 AST 推断）。别名无法解析时，沿用现有逻辑记入 `unresolved`，页面标为 `partial`。

### 7.3 隐式依赖

| 来源 | 提供者 | 说明 |
|---|---|---|
| Next layout / template / `_app` 等 | `nextjs` 适配器 | 从 `framework-dependencies.js` 迁入，行为不变 |
| 父路由组件（`Guard`、`HomeView`） | 路由适配器的 `layoutChain` | 作为 scope 依赖，并递归遍历它们的 import |
| `unplugin-vue-components` 自动注册的本地组件 | `vue-sfc` 扩展 | 读取 `components.d.ts`，建立「组件名 → 文件」映射，再把模板里用到的标签映射到文件。neo-knowledge 中有 12 个本地组件属于这种情况 |

`components.d.ts` 不一定会提交进仓库。检测到 `unplugin-vue-components` 但找不到这个文件时，使用了未解析组件标签的页面标为 `partial`，`update` 遇到无法归属的 `.vue` 改动时按现有规则保守扩散，**不能给出「无需更新」的确定结论**。

## 8. 路由定义文件与增量更新

### 8.1 问题

`src/routes.ts` 被修改，并不代表它管理的 60 个页面都发生了变化。当前规则下，路由文件不在任何页面的依赖图中，会被当成「无法归属的源码」，进而扩散到所有依赖覆盖不完整的页面（`impact.js:150`）。

### 8.2 方案

1. **图中单独登记路由定义文件**：源码图新增 `routeSources: { <file>: <hash> }`，与 `globals` 平级。
2. **影响分类**：在 `impact.js` 中，属于 `routeSources` 的变更归类为 `route-definition-changed`，**不进入**无法归属文件的扩散分支。`update` 本来就会重新执行 `buildSourceGraph`，真正的影响由下面两条机制给出。
3. **页面新增、删除、改名**：沿用现有的 `reconcile` 和 `impactReport`（`page-added` / `page-removed`），不需要新逻辑。
   - 路由定义文件同时是依赖图的**边界**：页面组件常 `import router` 做跳转，依赖图遍历到路由定义文件时停下，不把它和它 import 的其他页面算进页面依赖。路由守卫（`beforeEach`）里的逻辑因此不进页面指纹，修改守卫只会被登记为路由定义变化。
4. **单条路由属性变化**：每条记录的 `recordHash`（path、entry、静态 props / meta、layoutChain）参与该页面的 `sourceRevision`。修改某一条路由的 `props` 只会让这一个页面的指纹变化，原因记为 `route-record-changed:<recordId>`。
5. 适配器贡献的构建配置（`vite.config.*`）进入 `GLOBAL_FILES` 的合并结果，变化时仍然保守扩散到全部页面，与现在对 `next.config.*` 的处理一致。

## 9. 指纹版本按能力区分

**问题**：`PARSER_VERSION` 是全局常量。接入 `.vue` 时如果升级它，所有 Next 页面的 revision 都会变化，导致整个项目重新截图。

**方案**：

```js
const CAPABILITY_VERSIONS = {
  'js-ts': 'regex-import-graph-3',   // 沿用现值，保证 Next 页面的 revision 不变
  'vue-sfc': 'vue-sfc-1',
  'route:nextjs': 'nextjs-1',
  'route:react-router-objects': 'rr-objects-1',
  'route:vue-router-objects': 'vr-objects-1',
};
```

- 页面的 `sourceRevision` 只纳入**它实际用到的能力**：依赖文件涉及的语言解析器，加上发现它的路由适配器。
- **兼容要求**：只用到 `js-ts` 和 `route:nextjs` 的页面，新算法得出的 revision 必须与旧算法**逐字节相同**。实现方式是让旧格式成为新格式的特例：只有一个能力且是 `js-ts` 时，参与 hash 的字段与原来的 `parserVersion: 'regex-import-graph-3'` 保持一致。`route:nextjs` 在 V1 不参与 hash，等 Next 扫描规则真正变化时再引入。
- 图文件中的 `parserVersion` 字段保留，改为记录能力版本表的摘要，并做兼容读取。

## 10. 检测层

`detect.js` 改为输出：

```js
{
  ok,
  routing: { adapter: 'nextjs' | 'react-router-objects' | 'vue-router-objects' | null,
             detected: [...], status: 'supported' | 'partial' | 'unsupported' },
  languages: ['js-ts', 'vue-sfc'],
  // nextjs 专用字段（appDir / pagesDir / router）原样保留在 adapterContext 中
  adapterContext: { ... },
  errors, warnings,
}
```

- 只建模**路由体系**和**源码语言**两个维度。构建工具（Vite / webpack）不单独建模，它们对结果的唯一影响是贡献全局配置文件，由适配器的 `globalFiles()` 负责。
- 判断依据：`package.json` 依赖（`next`、`react-router-dom` / `react-router`、`vue-router`、`@react-router/dev`）、配置文件（`next.config.*`）、路由定义文件特征（`createBrowserRouter`、`createRouter`、`<Routes>`）。
- 同时命中多个路由体系时（比如迁移中的项目），按优先级选择主适配器，在 warnings 中列出其余的，completeness 最高只能是 `partial`。
- `project.yaml` 的 meta 中，`framework` 改为 `routing.adapter`，保留 `framework` 作为兼容字段（Next 项目的值仍为 `nextjs`）。

## 11. 实施阶段

### 阶段 1：统一发现层（不新增框架）

| 任务 | 涉及文件 |
|---|---|
| 定义 `RouteAdapter` / `RouteRecord` / `RouteDiscoveryResult`；新增适配器注册表 | 新增 `src/inspect/adapters/index.js` |
| `nextjs.js` 包装为适配器，迁入隐式依赖和全局文件 | `src/inspect/adapters/nextjs.js`、`nextjs.js`、`framework-dependencies.js` |
| `detect.js` 改为 §10 的结构 | `detect.js` |
| `source-graph.js` 改为适配器分发 | `source-graph.js` |
| 项目级完整性报告和去向不变式 | `source-graph.js`、`commands/inspect.js`（文本与 `--json` 输出） |
| 指纹按能力区分版本（§9） | `fingerprint.js` |
| `routeSources` 登记与 `route-definition-changed` 分类（§8）；Next 的 `routeSources` 为空 | `fingerprint.js`、`update/impact.js` |
| `project.yaml` meta 兼容字段 | `inspect/refresh.js`、`commands/inspect.js`、`inspect/store.js` |

**验收**：

- `npm test` 全部通过。
- 用现有 Next fixture 做前后对照：`pages/*.yaml`、`index/*.json`、源码图中每个页面的 `sourceRevision` **完全一致**（这是 §9 兼容要求的直接检验）。
- 不变式单元测试：Next fixture 中每个 `page.*` 和被跳过的文件都恰好有一个去向。

### 阶段 2：React Router（console-web）

| 任务 | 涉及文件 |
|---|---|
| 引入 `@babel/parser`（精确版本，延迟加载） | `package.json`、新增 `src/inspect/ast/js.js` |
| `react-router-objects` 适配器（§6.2 的支持范围） | 新增 `src/inspect/adapters/react-router.js` |
| 不支持写法的检测（JSX `<Routes>`、`useRoutes`、framework mode、`patchRoutesOnNavigation`） | 同上 |
| `vite.config.*` 加入全局文件 | 适配器的 `globalFiles()` |
| fixture：最小 React Router 项目，覆盖绝对 / 相对子路径、index、无 path 布局、`lazy`、`element`、自定义 `dynamic(() => import())`、spread、`*` | `test/fixtures/` 下新增 |
| 不支持写法的 fixture：JSX Routes、framework mode | 同上 |

**验收**：

- fixture 测试中，每条记录的去向和原因都符合预期，不变式成立。
- console-web **逐条核对路由记录**。预期结果包括：`/` 的 Guard 记录为 `layout-only`；`*` 为 `catch-all`；`/help` 同时是 page 和 layout；`/` 与 `/:code` 都指向登录页（作为普通页面产出，是否排除由用户通过 `inspect.exclude` 决定）。
- console-web 完整走通 `inspect → describe → generate`，至少验证一个页面。
- 修改单条路由的 path，`update` 只报告这一条路由对应页面的新增、删除或改名；修改 `routes.ts` 中的注释，不产生任何页面影响。

### 阶段 3：Vue Router + SFC（neo-knowledge）

| 任务 | 涉及文件 |
|---|---|
| 引入 `@vue/compiler-sfc`（精确版本，延迟加载）；`vue-sfc` 语言解析器 | `package.json`、新增 `src/inspect/ast/vue.js`、`import-graph.js` |
| 扩展名列表按已启用的语言动态生成 | `import-graph.js`、`update/impact.js`（`isSourceLike`） |
| `components.d.ts` 自动组件映射，以及缺失时降级为 partial | `src/inspect/ast/vue.js` |
| `vue-router-objects` 适配器 | 新增 `src/inspect/adapters/vue-router.js` |
| tsconfig `references` 回退读取 | `import-graph.js` |
| fixture：最小 Vue 项目，覆盖相对子路径、redirect、catch-all、跨文件 spread、同一组件对应多路由（不同 props）、自动注册组件、`addRoute` | `test/fixtures/` 下新增 |

**验收**：

- neo-knowledge 逐条核对，包括 `specialPracticeRoutes` 展开出的 10 条记录（入口 1 条 + 写作、语法、阅读各 3 条）。`/` 的 HomeView 记录有 redirect 和 children，预期为 `layout-only`。
- `CourseList.vue` 对应的写作、语法、阅读三个页面保持三个独立的页面身份；只修改其中一条路由的 `props` 时，只有该页面受影响；修改 `CourseList.vue` 时，三个页面都受影响。
- 修改一个自动注册组件（例如 `NeoTag.vue`），`update` 能报告使用它的页面。删除 `components.d.ts` 后，再次修改该组件会得到保守扩散，而不是「无需更新」。
- 阶段 1 的 Next 前后对照仍然一致（Vue 能力的引入不影响 Next 页面的 revision）。

### 阶段 4：AI 兜底、override 与审计

| 任务 | 涉及文件 |
|---|---|
| unresolved 清单输出与 `model-input-required` 提示 | `commands/inspect.js` |
| `--routes-input` 候选提交、校验、`routes.candidates.yaml` 及过期机制 | 新增 `src/inspect/route-candidates.js` |
| `routes.override.yaml` 及优先级合并 | 新增 `src/inspect/route-overrides.js` |
| 路由差异报告（相对上次 inspect，按记录列出新增、删除、修改） | `commands/inspect.js`、`commands/update.js` |
| 浏览器路由审计：通用链接收集 + Vue `getRoutes()` 增强；命令为 `manual verify --routes`（只读，输出差异报告） | 新增 `src/verify/route-audit.js`、`commands/verify.js` |
| SKILL.md 与 `references/command-workflows.md` 中的 AI 提取流程说明 | 文档 |

**验收**：

- 浏览器审计：在 Vue fixture 中通过 `addRoute()` 添加一条路由，并在 React fixture 中放一个指向未声明路由的菜单链接，两者都能被报告为差异；审计过程不修改页面模型。
- 准备一个使用自定义路由封装的 fixture：不修改核心代码，通过 L3 候选或 L4 override 就能补全路由，每条记录都保留来源。
- 候选对应的源码改变后，候选自动过期，重新进入 unresolved。

## 12. 测试策略

- **不变式测试**：在所有适配器的 fixture 上统一断言「每条记录恰好有一个去向」以及 counts 的一致性。
- **Next 前后对照测试**：阶段 1 新增，之后每个阶段都运行。断言 `sourceRevision` 逐页一致。
- **负面测试**：不支持的写法必须得到 `partial` 或 `unsupported` 加诊断信息，不能得到 `complete` 加 0 条路由。
- **真实项目核对**：console-web 和 neo-knowledge 的逐条去向核对表放在测试报告里，不作为自动化测试提交（它们不在本仓库中），但要在 PR 描述中附上。
- **增量测试**：在 `incremental-update.test.js` / `impact-analysis.test.js` 中增加 `route-definition-changed`、`route-record-changed` 场景。

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| 漏掉页面却显示成功 | 去向不变式、项目级 completeness、负面测试、`unsupported` 不退化为 0 条 |
| 改造过程中 Next 页面被全部判定为变化 | §9 兼容要求加前后对照测试，作为阶段 1 的硬性门槛 |
| 自动注册组件漏追踪，导致 `update` 漏报 | `components.d.ts` 映射；缺失时降级为 partial，按现有规则保守扩散 |
| 同一入口文件对应多路由被误判为改名 | 现有 `reconcile` 只在唯一入口时触发改名；补充测试锁定这个行为 |
| AI 候选过期后仍被使用 | 候选绑定源码 hash，hash 变化即失效 |
| 动态参数路由无法截图 | 沿用现有 `params`、Scenario、认证档案的机制；不让 AI 编造参数值，缺参时由用户提供或跳过采集 |
| 依赖体积增长 | 延迟加载；体积成为实际问题后再拆出可选包 |
| 按角色控制权限导致截图被重定向 | 不属于发现层的问题，沿用现有的认证档案和 Scenario（其他角色）机制；在接入文档中提示 |

## 14. 文档更新清单

完成相应阶段后更新：

- `README.md`、`SKILL.md`：支持范围（逐阶段放开），不夸大支持程度。
- `docs/ARCHITECTURE.md`：「框架支持」一节改为适配器架构，并链接本文件；「尚未提供」中的第 1 项相应调整。
- `docs/GETTING_STARTED.md`：Vite + React Router / Vue Router 项目的接入说明。
- `references/command-workflows.md`：`--routes-input` 与 override 的使用说明（阶段 4）。

## 15. 工作量估计

| 阶段 | 估计 |
|---|---|
| 阶段 1：统一发现层 | 2～3 人日 |
| 阶段 2：React Router | 2～3 人日 |
| 阶段 3：Vue Router + SFC | 2～4 人日 |
| 阶段 4：AI 兜底、override、审计 | 2～4 人日 |
| **合计** | **约 8～14 人日** |

以上是工程规划的量级，没有在两个真实项目上实测过，实际耗时取决于路由写法的变体和端到端测试的情况。

## 16. 已决事项（2026-10-14）

1. L3 命令采用 `manual inspect --routes-input <候选.json>`，与 `describe --input` 对称。
2. console-web 中 `/` 与 `/:code` 都指向登录页：不内置合并规则，作为普通页面产出，由用户通过 `inspect.exclude` 决定是否排除。
3. 浏览器路由审计纳入本轮（阶段 4），按 §6.4 的方案实现。四个阶段全部完成后统一推送。

## 17. 实施结果（2026-10-14）

**兼容性**：三个 Next 夹具（App Router、Pages Router、采集夹具）在改造前后逐页对照，`sourceRevision`、`graph.json`、页面 YAML、正向索引逐字节一致；全部单元测试与浏览器 / 端到端测试通过。

**真实项目核对**（只读扫描，未写入两个项目）：

| 项目 | 适配器 | 完整性 | 记录 | 页面 | 跳过 | 未解析 | 页面依赖覆盖 |
|---|---|---|---|---|---|---|---|
| console-web | react-router-objects | complete | 61 | 59 | 2（Guard 布局壳 layout-only、`*` catch-all） | 0 | 59 / 59 complete |
| neo-knowledge | vue-router-objects | complete | 39 | 37 | 2（HomeView 的 redirect 布局 layout-only、`/:pathMatch(.*)*` catch-all） | 0 | 37 / 37 complete |

- console-web：`/` 与 `/:code` 都作为登录页产出（按 §16 第 2 条交给 `inspect.exclude`）；`/help` 既是页面又是 `/help/*` 的布局，子页面布局链为 Guard → help。
- neo-knowledge：`specialPracticeRoutes` 展开出 10 条记录；`CourseList.vue` / `CourseEditor.vue` 按 `props.module` 各对应 3 个独立页面。

**实施中发现并修复的依赖图问题**（对 Next 项目同样生效）：注释掉的 import 曾被当成依赖、Vite 的 `?url` / `?raw` 后缀导致资源解析失败。修复前 console-web 有 56 个页面被错标为依赖覆盖不完整。

**与计划的差异**：
- 路由定义文件同时作为依赖图边界（§8），避免页面 `import router` 时把整张路由表算进页面依赖。
- 浏览器审计除 Vue 3 运行时路由表外，增加了对所有框架通用的站内链接收集（§6.4），命令为 `manual verify --routes`。
- `catch-all` 判定优先于 `redirect`。
