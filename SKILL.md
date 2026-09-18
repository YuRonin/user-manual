---
name: manual
description: Use when a Web project needs a living user manual, task-oriented操作指南, page discovery, real-browser screenshots, or maintained Markdown help content; also when the user invokes /manual commands or asks to 初始化、扫描、截图、生成或更新使用手册。
---

# manual —— Living User Manual

给任意 Web 项目建一份「活的」用户手册。页面模型提供位置与证据，用户任务模型组织最终指南；真实浏览器负责验证状态与截图，程序负责确定性校验和落盘。

Skill 自身代码与项目数据分离：**Skill 只提供能力，项目状态一律落在业务项目的 `.manual/`。**

## 当前版本能力

| 命令 | 状态 | 作用 |
|---|---|---|
| `manual init` | ✅ V0.1 | 收集配置，生成 `.manual/config.yaml` |
| `manual inspect` | ✅ V0.2+ | 扫描路由与静态源码依赖，建立页面模型和正逆索引 |
| `manual describe` | ✅ V0.2 | 把页面的源码分析结果写回模型 |
| `manual capture` | ✅ V0.3 | 用真实浏览器打开页面并截图 |
| `manual generate` | ✅ V0.4 | 生成 Markdown 手册（含中文自然化） |
| `manual discover-tasks` | ✅ Task-first 基础 | 基于页面证据准备候选发现工作清单并写入候选任务 |
| `manual approve-tasks` | ✅ Task-first 基础 | 由人工批准、调整或拒绝候选任务 |
| `manual plan-capture` / `capture-task` | ✅ Task-first 采集 | 任务截图计划 / 安全交互采集 |
| `manual generate-task` / `verify` | ✅ Task-first 发布 | 任务指南草稿、结构化事实校验与最终验证 |
| `manual migrate-artifacts` | ✅ 兼容迁移 | 检查旧页面原图，显式复制到非发布产物目录且不删除源文件 |
| `manual update` | ⏳ | 增量更新与过期处理 |

未实现的命令被调用时 CLI 会明确提示，不会静默失败。

**任何命令都不改动业务项目代码**，只写 `.manual/` 与配置里指定的文档目录。

---

## 任务优先工作流

当用户要的是“怎样完成某件事”，使用任务流程；不要把页面上的每个按钮机械地写成并列功能。页面式 `capture` / `generate` 在迁移期继续用于页面总览和静态证据。

```text
manual inspect
→ manual describe
→ manual discover-tasks <page-id|--all>
→ AI 基于工作清单提出候选 JSON
→ manual discover-tasks ... --input <候选.json>
→ 把候选名称、目标、步骤、风险和证据摘要展示给用户
→ 用户明确确认后 manual approve-tasks --input <决策.json>
```

候选任务必须保持 `candidate`；不得代替用户批准，也不得把“请生成手册”解释成对所有候选任务的批量批准。只有 `approved` 任务才能进入后续截图计划、任务采集和发布。

任务批准后，先运行 `manual plan-capture <task-id> --json`，把计划里的动作、状态断言、截图点和风险边界展示给用户。确认计划符合预期后再运行 `manual capture-task <task-id>`。`read` / `local` 可执行，`write` 停在动作前，`destructive` 不执行；目标缺失、不可见、匹配多个或状态断言失败时立即停止，并保留诊断图。

任务证据完成脱敏与标注后，运行 `manual generate-task <task-id> --json` 生成事实草稿。按中文写作规范编辑草稿，再用 `--finalize <文件>` 定稿；最后运行 `manual verify <task-id>`。正式任务文档只能引用 `images/annotated/`，任何 raw、sanitized、缺失图片或结构化事实变化都会阻止发布。

执行候选发现或审批时，先读 [references/task-workflow.md](references/task-workflow.md)。

---

## `$manual-init` / `/manual-init` —— 初始化配置

### 1. 先问用户六项配置

