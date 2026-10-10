# Living User Manual Skill｜七阶段完整优化实施计划

> **文档性质**：可执行工程计划（Plan / Roadmap / Acceptance Criteria）  
> **版本**：v1.0 ｜ **编制日期**：2026-10-10  
> **适用仓库**：`E:\NeoStar\user-manual`（审计时 `living-manual` 0.1.0）  
> **依据**：《Living User Manual Skill 七阶段优化进度审计报告》（2026-10-10；基线 `main@6da5bf7` + 审计时工作区未提交改动）  
> **补充依据**：NeoAgent `demo/website/docs/manual-full-rerun-plan.md` 的“已知问题与对策”（2026-10-10）。该记录是一次测试环境运行快照；实施前仍须复核现状。  
> **实施状态**：B0、B1、B2 已完成（见第 15 节）；B3 起待实施。未勾选的项目不代表已修改或验证通过。  
> **维护方式**：每批次开始前重新核对最新仓库；完成后勾选任务、登记测试和变更证据。

---

## 0. 总览：目标、范围、成功标准

### 0.1 最终目标

在**保留现有 CLI、Playwright 采集、Sharp/SVG 绘制、不可变 Capture、内容寻址、Runtime、发布事务及增量更新主干**的前提下，建成可靠的用户手册生产闭环：

```text
项目与页面分析（Inspect / Describe）
  → 有来源、可核验的功能清单（Feature Inventory）
  → 按任务/步骤/Scenario 确定截图计划（Annotation Plan）
  → 真实页面状态回放与采集（Capture）
  → 程序化标注、逐项结果与证据冻结（Render / Evidence）
  → 任务式说明与引用关联（FactPack / Sections）
  → 独立完整性与真实性校验（Coverage / Grounding / Verify）
  → 质量门禁与发布（Publication）
  → 变更影响分析、漂移检测和定向修复（Update / Repair）
```

**不可妥协的目标**：

1. **不漏报重要功能**：功能发现与标注计划独立，计划外的关键功能不能因为分母缺失而显示 100%。
2. **不产生伪证据**：Scenario/角色/页面/步骤/截图/标注与实际执行状态一致；失败截图不能以成功状态进入可复用缓存。
3. **不编造操作**：涉及 UI 操作和操作结果的正文必须可追溯到已采集证据；未执行内容不能伪装为已验证。
4. **不错误发布**：Required 漏标、证据不匹配、隐私风险和确定的虚构描述必须阻断正式发布。
5. **不重复全量工作**：能够复用原图、结构化坐标和有效证据，变更仅触发必要范围的采集/派生。
6. **不破坏已有项目**：兼容旧数据、保持人工编辑和发布状态安全，迁移可诊断、可回退。

### 0.2 七阶段审计基线（不是最新仓库的实时数值）

| 原七阶段 | 审计完成度 | 已有可用基础 | 主要欠缺 |
|---|---:|---|---|
| 1. 标注完整性 | **43%** | DOM 定位、原图派生、覆盖校验雏形 | Inventory 与 Plan 同源；图文未关联；旧证据可绕过 |
| 2. Scenario 联动 | **47%** | Fixture/Auth/任务动作回放 | 任务变体按默认 Scenario 执行；页面 setup 未消费 |
| 3. 智能修复 | **56%** | Retry/Resume/Re-derive | 失败缓存复用；缺定向修复规划 |
| 4. 视觉优化 | **35%** | DPR/主题/Sharp 渲染 | 重叠、裁切、拆图、视觉漂移误报 |
| 5. 内容质量 | **56%** | 任务指南、FactPack、正文白名单 | 未加括号的编造能通过；UI 名称未用 DOM 证实 |
| 6. 增量更新 | **60%** | Git Diff、影响分析、局部重建 | import 解析漏依赖；模型定义变更不触发更新 |
| 7. 自动化质量 | **67.5%** | CI、日志、恢复、发布事务 | 无统一报告；标注门禁缺测试；macOS 未验证 |

审计等权平均约 **52%**。**百分比是审计当时按检查项打分的估计值，不是本计划进度，也不是用户手册质量实测得分**。

### 0.3 工作安排：按依赖分批，不机械按阶段序号施工

| 批次 | 核心目标 | 覆盖原阶段 | 优先级 | 审计给出的粗略工期* |
|---|---|---|---|---|
| **B0** | 冻结基线、修复标注改造回归 | 1 / 3 / 7 | P0 | 1–2 人日 |
| **B1** | 修正伪证据、失败缓存、漏依赖 | 2 / 3 / 6 | P0 | 2–3 人日 |
| **B2** | 独立功能清单 + 完整证据引用 + 发布门禁 | 1 / 3 / 5 / 7 | P0 | 3–5 人日 |
| **B3** | 正文防编造、真实性校验、质量结果可见 | 5 / 7 | P0 | 3–4 人日 |
| **B4** | 高质量标注布局、拆图与视觉校验 | 4 / 6 | P1 | 3–4 人日 |
| **B5** | Scenario 状态覆盖、增量准确性、定向修复 | 2 / 3 / 6 | P1 | 需细分评估 |
| **B6** | 统一质量治理、跨平台回归与正式版放行 | 7（横跨所有阶段） | P1 | 需细分评估 |

\* 粗估来自审计对 B0–B4 的建议，仅作规划参考；不是承诺的交付日期。B5、B6 在实施前按当前仓库评估。

**建议发布节奏**：完成 **B0→B1→B2→B3** 并通过全部 P0 验收后，才能称为“内容与证据可信的发布候选版本”；完成 **B4→B5→B6** 后再评估自动维护能力和正式版质量。

### 0.4 全量重跑反馈的处理边界

- **工具缺陷**纳入下文对应批次，按最新代码复核后实施：认证档案中的 UI 状态、流式回复和截图稳定性、合法跳转、慢环境等待、YAML 结构化修改、读者动作句等。
- **测试数据与环境**纳入可复跑验收：待补充会话、产物 v1、各环境 Scenario ID、空付款记录 Fixture、`next dev` 热更新与开发指示器。固定业务 ID、测试站地址和特定文件名只作为重跑记录，不写成通用工具常量。
- **产品缺陷**单独追踪：对话中产物二次编辑返回 409（记录指向 `ArtifactShell` 未传 `baseVersion`）属于 NeoAgent 产品仓库；本计划要求手册采集明确使用新建 v1 产物的临时前提，并在产品修复后复测、移除绕法，不把产品修复误记为本工具仓库的交付。
- **已覆盖项目**继续按现有任务验收：单图 5 个标注上限见 B4-02；Scenario 状态和 Fixture 见 B5-A；模型变化与历史证据的区分见 B2-13、B5-07。下文只补充它们在本次重跑暴露的具体负例。

---

## 1. 贯穿所有批次的工程纪律

### 1.1 开工前必须执行的只读检查

- [ ] 检查 `git status`、当前分支/提交和差异范围，记录**本批次开始基线**。
- [ ] 核对审计期间并发修改：最初 9 个修改文件 + 2 个未跟踪项，汇总时变为 28 个修改文件，相关模块可能已经被其他会话更新。
- [ ] 对照最新代码确认“已修复 / 仍存在 / 行为变更 / 不确定”，**不可照抄审计行号直接修改**。
- [ ] 将本批次变更限定到明确文件，避免另一个 Agent 并发编辑同一文件；若正在并发开发，先隔离工作树/分支或串行执行。
- [ ] 记录已存在的测试失败和环境不稳定：审计中 unit 415 通过、1 偶发失败；这一数据也仅为审计时快照。
- [ ] 确认 npm scripts、Node/Playwright/Sharp 版本及 CI 命令，以仓库 `package.json` 为准，不臆造脚本名称。

