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
| `manual capture` | ✅ V0.3 | 用真实浏览器采集页面或任务证据（`page:<id>` / `task:<id>` / `scenario:<id>`），只推进到证据提交 |
| `manual auth` | ✅ | 登录并管理可跨 worktree 复用的认证档案 |
| `manual generate` | ✅ Runtime | 规划并执行：按需采集（复用有效缓存）→ 草稿 → 文案 → 发布门槛 → 发布；`--plan` 只预览 |
| `manual status` / `resume` / `run-submit` | ✅ Runtime | 查看 Run、从任务快照继续、提交模型文案响应 |
| `manual publication` | ✅ | 查看与恢复中断的发布事务（`status` / `repair`） |
| `manual migrate` | ✅ | 显式迁移旧项目到 v2 模型（`--dry-run` / `--apply` / `--rollback`） |
| `manual discover-tasks` | ✅ Task-first 基础 | 基于页面证据准备候选发现工作清单并写入候选任务 |
| `manual approve-tasks` | ✅ Task-first 基础 | 由人工批准、调整或拒绝候选任务 |
| `manual plan-capture` / `capture-task` | ✅ 兼容 | 任务截图计划 / 安全交互采集（与 `capture task:<id>` 同一用例） |
| `manual update` | ✅ Phase 3 | 按源码变化只更新受影响的已发布手册；`--plan` 只读预览影响与原因 |
| `manual verify` | ✅ Phase 3 | `--artifacts`（默认，离线）/ `--live`（真实导航回放 + 漂移报告），`--all` 验证全部已发布手册 |
| `manual gc` | ✅ Phase 3 | 按保留策略回收未引用的临时文件、原图与旧 Run（默认只列出） |
| `manual generate-task` | ✅ 兼容 | 分步生成任务指南（`--copy` / `--finalize`） |
| `manual migrate-artifacts` | ✅ 兼容迁移 | 检查旧页面原图，显式复制到非发布产物目录且不删除源文件 |
| `manual doctor` | ✅ | 只读检查 Node、依赖、Chromium、中文字体、配置与认证缓存 |

兼容入口（`plan-capture`、`capture-task`、`generate-task`、`generate --draft/--finalize`）保留至少一个迁移窗口，
新流程用 `generate` / `update` / `capture scenario:<id>`；迁移说明见 docs/MIGRATION.md，运行时说明见 docs/RUNTIME.md。

**任何命令都不改动业务项目代码**，只写 `.manual/` 与配置里指定的文档目录。

---

## 质量与证据工作流

先阅读 [references/quality-workflow.md](references/quality-workflow.md)。现有会话授权持续有效；用户已要求修复并实践的范围无需重复确认。新任务应先明确目的、数据前提、操作与验证终点，再生成文案。

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

候选任务需要记录审批依据；可按用户本次或先前明确授权的范围执行 approve-tasks。范围不清楚时展示具体任务再询问。只有 approved 任务才能进入采集和发布。

任务批准后，用 `manual generate task:<id> --plan --json` 把计划里的动作、风险边界（`write` 停在动作前、`destructive` 不执行）和需要浏览器的场景展示给用户；在现有用户授权范围内执行 `manual generate task:<id> --json`。正式任务文档只能引用 `images/annotated/`，任何 raw、sanitized、缺失图片或结构化事实变化都会阻止发布；发布后可用 `manual verify <task-id>` 复核。

执行候选发现或审批时，先读 [references/task-workflow.md](references/task-workflow.md)。

---

## Runtime：一条命令完成已授权的依赖

Skill 只负责 **解析意图 → 调用命令 → 处理 waiting_input → 报告结果**。状态、缓存、重试、恢复都由 Runtime 决定并持久化在 `.manual/runs/`，不要在对话里自己重演（例如不要为了“保险”手动重新截图，也不要自行重试失败的步骤）。

```
node <skill>/bin/manual.js generate <task:<id>|page:<id>> --project-root <项目根> --json
```

按退出码处理（契约 C08，JSON 里的 `code` 作细分）：

