# 命令细节与兼容流程

需要初始化与扫描的细节、登录与截图参数、高级命令时阅读本文件。日常生成按 `SKILL.md` 的主流程。

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

**边界**：这一阶段只回答「这个页面是什么、能做什么」。**不要**去区分 free/pro/max、loading/error、空状态——那些用 Scenario 声明，见 `docs/RUNTIME.md` 第 7 节。

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

## 登录与单独采集（`auth` / `capture`）

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

**界面状态不进认证档案**：站点把侧栏收起、主题之类的 UI 状态存在 localStorage 时，某次采集改动的状态会随认证档案写回，污染后面的任务。在 `auth.ephemeralStorageKeys` 里列出这些键（`前缀*` 表示前缀匹配），写回和注入时都会剔除，页面按默认状态打开：

```yaml
auth:
  ephemeralStorageKeys: [neo_sidebar_collapsed, neo_ui_*]
```

依赖某个 UI 状态的任务步骤，用 `requires` 断言它（例如侧栏的「全部」入口可见），不要依赖上一次采集留下的状态。

**慢环境的等待预算**（`capture.waits`，每项都有上限，超时会明确报告当前状态）：

```yaml
capture:
  waits:
    readinessMs: 30000      # 打开页面后等待就绪，1000–300000
    stabilityMs: 5000       # 截图前等 DOM 静止、数据请求结束（每次尝试），500–120000
    authCheckMs: 15000      # 登录检查打开验证页，1000–300000
    reloadOnStuckLoading: true  # 入口页超时后仍"加载中"时刷新一次（只用于入口，从不重放动作）
```

生成类步骤（如等待 AI 回复）在步骤上设 `assertionTimeoutMs`，上限 600000（10 分钟）；超出上限会被拒绝。截图前 DOM 仍在变化（回复还在逐字输出）不会截图；有数据请求未结束但 DOM 已静止时照常截图，并在 `warnings` 里提示 `screenshot-network-busy`。
不要在同一认证档案上同时运行多个 manual 进程；建议用专门的测试账号采集，避免连带踢掉真人登录。
如果仍被要求重新登录，说明缓存里的 token 已被站点吊销，请用户重新 `auth login`，不要反复重试。

该命令打开一次可见浏览器，让用户手动完成登录；之后 `capture` 与 `capture-task` 自动复用 cookies 和
localStorage。使用 `manual auth status` 查看本地档案元数据；需要判断是否仍能登录时运行 `manual auth check --path <受保护路径>`。使用 `manual auth clear` 清除档案。认证值位于
系统用户级缓存，可跨 worktree 使用；不得打印、复制进项目文件或写入证据清单。

```
node <skill>/bin/manual.js capture <page:<id>|task:<id>|scenario:<id>> --project-root <项目根> --json
```

`generate` 会按需自动采集；只想取证据、不生成文档时才单独运行 `capture`。页面采集流程：优先从正索引取出 route（索引不可用时回退页面模型）→ 拼出 `{baseUrl}{route}` → 用配置里的 Provider 打开真实页面 →
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

截图使用 Demo Capture（唯一模式）：`data-redact` 区域替换为演示值、非只读请求在浏览器内中止。
采集失败且原因为 `demo-needs-fixture` / `demo-blocked` / `demo-write-blocked` 时，本次截图与原图都已丢弃；
按输出中的原因码补 `capture.demo` 或 Fixture 后重新采集，见 [Demo Capture](../docs/DEMO_CAPTURE.md)。

---

## 文案与事实校验

`generate` 默认在事实草稿之后停下，请宿主模型填写文案块（导语、步骤补充说明），见 SKILL.md 第 3 步与[写作规范](manual-writing-style.md)。正文其余部分由事实包确定性渲染，提交的文案经程序校验：改写受保护的 UI 名称或动作会被拒绝，写作规范第四节标 ⚙ 的风格问题（套话、“您”、连串「」）也会被拒绝（`style-*`），新出现的数字或承诺需要人工确认（`review-required`）。`describe` 写入的 `purpose` 与 `guide` 做同样的风格检查；任务模型的读者字段命中时在 `review-task` 里给警告。

旧的页面三段式（`generate <page-id> --draft` → 整篇润色 → `--finalize <文件>`，可加 `--fallback-draft`）仍可用，只在需要整篇改写 Markdown 时使用；校验规则同上，详见 `docs/MIGRATION.md`。

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

## 高级命令

只在对应场景使用，主流程不需要：

- `manual plan-capture <task-id> --live`：新建任务、改过定位或数据前提不确定时，在真实浏览器只读预演到写操作前，不产出截图、不改证据。
- `manual capture-task <task-id> --reconcile-url <已有会话URL> --prior-captures <ID,...>`：已授权的写操作结果不明（`outcome-unknown`）时，核对已有会话并补采最终截图，不重复提交。
- `manual capture-task <task-id> --continue-url <已有会话URL>`：提交已验证、只缺最后的结果查看步骤时，在已有会话续采，不重放提交。两者的前提与限制见 [质量工作流](quality-workflow.md)。
- `manual gc`：列出未引用的临时文件、原图与旧 Run；确认后 `--apply --expect <planHash>`。`--inventory` 逐项给出大小与保留原因。

## 目录分组（`docs.catalog`）

