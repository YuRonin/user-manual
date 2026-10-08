# Living User Manual 正逆索引设计

## 目标

在不改变现有 `init → inspect → capture → generate` 主链路的前提下，把代码依赖关系纳入 `inspect`，生成页面正索引与文件逆索引，为上下文增强和后续 `manual update` 提供稳定输入。

## 设计选择

采用旁路 JSON 索引：`.manual/pages/*.yaml` 继续作为页面事实源，新增 `.manual/index/forward.json` 与 `.manual/index/reverse.json` 作为可随时重建的派生产物。现有 `project.yaml` 保留，避免破坏旧项目和当前命令输出。

未采用以下方案：

- 只扩充 `project.yaml`：文件较少，但正向和逆向关系混杂，不利于未来按变更文件查询页面。
- 图数据库或通用节点边模型：扩展性更强，但超出 MVP 的复杂度和维护成本。

## 页面模型

`inspect` 在每个 `.manual/pages/<id>.yaml` 中新增扫描拥有的 `dependencies` 字段：

```yaml
entry: src/app/login/page.tsx
dependencies:
  files:
    - src/components/Input.tsx
    - src/components/LoginForm.tsx
    - src/hooks/useAuth.ts
  unresolved: []
```

`files` 是从入口文件递归追踪得到的项目内静态依赖，不包含入口本身。`unresolved` 只记录看起来属于本项目、但无法确定到实际文件的导入，供诊断使用。该字段每次 inspect 重写；老页面没有此字段时等同于空依赖。

V1 识别：

- ES `import ... from`、副作用 import、`export ... from`。
- 参数为字符串字面量的 `require()`。
- 相对导入，以及能由 `tsconfig.json` / `jsconfig.json` 的 `baseUrl`、`paths` 解析的项目别名。
- `.js`、`.jsx`、`.ts`、`.tsx`、`.mjs`、`.cjs`、`.mdx`，以及目录下的 `index.*`。

V1 忽略：

- 第三方包、`node_modules`、样式、图片、字体和其他静态资源。
- 动态表达式 import/require。
- props、API 调用和运行时交互关系。

依赖遍历使用已访问集合处理循环引用；所有落盘路径转为项目相对 POSIX 路径并稳定排序。

## 索引格式

`.manual/index/forward.json` 以 route 为键：

```json
{
  "/login": {
    "id": "login",
    "entry": ["src/app/login/page.tsx"],
    "files": [
      "src/app/login/page.tsx",
      "src/components/Input.tsx",
      "src/components/LoginForm.tsx",
      "src/hooks/useAuth.ts"
    ],
    "components": [
      "src/components/Input.tsx",
      "src/components/LoginForm.tsx"
    ],
    "hooks": ["src/hooks/useAuth.ts"],
    "apis": [],
    "scenarios": [],
    "screenshot": null,
    "manual": "docs/manual/login.md"
  }
}
```

`.manual/index/reverse.json` 以源码文件为键：

```json
{
  "src/components/Input.tsx": ["/login", "/register", "/settings"],
  "src/hooks/useAuth.ts": ["/login", "/profile"]
}
```

`files` 包含入口文件，因此入口文件也能通过逆索引找到所属页面。`components` 与 `hooks` 是对 `files` 的保守分类：V1 依据规范化路径和 hook 文件名分类，不推断代码语义。`apis`、`scenarios` 预留为空数组。

## 数据流

```text
scan routes
    ↓
recursive static import graph
    ↓
page YAML (dependencies)
    ↓
forward.json ──invert──▶ reverse.json
    ↓                       ↓
capture route lookup       future update impact lookup
generate source context
```

`inspect` 完成路由合并后分析每个当前页面入口，写页面 YAML、`project.yaml` 和两个 JSON 索引。`describe` 与 `capture` 改写页面状态后，根据页面 YAML 中保存的 dependencies 重建索引，确保截图和文档路径等派生字段同步。

`capture` 和 `generate` 通过统一的索引读取器按 page id/route 获取上下文。索引不存在、格式损坏或没有对应页面时，回退现有页面 YAML 行为，保持旧项目可用；命令不会把派生索引当成唯一事实源。

## 错误处理

- 单个静态导入无法解析：记录在 `dependencies.unresolved`，并由 inspect 输出 warning；其他页面继续构建。
- 入口文件不可读：该页只保留入口，记录 warning，不让整个 inspect 失败。
- 索引目录不存在：自动创建。
- 索引 JSON 损坏：消费者回退页面 YAML；下一次 inspect/describe/capture 会重建。
- 写入使用现有统一文件工具，JSON 采用两个空格缩进并带末尾换行，保证可审查 diff。

## 测试策略

测试遵循 TDD：每项行为先增加失败测试，再写最小实现。

- import graph：直接依赖、递归依赖、循环依赖、re-export、literal require、扩展名与目录 index。
- 解析边界：第三方包和静态资源忽略；无法解析的本地 import 被报告。
- alias：`baseUrl` 和 `paths` 映射。
- index builder：正向字段、共享文件逆向映射、去重、稳定排序、Windows 路径规范化。
- inspect 集成：生成两个 JSON 文件并把 dependencies 写入页面 YAML；重复运行结果稳定。
- capture/generate：优先消费索引，同时验证索引缺失或损坏时的兼容回退。
- 回归：运行现有 init、inspect、capture、generate 全量测试。

## 非目标

V1 不实现 API 检测、props 分析、Playwright 运行时关系、Git diff 驱动的 `manual update`，也不引入数据库。它只建立这些能力所需的稳定索引基础。
