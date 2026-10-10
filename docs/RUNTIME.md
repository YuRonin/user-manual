# Runtime 使用说明

本文按真实命令与 `--json` 输出说明一份手册从安装到长期维护的全过程。所有命令都可加 `--project-root <业务项目根>`，
下文省略；每条命令的完整参数以 `manual <命令> --help` 为准。

## 1. 安装与环境检查

```bash
npm ci                              # 依赖版本以 package-lock.json 为准
npx playwright install chromium     # Linux CI 用 --with-deps；中文截图需要 CJK 字体（fonts-noto-cjk）
node bin/manual.js doctor --json    # 只读：Node / 依赖 / Chromium / 字体 / 配置 / 认证缓存
```

`doctor` 有 `fail` 项时退出码为 1。

## 2. 初始化与首次登录

```bash
manual init --base-url http://localhost:3000 --audience public   # 写 .manual/config.yaml
manual auth login --profile default                              # 受保护页面：登录一次，命名档案跨 worktree 复用
manual inspect                                                   # 扫描路由与源码依赖，写源码图快照
manual describe --input describe.json                            # AI 读源码后写回标题 / 用途 / 主要操作
```

匿名访问的 Scenario 必须显式写 `authProfile: anonymous`，不会借用已登录的档案。

## 3. 生成：一个 Run 完成已授权的依赖

```bash
manual generate page:chat --json                # 采集 → 草稿 → 等待模型文案（退出码 3）→ resume 后发布
manual generate page:chat --plan --json          # 新动作或风险范围需要先审阅时使用；只读
manual generate page:chat --copy-default --json  # 跳过模型文案出粗稿；交付前必须审阅
```

目标写法：`page:<id>` / `task:<id>` / `manual:<page|task>-<id>` / 无前缀的唯一 id；`scenario:<id>` 只用于 `capture`。

Run 的节点：`(fixture-setup) → capture | derive-image → (analyze) → draft → (rewrite) → validate → publish → (fixture-cleanup)`。
缓存命中的采集报告 `cache-hit` 与当时的 `observedAt`（历史观察，未在线确认）。
成功的 `publish` 节点会在结果的 `documents` 中列出正式文档绝对路径；规划提醒和执行期提示（缓存在执行前失效、标注覆盖失败、未生成发布图、截图时网络未空闲等，形如 `<节点>：<提示>`）都随 `warnings` 返回，`manual status` 同样展示。结构化的 `quality`（按节点：步骤执行数、完成声明验证状态、界面名称来源、质量提示、文案待确认项、门禁提示）也一并返回。正文里未实际执行的步骤带“未验证”标识。发布成功仍需审阅手册内容与截图。

### 等待输入（Run 状态 waiting_input）

Run 停在 `waiting_input` 时退出码为 3；其中人工修改冲突（`merge-conflict`）与已发布文档缺失（`document-missing`）
属于冲突类，退出码为 4。`waiting[].code` 与处理方式：

| code | 处理 |
|---|---|
| `model-input-required` | 读 `runs/<runId>/model/<requestId>.request.json`，写响应后 `manual resume <runId> --request <requestId> --input <响应.json>`（提交并继续；旧的 `run-submit` + `resume` 两步仍可用） |
| `approval-required` / `scope-changed` | 用户确认任务后 `manual approve-tasks --input <决定.json>`，再 `resume` |
| `auth-missing` / `auth-expired` / `login-required` | `manual auth login` 后 `resume` |
| `review-required` | 用户确认新出现的数字 / 承诺属实后带 `--accept-review` 重新运行 |
| `merge-conflict` | 见第 5 节 |
| `document-missing` | 已发布文档被删除：重新生成用 `--force`，下线则把页面 / 任务标为 retired |
| `fixture-cleanup-required` | 测试数据清理失败：确认测试环境可用后 `resume`（按命名空间幂等） |

### 恢复与查看

```bash
manual status [runId] --json     # 只读：任务状态、等待 / 失败 code、缓存复用来源、恢复理由
manual resume <runId>            # 从任务快照继续；已成功的任务不重做
manual resume <runId> --replan   # 输入已变化（run-input-changed）时按原目标与策略创建新 Run
```