用一次 AskUserQuestion 把下面五项一起问完：

| 项 | 选项 / 默认 |
|---|---|
| 截图规格 | `desktop-standard` 1440×900 @2x（默认）· `desktop-wide` 1920×1080 @1x · `laptop` 1280×800 @2x · `custom` |
| Browser Provider | `playwright-headless` 无头，快（默认）· `playwright-headed` 有头，能看见操作过程 |
| 项目访问 URL | 必填。**先问清开发服务器是否在跑、端口多少**，不要想当然填 3000 |
| 文档语言 | `zh-CN`（默认）· `en-US` · 其它 BCP-47 标签 |
| 文档输出目录 | `docs/manual`（默认），相对项目根 |
| 发布范围 | `public` 面向外部（默认）· `internal` 仅内部 |

选 `custom` 时补问视口（如 `1600x1000`）与 DPR（如 `2`）。

### 2. 调 CLI

```
node <skill>/bin/manual.js init \
  --project-root <业务项目根目录> \
  --base-url http://localhost:5173 \
  --profile desktop-standard \
  --provider playwright-headless \
  --lang zh-CN --docs-dir docs/manual --audience public --json
```

受保护页面需要登录时，使用 `manual auth login` 建立可跨 worktree 复用的命名认证档案；不要临时编写登录脚本。

自定义规格加 `--profile custom --viewport 1600x1000 --dpr 2`。已存在配置时 CLI 以退出码 1 拒绝覆盖；确认用户要重置后再加 `--force`（会先备份 `.bak`）。

---

## `$manual-inspect` / `/manual-inspect` —— 建立项目地图

回答一个问题：**这个 Web 产品有哪些用户可访问的页面？**

职责边界很重要：**路由扫描是确定性的，程序做；页面的标题与用途需要读源码理解语义，AI 做。** 所以流程是「扫描出骨架 → AI 读源码 → 写回」。

### 1. 扫描

```
node <skill>/bin/manual.js inspect --project-root <项目根> --json
```

CLI 会识别技术栈、扫出全部页面、递归追踪项目内静态依赖，写 `.manual/project.yaml`、`.manual/pages/<id>.yaml`、`.manual/index/forward.json` 与 `.manual/index/reverse.json`，并在 `worklist` 里给出**每个待分析页面该读哪些文件**。

依赖扫描支持静态 `import`、re-export、字面量 `require()`，以及 `tsconfig.json` / `jsconfig.json` 的 `baseUrl`、`paths`。第三方包、样式和静态资源会被忽略；无法解析的项目内依赖写入页面模型的 `dependencies.unresolved` 并作为 warning 报告，不中断其它页面。

当前只支持 **Next.js**（App Router + Pages Router）。Vite + Vue 等其它框架会被识别，但会给出准确的「暂不支持」提示。

### 2. 读源码，分析语义

按 `worklist[].read` 列出的文件逐个读。**不要只看文件名**——要真读代码，识别出：

- `title`：页面在产品里的实际名称（用户在导航/标题上看到的那个词，不是路由段的英文）
- `purpose`：一句话说清这个页面让用户做什么
- `detectedActions`：页面上的主要操作（按钮、表单提交、模式切换等）

如果发现页面依赖的关键组件不在 `entry` 里（如 `components/membership/**`），一并补进 `source`。

**边界**：这一阶段只回答「这个页面是什么、能做什么」。**不要**去区分 free/pro/max、loading/error、空状态——那些是 Scenario，属于 V0.5。

### 3. 写回

把分析结果写成 JSON 文件，然后：

```
node <skill>/bin/manual.js describe --project-root <项目根> --input <分析结果.json> --json
```

```json
{
  "pages": [
    {
      "id": "membership",
      "title": "会员计划",
      "purpose": "查看和购买会员套餐。",
      "detectedActions": ["查看套餐", "购买 Pro", "购买 Max"],
      "source": ["app/membership/page.tsx", "components/membership/**"]
    }
  ]
}
```