### 1.2 所有变更必须满足

- **最小差异**：优先修复现有模块；不要新建与现有 Store/Planner/Feature 推导重复的子系统。
- **强类型语义**：区分“未声明、不可用、未采集、采集失败、未验证、已验证”；不要把 `null` 或字段缺失等同于 `ok`。
- **证据不可伪造**：严格区分现场观察事实、模型推断、人工声明、未执行步骤。
- **只发布可信产物**：重要失败状态可被看到、被测试和被发布门禁消费。
- **兼容读取、规范写入**：读取支持旧 snake_case/历史字段，新写入逐步收敛为仓库现有 camelCase 风格；旧数据不要求无意义的全量迁移。
- **安全优先**：隐私打码与图片发布要先于视觉优化，不能用“截图看起来没问题”替代像素与坐标检查。
- **有限重试**：已知确定性失败不得重复截图；补采也应受 Run budget、幂等与副作用限制。
- **逐批验收**：每批必须有针对性负例测试和可复现的运行结果；未通过不得声称完成。

### 1.3 开发任务统一交付格式

每个任务/PR 均应包含：

1. **问题与根因**（关联审计问题编号，如 `P0-2`）。
2. **修改文件**与完整调用链受影响节点。
3. **数据结构变化**（旧数据读入行为、缓存键或版本号是否变化）。
4. **正向测试 + 负向测试**，实际运行命令与结果。
5. **用户可观察结果**（CLI 退出码、JSON 字段、产物、截图、验证报告）。
6. **风险与回滚方式**；若无法确认，明确标记未验证。

---

## 2. 核心架构收敛设计（先约束，按批次落地）

### 2.1 使用已有模型，新增最小证据引用

建议的逻辑关系：

```text
Page.features [Feature ID + scope + source]
   │                       ┌── 页面可交互元素证据（ARIA / DOM）
   ├── Task / Step         │
   └── Scenario / State ───┤
                           └── Annotation Plan [featureRef + locator + timing]
                                    │
                              Capture Record（冻结）
                                    │
                   raw / sanitized / annotated / per-item result
                                    │
                 FactPack → Section [captureRefs + annotationRefs]
                                    │
                         Validate → Release → Update
```

这里的 **Feature Inventory 是可审阅的功能事实集合**，**Annotation Plan 是当前截图具体要怎么标注的执行计划**。两者必须独立产生，不能同源自检。

### 2.2 最小建议字段（概念设计，实施前与当前 schema 对齐）

```json
{
  "pageId": "workspace",
  "features": [
    {
      "id": "upload-attachment",
      "name": "上传附件",
      "priority": "required",
      "source": ["describe-confirmed", "dom-observed"],
      "taskIds": ["upload-material"],
      "stepIds": ["choose-file"],
      "scenarioIds": ["workspace-default"],
      "locator": { "role": "button", "name": "上传附件" },
      "reason": "完成上传教学资料任务必须经过该入口"
    }
  ],
  "unresolvedCandidates": [
    {
      "candidateId": "candidate-history",
      "source": "dom-observed",
      "reason": "发现历史会话入口，但尚未判定是否在当前任务内"
    }
  ]
}
```

- `Page.features[].id` 必须稳定，不能只用按钮显示文案 hash；重命名不应自动导致关联丢失。
- **Required / Optional / Skip / Undecided** 都有明确语义；Skip 必须有原因，Undecided 不可偷偷丢弃。
- `source` 指出处：显式声明 / DOM 观察 / AST 推断 / 模型建议 / 任务步骤；不同来源可信度不可混同。
- 任务、步骤、Scenario 和截图时机共同决定 Required 的**作用域**；并非一个页面的所有 Required 必须出现在每张局部截图中。
- 每条 Annotation 增加 `featureId`、`captureId`、`label`、`rect`、`rendered`、`failureReason` 等可追踪字段；理想引用为 `<captureId>#<featureId>`，实际需处理同图重复标注的唯一性。
- Section 增加可选 `featureRefs`、`captureRefs`、`annotationRefs`、`scenarioRefs`。
- 旧 `feature_id/task_ids` 应兼容读取；不要无迁移地修改原持久化字段的语义。

### 2.3 四类核心质量指标（分母不得互相替代）

| 指标 | 分母 | 分子 | 关键约束 |
|---|---|---|---|
| **Inventory Review** | 当前作用域内待判定的重要候选功能 | 已判定 priority 且有依据的候选功能 | 存在重要未判定项时，不应显示“功能发现完整” |
| **Plan Coverage** | 已确认的 Required 功能 | 纳入有效 Annotation Plan 的 Required | 8 个 Required、只计划 6 个，不得显示 100% |
| **Render Coverage** | 当前截图/分组应呈现的 Required 标注 | 位置与边框、编号均有效的 Required | 计划 6 个、成功 5 个时阻断发布 |
| **Documentation Coverage** | 当前任务/章节应解释的 Required 功能 | 有 Section 证据引用和真实说明的 Required | 绘图成功但正文缺说明仍不达标 |

**指标规则**：

- 无有效 Required 分母时显示 `N/A`，不能机械等于 100%。
- 分母须绑定 `{page, task, step, scenario, timing, inventoryRevision}`；不同 Scope 不能简单相加。
- `unknown/undecided/legacy-unverified` 单列数量，不从“已验证”中偷换口径。
- 未确认的候选功能不应自动升级为 Required；但高价值候选未决应阻止宣称“功能已全部覆盖”，并在严格发布模式下触发人工确认或可配置门禁。
- `rendered=true` 不只意味着函数返回成功：要有合法坐标、满足可见区域要求、真实渲染、必要时验证未被遮挡或马赛克覆盖。

### 2.4 数据真值与缓存原则

- **持久权威事实**：现有 Page/Task/Scenario 定义 + Capture 记录 + Release 记录。
- **派生索引**：`feature-inventory.json` 若继续存在，必须有明确消费者和一致性策略；不应变成另一套独立真相来源。
- **可重建产物**：raw / sanitized / annotated / derivation 等仍可放在 artifacts；但跨机器校验所需的**最小标注证明**必须进入持久化、可迁移的位置，不能完全依赖 `.gitignore` 下的 sidecar。
- **不可变证据**：发布记录校验应使用 Capture 当时冻结的 plan、feature revision、render result；当前模型的变化应触发 `stale/update`，而不是倒过来篡改对历史 Capture 的解释。
- **失败缓存**：`annotationCoverage.ok === false`、证据不匹配或元数据 `unknown` 不能被当作有效成功命中。缓存失效要可解释，并给出 `missReason`。

---

## 3. B0｜稳住当前标注改造与兼容行为（P0）

**目标**：先防止新覆盖规则让已有页面/Scenario/操作后截图大面积丢失发布图，并且让真实错误可见。  
**依赖**：最新代码基线检查。  
**建议改动入口**：`src/annotations/coverage.js`、`src/evidence/capture-page.js`、`src/tasks/executor.js`、`src/generate/page-usecase.js`、`src/tasks/task-draft.js`、`src/runtime/planner.js`、相关 schema/测试（以现有文件实际名称为准）。

### B0 工作项