每次发布都会重写 `docs.outputDir/index.md` 的 `manual:catalog` 区块。默认分「操作指南」（任务篇）和「功能介绍」（页面篇）两组；产品手册想按读者场景组织时，在 `config.yaml` 的 `docs:` 下配置 `catalog`（整段可选）：

```yaml
docs:
  catalog:
    fallbackTitle: 更多            # 未被任何分组引用的已发布手册落到这里；全部引用时不出现
    groups:
      - title: 快速开始
        entries: [page-login, page-password-reset]
      - title: AI 对话与教学
        entries: [page-chat, task-generate-practice]
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `groups[].title` | 必填 | 单行非空，不能与 `fallbackTitle` 同名 |
| `groups[].entries` | 必填 | 手册 id，即 `.manual/releases/` 下的目录名（`page-<id>` / `task-<id>`），不是发布记录 UUID；组内顺序即目录顺序；同一 id 只能出现在一个分组 |
| `fallbackTitle` | `更多` | 兜底分组标题 |

- 输出格式不变（`## 分组` + `- [标题](路径)：摘要`），`manual site` 与其它消费者无需改动；空分组一律省略。
- 引用了尚未发布的手册：生成时跳过并输出 `catalog-unknown-entries` 告警；`manual doctor` 的 `catalog` 项给 warn。
- 配置形状错误（坏 id、跨组重复等）在加载配置时直接报错。

## 文档元数据（`meta.json`）

与目录同时，每次发布整文件重写 `docs.outputDir/meta.json`，给应用内帮助中心等下游只读使用（`manual site` 目前不读它）。不要手改。

```json
{
  "version": 1,
  "docs": {
    "tasks/generate-practice.md": {
      "updatedAt": "2026-10-08T07:18:42.512Z",
      "related": [{ "target": "chat.md", "title": "AI 对话", "reason": "entry-page" }]
    }
  }
}
```

- 键与 `target` 是相对 `docs.outputDir` 的 posix 路径，与目录链接一致；只含已发布手册（发布记录在且文档文件存在），没有相关文章的篇目为 `"related": []`。
- `updatedAt`：当前发布记录的 `createdAt`；`title`：手册标题（与目录一致）。
- `related` 每篇最多 5 条，去掉自身、同一目标只留最强理由；同强度按目录顺序、再按路径。理由从强到弱：
  - `explicit`：任务定义的 `relatedTasks`（单向）；
  - `guide-link`：页面指南里引用的任务（页面 ↔ 任务）；
  - `entry-page`：任务入口路由等于页面路由（双向，忽略查询串与尾斜杠）；
  - `shared-page`：任务步骤经过的页面（双向）；
  - `same-group`：目录同一分组（配置了 `docs.catalog` 按配置，否则按默认两组）。
- 指向未发布手册的关系静默丢弃。同样的发布状态得到逐字节相同的文件；写入失败只告警 `doc-meta-update-failed`，不影响发布。

## 帮助中心网站（`manual site`）

`manual site` 只读手册、只写 `site.outputDir`，可随时重跑；截图按修改时间增量转码。`config.yaml` 的 `site:` 段（整段可选）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `outputDir` | `.manual/site` | 项目内相对路径，不能与 `docs.outputDir` 重叠（构建会清理旧产物） |
| `title` / `description` | `帮助中心` / 空 | 首页标题与副标题 |
| `homeUrl` | 无 | 顶栏「返回应用」链接；http(s) 或站内绝对路径 |
| `appBaseUrl` | 无 | 手册里 `/credits` 这类产品链接的前缀；嵌在应用同域时不填 |
| `noindex` | `privacy.audience` 不是 `public` 时为 true | 页面加 `robots noindex` |
| `webpQuality` | 82 | 1-100 |
| `theme` | 中性蓝灰 | `primary` / `text` / `muted` / `background` / `surface` / `border` / `soft`，只接受十六进制颜色 |
| `labels` | — | `completion`（提示框标题）、`backToIndex`、`backToApp` |
| `support` | 无求助区 | `{ title, description, items: [{ title, description, image }] }`，`image` 为项目内路径，复制到 `assets/` |

链接规则：文档互链 → 相对 `.html`；`images/…/*.png|jpg` → `.webp`（gif/webp 原样）；站内绝对路径原样（或拼 `appBaseUrl`）；`http(s)` 外链新标签页打开；其它协议与 `//host` 丢弃链接只留文字。只发布被正文引用到的截图。输出目录里的 `.manual-site.json` 记录生成过的文件，清理只针对清单内文件。

## 发布恢复与迁移

- 发布按 journal 推进（prepared → assets → document → release → completed）。进程中断后运行 `manual publication status --json` 查看，`manual publication repair` 对账恢复；文档被人工修改时报 `publication-conflict` 并保留修改，不自动覆盖。
- 旧项目先 `manual migrate --dry-run --json` 查看清单，再 `--apply`；迁移不会把旧的 verified 伪装成已验证。

## 注意

- inspect 不需要项目正在运行；capture 需要。
- 动态路由记作 `/artifact/:id`。capture 必须给 `--params "id=123"`，不给就明确拒绝，不会去猜一个 id。
- 设计约定与 Provider 接口契约见 `docs/ARCHITECTURE.md`。
- 客户端别名只覆盖主流程命令（init / inspect / describe / auth / generate / update / verify / site / doctor）：Codex 用 `$manual-<command>`，Claude Code 用 `/manual-<command>`；其它命令通过主 skill `manual` 调用 CLI。
