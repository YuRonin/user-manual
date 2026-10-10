---
name: manual
description: Use when a Web project (currently Next.js) needs a living user manual: 初始化、扫描页面、用真实浏览器截图、生成或更新图文使用手册与任务操作指南、核对手册是否仍与线上一致；also when the user invokes /manual or /manual-<command>.
---

# manual —— Living User Manual

为 Web 项目生成并持续维护图文使用手册：读源码建立页面与任务模型，用真实浏览器操作和截图，按帮助中心的写法出稿，代码变化后只更新受影响的文档。

三条不变的原则：

- **手册里的每张图都来自真实渲染的页面**；页面打不开就报错，不出图。
- **事实由程序锁定**：步骤顺序、界面名称、截图、完成标志来自结构化模型；模型只能改写说明文字。
- **只写业务项目的 `.manual/` 和配置里的文档目录**，不改业务代码；原图、认证缓存和会话 URL 不进入正式文档。

命令统一为 `node <skill>/bin/manual.js <命令> --project-root <项目根> --json`，下文简写为 `manual <命令>`。

## 先判断从哪一步开始

| 当前状态 | 做什么 |
|---|---|
| 项目没有 `.manual/config.yaml` | 第 1 步：首次接入 |
| 已接入，但要写的页面或任务还没有模型 | 第 2 步：建模 |
| 页面或任务已建模（任务已批准） | 第 3 步：生成 |
| 代码改了，想同步手册 | 第 4 步：`update` |
| 想知道手册是否仍然正确 | 第 4 步：`verify` |

不确定时运行 `manual doctor` 查看环境、配置与认证状态。

## 1. 首次接入（每个项目一次）

```text
manual init --base-url <站点地址> --audience <public|internal>
manual auth login --profile default          # 有登录保护的站点；先在 config.yaml 配好 auth.verifyPath 与 auth.identityAssertions
manual inspect                                # 扫描 Next.js 路由与源码依赖，输出要读的文件清单
manual describe --input <分析.json>           # 你读完源码后，写回每页的标题、用途、主要操作和 guide
```

`inspect` 目前只支持 Next.js（App Router 与 Pages Router）；其它框架会明确提示暂不支持。`describe` 的输入格式见[命令细节](references/command-workflows.md)。`purpose` 和 `guide` 会原样进入手册，按[写作规范](references/manual-writing-style.md)第一、三节写：说清用途、选项区别和操作后的变化，「」只给要操作的控件；套话、“您”、连串「」会被拒绝。

## 2. 建模：要写哪些任务

用户要的是“怎样完成某件事”时写任务指南，不要把页面上的按钮逐个罗列。

```text
manual task-guide "要完成的目标"                    # 找入口页面
manual task-guide "要完成的目标" --page <page-id>   # 取得步骤与断言线索（只读）
manual discover-tasks <page-id|--all>              # 取得候选工作清单 → 你写候选 JSON → 带 --input 保存
manual approve-tasks --input <决策.json>            # 用户确认后才批准
```

候选任务的名称、目标、步骤、风险和证据摘要要先展示给用户；只在用户本次或先前明确授权的范围内批准，范围不清就问。只有已批准的任务才会被采集和发布。任务模型里直接面向读者的字段（标题、步骤 `title`（帮助中心目录用的短名称）、`readerPreconditions`、完成声明、`readerChecks`、`branches`、`capture.readerCaption`）按[写作规范](references/manual-writing-style.md)第三、五节写。细节见[任务工作流](references/task-workflow.md)。

### 标注计划与待确认功能

`inspect` / `describe` / 任务审批后读取 `.manual/feature-inventory.json` 的 `pending`。结合读者要完成的任务，在 `describe --input` 的 `features` 中为相关功能写稳定的 `feature_id`、`required|optional|skip` 决策、Scenario 和说明；Required 要关联页面 `guide` 或任务步骤及截图目标。采集后的 `annotations.json` 和 `verify --artifacts --json` 会分别报告逐项绘制与覆盖状态。`pending-review` 需要明确报告为待确认，Required 失败时按失败原因补计划或截图，再生成手册。字段与判定细节见 [标注覆盖率](docs/ANNOTATION_COVERAGE.md)。

## 3. 生成

```text
manual generate task:<id> [task:<id2> page:<id> ...]
```

多个目标共用一个 Run 和浏览器会话。Runtime 自动决定是否需要采集（可复用的有效证据直接用），然后生成事实草稿，**默认停下来请你写文案**（退出码 3，`model-input-required`）：

1. 读请求文件 `.manual/runs/<runId>/model/<requestId>.request.json` 和其中 `files` 列出的文件；需要背景时只回看该页面模型及其列出的源码，用来理解已有事实，不添加新事实。
2. 按[写作规范](references/manual-writing-style.md)填写 `allowedBlocks` 里的文案块：默认文字通常偏短，按第三节补全读者会问的“填什么、选哪个、点了会怎样”。写成响应 JSON（格式见规范第七节）。
3. `manual resume <runId> --request <requestId> --input <响应.json>` 提交并继续，直到发布。

常用选项：

- `--plan`：只预览动作、风险边界（`write` 停在动作前，`destructive` 不执行）与需要的浏览器场景；有新动作或风险范围需要用户审阅时先用它。
- `--offline`：只改文案、已有有效证据时使用，不打开浏览器。
- `--refresh`：强制重新采集，只在用户要求新截图时使用。
- `--copy-default`：跳过模型文案、直接用默认句子。只在用户明确要“先出一个粗稿”时使用，交付时要说明文案未经润色。