- [x] **B0-01｜冻结当前状态**：列出审计期间已经修复的项目（`page.features` 持久化、`RENDERER_VERSION=sharp-svg-2`）和仍有缺口的项目；确认 `capturePipelineVersion`、错误检查顺序、编号行为。
- [x] **B0-02｜统一步骤所属页面**：引入 `stepPageId(step) = step.pageId ?? step.page` 等统一读取方式，消除 schema/任务执行/覆盖校验对字段名理解不一致。
- [x] **B0-03｜重新定义 guide 语义**：仅说明性且没有 target 的 guide 不应被强行视为绘图 Required；**显式 Required** 即使缺 target 也不能静默降级，必须报告“缺少定位目标”。
- [x] **B0-04｜Scenario 作用域收敛**：只对当前 Scenario 应当可见的 Required 计数；默认 guide 和变体 checkpoint 不得互相制造伪缺失。
- [x] **B0-05｜任务截图时机**：隐式动作目标标注默认是提示性/Optional（除非任务或 feature 明确 Required），防止操作后按钮消失使整张图失败。
- [x] **B0-06｜步骤精度与编号**：避免把 feature 仅按 `taskIds` 注入该任务所有 step；隐式标注的 label 不再固定为 `1`，必须和步骤/说明规则一致。
- [x] **B0-07｜恢复真实错误**：先检查 `annotationCoverage` 再报“无发布图”；`annotation-layout-failed` 不得被改写成 `navigation-failed`；JSON / stderr / run event 保持一致错误码和 feature 信息。
- [x] **B0-08｜版本与旧数据策略**：修改会影响采集/标注语义的版本号；针对旧 Sidecar 的 `coverage=null` 标明 `unknown`，不能自动视为通过。
- [x] **B0-09｜门禁回归测试**：覆盖元数据缺失、hash 篡改、Required 失败、已删除页面；规范测试框架格式。

### B0 验收（全部满足）

- [x] 说明性 guide 未提供 target 时仍能生成正确手册/对应截图；显式 Required 缺 target 时有准确诊断。
- [x] 非默认 Scenario 页面有独立作用域，不因默认 guide 而必然失败。
- [x] 操作后消失的按钮不会因自动标注规则而使合法截图失败。
- [x] Task 第 3 步的说明与标注编号可对应，不会无条件显示 ①。
- [x] 页面/任务两条路径对覆盖失败均显示 `annotation-coverage-failed`，并提供 `featureId:reason`。
- [x] 新增相关测试全部通过；完整 unit/browser 基线没有非预期回归。

**结束标志**：可以安全开始修复跨阶段证据正确性 P0；B0 不是“标注完整性已完成”。

---

## 4. B1｜证据可信与缓存正确性（P0）

**目标**：杜绝“变体被执行成默认状态”“失败截图进入缓存”“源码变化被漏报”。  
**依赖**：B0 的错误分类和覆盖结果输出。  
**重点模块**：`src/runtime/handlers.js`、`src/tasks/capture-usecase.js`、`src/cache/lookup.js`、`src/inspect/import-graph.js`、`src/inspect/fingerprint.js`、`src/runtime/planner.js`、`src/commands/generate.js`。

### B1 工作项

- [x] **B1-01｜任务 Scenario 参数贯通（P0-2）**：Runtime 调用 `captureTask()` 必须传入选中的 `scenarioDefinition`；核对登录身份、Fixture、entry、断言与 `record.scenarioId`。
- [x] **B1-02｜Scenario 缓存及投影隔离**：变体 Capture 不能覆盖默认页面 `latestCaptureId` / 任务 `lastCapture`；缓存命中与重新执行路径行为相同。修复 `restoreProjection` 的变体判断。
- [x] **B1-03｜失败缓存拦截（P0-3）**：写缓存前以及 lookup 复用前同时检验 coverage/evidence 状态；失败/unknown 不得以成功缓存复用；提供 `annotation-incomplete` 等明确 miss reason。
- [x] **B1-04｜真实错误穿透**：确保 handler warnings 进入 runner、events、状态输出；缓存失效和截图失败不会被误报为 `succeeded`。
- [x] **B1-05｜Import Graph 修复（P0-5）**：解析 `./api.client`、`@/lib/date.utils`、`export * as ns from`；解析不了标为 unresolved/partial，不能虚报 complete。
- [x] **B1-06｜Generate 新鲜度**：调用现有 `refreshModel` 或等效新鲜度检查，确保刚修改源码后直接 `generate` 不复用旧指纹。控制不必要全量失效。
- [x] **B1-07｜Legacy Sidecar 与缓存治理**：已知不可验证旧证据标为待补采或待重派生，避免 `null` 绕过覆盖门禁。
- [x] **B1-08｜认证档案 UI 状态隔离**：复核 `localStorage` 中 `neo_sidebar_collapsed` 如何写入、回写认证档案；依赖侧栏的任务在采集前须恢复并断言侧栏展开，采集其他页面不能把收起状态永久污染后续任务。优先复用现有 `readState/writeState` 与 Auth Profile 机制，不在任务模型中硬编码测试账号。
- [x] **B1-09｜流式回复与截图稳定性**：`reply-ready` 必须等真实回复正文或产物卡片出现且生成状态结束；截图前等待网络/DOM 达到有界稳定窗口，超时明确报告当前状态，不能把用户消息或短暂停顿当作 AI 回复完成。复核本次 `page:chat` 修复是否已合入工具仓库。
- [x] **B1-10｜慢环境等待与恢复**：登录检查、页面就绪和截图稳定等待采用可配置且有上限的预算；接口尚未返回时不能提前通过静置判据。整页长期卡在“加载中”时允许一次有记录的刷新，写步骤及结果未知时不得自动重放。
- [x] **B1-11｜暂态提示条遮挡操作**：保存成功后若提示条覆盖后续目标，执行已声明的安全鼠标移开/等待动作并重新检查目标可见性；不能在提示条遮挡时反复点击或重放保存。以 `edit-export-artifact` 的“保存后打开更多操作”复现。

### B1 验收

- [x] Task Scenario 变体以 mock/匿名等指定状态运行，`scenarioId` 和 `provenance.mode` 正确；默认主体投影保持不变。
- [x] 失败覆盖结果不会二次命中：重新生成显示 `capture-required:annotation-incomplete` 或明确修复路径。
- [x] 修改 `api.client.ts`、`date.utils.ts` 或 `export * as` 链接模块时，`update --plan` 能命中相关页面。
- [x] 改动源码后 `generate` 能识别 `input-changed(sourceHash)`（最终字段以现有协议为准）。
- [ ] 先采带产物对话、再采依赖侧栏「全部」的任务，目标仍可见；发送 AI 请求后不会在回复生成中发布截图；人为延迟接口时报告可定位的等待超时，而非伪成功或无限等待；保存提示条遮挡后续按钮时可恢复目标可见性，且不重复保存。（工具侧机制已用测试夹具验证；待在 NeoAgent 测试站实际重跑确认）
- [x] 新增任务变体与缓存隔离集成测试；完整 CI 不回归。

---

## 5. B2｜Feature Inventory 独立化与端到端证据链（P0）

**目标**：真正解决初始诉求——关键功能漏标但检查显示 100%；建立 “Feature → Screenshot → Annotation → Section” 的稳定对应。  
**依赖**：B0–B1 已让 capture/缓存状态可信。  
**重点模块**：`src/annotations/coverage.js`、`src/annotations/store.js`、`src/inspect/model.js`、`src/model/schema.js`、`src/model/links.js`（拟新增）、`src/evidence/capture-safe.js`、`src/evidence/image-pipeline.js`、`src/evidence/rederive.js`、`src/generate/manual-model.js`、`src/publication/validate.js`、`src/verify/artifacts.js`。

### B2-A：让功能发现与标注计划不再相互依赖

