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
manual generate page:chat --plan --json     # 只读计划：节点、原因、缓存命中与否、风险边界
manual generate page:chat --json            # 执行
```

目标写法：`page:<id>` / `task:<id>` / `manual:<page|task>-<id>` / 无前缀的唯一 id；`scenario:<id>` 只用于 `capture`。

Run 的节点：`(fixture-setup) → capture | derive-image → (analyze) → draft → (rewrite) → validate → publish → (fixture-cleanup)`。
缓存命中的采集报告 `cache-hit` 与当时的 `observedAt`（历史观察，未在线确认）。

### 等待输入（退出码 3）

`waiting[].code` 与处理方式：

| code | 处理 |
|---|---|
| `model-input-required` | 读 `runs/<runId>/model/<requestId>.request.json`，写响应后 `manual run-submit <runId> --request <requestId> --input <响应.json>`，再 `manual resume <runId>` |
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
- 同一块两边都改、人删掉生成块、块外同一位置两边都改 → `merge-conflict`（退出码 4），提案在 `runs/<runId>/merge/<manualId>/proposed.md`，逐块对照在 `conflicts.txt`。采用提案或把块改为 `owner=human` 后 `resume`；`--force` 用新生成覆盖（旧版本仍在发布记录中）。

## 6. 验证

```bash
manual verify task:edit-profile            # --artifacts（默认）：离线产物，onlineChecked=false
manual verify task:edit-profile --live     # 真实导航回放
manual verify --all --live                 # 全部已发布手册，复用一个 Browser、每个 Scenario 独立 Context
```

`--live` 的报告（`.manual/verifications/<id>.json`，不可变）：逐条检查（`scope` / `outcome` / `category`）、完成声明（发布时状态、本次状态）、章节结果、覆盖（已执行步骤、停止边界）、漂移（页面手册）。
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

## 8. 保留与回收

```bash
manual gc --json                               # dry-run：对象、原因、大小、planHash
manual gc --apply --expect <planHash>          # 项目锁内重新核对后删除
```

默认天数（`config.retention` 可调）：staging / 诊断 7 天；已结束 Run、原图、未引用 Capture 30 天。发布记录与被引用的证据永不回收；原图回收后不能再重新标注，隐私或主题变化需要重新采集。

## 9. 故障排查

| 现象 | 先看 |
|---|---|
| 一直 `cache-hit` 但页面已变 | 缓存只证明输入没变；用 `verify --live` 检查线上，或 `generate --refresh` 重新采集 |
| `run-input-changed` | 规划之后模型 / 文案 / Fixture 变了：`resume <runId> --replan` |
| `publication-in-progress` | `manual publication status`，再 `publication repair` |
| `fixture-policy-denied` | Scenario 的 environment 是否在 `config.fixtures.environments` 登记、baseUrl 是否匹配 origins |
| `environment-incompatible`（verify） | 浏览器版本、平台、视口或 DPR 与发布时不同；在同规格环境重新验证或重新采集 |
| `no-baseline`（update） | 还没有发布过：先 `generate` |
| 截图中文是方块 | `doctor` 的 `fonts:cjk`；Linux 安装 fonts-noto-cjk |