发布后：报告结果里 `documents` 给出的正式文档路径，处理 `warnings`；任务指南再运行 `manual review-task <id> --preview`，按[质量工作流](references/quality-workflow.md)对照截图逐篇审阅。`cache` 里的复用项说明用的是 `observedAt` 时刻的历史观察，未在线确认。

## 4. 维护

**代码改了：**先 `manual update --plan` 把影响范围和原因链（`sections[].reasonPaths`：文件 → 页面 → 手册）给用户看，确认后 `manual update`。`confidence=conservative` 表示范围被保守扩大，说明原因即可，不要自行缩小；`retirement` 是页面删除后的下线建议，只转告，不删文件。远端数据、权限或部署变化不在源码影响里，需要 `verify --live`。

**手册还对吗：**`manual verify <目标>` 默认离线检查产物（`onlineChecked=false`，不代表线上行为）；`--live` 在真实浏览器回放，结果分 `failed`（行为不一致）、`drift`（内容变化）、`inconclusive`（环境问题）。写操作步骤不执行，对应声明是 `not_run`，要如实说明覆盖范围。`--all` 检查全部已发布手册。

## 5. 发布为帮助中心网站

用户要把手册做成可访问的帮助中心、或要 HTML 而不是 Markdown 时：`manual site`。它读取已发布的 `docs.outputDir`（`index.md` 目录 + 页面篇 + `tasks/` 任务篇；目录分组可用 `docs.catalog` 配置，见[命令细节](references/command-workflows.md)），输出一套静态 HTML 到 `site.outputDir`（默认 `.manual/site/`）：首页目录与可选求助区、正文页面包屑、「完成后你会看到」提示框、WebP 截图。

每次发布还会重写 `docs.outputDir/meta.json`（每篇的 `updatedAt` 与最多 5 篇 `related`，契约见[命令细节](references/command-workflows.md#文档元数据metajson)），给应用内帮助中心等下游只读使用；`manual site` 目前不读它。不要手改，下次发布会覆盖。

- 退出码 1 + `site-dead-link` / `site-catalog-*`：手册本身有断链或目录缺失，报告给用户并修手册（或重新 `generate`），不要改生成的 HTML。
- 退出码 4 + `site-output-unmanaged`：`site.outputDir` 里已有别人的文件。问用户确认可以覆盖后才加 `--force`。
- 要嵌进应用：把 `site.outputDir` 指到应用的静态目录（如 `public/help`），`homeUrl` 设为应用首页；独立部署在别的域名时设 `appBaseUrl`，让手册里的产品入口链接到应用。配置项见[命令细节](references/command-workflows.md)。

## 按退出码处理

Skill 只负责：解析意图 → 调用命令 → 处理等待 → 报告结果。重试、缓存、恢复由 Runtime 决定并记录在 `.manual/runs/`，不要自己重新截图或循环重跑。

| 退出码 | 含义 | 怎么做 |
|---|---|---|
| 0 | 完成（或 `--plan` 预览） | 报告 `documents` 路径并处理 `warnings` |
| 3 | 等待输入 | 按 `waiting[].code`：`model-input-required` → 上面第 3 步写文案；`approval-required` / `scope-changed` → 把任务展示给用户，确认后 `approve-tasks` 再 `resume`；`auth-missing` / `auth-expired` / `login-required` → `manual auth login --resume <runId>`；`review-required` → 展示需确认的数字与承诺，用户确认后加 `--accept-review` 重跑；`fixture-cleanup-required` → 告诉用户测试数据残留在哪个命名空间，环境恢复后 `resume` |
| 4 | 漂移或冲突 | `run-input-changed` → `resume <runId> --replan`；`merge-conflict` → 把 `proposed.md` 与逐块对照给用户，由用户选择采用提案或把块头改为 `owner=human` 后 `resume`，只有用户明确要求才 `--force`；`document-missing` → 问用户重新生成还是下线；`verify` 的 failed / drift → 报告差异，不要自动重新生成或接受新基线 |
| 1 | 失败 | `manual status <runId>` 报告失败任务的 code 与提示。`network-access-denied` 是客户端沙箱禁止联网：在沙箱外重新执行同一条命令。`outcome-unknown`（写操作结果不明）不能重新提交，按[质量工作流](references/quality-workflow.md)“异常恢复”核对 |
| 2 | 参数错误或目标歧义 | 把 `candidates` 给用户选，用 `task:` / `page:` 前缀重跑 |

## 按需阅读

- [写作规范](references/manual-writing-style.md)：写文案块和任务模型的读者字段之前必读。
- [质量工作流](references/quality-workflow.md)：交付前审阅、已授权的测试写操作、异常恢复（`outcome-unknown`、身份变化、会话核对与续采）。
- [任务工作流](references/task-workflow.md)：候选发现、审批与截图质量。
- [命令细节](references/command-workflows.md)：`init` / `inspect` / `describe` 输入格式，单独采集（`capture`）、预演（`plan-capture --live`）、写操作恢复（`capture-task`）、发布事务（`publication`）、回收（`gc`）与迁移（`migrate`）。
- `docs/RUNTIME.md`：Run、缓存与故障排查；`docs/MIGRATION.md`：旧项目与兼容命令。