- [x] **B2-01｜唯一 Inventory 入口**：统一四处推导为 `inventoryFor(subject, scenario, step, timing, revision)`（概念接口）；调用方只做作用域过滤，不各自实现来源合并。
- [x] **B2-02｜权威 Required 规则**：`Page.features` 或经 describe/审批确认的条目才可以成为正式 Required；guide 主要是标注计划来源，不得同时自动生产分母和分子。
- [x] **B2-03｜候选发现（弥补源头漏项）**：比对 DOM/ARIA 可交互元素、detectedActions、guide、task steps、显式 features，输出 `unresolvedCandidates`；未核实项不编造 Required，但重要未决不得被虚假隐藏。
- [x] **B2-04｜稳定 ID**：为持久 Feature 使用稳定 ID，兼容旧 `feature_id`；重复标题不能冲突，文本变化不导致 ID 重新生成。
- [x] **B2-05｜可审阅的 Plan**：独立记录 `featureRef`、`priority`、定位、Scenario、截图时机、reason、planRevision；Required 没进入计划必须产生 `missing-from-plan`。
- [x] **B2-06｜清晰的作用域**：每张图的 Required 只包含其任务/步骤/状态真正应呈现的元素；一个任务跨多张图可联合覆盖，不能靠单图 5 个标注上限断定全部任务失败。（按页面 / Scenario / 步骤限定作用域，任务级 Required 跨多张图联合覆盖（missing-from-task-plan）；单图超上限自动拆图属于 B4-02）

### B2-B：让绘图与正文能够逐项对证

- [x] **B2-07｜Renderer 逐项产物**：为每项记录 `{featureId, resolvedLocator, rect, imageRect, visibleRatio, marker, drawn, reason}`；不要将“几何预测”冒充像素验收结论。（记录 featureId、locator、imageRect、visibleRatio、redactedRatio、marker、drawn、visible、reason；备选定位命中给出 annotation-locator-fallback 提示）
- [x] **B2-08｜不可见与裁切检测**：区分不存在、不可见、在视口外、部分裁切、被遮挡、被打码；可见比例门槛建议先以 **80%** 作可配置候选值，通过样例验证后确定，不直接写死为产品真理。
- [x] **B2-09｜编号、图、文强关联**：Section 引用真实 `annotationRefs` 而不是依靠“guide 下标 + 1”；调换 guide 顺序但未更新截图时应报 `annotation-label-mismatch`。
- [x] **B2-10｜统一 Step 页面与跨实体引用**：规范 `stepPageId`、`step.featureRefs`、`guide.featureId`、`Capture.subject` 和 Section 的引用关系；现有 `validateUserTask(...,{pages})` 应真正接入。
- [x] **B2-11｜新增 `validateLinks()`**：在模型提交、Capture 写入、草稿构建、发布/离线 verify 处检查引用存在和所属关系，典型错误 `missing-reference`、`capture-subject-mismatch`、`section-ref-invalid`。（已接入模型提交、Capture 写入、任务草稿、发布、verify --artifacts）
- [x] **B2-12｜修复跨机器证据**：将验收必要的精简 annotation 证明内嵌进入库 Capture 或归档到可持久化证据目录；`.manual/artifacts/` 可继续存可重建大文件。
- [x] **B2-13｜修正历史验证语义**：发布时校验冻结 Capture 的有效性；当前 Page 定义变化只标记失效/待更新，不反向改变历史截图的含义。
- [x] **B2-14｜收紧逃逸入口**：明确 `--no-screenshot` 的允许场景；当正式输出要求 Required 图片时不能绕过；缺 Capture / 缺 sidecar 不得默认为 pass。兼容行为必要时区分 internal 与 public。
- [x] **B2-15｜重派生计划新鲜度**：plan/feature revision 变化时识别 `plan-changed`，按情况重新标注或重采；不能无限沿用旧冻结计划生成“新定义下的有效图”。

### B2 验收

- [x] **AC-01**：8 个已确认 Required，计划只有 6 个 → Coverage 不得 100%，缺少两个具体 featureId，严格发布阻断。
- [x] **AC-02**：计划 6 个 Required，真正绘制了 5 个 → `renderCoverage < 100%`，严格发布阻断。
- [x] **AC-03**：图像绘制 6 个，但正文引用缺 1 个 → Documentation Coverage 失败。
- [x] **AC-04**：仅说明性 guide 不要求标注，能正常发布；显式 Required 不因缺 target 被跳过。
- [x] **AC-05**：同一个 Task 的不同 Step/Scenario Required 不互相污染。
- [x] **AC-06**：删除 `.manual/artifacts/` 后，仍能从持久证据完成必要的引用完整性验收；若缺失可重建图像，则应明确报“可重建资源缺失”，而不是错误通过或误报 annotation 元数据。
- [x] **AC-07**：Section → Capture → Annotation → Feature/Task/Scenario/Step 能通过 ID 跟踪；伪造 captureId、featureRef 时有确定错误。
- [x] **AC-08**：旧数据读取兼容，事实 hash 的不相关字段不会被无意改变；未知覆盖度不会显示 100%。
- [x] **AC-09**：源码中只保留一个权威 Inventory 生成入口；派生 JSON 有真实消费者或被移除。

---

## 6. B3｜文案真实性与统一质量门禁（P0）

**目标**：防止 AI 在手册正文中写出页面不存在的按钮或承诺；把质量问题带到 JSON、状态与发布门禁。  
**依赖**：B1 证据可靠；B2 可追溯的 Feature/Section 链。  
**重点模块**：`src/generate/fact-pack.js`、`src/generate/markdown-validate.js`、`src/generate/style-lint.js`、`src/generate/model-request.js`、`src/generate/manual-model.js`、`src/runtime/handlers.js`、`src/runtime/runner.js`、`src/publication/validate.js`、相关 Capture 数据模型。

### B3 工作项

- [ ] **B3-01｜限制模型“补结果”自由度（P0-1）**：修改模型改写请求；操作后的结果只能根据已执行断言、`claims` 或 `readerChecks` 表述，不得凭常识推断“自动导出/发送到邮箱”等动作。
- [ ] **B3-02｜不依赖「」识别操作断言**：解析“点击、选择、输入、打开、上传、保存、发送”等动作表达，以及“将生成、会自动、发送到”等结果表达；抽取声称的 UI/能力对象并校验来源。
- [ ] **B3-03｜DOM / ARIA 证据清单**：按具体 Scene/Step 采集交互元素 role、accessible name、文本和关联 locator；避免记录敏感输入值，尊重隐私打码政策。
- [ ] **B3-04｜可信术语来源**：`allowedUiTerms` 改为可区分 `observed / declared / model-inferred`；只有已观察或经过有效人工确认的条目可以支持“已验证 UI”的断言。动态状态下应查对应 Scenario 的证据，不用单个默认截图的文本白名单误杀真实操作。
- [ ] **B3-05｜未知语义处理**：确切虚构的功能/结果 `blocked`；证据不足但可能正确的表述 `review-required`；不把关键词正则检查误判为事实证明。
- [ ] **B3-06｜未执行步骤可见**：风险边界后未执行步骤必须有“未验证/仅供操作参考”的可辨识说明，不得与已完成步骤同一证据等级。
- [ ] **B3-07｜补全结果与引用**：修复 completion Section 的 `captureRefs`；必要时引入步骤级 `result` 引用 after assertions，不把模型描述当作真实执行结果。
- [ ] **B3-08｜质量结果汇总**：`taskQuality/imageQuality`、标注覆盖、步骤执行率、事实可信度、warnings 必须进入统一 `quality` 结构、Run events、CLI `--json` 与 `status`。
- [ ] **B3-09｜可配置门禁**：增加或扩展 `quality.blockOn`、按项目模式区分严格/观察策略；有高风险虚构、隐私、伪证据时不允许用户随意通过“降低分数线”静默放行。
- [ ] **B3-10｜定位名称与读者动作句分离**：定位可使用 selector/ARIA 等稳定证据，正文动作句优先使用已审核的 `instruction`；不得把冗长的题目卡、产物按钮 `aria-label` 原样写成“点击「……」”。仍须验证 instruction 声称的操作对象确实存在。