**用 `--input` 文件而不是命令行参数**——中文内容走命令行在 Windows 控制台容易乱码。单页小改可以用 `--id/--title/--purpose/--actions`。

不该进手册的页面（内部后台、调试页）用 `"includeInManual": false` 标掉；整片路由用 config 的 `inspect.exclude`（如 `/admin/**`）更省事。

### 4. 回报

告诉用户扫到多少页面、分析了多少、还剩哪些，以及有没有 stale 页面需要重新分析。

---

## `$manual-capture` / `/manual-capture` —— 真实浏览器截图

```
node <skill>/bin/manual.js capture <page-id> --project-root <项目根> --json
```

优先从正索引取出 route（索引不可用时回退页面模型）→ 拼出 `{baseUrl}{route}` → 用配置里的 Provider 打开真实页面 →
等页面稳定 → 按配置的 viewport 与 DPR 截图 → 回写页面模型的 `browser` 状态。

**先确认开发服务器在跑**。capture 不启动项目，也不会去猜端口——连不上就直接失败。

### 截图前会等什么

load 事件 → 网络空闲 → 指定元素（可选）→ Web Font 就绪 → 图片加载完 →
DOM 连续静止 → 冻结 CSS 动画与过渡 → 静置回流。

每步都有独立上限，单步超时只记 warning 不中断。页面内容来得特别晚时，
用 `--wait-for <选择器>` 指定真正该等的元素——这是最可靠的信号。

### 失败时绝不产出截图

页面打不开就没有 PNG，并给出分类原因：`server-unreachable`（项目没启动）、
`http-not-found`（404，route 可能过期）、`login-required`（需要登录）、
`timeout`、`blank-page`（前端崩了）、`http-error`、`unsafe-port`。
每类都带一条可操作的建议。**把失败原因原样转达给用户，不要自己找补。**

### 常用参数

```
--params "id=123"        动态路由（/artifact/:id）必须给参数值，否则拒绝执行
--wait-for <选择器>       等这个元素出现再截
--provider playwright-headed   临时用有头浏览器，能看见过程
--profile desktop-wide   临时换截图规格
--full-page              整页截图（默认只截一屏视口）
--timeout <毫秒>          放宽单步等待上限
```

### 输出

`<docs.imagesDir>/raw/<page-id>.png`，默认就是 `docs/manual/images/raw/chat.png`。
截图跟手册一起入库——手册要引用它们。

---

## `$manual-generate` / `/manual-generate` —— 生成手册（含中文自然化）

三段式。**中文润色是 AI 的活，事实校验是程序的活**——AI 润色时最容易「顺手把事实改通顺」，
靠提示词自觉挡不住，所以由程序逐项比对。

### 阶段一：出事实草稿

```
node <skill>/bin/manual.js generate <page-id> --project-root <项目根> --json
```

草稿写到 `.manual/drafts/<id>.md`，只由确定性事实拼成，一个字都不是推断的。正索引中的关联源码会写入 HTML 元数据，并通过 `--json` 的 `indexContext` 返回给 AI 调用方，不会被当成用户可见操作步骤。
`--json` 还会返回 `protected` 字段，列出润色阶段一个字都不能动的东西。

前置条件：页面必须已 `describe`（有标题和用途）且已 `capture`（有真实截图）。
缺哪个会明确告诉你先跑哪条命令。确实要出纯文字版才加 `--no-screenshot`。

### 阶段二：按规范改写成自然中文

**先读 `references/manual-writing-style.md`**，然后把草稿改写成国内 SaaS 帮助中心那样的中文。

只能改：句式、语序、冗余表达、翻译腔、AI 套话。
不能改：事实、UI 名称、操作顺序、页面行为、截图引用、数字。

一句话判据：**改完之后读者照着做会得到不同结果，那就是改错了。**

