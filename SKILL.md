---
name: manual
description: Use when a Web project needs a living user manual, task-oriented操作指南, page discovery, real-browser screenshots, or maintained Markdown help content; also when the user invokes /manual commands or asks to 初始化、扫描、截图、生成或更新使用手册。
---

# manual —— Living User Manual

给任意 Web 项目建一份「活的」用户手册。页面模型提供位置与证据，用户任务模型组织最终指南；真实浏览器负责验证状态与截图，程序负责确定性校验和落盘。

Skill 自身代码与项目数据分离：**Skill 只提供能力，项目状态一律落在业务项目的 `.manual/`。**

## 最短可用流程

已有 `.manual/config.yaml` 与目标模型时直接从下面开始，不重复 `init`、`inspect`、`describe`。

1. 对已有且已批准的模型，直接运行 `manual generate task:<id> --copy-default --json`。多个目标可列在同一命令中，共用一个 Run。结果的 `documents` 给出正式文档路径；检查 `warnings`、`riskBoundaries` 和 `cache`，再按[质量与证据工作流](references/quality-workflow.md)审阅成品。只有需要事先审阅新动作或风险范围时，才先运行 `--plan`。
2. Runtime 仅在需要浏览器且已配置身份断言时预检登录。失效后运行一次 `manual auth login`，再用结果中的 Run ID 执行 `manual resume <runId>`；已有用户提供的测试凭据可按授权使用。单独排查时运行 `manual auth check --path <受保护页面路径> --json`；`auth status` 只说明缓存存在。
3. 已有有效证据且只需修改文案时加 `--offline`；明确需要新截图时才加 `--refresh`。`--copy-default` 省去模型文案等待，但其文案必须经过读者视角审阅。
4. `outcome-unknown` 先检查已有会话，不能重新发送；按照[质量与证据工作流](references/quality-workflow.md)核对。

页面目标把 `task:<id>` 换成 `page:<id>`。页面或任务不存在时，再按[命令细节与兼容流程](references/command-workflows.md)中的 `init`、`inspect`、`describe`、`discover-tasks` 补齐。

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

任务批准后，在现有授权范围内直接运行 `manual generate task:<id> --copy-default --json`；如需事先审阅新动作或风险范围，用 `--plan` 查看动作、风险边界（`write` 停在动作前、`destructive` 不执行）和需要浏览器的场景。正式任务文档只能引用 `images/annotated/`，任何 raw、sanitized、缺失图片或结构化事实变化都会阻止发布；发布后可用 `manual verify <task-id>` 复核。

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
| 0 | 完成 | 报告 `documents` 的路径并处理 `warnings`；`cache` 里的复用项说明“使用了 observedAt 时刻的历史观察，未在线确认” |
| 3 | 等待输入 | 看 `waiting[].code`：`model-input-required` → 读请求文件（只读其中列出的文件），按 `references/manual-writing-style.md` 第七节写响应 → `manual run-submit <runId> --request <id> --input <响应.json>` → `manual resume <runId>`；`approval-required` / `scope-changed` → 把任务展示给用户，得到明确确认后 `approve-tasks` 再 `resume`；`auth-*` → 按已获授权的登录方式完成 `auth login` 后 `resume`；`review-required` → 展示需确认的数字 / 承诺，用户确认后带 `--accept-review` 重新运行 |
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

## 按需阅读

- 需要初始化、扫描、旧版截图与分阶段定稿：读[命令细节与兼容流程](references/command-workflows.md)。
- 需要任务审批、可执行前提和截图质量：读[质量与证据工作流](references/quality-workflow.md)。
- 需要调整中文文案：读[写作规范](references/manual-writing-style.md)。
- 需要迁移旧数据或恢复发布事务：读 `docs/MIGRATION.md` 或 `docs/RUNTIME.md`。

所有项目状态只写业务项目的 `.manual/` 与配置中的手册目录。原图、认证缓存和含会话参数的 URL 不进入发布文档。写操作只在已登记、已授权的测试范围执行。