### B3 验收

- [ ] **AC-10**：原审计实测句子——“然后点击右上角的导出按钮，系统会生成 PDF 报告并发送到邮箱。”——在无支持证据时返回 `blocked` 或 `review-required`，不能 `ok:true` 且无警告。
- [ ] **AC-11**：在 instruction 中写不存在的 UI 名称，不得自动进入已验证白名单；输出 `ui-term-not-observed` 或审核提示。
- [ ] **AC-12**：动态弹窗中确实出现的菜单项，在对应 Scenario 有 DOM 证据时不会被默认场景误判为虚构。
- [ ] **AC-13**：`generate --json` 和 `status` 能查看统一 `quality` 指标及 warnings，不只存在 stderr。
- [ ] **AC-14**：人工未执行步骤带明确状态标识；无法伪装成已验证成功。
- [ ] **AC-15**：完成声明的截图引用可被追溯；无证据的“执行成功”不予放行。
- [ ] **AC-15a**：题目卡或产物按钮带长 `aria-label` 时，生成的动作句可供读者理解，定位仍命中真实控件；虚构的 `instruction` 仍被真实性检查发现。

---

## 7. B4｜视觉标注质量与真实漂移比对（P1）

**目标**：生成易读、不碰撞、可扩展的标注图，并确保视觉校验比的是同一语义层的图片。  
**依赖**：B2 的逐项渲染结果、独立引用；B3 可追踪 Section。  
**重点模块**：`src/evidence/image-pipeline.js`、`src/artifacts/annotation.js`、`src/config/annotation.js`、`src/browser/playwright.js`、`src/verify/live.js`、视觉 diff/重派生模块。

### B4 工作项

- [ ] **B4-01｜标注布局器**：编号候选位置按 左/右/上/下/框内角及安全留白评分；与其他编号、边框、隐私遮挡区域检测碰撞；无安全位置时记录明确失败而不是硬塞。
- [ ] **B4-02｜密度控制与拆图**：`maxMarkersPerImage` 是触发分组的条件而不是整次报错；保留单个 Screenshot 的来源与分图 `part-N`、全局编号及 Section 引用。
- [ ] **B4-03｜主题参数统一**：光晕、线宽、字体大小、颜色、编号背景和字号比例全部由主题控制；删除死配置或接入消费方。
- [ ] **B4-04｜坐标与图像自检**：严格核对 viewport/full-page 的截图尺寸、DPR、scroll offset、null boundingBox；修复 fixed/sticky 在整页图的坐标偏移，并同时覆盖隐私打码。
- [ ] **B4-05｜裁切与遮挡**：对真实可见占比、边框有效像素、马赛克交集计算结果；Required 失败会沿现有门禁传播。
- [ ] **B4-06｜视觉漂移公平比较**：对比相同层级（sanitized 对 sanitized，或按同一 plan 重绘 annotated 对 annotated）；避免“历史带标注图 vs 新无标注图”的必然误报。
- [ ] **B4-07｜Golden/Fixture**：覆盖紧邻按钮、四边贴边、全宽按钮、密集表单、滚动 + fixed/sticky、DPR=1/1.5/2、不同页面主题。
- [ ] **B4-08｜异常处理**：拆图失败、布局拥挤必须有可诊断的 `annotation-*` 代码，不回写成导航失败。

### B4 验收

- [ ] **AC-16**：7 个目标、单图上限 5 个 → 生成 2 张图（例如 1–5、6–7），说明与编号一致。
- [ ] **AC-17**：紧邻目标、贴边、全宽目标的编号不压住必要控件，边框不错误指向其他元素。
- [ ] **AC-18**：DPR=1、1.5、2 和整页滚动组合下标注/隐私遮罩仍准确落在目标位置。
- [ ] **AC-19**：没有页面变化时连续运行 `verify --live`，带标注页面返回 `visual.status = same`（或等效稳定结果）。
- [ ] **AC-20**：设计变更后可以只重派生图片而不强制重新登录和采集。

---

## 8. B5｜Scenario、更新与定向修复闭环（P1）

**目标**：从“单一截图正确”拓展到“交互状态可重放、项目变更可感知、失败可以最小代价修复”。  
**依赖**：B1 正确的 Scenario 身份/缓存，B2 完整失败定位，B4 可重派生渲染。

### B5-A：Scenario 状态覆盖

- [ ] **B5-01｜页面 setup 动作**：让 `scenario.setup` 有实际消费者，可复用任务已存在的 `validateAction / performAction`，而不是再写第二套浏览器动作引擎。
- [ ] **B5-02｜Checkpoint 实际执行**：`checkpoint.state/afterStepId`、`capture.annotations`、`capture.mode`、`expected` 与 Fixture/身份的语义统一；对没有消费者的字段明确“实现或弃用”，不能继续无声接受。
- [ ] **B5-03｜可复现状态**：稳定复现 Modal、Dropdown、Tab、Hover、Loading、Error、Empty；Empty 至少需要明确非 URL 的断言证据；Loading 使用可控 Fixture 时序，不靠碰巧捕获。
- [ ] **B5-04｜逐角色断言**：Auth Profile 与角色期望一致；权限不足应报告真实限制，不自动代入其他角色。
- [ ] **B5-05｜截图后状态复核**：复核 expectedState、hover/菜单可见性，避免定位步骤移动鼠标后把菜单弄没却留下“已成功”记录。
- [ ] **B5-06｜变体出口**：变体截图可经 Section/手册页面明确引用，而不是仅存档却无人消费；`verify --live` 不应永远只检查默认状态。
- [ ] **B5-06a｜合法跳转与登录判定**：Scenario 明确声明的 `redirects`（如 `/password-reset` → `/login?view=reset`）应按预期终点和页面状态校验；仅 URL 落到 `/login` 不得直接判为需要登录。未声明跳转及真正的登录墙仍应报告。`verify --live` 对合法跳转不能长期只给 `inconclusive`。
- [ ] **B5-06b｜一次性前置数据**：对“待补充”会话、已保存产物等消耗型状态记录创建/选取/消费前提；每次重采前检查状态仍在，并确认目标位于可见区域。失效时提示重新准备，不能悄悄截取其他会话或视口外标注。

**Scenario 验收**：Modal / Dropdown / Tab / Hover 四个真实浏览器 Fixture 能打开指定状态、在弹层内部完成 Required 标注、经 replay 得到同一结论；损坏的 Scenario 定义不能静默 `continue`。另以合法密码重置跳转、付款空状态 Fixture、已消费的待补充会话为负例/正例，检查跳转、空状态和前置数据诊断。

### B5-B：增量更新准确性