中断的任务按产物对账：已提交的补记成功；可安全重放的重新执行；写操作结果不明的转为 `outcome-unknown`，需要人工核查，不会盲目重放。

## 4. 代码变化后：update

```bash
manual update --plan --json      # 只读：受影响目标、reasonPaths、缓存决策、文档人工修改、下线建议
manual update --json             # 执行：刷新源码指纹 → 一个 Run 更新受影响目标
manual update --base main~3 --plan
```

- 每份已发布手册记录发布时的源码基线（`release.sourceBaseline`：提交 + 源码图快照）。Git 项目比较已提交、staged、unstaged 与 untracked；非 Git 项目逐文件比较内容。
- 影响沿"文件 → 页面 → Scenario → 手册章节"传播，删除 / rename 通过旧新依赖图的并集找到；全局配置与无法归属的源码保守扩大（`confidence: conservative`）。
- 没有基线（旧发布记录）→ 这些手册全量重建；没有任何发布记录 → `no-baseline`，先用 `generate`。
- 每个目标独立成败：失败目标保留上一版文档并报告 `stale`；无变化时退出 0 且不写任何文件；`update` 自己写出的文档不会触发下一轮。
- 远端 build、数据、权限的变化不在源码影响里，用 `verify --live`。

## 5. 人工修改与合并

生成内容以 `<!-- manual:block id=… -->` … `<!-- /manual:block -->` 分块：

- 块外的内容属于人工，永远保留；块头写 `owner=human` 的块由人接管；
- 发布记录保存纯生成正文（`.manual/releases/blobs/`），下次生成做"旧生成 / 当前文档 / 新生成"三方合并；
- 同一块两边都改、人删掉生成块、块外同一位置两边都改 → `merge-conflict`（退出码 4），提案在 `runs/<runId>/merge/<manualId>/proposed.md`，逐块对照在 `conflicts.txt`。采用提案或把块改为 `owner=human` 后 `resume`；`--force` 用新生成覆盖（覆盖前的版本可从 Git 历史找回）。

## 6. 验证

```bash
manual verify task:edit-profile            # --artifacts（默认）：离线产物，onlineChecked=false
manual verify task:edit-profile --live     # 真实导航回放
manual verify --all --live                 # 全部已发布手册，复用一个 Browser、每个 Scenario 独立 Context
```

`--live` 的报告（`.manual/verifications/<id>.json`，不可变，本机产物不入库，按 `runLogDays` 回收）：逐条检查（`scope` / `outcome` / `category`）、完成声明（发布时状态、本次状态）、章节结果、覆盖（已执行步骤、停止边界）、漂移（页面手册）。
结果与退出码：`passed` 0；`failed` / `drift` 4；需要登录 3；`inconclusive`（网络 / 超时）1。视觉差异只报告，不否定已验证行为；基线不会被自动接受。
动态区域在 `config.yaml` 的 `verify.visual.dynamicRegions: [{ id, selector }]` 声明，只用于比较，与断言目标重叠的区域不能被忽略。

## 7. Scenario 变体与 Fixture

```yaml
# .manual/scenarios/dashboard-empty.yaml
schemaVersion: 1
id: dashboard-empty
userTaskId: null
environment: local
authProfile: anonymous
entry: { pageId: dashboard, routeBindingId: main, params: {} }
data: { mode: fixture, fixture: dashboard-empty }
expected: { httpStatuses: [200], redirects: [], state: empty }
setup: []
checkpoints:
  - { id: default, afterStepId: null, pageId: dashboard, assertions: [{ id: empty, type: visible, target: { text: 暂无数据 } }], capture: { mode: viewport, annotations: [] } }
```

```yaml
# .manual/config.yaml
fixtures:
  environments:
    local: { origins: ['http://127.0.0.1:*', 'http://localhost:*'] }
```

Fixture 定义在 `.manual/fixtures/<id>.yaml`（格式见 `src/scenarios/fixtures.js` 头注释）。`manual capture scenario:<id>` 采集变体；
mock 结果标 `simulated`，hook 的 setup / cleanup 是独立任务（采集失败也清理）；生产与未登记环境在规划时拒绝；secret 只写 `env:NAME` 引用。