| 退出码 | 含义 | 怎么做 |
|---|---|---|
| 0 | 完成 | 报告文档路径；`cache` 里的复用项说明“使用了 observedAt 时刻的历史观察，未在线确认” |
| 3 | 等待输入 | 看 `waiting[].code`：`model-input-required` → 读请求文件（只读其中列出的文件），按 `references/manual-writing-style.md` 第七节写响应 → `manual run-submit <runId> --request <id> --input <响应.json>` → `manual resume <runId>`；`approval-required` / `scope-changed` → 把任务展示给用户，得到明确确认后 `approve-tasks` 再 `resume`；`auth-*` → 请用户登录后 `resume`；`review-required` → 展示需确认的数字 / 承诺，用户确认后带 `--accept-review` 重新运行 |
| 4 | 漂移或冲突 | `run-input-changed` → `manual resume <runId> --replan`；`merge-conflict` → 把 `proposed.md` 与逐块对照展示给用户：采用提案（合入正式文档）或把要保留的块头改为 `owner=human`，然后 `resume`；只有用户明确要求才 `--force`；`document-missing` → 问用户是重新生成（`--force`）还是下线（标 retired）；`verify` 的 failed / drift → 报告分类与差异，不要自动重新生成或接受新基线 |
| 1 | 失败 | `manual status <runId> --json` 报告失败任务的 code 与提示；Runtime 已按策略重试过，不要自行循环重跑。例外：`network-access-denied` 是客户端沙箱禁止联网，不是网站问题，应在沙箱外重新执行同一条命令（Codex 申请提权执行，用户批准即可），不要让用户“等环境恢复” |
| 2 | 参数错误 / 目标歧义 | 把 `candidates` 给用户选，用 `task:` / `page:` 前缀重新运行 |

常用选项：`--plan`（只预览，不执行）、`--copy <文案.json>`（已有文案块）、`--copy-default`（不改写文案）、`--offline`（只用历史证据）、`--refresh`（强制重新采集，仅在用户要求时使用）。

写操作返回 `outcome-unknown` 时，不重试提交。若已有会话确实出现结果，按 [质量与证据工作流](references/quality-workflow.md) 修正断言，并用 `capture-task --reconcile-url` 核对既有会话，再离线生成指南。

`fixture-cleanup-required`（退出码 3）表示测试数据清理失败：告诉用户数据仍在测试环境的哪个命名空间，确认环境可用后 `resume`。

### 代码变了：`update`

```
node <skill>/bin/manual.js update --plan --project-root <项目根> --json   # 先给用户看影响范围与原因链
node <skill>/bin/manual.js update --project-root <项目根> --json          # 确认后执行
```

- `sections[].reasonPaths` 是"哪个文件 → 哪个页面 → 哪个 Scenario → 哪份手册"的原因链，按它向用户解释；`confidence=conservative` 表示范围被保守扩大（全局配置、未知依赖），说明原因即可，不要自行缩小范围。
- `fullRebuild` 表示没有可比较的基线（旧发布记录或非 Git 且无快照）：这些手册会整体重建。
- `retirement` 是页面被删除后的下线建议：只转告用户，不要删除文档或图片。
- 源码变化会让受影响页面的语义分析需要复核（`model-input-required` 的 analyze 请求）：按请求读源码、提交分析后 `resume`。
- 远端 build / 数据 / 权限变化不在源码影响里：需要 `verify --live`。

### 手册还对吗：`verify`

`manual verify <目标>` 默认只做离线产物验证（`onlineChecked=false`）。用户想知道线上是否变了时用 `--live`：
结果 `failed`（行为与手册不一致）/ `drift`（页面内容与发布时不同）/ `inconclusive`（网络或环境问题，不能下结论）。
逐条转述 `failures[].category` 与 `claims[]`；写操作步骤不会执行，对应声明是 `not_run`，要如实说明验证覆盖范围。

---

## `$manual-init` / `/manual-init` —— 初始化配置

### 1. 先问用户六项配置

优先用客户端的结构化选项工具，让用户点选而不是打字：Claude Code 用 `AskUserQuestion`，Codex 用 `request_user_input`。
这类工具单次最多 4 个问题，所以这样拆：

1. 先自己探测项目访问 URL：读 `package.json` 的 dev 脚本与框架默认端口，再请求一下常见端口看是否已在运行。
   探测到就作为推荐项，否则放一个"开发服务器未运行"选项；用户可以在自定义输入里填完整 URL。
2. 一次结构化提问问 4 项：截图规格、Browser Provider、项目访问 URL、发布范围。
   文档语言与输出目录直接用默认值，并在问题说明里写明"需要改可在自定义输入里说明"。

每个问题都把默认项放在第一位，标"（推荐）"。

当前客户端没有结构化选项工具时（例如 Codex 默认模式），不要把选项逐条展开成长列表，而是给一张紧凑的编号表，并允许一句话全部确认：