- [ ] **B5-07｜模型定义和配置变更**：`update --plan` 能识别 `.manual/` 的 guide/任务/Scenario/图片配置变化，同时把纯文档修改与采集必要变更区分开。
- [ ] **B5-08｜依赖图完整性**：未解析依赖采用 `partial/unresolved` 并保守扩散，不能宣称 complete；B1 修复规则建立持续测试。
- [ ] **B5-09｜全局文件分级**：package.json scripts 等无运行影响修改不应全量重采；React/Playwright/核心运行依赖升级时有明确失效理由；lockfile 处理需依据实际解析相关性而非粗暴“一变全重建”。
- [ ] **B5-10｜新页面/移动路由可见性**：文本输出提示未归属改动、未发布新页面、renameCandidates；不要静默过滤。
- [ ] **B5-11｜视觉/语义漂移回流**：live verify 结果进入 update 规划或待修清单，能定位到 page/task/scenario/section。
- [ ] **B5-12｜缓存新鲜度**：消除 `task.stale` 在缓存命中后未清除等问题，冻结版本变化可解释，避免误复用。
- [ ] **B5-12a｜页面状态定义的影响范围**：更改 `page:chat` 等共享状态断言时，列出所有引用该状态的任务和 Capture；`verify` 应说明 `evidence-stale` 的具体状态修订及需要重采的范围，不得把历史证据误判为当时无效。

**更新验收**：修改 `.manual/pages/` 对应 guide 会列出受影响文档；只改无关脚本不引起全量截图；修改关键共享依赖时影响范围可解释；单页面修改不会更新无关文档字节。

### B5-C：标注失败定向修复（有界、无副作用）

- [ ] **B5-13｜失败原因分类**：`locate / visibility / state / plan / inventory / draw / description / privacy`；区分 not-found 与 not-visible；`annotation-*` 纳入 HINTS/POLICIES。
- [ ] **B5-14｜定位短等待与备选记录**：有界等待元素（可用两次短重试作初始策略），记录 fallback 被采用的 locator 与当前证据，不静默替换原配置。
- [ ] **B5-15｜Repair Planner**：只因主题/布局失败时重新 derive；定位失败时重新定位/局部补采；状态缺失才重新播放 Scenario；源清单错误进入审核而不是盲采。
- [ ] **B5-16｜重试预算与幂等**：建议初始最多 **2 次定向修复**（独立于现有通用重试，需要总预算协调）；涉及写操作的任务不得在不确认副作用情况下自动重放。
- [ ] **B5-17｜终态报告**：修复不可行时报告 `annotation-unrepairable`、关联 feature 和明确行动建议；`waiting_input` 不能被伪装为 succeeded。

**修复验收**：纯绘图失败直接重派生；操作失败只重跑允许的必要步骤；连续失败按预算停止；原模型/原截图未变化时不会永久命中错误缓存。

---

## 9. B6｜发布级质量治理、CI、运行手册（P1）

**目标**：让前六批次的质量要求成为可运行、可观察、可回归、可支持多平台的持续机制。  
**依赖**：前面各批次的指标、错误、发布门禁逐步稳定。

### B6 工作项

- [ ] **B6-01｜统一质量模型**：一次运行输出 `inventoryReview / planCoverage / renderCoverage / documentationCoverage / executedSteps / verifiedClaims / privacy / freshness / warnings`，并保留旧 `executionCoverage` 的独立口径。
- [ ] **B6-02｜质量门禁策略**：面向 public/正式发布采用 fail closed；开发观察模式允许 warning，但报告不能标记“已验证”。核心伪证据、隐私违规、确定虚构不允许静默放行。
- [ ] **B6-03｜质量趋势与对比**：至少记录本次 vs 上次的 Required 缺失数、图文不一致数、Schema/Scenario 错误数；区分单次页面异常和系统性回归。
- [ ] **B6-04｜补齐 CI 矩阵**：保持现有 Ubuntu + Windows × Node 版本测试；新增 macOS 前先验证环境支持与超时/浏览器依赖，失败需可定位。
- [ ] **B6-05｜测试层级**：单元（Inventory、Coverage、Layout）、集成（Capture/Cache/Verify）、真实浏览器（Scenario/Full-page）、端到端（Generate→Validate→Publish→Update）。
- [ ] **B6-06｜Golden Fixture 管理**：固定用于用户任务、复杂控件、隐私遮挡、跨语言、不同 DPR 的可重跑小型页面集，不依赖远程业务环境的偶然状态。
- [ ] **B6-07｜CI 自动化模式**：审计提议的 `--analysis-default` 属于可选方案，先确认已有 `--copy-default` 能否满足无人值守；不要为了新 flag 重建第二套分析流程。
- [ ] **B6-08｜跨机器验证**：在干净 clone / 不同 OS 测试：缺少忽略目录中的原图时行为明确、可校验的持久化 Capture 不丢、能按需重建派生产物。
- [ ] **B6-09｜运行手册与故障处理**：为 `annotation-coverage-failed`、`scenario-mismatch`、`annotation-incomplete`、`ui-term-not-observed`、`geometry-scale-mismatch` 等提供定位命令/修复建议。
- [ ] **B6-10｜收敛死字段/旧入口**：只清理被完整调用链和测试证实无消费方的字段；兼容已公开 CLI，弃用需先公告、再迁移、后删除。
- [ ] **B6-11｜任务模型结构化修改**：复核 `approve-tasks` 对 YAML 长文本的格式重写；工具和运行手册中的后续修改按解析后的字段进行，不依赖原文字符串替换。格式改变不应静默漏掉授权、动作或说明更新。
- [ ] **B6-12｜开发环境采集基线**：对本地 `next dev` 验证产物写入 `.manual/`、`docs/` 不会引起持续热更新；验证开发指示器不进入发布截图。NeoAgent 侧的 Tailwind `@source not` 和 `devIndicators: false` 作为待确认的项目配置，不擅自修改产品配置。
- [ ] **B6-13｜重跑数据与授权清单**：运行手册要求在切换测试站/本地站时核对 Scenario ID、进行中的活动、可用积分与资料；`view-billing` 等外部服务不可用时使用经声明的 Empty Fixture；写授权到期前检查有效期，续期后按现有审批规则重新批准，不让写步骤在运行中意外停下。
- [ ] **B6-14｜产品绕法退出条件**：记录对话内产物二次编辑 409 的产品修复责任与跟踪位置；在修复前，`edit-export-artifact` 重采须准备新 v1 产物并按最新目标定位。产品修复合入后复测二次编辑，再删除该测试数据绕法。

### B6 验收

- [ ] 所有 P0/P1 关键负例进入 CI 且稳定执行。
- [ ] Release 前能生成机器可读的质量报告，并对失败门禁给出责任 feature/section/scenario。
- [ ] 跨平台/跨机器核心证据校验行为一致，不能因 clone 丢失 `.manual/artifacts` 就把历史手册误判通过或不可解释地失败。
- [ ] 正常流程可无人值守完成非交互部分；审批、登录和有副作用步骤仍尊重明确的人机边界。
- [ ] 本地全量重跑中，长 `aria-label` 不污染读者动作句；授权过期、Scenario ID 失效、一次性数据已消费、付款服务缺配置均给出可操作诊断；产品 409 绕法和退出条件有记录。

---

## 10. 综合验收矩阵（推荐转成测试用例）