**打开具体内容**：有些页面的路由是静态的，数据却从路径后缀（`/s/<shareId>`，由 rewrite 落到 `/s`）或查询参数（`/activities/detail?id=`）读取，
只靠路由打不开有效内容。在页面的 `page-<id>.yaml` 里用 `entry.path` / `entry.query` 指定一条测试数据：

```yaml
# .manual/scenarios/page-share.yaml —— 采集、generate 与 verify --live 都打开 /s/abc123?from=qr
entry: { pageId: share, routeBindingId: main, path: /s/abc123, query: { from: qr } }
```

- `entry.path` 必须落在页面路由的静态前缀内（等于 `/s` 或以 `/s/` 开头），不能借它打开别的页面；不能与非空 `entry.params` 同时使用。
- 查询串只进入本次打开的地址，Capture 记录只保存 origin + pathname；手册正文的入口链接仍是页面路由，不出现测试数据。
- 改 `entry` 会改变 Scenario revision，旧截图不会被缓存复用。

## 8. 保留与回收

```bash
manual gc --json                               # dry-run：对象、原因、大小、planHash
manual gc --apply --expect <planHash>          # 项目锁内重新核对后删除
```

默认天数（`config.retention` 可调）：staging / 诊断 7 天；已结束 Run、原图、未引用 Capture 30 天。当前发布记录与被引用的证据永不回收；原图回收后不能再重新标注，隐私或主题变化需要重新采集。

工作区只保留当前版本：发布完成后，被取代的旧发布记录及只被它引用的生成正文随即删除；模型提交后只留 current 指向的快照（快照与 `pages/` + `tasks/` 等价，属本机产物不入库，新克隆中缺失时按工作副本自动重建）。历史版本由 Git 保存。升级前积累的存量用 `manual gc` 一次清理。

## 9. 故障排查

| 现象 | 先看 |
|---|---|
| 一直 `cache-hit` 但页面已变 | 缓存只证明输入没变；用 `verify --live` 检查线上，或 `generate --refresh` 重新采集。`generate` 执行前会重扫源码指纹，源码改动会显示为 `capture-required:input-changed(sourceHash)` |
| `review-required`（`ui-term-not-observed` / `unsupported-result`） | 文案写了页面上没观察到的控件，或事实里没有依据的结果（“会生成 PDF”“发送到邮箱”）；改成事实里有的内容，确认属实才加 `--accept-review` |
| `claim-failed` | 完成声明引用的断言在采集时实际失败：先查界面是否真的达成目标，修正任务定义或页面状态后重新采集，不能配置放行 |
| `quality-blocked` | 质量提示命中了 `quality.blockOn`；按 `quality.warnings` 里的代码补齐任务定义或截图 |
| `capture-required:annotation-incomplete` | 上次采集标注覆盖失败、没有发布图，或是没有覆盖记录的旧证据：不会复用，按提示修正 guide / 功能目标后重新采集 |
| `source-freshness-unknown`（warnings） | 生成前重扫源码失败，按上次 inspect 的指纹规划；先 `manual inspect` 确认扫描正常 |
| `geometry-unstable` | 截图前页面一直在变（回复仍在输出、轮询刷新）；确认步骤断言等到了真正的完成状态，必要时放宽 `capture.waits.stabilityMs` |
| `readiness-timeout` / `page-reloaded`（warnings） | 入口长时间加载中：已自动刷新一次；仍失败时检查接口，或放宽 `capture.waits.readinessMs` |
| `target-obscured` | 操作目标被提示条等浮层盖住，移开指针并等待后仍未消失；不会重试（避免重复保存）。在下一步 `requires` 里用 `hidden` 断言等提示条消失 |
| `run-input-changed` | 规划之后模型 / 文案 / Fixture 变了：`resume <runId> --replan` |
| `publication-in-progress` | `manual publication status`，再 `publication repair` |
| `fixture-policy-denied` | Scenario 的 environment 是否在 `config.fixtures.environments` 登记、baseUrl 是否匹配 origins |
| `environment-incompatible`（verify） | 浏览器版本、平台、视口或 DPR 与发布时不同；在同规格环境重新验证或重新采集 |
| `no-baseline`（update） | 还没有发布过：先 `generate` |
| 截图中文是方块 | `doctor` 的 `fonts:cjk`；Linux 安装 fonts-noto-cjk |