重点删掉：`用户可以点击……以实现……` · `通过该功能，用户能够……` · `首先/其次/最后` ·
`值得注意的是` · `从而提升` · `进一步提升` · `更好地` · `高效地` · `轻松地` · `即可实现` ·
不必要的`您可以`。

操作说明直接上动词：点击、选择、输入、打开、返回、上传、下载、查看。

```
✗ 用户可以点击「发送」按钮以提交当前请求。
✓ 输入完成后，点击「发送」。

✗ 通过该功能，用户能够快速创建新的对话。
✓ 点击「新对话」创建会话。
```

**「」只能用于页面模型里确实记录了的 UI 名称。** 不确定按钮叫什么就用描述性说法——
编一个「开启新会话」出来，用户在页面上根本找不到。

### 阶段三：事实校验并定稿

```
node <skill>/bin/manual.js generate <page-id> --finalize <润色后的文件> --json
```

程序逐项比对草稿与定稿：截图路径、「」里的 UI 原文、`` ` ``里的路由与文件名、数字、
操作步骤的数量与顺序、一级标题。全部一致才写 `docs/manual/<id>.md`。

不一致就**不输出正式文档**，并逐条列出哪里改动了事实。按提示修正后重新 `--finalize`。
`--fallback-draft` 可以用草稿原文强行定稿——保事实、丢润色，事实优先。

### 想让真实按钮名进手册

在 `describe` 阶段就把它写进 `detectedActions`，并用「」括起来：

```json
{ "detectedActions": ["输入问题后点击「发送」", "点击「新对话」创建会话"] }
```

润色阶段只能保留和重排这些词，不能新造。

---

## 页面模型的字段归属（关键约定）

```yaml
# .manual/pages/membership.yaml
id: membership
route: /membership          # ← 扫描拥有，每次 inspect 重写
dynamic: false              # ←
params: []                  # ←
entry: app/membership/page.tsx  # ←
dependencies:               # ← 扫描拥有，每次 inspect 重写
  files:
    - components/membership/PlanCard.tsx
  unresolved: []

title: 会员计划              # ← 分析拥有，inspect 绝不覆盖
purpose: 查看和购买会员套餐。  # ←
detectedActions: [...]      # ←
source: [...]               # ←
includeInManual: true       # ←

confidence: inferred        # none → inferred（源码推断）→ verified（浏览器验证过）

browser:                    # ← capture 拥有
  verified: true
  lastCapture: '2026-09-16T08:22:59.772Z'
  screenshot: docs/manual/images/raw/membership.png
  url: http://localhost:3000/membership
  viewport: 1440x900
  deviceScaleFactor: 2
  provider: playwright-headless

status:
  sourceAnalysis: completed # pending | completed | stale
```

四条由此而来的行为：

- **重跑 `inspect` 不会丢掉 AI 的分析结果，也不会丢掉截图状态。** 页面的身份是它的**路由**，按 route 匹配已有文件。
- **入口文件或路由变了**，原分析保留但标成 `stale`，提示需要重新分析。
- **路由变了**，`browser` 状态会被清空——那已经是另一个 URL 了，旧截图不作数。
- **代码里删掉的路由**默认只报告不删（那些文件里有分析成果），确认后加 `--prune` 才清理。

`confidence` 只有在**源码分析完成 且 浏览器验证过**时才升到 `verified`。
光截了图但没分析过语义，`browser.verified` 是 true 而 `confidence` 仍是 `none`——不虚报。

## 注意

- inspect 不需要项目正在运行；capture 需要。
- 动态路由记作 `/artifact/:id`。capture 必须给 `--params "id=123"`，不给就明确拒绝，不会去猜一个 id。
- 设计约定与 Provider 接口契约见 `docs/ARCHITECTURE.md`。
- 客户端调用必须使用各自原生别名：Codex 用 `$manual-<command>`，Claude Code 用 `/manual-<command>`。CLI 内部仍使用 `manual <command>`；运行 `npm run install:compat` 可生成全部别名。