| ID | 测试场景 | 期望结果 | 首次引入批次 |
|---|---|---|---|
| T01 | guide 不带 target、仅有文字说明 | 不强制标注、不误阻断 | B0 |
| T02 | 显式 Required 没 target | 具体错误，不能降级跳过 | B0 |
| T03 | 带默认 guide 的非默认 Scenario | 仅校验本 Scenario 应有的项 | B0 |
| T04 | 第 3 步操作后按钮消失 | 按 timing 判定，不制造伪失败 | B0 |
| T05 | 覆盖失败先于“图片缺失”检查 | 明确 `annotation-coverage-failed` | B0 |
| T06 | 任务变体 mock + 匿名身份 | 按变体执行、provenance 正确 | B1 |
| T07 | 变体缓存命中 | 不覆盖默认主体投影 | B1 |
| T08 | 失败截图写缓存/再 lookup | 拒绝复用，记录 miss reason | B1 |
| T09 | 导入 `api.client`/`date.utils` | 正确纳入影响图 | B1 |
| T10 | 8 个 Required、计划 6 个 | 发现 2 个漏项，不能 100% | B2 |
| T11 | 6 个 Required、有效绘制 5 个 | 阻止严格发布 | B2 |
| T12 | 6 个已绘制、正文只解释 5 个 | Documentation Coverage 失败 | B2 |
| T13 | 调整 guide 顺序但继续用旧图 | `annotation-label-mismatch` | B2 |
| T14 | Section 引用不属于本 step 的 Capture | `capture-subject-mismatch` | B2 |
| T15 | 删除未入库 artifacts 后离线验证 | 证据来源可解释，正确判定 | B2 |
| T16 | AI 编造导出 PDF 并发送邮箱 | 阻断或要求审核 | B3 |
| T17 | 不存在的 UI 名称 | 标记未观察，不能当成真实按钮 | B3 |
| T18 | 动态弹窗里真实存在 UI | 引用对应 Scene 证据可通过 | B3 |
| T19 | 未执行的任务步骤 | 正文显式标记未验证 | B3 |
| T20 | 7 个标注、每张最多 5 个 | 自动两张图，图文编号一致 | B4 |
| T21 | full-page + sticky + 隐私字段 | 坐标、打码与标注正确 | B4 |
| T22 | 带标注页面连续 `verify --live` | 未变化时不误报漂移 | B4 |
| T23 | Modal / Dropdown / Tab / Hover | 状态重放后采集、校验均正确 | B5 |
| T24 | `.manual` guide 发生变化 | Update 命中对应目标 | B5 |
| T25 | 纯布局失败 + 原图有效 | 直接 rederive，不全量重采 | B5 |
| T26 | 两次修复仍失败 | 有界停止并记录终态 | B5 |
| T27 | public 下旧证据覆盖度 unknown | 不宣称 100%，按策略补证据/阻断 | B2/B6 |
| T28 | 只执行审计模式/无提交权限 | 不执行生产副作用动作 | B6 |
| T29 | 带产物对话收起侧栏后采集「全部」入口 | 侧栏状态被恢复且目标可见，认证档案不被错误状态持续污染 | B1 |
| T30 | AI 回复流式输出、接口延迟、暂态提示条遮挡按钮 | 等待真实完成并稳定截图；遮挡可安全恢复；超时有明确诊断且无重复写入 | B1 |
| T31 | `/password-reset` 合法跳到 `/login?view=reset`，另设真正登录墙 | 前者按声明验证页面状态，后者仍报需登录 | B5 |
| T32 | 待补充会话已消费、Scenario ID 失效、付款服务未配置 | 提示重建前置数据或使用已声明 Fixture，不截错误状态 | B5/B6 |
| T33 | `approve-tasks` 将 YAML 长文本改写为折叠格式 | 按字段修改仍准确，授权和动作变更不静默遗漏 | B6 |
| T34 | `next dev` 写入采集文件且开发指示器开启 | 无持续热更新打断采集，发布截图不含开发指示器 | B6 |

**测试必须断言最终行为和产物**，不能只检查某个函数存在、某 JSON 字段被写入或者某日志出现。必要时检查图片实际几何/像素和 Section 的 ID 级引用。

---

## 11. 版本、迁移、缓存与发布策略

### 11.1 兼容性矩阵

| 输入状态 | 预期策略 |
|---|---|
| 新模型 + 新 Capture + 新 annotation meta | 正常严格校验 |
| 旧模型无 `features` | 兼容读取，显示发现能力未知/待确认，不得虚假显示 Required 100% |
| 旧 Capture 无 annotationCoverage | `unknown`；严格发布须补采或有可信迁移证明 |
| 旧 Sidecar 可重派生但计划旧 | 校验修复前提；若 plan 过期则补采/重建，不能伪造最新覆盖度 |
| 缺失 `.manual/artifacts` | 保留可核验的 Capture/Release 元数据；需要视觉文件时提示重建或明确缺失 |
| UI 名称变化但 feature id 不变 | 保持 ID 引用，重新核对 locator/显示名称，不自动创建新 Feature |
| 历史已发布手册遇到新模型 | 不改写历史证据结论；通过 staleness/更新流程处理 |

### 11.2 缓存版本规则

- 升级会影响**采集语义**的版本时，Capture cache 必须失效或被显式重验。
- 只改**标注主题/布局**时，优先失效 image derivation，而不是强迫重新登录或执行任务。
- 只改**正文样式**时，优先重渲染文档，不应全量重采。
- 基于 Current Model 判断是否 stale，基于 Frozen Capture 判断历史证据当时是否有效；两类判断不可合并。
- 对版本键和忽略目录变化加自动回归测试，避免旧缓存偷偷绕过新门禁。

### 11.3 渐进发布与回滚

建议作为新策略的**实施方案**（不是声称仓库已有对应开关）：

1. **Observe**：先计算新 Coverage 和 Grounding，只记录诊断；不能将这些结果写成“正式严格合格”。
2. **Enforce on fixtures**：对固定测试页/内部试运行启用阻断，验证误报率与真实漏检。
3. **Enforce on public releases**：严格发布启用全部 P0 门禁；保留旧版产物以便回退。
4. **Fallback**：若新门禁误伤，回滚代码/新策略配置并保留原始证据、问题日志，不靠强行 `ok=true` 绕过；涉及隐私/伪证据的问题不得放行。

每批次部署需记录：`commit SHA`、schema/capture/renderer version、测试结果、已知兼容限制以及回滚责任人。

---

## 12. 风险登记与处理

| 风险 | 影响 | 规避方式 |
|---|---|---|
| 审计期间并发修改，计划依据过期 | 重复开发、覆盖代码 | 每批重新核对文件和测试；独立工作树或串行编辑 |
| DOM 候选元素过多导致“必须全标” | 手册杂乱、误阻断 | 基于任务和 Scenario 分级；Undecided 待审核，不自动 Required |
| 关键词检测误伤中文自然语言 | 大量 false positive | 先 review、结合角色/场景证据，逐步严格化，不仅靠 regex |
| Required 强制 100% 导致旧项目无法生成 | 业务中断 | 兼容状态为 unknown；区分开发观察与正式发布；提供补证据路径 |
| 图片绘制位置正确但遮挡实际控件 | 误标 / 误导 | 可见性/裁切检查、golden 测试、复杂图拆分 |
| fixed/sticky 坐标偏移涉及隐私字段 | 隐私泄露 | 隐私校验不可降级；整页/滚动/DPR 必测 |
| 自动重试重复执行写入任务 | 产生副作用 | 写操作保留审批、幂等和不可盲重放策略 |
| 同时存多套 inventory / schema | 数据漂移、调试困难 | 权威单入口，派生索引可重建，跨实体 validateLinks |
| 追求“阶段分数”导致过度重构 | 研发成本失控 | 按缺陷和验收需求落地，已有成熟模块不重写 |
| 跨 OS 字体渲染差异 | Golden 不稳定 | 容差测试 + 几何断言，固定字体环境或屏蔽无意义差异 |

---

## 13. 每批次执行模板（供 Codex / Astra 使用）

将下面模板复制给开发 Agent，每次只替换批次编号，**不要一次性要求实现整份计划**：