```text
初始化配置（直接回复"默认"即全部采用推荐值；只改个别项就写 "1=b 3=http://localhost:5173"）：
1 截图规格    a) desktop-standard 1440×900@2x（推荐） b) desktop-wide c) laptop d) custom
2 浏览器      a) 无头（推荐） b) 有头，可看见操作过程
3 访问 URL    探测到 http://localhost:3000 正在运行（推荐）/ 未探测到，请填写
4 文档语言    a) zh-CN（推荐） b) en-US c) 其它
5 输出目录    docs/manual（推荐）
6 发布范围    a) public（推荐） b) internal
```

各项的取值：

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

受保护页面先运行：

```text
manual auth login --profile default
```

**登录前先排查 baseUrl 重定向**：`init`、`auth login`、`doctor` 都会探测 `project.baseUrl` 是否被 301 到另一个协议或主机（最常见是 http → https）。
只要输出里有 `⚠ baseUrl … 会被服务器重定向到 …`，先把它转告用户，确认后改 `.manual/config.yaml` 的 `project.baseUrl`，再登录。
不改也能登录，但认证缓存、截图地址和配置对不上，后续命令容易出问题。

登录过程中 CLI 会往 stderr 输出进度：已打开登录页、当前页面 URL、检测到已离开登录页、正在保存。
要把这些进度原样告诉用户，不要自己猜 CLI 停在哪一步。几种结果的含义：
- `auth-window-closed`：窗口在保存前被关掉了。请用户重新登录，看到"登录状态已保存"之后再关窗口。
- `auth-timeout`：报错里会带最后停留的 URL，据此判断是没登录完，还是跳去了别的主机。

**会轮换 refresh token 的站点**（每次刷新都换发新 token，复用旧 token 会被吊销全部登录）：采集时工具会串行使用同一认证档案，站点下发新 Cookie 就立即写回缓存，采集失败也会保存轮换后的令牌。
不要在同一认证档案上同时运行多个 manual 进程；建议用专门的测试账号采集，避免连带踢掉真人登录。
如果仍被要求重新登录，说明缓存里的 token 已被站点吊销，请用户重新 `auth login`，不要反复重试。

该命令打开一次可见浏览器，让用户手动完成登录；之后 `capture` 与 `capture-task` 自动复用 cookies 和
localStorage。使用 `manual auth status` 查看档案状态，使用 `manual auth clear` 清除档案。认证值位于
系统用户级缓存，可跨 worktree 使用；不得打印、复制进项目文件或写入证据清单。

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
`http-not-found`（404，route 可能过期）、`auth-missing`（未登录）、`auth-expired`（登录过期）、
`auth-corrupt`（认证缓存损坏）、
`timeout`、`blank-page`（前端崩了）、`http-error`、`unsafe-port`、
`network-access-denied`（客户端沙箱禁止联网，需在沙箱外执行）。
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

原图仅保存在 `.manual/artifacts/raw/`。手册只引用 `docs/manual/images/annotated/` 中经隐私处理并带完整性记录的发布图。

---

## `$manual-generate` / `/manual-generate` —— 生成手册（含中文自然化）

默认走 Runtime（见上文）：文案通过交接请求填写，正文由事实包确定性渲染。下面的三段式是兼容流程，
需要整篇润色 Markdown 时使用。**中文润色是 AI 的活，事实校验是程序的活**——AI 润色时最容易「顺手把事实改通顺」，
靠提示词自觉挡不住，所以由程序逐项比对。

### 阶段一：出事实草稿

```
node <skill>/bin/manual.js generate <page-id> --draft --project-root <项目根> --json
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
  screenshot: .manual/artifacts/raw/pages/membership.png
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

## 发布恢复与迁移

- 发布按 journal 推进（prepared → assets → document → release → completed）。进程中断后运行 `manual publication status --json` 查看，`manual publication repair` 对账恢复；文档被人工修改时报 `publication-conflict` 并保留修改，不自动覆盖。
- 旧项目先 `manual migrate --dry-run --json` 查看清单，再 `--apply`；迁移不会把旧的 verified 伪装成已验证。

## 注意

- inspect 不需要项目正在运行；capture 需要。
- 动态路由记作 `/artifact/:id`。capture 必须给 `--params "id=123"`，不给就明确拒绝，不会去猜一个 id。
- 设计约定与 Provider 接口契约见 `docs/ARCHITECTURE.md`。
- 客户端调用必须使用各自原生别名：Codex 用 `$manual-<command>`，Claude Code 用 `/manual-<command>`。CLI 内部仍使用 `manual <command>`；运行 `npm run install:compat` 可生成全部别名。