```text
请先阅读《Living User Manual Skill｜七阶段完整优化实施计划》及其审计依据。

本次只实施【B__】中的未完成任务。工作前：
1. 只读检查最新 git status、当前分支、未提交变更与相关测试；
2. 对照计划逐项验证问题是否仍存在，记录差异；
3. 不覆盖他人改动，不修改不相关模块，不重构已有稳定架构。

实施要求：
- 按任务 ID 逐项修复，优先复用现有 Capture / Runtime / Planner / Store / Verify；
- 更新必要的 schema / migration / cache revision / docs；
- 为每项新增一正一负的关键验收测试；
- 运行仓库现有的相关测试和最终回归测试；
- 若发现跨批次依赖，只记录阻塞与最小接口，不擅自扩大范围。

完成报告必须包含：
- 任务 ID → 状态（完成 / 部分 / 阻塞 / 未开始）；
- 修改文件及关键函数；
- 调用链或数据链的变化；
- 测试命令、通过数、失败数及原因；
- CLI / JSON / Screenshot / Evidence 的可观察验收结果；
- 旧数据兼容、缓存/版本变更、剩余风险、是否满足本批次 DoD。

若测试失败，不要声称批次完成；优先给出最小修复。不要自动提交或推送，除非我另行明确授权。
```

---

## 14. 批次级 Definition of Done（DoD）

每个批次只有同时满足以下条件才能标记为完成：

- [ ] 所有必做任务已落地；部分项有明确记录和阻塞说明。
- [ ] 每个高风险问题至少有**正例 + 反例**，能证明修复不是“换一个错误码”。
- [ ] 最新单元、浏览器与相关 E2E 测试通过；环境/偶发失败单独说明并复跑验证。
- [ ] 不发生新的静默跳过、伪成功缓存、假 100% 覆盖或未记录失败。
- [ ] 对缓存、持久格式、原图和已发布产物的兼容性影响已经明确。
- [ ] 项目说明、运行日志和 JSON 输出与代码真实行为一致。
- [ ] 没有未经授权地覆盖工作区已有修改或引入不必要新抽象。
- [ ] 在计划里附加对应 PR/提交 SHA、测试证据、结论和待办链接。

### 项目最终发布准入（所有 P0 均必达）

- **功能层**：重点用户任务 Required 功能 Plan/Render/Documentation 覆盖均通过；仍有重要未知功能时不宣称完整。
- **证据层**：每张用于发布的图片能追溯到正确的 Page/Task/Step/Scenario/State；缓存不复用不合格证据。
- **内容层**：操作和结果陈述可核对到真实 UI/断言；未验证文本与已验证操作显著区分。
- **隐私层**：公开图片通过严格隐私校验；full-page、滚动和 fixed/sticky 情况经回归验证。
- **更新层**：依赖改变、手册定义改变能被发现；更新不会静默漏掉相关页面。
- **维护层**：失败能定位到 feature/annotation/section，支持必要的定向修复和重派生。
- **运行层**：CI、跨机器校验、恢复与发布事务能够稳定工作。

---

## 15. 状态追踪表（实施时更新）

| 批次 | 状态 | 开始基线 | 完成提交/PR | 测试记录 | 遗留问题 |
|---|---|---|---|---|---|
| B0 | 完成 | `main@6da5bf7` + 工作区未提交的标注覆盖改动 | 待提交 | unit 全部通过；browser 全部通过（基线 1 个失败 `generate.test.js` 已修复）；`annotation-coverage.test.js` 20 项 | 旧证据 `unknown` 仅提示不阻断（B2-14）；B0-01 发现页面/任务草稿错误顺序与 overflow 已在并发改动中修复 |
| B1 | 完成 | `fa9b500` | 待提交 | unit / browser 全部通过；新增 task-scenario-variant、capture-stability、target-obscured 测试，import-graph / runtime-planner / runtime-runner / auth-cache / scenario-fixtures 增补正反例 | 侧栏等 UI 状态需项目在 `auth.ephemeralStorageKeys` 声明并用 `requires` 断言；网络未空闲只提示不阻断（长轮询页面）；`reply-ready` 语义仍由目标项目的状态断言定义 |
| B2 | 完成 | `8cc2fd1` | 待提交 | unit / browser 全部通过（与并行的 Demo Capture 改动一起跑）；新增 model-links 测试，annotation-coverage 29 项，target-obscured 增加遮挡用例 | Required 只认显式 features，NeoAgent 现有页面需在 describe 中确认候选后才能 public 发布；单图超上限拆图在 B4-02 |
| B3 | 未开始 | 待填 | 待填 | 待填 | 待填 |
| B4 | 未开始 | 待填 | 待填 | 待填 | 待填 |
| B5 | 未开始 | 待填 | 待填 | 待填 | 待填 |
| B6 | 未开始 | 待填 | 待填 | 待填 | 待填 |

**建议立即执行的第一条命令不是修改代码，而是检查最新仓库状态并做 B0-01 的差异核对。** 审计报告已有一批在并发开发中被修复/变动的结论；以最新实现为准，计划不会要求重新造轮子。

---

## 附录 A｜审计问题编号 → 开发批次映射

| 审计问题 | 首要批次 | 说明 |
|---|---|---|
| P0-1 模型编造未被拦截 | B3 | 结合 DOM/ARIA 证据和语义动作校验 |
| P0-2 任务变体采错 Scenario | B1 | 连同缓存和投影隔离修复 |
| P0-3 标注失败证据进入缓存 | B1 | 新旧缓存两侧都检验 |
| P0-4 Required 与 Plan 同源 | B2 | 最初漏标问题的核心根因 |
| P0-5 Import Graph 漏依赖 | B1 | 修复错误 complete 和增量漏更新 |
| P1-1～P1-3 标注错误顺序、作用域/步骤问题 | B0 | 优先稳住已投入使用的采集链 |
| P1-4 warnings 丢失 | B1/B3 | Runtime 先透传，B3 统一质量视图 |
| P1-5 视觉漂移误报 | B4 | 比对层统一 |
| P1-6 标注超限报错 | B4 | 自动拆图 |
| P1-7 fixed/sticky 与隐私偏移 | B4 | 验收时隐私不可跳过 |
| P1-8 文案真实性/未执行状态 | B3 | 严格区分证据等级 |
| P1-9 定义变更与版本失效 | B0/B1/B5 | 版本早修，update 完善放 B5 |
| P1-10 变体投影和覆盖问题 | B1/B5 | 先保正确，再做丰富状态 |
| P1-11 标注元数据未入库 | B2 | 跨机器离线验收 |
| P1-12 发布门禁重算当前模型 | B2 | Frozen evidence 与 stale 分离 |
| P1-13 旧证据/无图绕过发布 | B0/B2 | 先补测试，B2 收紧语义 |
| P1-14 定位无等待、fallback 丢失 | B5 | 定向修复前提 |
| P1-15 全局文件造成过量重采 | B5 | 成本优化 |

## 附录 B｜刻意不做的事项

- 不重写 Playwright 浏览器驱动、Sharp/SVG、Runtime Planner、发布 journal、现有 Git Diff 实现。
- 不把“页面所有按钮”都设为 Required；优先按真实用户任务解释功能。
- 不把模型自评当成唯一覆盖率或事实校验依据。
- 不让模型直接决定像素坐标；坐标仍以真实 DOM/截图几何为准。
- 不为了 7 个阶段都“达到 100%”而无条件新增 Store、数据库或复杂任务框架。
- 不因用户请求完整 Plan，就在没有最新代码复核的情况下认定所有审计缺陷仍然存在。

---

> **本计划的核心次序**：先阻止伪证据和错误缓存（B0/B1）→ 再补齐独立清单与证据链（B2）→ 再保证正文真实（B3）→ 最后提升图片观感、状态覆盖及自动维护（B4/B5/B6）。
