# Living User Manual Skill 七阶段优化进度审计报告

- 审计日期：2026-10-10
- 审计对象：`E:\NeoStar\user-manual`（`living-manual` 0.1.0，Node ≥20.9，CommonJS；依赖 js-yaml、markdown-it 15.0.2、playwright 1.63.0、sharp 0.35.4）
- 审计方式：只读。8 个审计 agent 并行工作（7 个阶段各一个，加 1 个跨阶段架构 agent），由主审汇总并抽查关键结论。
- 基线：`main@6da5bf7` 加上工作区未提交修改。

> **重要说明：审计期间工作区在被并发修改。**
> 审计开始时有 9 个修改文件和 2 个未跟踪项；汇总时变成 28 个修改文件，另有新增的 `src/annotations/store.js` 和 `docs/ANNOTATION_COVERAGE.md`。这些改动来自另一个会话，不是本次审计产生的。
> 下文大部分行号对应 11:15–11:40 的快照。汇总时我对关键结论做了复核，结果是：
>
> | 结论 | 复核状态 |
> |---|---|
> | `page.features` 在持久化时被丢弃 | **已被并发修改修复**（`src/inspect/store.js:129`） |
> | `RENDERER_VERSION` 没有升级 | **已修复**，现为 `sharp-svg-2`（`src/evidence/image-pipeline.js:20`） |
> | `capturePipelineVersion` 没有升级 | 仍存在（`src/runtime/planner.js:67,241` 仍是 `quality-2`） |
> | 页面和任务草稿的错误信息顺序错误，导致 `annotation-coverage-failed` 不可达 | 仍存在（`page-usecase.js:109-113` 在第 69 行之前抛出；`task-draft.js:48` 在第 22 行之前报错） |
> | 任务 Scenario 变体在 runtime 中被丢弃 | 仍存在（`runtime/handlers.js:283`） |
> | import 图漏掉带点号的模块名 | 仍存在（`src/inspect/import-graph.js:201,246`） |
> | 没有 target 的 guide 默认被判为 required | 仍存在（`src/annotations/coverage.js:25`） |
> | 隐式动作标注的 label 固定为 `'1'` | 仍存在（`coverage.js:66`） |
>
> 工作区仍在变化。实施前请按本文的"验收标准"重新确认。

---

## 1. 总体进度仪表盘

| 阶段 | 完成度 | 当前状态 | 主要缺口 | 优先级 |
|---|---|---|---|---|
| 1. 标注完整性 | **43%**（4.75/11） | 主干已接上：Required 漏标时不出发布图，生成和发布被阻断。覆盖率代码大部分是未提交改动 | Required 清单与标注计划都来自 guide，覆盖率等于"自己核对自己"，查不出重要功能漏标；编号与正文 ①②③ 的对应没有校验；没有 target 的 guide 和非默认 Scenario 会被误判为失败；旧证据和 `--no-screenshot` 可以绕过 | **P0** |
| 2. Scenario 联动 | **47%**（3.75/8） | 页面 Scenario、Fixture、多身份可用；交互状态只能经任务步骤到达 | 任务 Scenario 变体在 runtime 中按默认 Scenario 执行，却登记在变体的缓存键下；页面没有 setup 前置动作；多个 Scenario 字段没有消费者；Empty 状态没有判定 | **P0** |
| 3. 智能修复 | **56%**（5/9） | 有界重试、resume、恢复、rederive 都完整；"漏标修复"本身尚未开始 | 标注失败的截图会作为成功写入缓存并被复用；失败后不会自动补采、重定位或重派生；回退定位命中的信息被丢弃；错误信息指向错误原因 | **P0** |
| 4. 视觉优化 | **35%**（3.5/10） | 集中配置主题、按 DPR 换算坐标、编号和边框原子绘制（未提交） | 没有碰撞和遮挡检测，不会自动拆图；标注超过 5 个时整次采集失败，且错误被改写成 `navigation-failed`；在线视觉校验对有标注的页面必然误报；fixed/sticky 元素在整页截图中坐标偏移 | P1 |
| 5. 内容质量 | **56%**（5/9） | 任务式指南链路完整，步骤、截图、结论由程序渲染，模型只填说明 | 模型在文案中不加「」就能写出不存在的按钮和功能，校验照样放行（已实测）；没有核对 DOM 文本；质量警告只写到 stderr，不阻断，也不进入 JSON；未执行的步骤与已验证步骤在正文里无法区分 | **P0** |
| 6. 增量更新 | **60%**（6/10） | Git diff 与快照、影响分析、按目标增量重建、三方合并都已接通 | import 图漏掉 `x.client`、`x.utils` 和 `export * as`，却仍报 complete；`.manual/` 下的定义和配置改动不被 update 发现；改动 lockfile 会导致全量重采；漂移报告不回流到 update；`generate` 不刷新指纹 | **P0** |
| 7. 自动化质量 | **67.5%**（6.75/10） | 79 个测试文件，CI 覆盖 Ubuntu 与 Windows；错误分类、事件日志、恢复和幂等都完整 | 没有统一的质量报告；内容质量指标只做警告；新增的标注发布门槛没有测试；CI 不含 macOS；页面分析和任务审批离不开宿主或人工 | P1 |

### 完成度计算方法

- 每个阶段按任务书列出的检查项逐项判定：
  - 完整实现 = 1
  - 部分实现 = 0.5
  - 只有基础设施（代码或字段存在，但没有接入链路或没有消费方）= 0.25
  - 未实现 = 0
- 完成度 = 得分 ÷ 检查项总数。
- Unknown 项计入分母、不计入分子，并单独注明。本次只有阶段 7 有两个子项是 Unknown："修复阶段回归测试"的含义，以及 macOS 上的实际表现。两者都已折算为"部分实现"。
- 判定依据是"能否在实际执行链路中生效"，不是"代码是否存在"。
- 未提交的代码按工作区现状计入，但相关风险会单独列出。
- 七个阶段等权平均约为 **52%**。

---

## 2. 系统现状

### 2.1 命令（`src/cli/commands.js:23-48`，共 24 个）

| 分组 | 命令 |
|---|---|
| core | init、inspect、describe、auth、generate、update、verify、site、doctor |
| task | task-guide、discover-tasks、approve-tasks、review-task |
| run | status、resume |
| advanced | capture、plan-capture、capture-task、publication、gc、migrate |
| legacy（不显示在帮助里） | run-submit、generate-task、migrate-artifacts，以及 `generate <page> --draft/--finalize` |

### 2.2 模块地图（行数 / 文件数）

| 目录 | 规模 | 职责 |
|---|---|---|
| commands | 3839 / 24 | 命令入口 |
| runtime | 2568 / 14 | 编排：planner、runner、handlers、store |
| generate | 2217 / 16 | FactPack、渲染、合并、Section 模型 |
| inspect | 1972 / 11 | Next.js 扫描、import 图、指纹 |
| browser | 1379 / 6 | 浏览器驱动 |
| store | 1372 / 5 | 存储层 |
| evidence | 1350 / 8 | 截图、派生、证据 |
| config | 1221 / 8 | 配置 |
| tasks | 1211 / 9 | 任务 |
| model | 990 / 4 | 数据模型 |
| publication | 842 / 5 | 发布 |
| 其他 | — | verify / update / site / auth / scenarios / cache / privacy / annotations（新增）等 |

### 2.3 产物

- **入库**：`.manual/config.yaml`、`project.yaml`、`pages/`、`tasks/`、`scenarios/`、`evidence/captures/*.json`、`releases/`、`index/`、`feature-inventory.json`（新增）、文档目录与 `images/annotated/`。
- **不入库**：`.manual/artifacts/`（raw、sanitized、derivation、**annotations**、**manifests**）、`runs/`、`drafts/`、`cache/`、`verifications/` 等。
- `merge/` 和 `migrations/` **没有**被加入 gitignore（`src/config/render.js:229-247`）。

### 2.4 测试

- 共 79 个测试文件：unit 组 51 个，browser 组 28 个。端到端验收测试有 gate0–3、task-first-e2e、install-smoke。
- unit 组实际运行结果：415 通过，1 失败。失败的是 `finalize-safety`，子进程在 Windows 上以 `0x80000003` 退出；单独重跑 10/10 通过，判定为偶发失败。
- 审计中途 `image-pipeline` 曾有 3 个用例失败，`gate2/gate3` 也曾失败过一次（`stateDirAbs is not defined`）。后来的并发修改修好了这些问题，单独重跑时全部通过。
- CI 配置在 `.github/workflows/manual-tests.yml`：矩阵为 ubuntu 和 windows × Node 20.19 和 22.14，依次运行 doctor、unit、browser。

---

## 3. 各阶段详细审计

### 阶段 1：标注完整性闭环（43%）

#### 实际执行链路

**页面路径：**

```
manual capture <page>
  → capture-page.capturePage
  → buildInventory        (annotations/coverage.js:10-35)
  → 按 Scenario 过滤      (capture-page.js:172)
  → buildPlan             (默认 Scenario 取 page.guide；其他取 checkpoint.capture.annotations；coverage.js:38-65)
  → captureStable(resolveTargets 逐项定位，失败时记录 reason)
  → derivePublished       (capture-safe.js：layoutAnnotations → renderAnnotationResults → verifyCoverage
                           → 覆盖不通过则 published = null)
  → annotations.json 产物 + record.annotationCoverage
  → generate：page-usecase 读取 published / 发布门槛 validate.js:157-176 复核覆盖率
```

**任务路径：**

```
capture-plan
  → executor.takeScreenshot
  → 每个步骤各自 buildInventory / buildPlan
  → 同一个 derivePublished
  → task-draft
```

#### 逐项结论

| # | 检查项 | 判定 | 证据与问题 |
|---|---|---|---|
| 1 | 独立的 Feature Inventory | 部分 | `coverage.js:10-35` 合并四个来源：features、guide、detectedActions、task.steps。`annotations/store.js:7-24` 写 `.manual/feature-inventory.json`。但这个文件没有消费方（采集和发布都不读它），并且写在 commit 之后、try 块之内：写入失败会报 `model-commit-failed`，模型却已经提交了 |
| 2 | 稳定的 feature_id | 部分 | guide 和 step 派生的 id 稳定。detectedActions 的 id 是 `sha12(文案)`，文案一改就变（`coverage.js:27`）。显式的 `feature_id` 不符合安全 slug 规范（`schema.js:273-287`），而且用 snake_case，和全库命名风格不一致。持久化丢字段的问题**已修复**（`inspect/store.js:129`） |
| 3 | Required / Optional / Skip 分级 | 部分 | 支持四个级别。只有 required 计入覆盖率，optional 和 skip 没有任何差别化处理，undecided 只产生 warning |
| 4 | 独立的 Annotation Plan | 部分 | `buildPlan` 存在。但默认 Scenario 的计划就是 guide 的逐条映射，没有可单独审阅、编辑或审批的计划 |
| 5 | 能否发现没进入计划的重要功能 | 仅基础设施 | 页面的 Required 来自 guide，计划也来自 guide，所以 `missing-from-plan` 在页面路径上几乎不可能触发。采集阶段从不传入 `discovered`（`capture-safe.js:95`），`missing-from-inventory` 是死代码。发布阶段的 `discoveredForCapture` 只是陈旧性检测。完全没有基于 DOM 或无障碍树的功能发现 |
| 6 | 定位和绘制是否逐项记录 | 部分 | `capture-page.js:211-226`、`executor.js:38-55` 逐项记录定位结果，`image-pipeline.js:87-94` 记录 `located / outlined / intersects / drawn / reason`。但 `drawn` 是几何预测，不是像素核对；`located` 恒为 true；`outlined` 和 `intersects` 重复。hover 冲突、超过数量上限时整次采集抛错，不会逐项记录 |
| 7 | 边界、定位失败、绘制失败检测 | 部分 | 能检测完全在图外（`outside-image`）和编号在图外（`marker-outside-image`）。**检测不到部分裁切**（只要 1px 可见就算 drawn），也检测不到遮挡或被隐私马赛克覆盖 |
| 8 | 标注与正文说明对应 | 未实现 | 编号只靠约定：图上是计划下标 i+1，正文是 guide 下标 i+1（`render.js:225`）。没有校验器。`description-missing` 只检查非空，guide 的 instruction 本就必填，所以这项检查基本恒通过。两条 guide 标题相同时 feature_id 会冲突 |
| 9 | Required 覆盖率是否接入链路 | 部分 | `verifyCoverage` 已接入采集、rederive 和发布门槛三处，统计口径是 Required 功能，和任务执行覆盖率是两回事。但分母等于 guide，指标偏乐观 |
| 10 | Required 漏标能否阻止发布 | 部分 | 覆盖失败 → 不出发布图 → generate 失败，这条链路成立。但有以下缺口：`manual capture` 仍返回退出码 0；`--no-screenshot` 完全绕过；旧证据（没有 `annotationCoverage`）直接放行（`validate.js:163`）；页面路径先报"只有未经隐私处理的原始截图"，真正原因被掩盖 |
| 11 | 从原图重派生 | 部分 | `rederive.js:54-80` 会重算覆盖率。但只有隐私、主题或渲染器变化时才会触发；计划变化不会触发；重派生时用的是冻结的旧计划 |

#### 风险与问题

- **P0：覆盖率自己核对自己。** Required 清单与标注计划同源（都来自 guide），所以"重要功能漏标"永远查不出来。
- **P1：没有 target 的 guide 被判为 required。** 结果是 `target-not-declared`，整页没有发布图。而 schema 允许 guide 不写 target，渲染层的注释也明确这样用（`render.js:225`）。
- **P1：非默认 Scenario 的页面必然失败。** 清单里包含默认 guide 的 required 项，计划却只包含 checkpoint 声明的项，于是只要页面有 guide 就一定 `missing-from-plan`。
- **P1：任务步骤自动补的动作目标标注是 required。** 截"操作后"的图时，目标如果已经消失（提交按钮、已关闭的弹窗），步骤就没有图。
- **P1：页面 feature 的 `task_ids` 粒度是任务，不是步骤。** `capture-plan.js:116` 把它注入到每个步骤里，而一旦 feature 能正确持久化（现在已修复），每张步骤图都会因 `missing-from-plan` 失败。架构 agent 在内存里实际跑过，结果证实了这一点。
- **P1：** 发布门槛用"当前模型"重算清单（`validate.js:93-110`），已经发布的文档会被后来改动的模型判失败；Capture 记录为 null 时则静默通过。
- **P1：`annotations.json` 放在被 gitignore 的 `.manual/artifacts/` 下。** 换一台机器或重新 clone 后，`verify --artifacts` 会报 `annotation-metadata-invalid`。

#### 可复用模块

- `annotations/coverage.js`（纯函数）
- `renderAnnotationResults` / `toImageRect`
- `capture-safe.derivePublished` 里的"覆盖率决定是否出图"结构
- `annotations` 产物的内容寻址与完整性校验
- `rederive` sidecar v2

#### 推荐改造与验收标准

1. **清单与计划解耦。** Required 只来自显式 `features`，或经过 describe 确认的条目。guide 只作为计划来源；没有 target 的 guide 降级为 optional。
   - 验收：页面声明了 required 功能 X，而 guide 里没有 X，此时 capture 记录 `X:missing-from-plan`，generate 被阻断；没有 target 的 guide 页面仍能出图。
2. **Scenario 作用域。** 非默认 Scenario 只纳入 `scenario === 当前id` 的功能，或纳入计划里显式引用的功能。
   - 验收：有 guide 的页面，其空态变体能出图。
3. **任务标注降级与步骤粒度。** 自动补的动作目标标注改为 optional；页面 feature 增加 `step_ids`，或改为按 target 匹配，不再注入整个任务。
   - 验收：提交按钮在"操作后"截图中消失时，仍出图并给出 warning；第 3 步的图标为 ③。
4. **编号对应校验。** `annotations.json` 记录 `label → guide.id / feature_id`；`validatePublication` 比对正文中的块 id。
   - 验收：调换 guide 顺序但不重新采集时，报 `annotation-label-mismatch`。
5. **门禁收紧。** capture 覆盖失败时返回非零退出码；public audience 下旧证据必须重新采集；修正 `page-usecase` / `task-draft` 的报错顺序；Capture 记录为 null 时报错；发布期只校验 Capture 内冻结的 annotations 是否自洽。
   - 验收：`generate --json` 的错误码为 `annotation-coverage-failed`，并列出 `feature_id:reason`。
6. **边界检测。** 可见比例低于 80% 时记为 `partially-clipped`；与马赛克区域重叠时报告。

---

### 阶段 2：Scenario 采集联动（47%）

#### 实际执行链路

- **页面：**
  ```
  capturePage
    → resolveScenario(derivePageScenario / 显式文件)
    → resolveEntryLocation
    → prepareScenarioData(Fixture)
    → prepareAuth(scenario.authProfile)
    → installRoutes → open → waitUntilReady
    → validateNavigation → runAssertions
    → captureStable → derivePublished
  ```
- **任务：**
  ```
  captureTask
    → deriveTaskScenario
    → buildCapturePlan
    → executor 逐步执行：requires → before → 动作 → waitUntilReady → after → 截图
  ```
- **Runtime：** planner 生成 `fixture-setup → capture → fixture-cleanup`。

#### 逐项结论

| # | 检查项 | 判定 | 证据与问题 |
|---|---|---|---|
| 1 | Default / Modal / Dropdown / Tab / Hover | 部分 | 页面只能截默认状态：`page.states` 只有断言、没有到达动作；`scenario.setup` 没有任何消费方（`scenarios/model.js:110`）。Modal 等状态只能靠任务步骤（`click/hover/...`，`playwright.js:629-643`）到达。需要 hover 才显示的标注目标会被自动唤出（`playwright.js:599-627`），并做冲突检测 |
| 2 | Loading / Error / Empty | 部分 | 有 mock / hook Fixture 和环境策略（`fixtures.js`、`policy.js:187-206`）。Loading 和 Error 用启发式判定（`validate-page.js:106-119`）。**Empty 没有任何判定**。mock 不支持延迟或挂起，无法稳定复现 Loading。任务路径不消费 `expected`（`capture-plan.js:132-140`） |
| 3 | 不同权限与角色 | 部分 | 每个 Scenario 可以指定 authProfile，并使用独立的 Context（`auth/runtime.js:17-60`）。但 `identityAssertions` 是全局的，无法按角色断言 |
| 4 | 页面截图是否读取 Scenario 的标注配置 | 部分 | 变体能读到配置。但 `page-<id>.yaml` 显式覆盖时，断言和标注被 `isDefaultScenario` 分支忽略，`expected` 却仍然生效（`capture-page.js:166-173`）。`checkpoint.capture.mode` 没有消费方 |
| 5 | Task 与 Page 采集是否共用状态模型 | 部分 | 共用 resolveScenario、Fixture、Auth、断言、captureStable、coverage。不共用的是：任务 Scenario 的 checkpoints 和 expected 不被执行器读取；页面无法复用任务步骤来到达某个状态 |
| 6 | 定义了但没执行的 Scenario | 仅基础设施 | 以下内容没有消费方：`setup`、`capture.mode`、`checkpoint.state/afterStepId`（页面）、`entry.routeBindingId`、任务 `expected`、任务 checkpoints、`task.fixtures`、`task.branches`。**任务变体 Scenario 整个没有被执行**。`planner.js:114,117` 遇到损坏的变体文件会静默 `continue` |
| 7 | 交互状态能否稳定重放 | 部分 | 有 8 步就绪等待、reducedMotion、有界断言轮询、`waitForQuiet`（新增）、几何重试。但截图前定位标注可能移动指针，破坏 hover 状态；截图前不会重新断言 expectedState |
| 8 | 截图与 DOM 位置是否一致 | 部分 | 有截图前后的几何快照对比，并在截图时刻重新定位。缺少截图后的复核；纯 CSS 变化（`:hover` 失效）观察不到；页面路径不会把视口外的目标滚动进来 |

#### 风险与问题

- **P0：任务变体执行了错误的 Scenario，产出伪证据。**
  - 问题：`runtime/handlers.js:283` 调用 `captureTask(...)` 时没有传入 `current.scenarioDefinition`，`capture-usecase.js:218-219` 因此只会解析出 `<task>-default`。
  - 后果：`scenario:<任务变体>` 实际以默认身份、真实数据、默认入口运行，mock 路由不会安装；而结果通过 `writeCaptureCache` 登记在**变体**的 captureKey 下，之后会一直命中这份伪证据。
  - 现状：没有测试覆盖。
- **P1：** 页面变体在缓存命中时会覆盖默认页面的投影（`handlers.js:222-231` 的 `restoreProjection` 不判断 `subject.scenarioId`），默认页面的 `latestCaptureId` 会被改成变体截图。直接采集路径有保护，复用路径没有。
- **P1：** `page-<id>.yaml` 显式覆盖只部分生效，用户以为配置生效了，实际没有。
- **P1：** 变体的标注清单混入了默认 guide 的 required 项（见阶段 1）。
- **P2：** Empty 状态没有判定；角色无法用断言区分；变体证据没有进入手册的出口；`verify --live` 只回放默认 Scenario。

#### 可复用模块

`resolveEntryLocation`、`prepareScenarioData`、`prepareAuth`、`session.withScenario`、`validateNavigation`、`runAssertions`、`captureStable`、`confirmTargetsShown`、`provider.performAction` / `inspectTarget`，以及 `executeCapturePlan` 的步骤循环（可以抽出来作为页面 setup 的执行器）。

#### 推荐改造与验收标准

1. **修复 P0。**
   - 做法：`captureTask` 增加 `scenario` 参数，`handlers.js:283` 传入 `current.scenarioDefinition`；采集变体时不更新任务的默认投影。
   - 验收：新增任务变体测试（mock 路由 + 匿名身份），断言 `record.scenarioId` 等于变体 id、`provenance.mode === 'simulated'`、任务的 `lastCapture` 不变。
2. **`restoreProjection` 对 scenarioId 提前返回。**
   - 验收：在缓存隔离测试之后，页面的 `latestCaptureId` 保持不变。
3. **页面 setup 前置动作。**
   - 做法：`scenario.setup: action[]` 复用 `validateAction` / `performAction`，并用 checkpoint 断言确认已到达目标状态。
   - 验收：Modal、Tab、Dropdown、Hover 四个夹具页面各自产出变体截图，且标注落在弹层内。
4. **为每个"无消费方"字段接上消费方，或从 schema 中删除。**
   - 验收：每个字段都有一条"写了就改变行为"的测试。
5. **补齐 Empty 判定与 Loading 复现。**
   - 做法：Empty 要求至少一条非 url 断言；mock 支持 `delayMs` / `hold`。
6. **截图后复核。**
   - 做法：截图后重新跑 expectedState，并检查目标是否仍然可见。
   - 验收：用"hover 菜单消失"的夹具测试，结果应当报错，而不是产出空框。

---

### 阶段 3：智能漏标修复（56%）

#### 实际执行链路

失败时只有两条路：

- **修改模型 → captureKey 变化 → 整个主体重新采集。**
- **修改主题、隐私或渲染器 → planner 插入 `derive-image` 节点 → 走 `rederive`。**

这两类输入都没变的情况下，缓存会直接命中，复用的就是那次失败的采集结果，此时只能用 `--refresh` 强制全量重采。

#### 逐项结论

| # | 检查项 | 判定 | 证据与问题 |
|---|---|---|---|
| 1 | 结构化的失败原因 | 部分 | 有 `verifyCoverage.failures[{feature_id, reason}]`；定位与渲染的结果按项记录；`browser/errors.js` 里 22 个 REASON 都配了 HINT。不足：`reason` 只是自由字符串，没有枚举也没有大类；`annotation-hover-conflict` 和 `annotation-layout-failed` 直接抛异常；所有 `annotation-*` 错误码都不在 POLICIES 和 HINTS 里 |
| 2 | 区分定位、绘制、不可见、状态缺失 | 部分 | `target-not-visible`（`playwright.js:566`）把"不存在"和"不可见"混成一类；状态缺失（`state-assertion-failed` 等）发生在步骤层就中止了，进不了覆盖结果；plan、inventory、description 三类失败和绘制失败混在同一个数组里 |
| 3 | 基于原图和坐标重派生 | 部分 | `planner.js:359-367` → `handlers.js:326` → `rederive.js` 这条链完整，测试也覆盖了。但它没有接入修复流程：覆盖失败不会触发；沿用的是冻结的旧计划；也没有 CLI 入口。`migrate-artifacts` 和这件事无关 |
| 4 | Locator 重新匹配 | 部分 | `target.alternatives` 最多支持 5 个人工预设的备选定位，`uniqueVisibleLocator` 会依次尝试（`playwright.js:554-566`）。但没有自动重新匹配；`lastResolution.fallback`（`:626`）被采集方丢弃；定位是即时的 `count()`，不等待元素出现 |
| 5 | 缺失 Scenario 的定向补采 | 部分 | 支持 `page:` / `task:` / `scenario:` 目标寻址，只重采缓存未命中的部分。但任务只能整条重跑，不能只补一个步骤；覆盖失败也不会自动换算成补采目标 |
| 6 | 自动重试与上限 | **完整** | `retry.js`：只重试 `policy=retry` 的情况，最多 3 次，退避 1s/3s；`captureStable` 内部还有 3 次；有 Run 预算和单任务超时；写操作任务 `maxAttempts:1`。测试：failure-matrix 17/17，runner 11/11。**但这套机制完全不覆盖标注失败**，因为覆盖失败时 handler 返回的是"成功" |
| 7 | 避免重复执行整个任务 | 部分 | 有 resume、`reconcileCapture`、四类缓存键、`derive-image`。但失败的截图会进缓存，复用粒度只到主体 |
| 8 | 明确报告无法修复的异常 | 部分 | 有 `annotations.json`、`ready.warnings`、发布门槛复核、`rederive-unavailable`。但 runtime 会丢掉 handler 返回的 warnings（`runner.js:473-475`），页面和任务两条路径的错误提示都指向错误原因 |
| 9 | 防止无限重试和把错误当成功 | 部分 | 无限重试已经杜绝；发布图有三重兜底。但采集任务会被记为 `succeeded`，`browser.verified=true`，退出码为 0，失败结果还会写进缓存；v1 sidecar 重派生时 `coverage=null`，等于跳过了校验 |

#### 风险与问题

- **P0：覆盖失败的截图被写入缓存并被复用。**
  - 位置：`handlers.js:211-219` 的 `writeCaptureCache` 只看隐私检查和 scopes；`cache/lookup.js:41-96` 不检查 `annotationCoverage`。
  - 后果：偶发的标注失败（比如目标渲染慢了）会被固化下来，之后每次 generate 都会失败，只能 `--refresh` 全量重采。这和本阶段"降低重复采集成本"的目标正好相反。
- **P1：错误提示误导。** `page-usecase.js:109` 和 `task-draft.js:48` 会先报"缺少发布图 / 需要 annotated 目录"，真正的原因 `annotation-coverage-failed` 根本走不到（汇总时复核，问题仍存在）。
- **P1：runtime 丢失 warnings。** generate、update、`capture scenario:` 三条路径都看不到覆盖失败。
- **P1：** 定位没有等待也没有重试，再叠加上面的 P0，一次瞬时失败就会变成永久失败。
- **P1：** 回退定位命中的信息被丢掉，模型永远不会被修正，后续想做"智能修复"也就没有数据可用。
- **P2（建议升为 P1）：** `capturePipelineVersion` 仍是 `quality-2`；v1 sidecar 重派生会跳过覆盖校验。这两点叠加 `RENDERER_VERSION` 已升到 `sharp-svg-2` 的改动，会出现以下情况：所有命中缓存的旧截图在下次规划时都会走 `derive-image`，但它们没有 inventory，所以 `coverage = null`，标注覆盖门槛对这批旧图实际不生效。

#### 可复用模块

- `coverage.js`、`annotations.json` / sidecar v2
- `rederive.js` + `handlers.deriveImage`
- `retry.decideRetry` 与 runner 的预算机制
- `recovery.js`
- `cache/lookup.js` 的 miss 原因体系（可以直接扩展）
- `uniqueVisibleLocator` / `inspectTarget`
- `resolve-target.js`

#### 推荐改造与验收标准

1. **缓存挡住失败结果。**
   - 做法：缓存摘要里记录 coverage 状态；`lookup` 遇到 `annotationCoverage.ok === false` 时返回 miss，原因记为 `annotation-incomplete`。
   - 验收：不改模型再跑一次 generate，plan 显示 `capture-required:annotation-incomplete`。
2. **把正确的原因传出去。**
   - 做法：`page-usecase` / `task-draft` 先检查 `annotationCoverage`，再检查是否有发布图；handler 返回 warnings，runner 把它写进事件；HINTS / POLICIES 登记所有 `annotation-*` 错误码。
   - 验收：页面和任务两种目标下，`generate --json` 的错误码都是 `annotation-coverage-failed`。
3. **给失败原因分大类。**
   - 做法：增加 `category`，取值为 locate / visibility / draw / plan / inventory / description / state；把 not-found 和 not-visible 拆开。
4. **定位等待与回退记录。**
   - 做法：有界地等待目标出现（如最多 2 次 × 500ms）；把 `resolution` 写进 `annotations.json`；回退命中时给出 warning `locator-fallback-used`。
   - 验收：目标延迟 300ms 出现时能成功；用 `alternatives[1]` 命中时，记录里有 `fallback:true`。
5. **修复规划。**
   - 做法：如果全部是绘制类失败（marker 超限、超出图片范围），且当前主题能解决，就走 `derive-image`；否则走 `capture`；同一个 key 连续 N 次失败，则转为 `waiting_input / annotation-unrepairable`。
   - 验收：在 failure-matrix 中新增用例"连续 2 次失败后进入 waiting_input"。

---

### 阶段 4：视觉标注质量优化（35%）

#### 实际执行链路

```
resolveTargets(boundingBox，整页模式再加 scroll)
  → captureStable
  → planRedactions
  → layoutAnnotations          (artifacts/annotation.js:3-22，固定规则：编号放框左侧 5px，放不下就换到右侧)
  → renderAnnotationResults
  → deriveImages               (maskSvg → annotationSvg → sharp 合成)
```

#### 逐项结论

| # | 检查项 | 判定 | 证据与问题 |
|---|---|---|---|
| 1 | 统一的视觉规范 | 部分 | `config/annotation.js:3-16` 做了集中配置和校验。但 `image-pipeline.js:75-81` 里仍写死了光晕宽 10、字号 16、白描边、Arial；`primaryDark`、`labelBackground`、`labelText`、`focusMask`、`fallbackColor` 和布局里的 `line` 字段都没人消费；字号不随 `markerSize` 联动；label 长度没有限制 |
| 2 | 编号是否按操作顺序 | 部分 | 页面图的编号等于 guide 的书写顺序，任务图的编号是步骤内序号。现在**每张任务图都从 ① 开始**（隐式标注时 label 固定为 `'1'`，`coverage.js:66`）。Scenario 过滤后，图上编号会和正文编号错位 |
| 3 | 编号与边框重叠检测 | 未实现 | 没有任何碰撞检测 |
| 4 | 避免遮挡重要内容 | 未实现 | 编号固定放在左侧，会压住相邻的标签；`focusMask` 没有实现 |
| 5 | 元素靠近截图边缘 | 部分 | 支持左右换位、垂直方向夹紧、`toImageRect` 裁剪。不支持上下换位，也不会把目标滚动进视口；部分裁切仍判为 drawn；坐标夹到 0 时右边和下边会多出 padding |
| 6 | 复杂页面拆成多张截图 | 仅基础设施 | 任务天然一步一图。超限或 hover 冲突时只会报错，不会自动拆图 |
| 7 | 单张截图的标注密度 | 部分 | `maxMarkersPerImage` 默认 5，但**超出时整次采集失败**，而且错误码 `annotation-layout-failed` 被 `capture-page.js:275-277` 改写成了 `navigation-failed` |
| 8 | DPR / Viewport / 滚动坐标 | 部分 | 视口坐标、文档坐标、DPR 的换算是正确的，真浏览器测试覆盖了 DPR=1、DPR=2 和整页模式（但只验证了打码，没验证标注）。存在的缺陷：整页截图中 fixed/sticky 元素在滚动后坐标偏移，**隐私打码同样受影响**；没有核对 `图片尺寸 ≈ canvas × dpr`；`boundingBox()` 为 null 时坐标变成 NaN，最后被误报为 `outside-image` |
| 9 | 编号显示但边框没画上 | 部分 | 已提交的 HEAD 中存在孤立编号的 bug；工作区（未提交）已改为框和编号原子绘制（`image-pipeline.js:73`）。但 drawn 仍是几何推断，计算 drawn 和实际绘制用的是两份重复逻辑 |
| 10 | 视觉回归测试 | 仅基础设施 | `visual-diff.js` 已实现并接入 `verify --live`。但**基线是带标注的图，当前图却没有标注**（`live.js:72` 没有传 `resolveTargets`），所以有标注的页面必然报 visual-only 漂移。没有任何标注渲染的 golden 测试 |

#### 风险与问题

- **P1：** 在线视觉校验必然误报。
- **P1：** 超过 5 个目标时整次采集失败，错误码还被改写。
- **P1（隐私）：** 整页截图中 fixed/sticky 元素的打码会偏移。
- **P1：** 图上编号和正文编号可能错位。
- **P2：** 编号之间、编号与框之间互相重叠或遮挡；目标占满整宽时编号会压进框里；字号写死。

#### 可复用模块

`toImageRect`、`renderAnnotationResults`（可以扩展记录 overlap 信息）、`captureStable`、`compareImages` / `applicableMasks`、`rederiveCaptures`（布局算法改动后可以批量重绘）。

#### 推荐改造与验收标准

1. **修复在线视觉校验。**
   - 做法：`pageDrift` 复用基线 sidecar 里的 plan 和 `resolveTargets`；或者两边都改为比较未加标注的 sanitized 图。
   - 验收：页面没有任何改动时，连续两次运行都得到 `visual.status === 'same'`。
2. **带碰撞检测的布局。**
   - 做法：编号候选位置依次尝试 左 → 右 → 上 → 下 → 框内角；与所有框、所有编号、所有打码区域做相交检测；放不下的记为 `overlap`。
   - 验收：五种情形（相邻目标、贴左边、贴右边、贴上边、整宽目标）下，编号互不相交。
3. **超出上限时拆图，不再失败。**
   - 做法：按 `maxMarkersPerImage` 分组，生成 `part-N`；把 `annotation-*` 加入 REASON，不再被改写成 `navigation-failed`。
   - 验收：7 个目标生成 2 张图，编号为 1–5 和 6–7，并与正文一致。
4. **视觉参数全部收进主题。**
   - 验收：用 grep 检查 `image-pipeline.js`，不再出现写死的颜色或尺寸。
5. **坐标自检。**
   - 做法：核对 `|meta.width − canvas.width×dpr| ≤ 1`，否则报 `geometry-scale-mismatch`；处理 rect 为 null 的情况；fixed 元素单独处理，或截图前先回到顶部。
   - 验收：在 DPR 1、1.5、2 加整页加滚动的组合下，框中心像素都落在目标元素内。
6. **新增小尺寸标注渲染 golden 测试**（带容差比对）。

---

### 阶段 5：手册内容质量优化（56%）

#### 实际执行链路（任务主路径）

```
generate task:<id>
  → approve
  → auth-check
  → capture        (Playwright 回放；before/after 断言；风险边界之后的步骤记为 not-executed)
  → draft          (checkEvidenceUsable → buildTaskFactPack(+taskQuality) → renderTask)
  → rewrite        (model-request → waiting_input → resume --request → model-response 白名单校验)
  → validate       (draft 新鲜度 → validateCopy → 三方合并 → validateTaskFinal → validatePublication)
  → publish
```

#### 逐项结论

| # | 检查项 | 判定 | 证据与问题 |
|---|---|---|---|
| 1 | 按用户任务组织手册 | **完整** | `SKILL.md:41-52` 和写作规范都把任务指南定为主形态；`task-guide → discover-tasks → approve-tasks → 回放 → FactPack → renderTask` 链路完整；`task-first-e2e` 覆盖了全链路。不足：没有 guide 的页面仍可以发布"主要功能"清单，只给一条 warning |
| 2 | 前提、步骤、预期结果 | 部分 | 有 preconditions、程序生成的动作句（`render.js:105-111`）、按证据分级的完成判断（`claims.js`）、readerChecks、branches。**步骤级没有 expected 字段**（`schema.js:327-345`）；前提缺失只给 warning |
| 3 | Step → Screenshot → Annotation → Section | 部分 | step.id 从头到尾都用 ID 关联；Section `step.<id>` 带 captureRefs。Annotation 与 Section 之间没有 ID 级引用；**completion 章节的 captureRefs 恒为空**（`manual-model.js:50` 取的是 `e?.captureId`，但 claims 的 evidence 里没有这个字段，已实测） |
| 4 | 每一步都有页面证据 | 部分 | 执行过的步骤有精确 role/name 定位和前后断言作为证据。**未执行的步骤（风险边界之后）在正文中和已验证步骤完全一样**；声明了 capture 却缺图时只给 warning；回退定位命中后，正文仍然用主定位的名称 |
| 5 | 按钮、字段名称的真实性 | 部分 | 动作句里的「X」来自 `target.name`，并经过真实定位，可信。但**没有采集页面可见文本清单**；`allowedUiTerms` 来自 instruction、purpose、guide 这些人写或模型写的文本（`fact-pack.js:102,130`），只能保证"自洽"，不能保证"真实" |
| 6 | 步骤遗漏、图文不匹配、重复 | 部分 | 正文与 FactPack 的步骤 id 列表锁定，缺漏会阻断；图文时机或目标不匹配只给 warning；没有检查图注和画面是否一致；没有跨章节的重复检测 |
| 7 | 自然、非技术化的中文 | 部分 | `lintProse` 已在文案块、模型响应、describe 处阻断。但任务的读者字段只给 warning；`detectedActions` 完全没检查，却会进入正文；规则只有 4 条 |
| 8 | 模型编造的风险 | 部分 | 结构上的约束很强：模型只能填白名单里的块，块里不能有标题/图片/列表，否定动作会被拦，数字和承诺需要 review，`inputHash` + CAS 防串改。**漏洞：不加「」就能写任意功能**。实测 `validateCopy(pack, {'step.open':'然后点击右上角的导出按钮，系统会生成 PDF 报告并发送到邮箱。'})` 返回 `ok:true`，没有任何 blocked 或 review；`model-request.js:68` 还鼓励模型补写"点了之后会看到什么"；`detectedActions` 和 purpose 由模型推断后直接进入正文 |
| 9 | 质量评分与门禁 | 部分 | 事实一致、文案 blocked、claim 等级、标注覆盖、隐私这些门禁会阻断。但 `taskQuality` 的 7 项检查和全部 warnings 只写到 stderr（`handlers.js:373,377`），不进 JSON（`run-report.js:48` 只取 `completion-*`）；没有数值评分，也没有阈值 |

#### 风险与问题

- **P0（编造）：模型不用「」包裹就能写出不存在的按钮和后续流程，校验全部放行，而且会渲染在已验证步骤的旁边。**
- **P1：** 未执行的步骤和已验证的步骤在正文中无法区分。
- **P1：** UI 名称白名单的来源不可信。
- **P1：** `detectedActions` 未经核对就进入"主要功能"。
- **P1：** 质量警告只写 stderr，SKILL.md 要求的"处理报告里的 warnings"根本看不到这些警告。
- **P2：** completion 章节的 captureRefs 为空；`claims.js:61-63` 的 `claimLabel` 是死代码，并且和模板不一致。

#### 可复用模块

`fact-pack.js`（allowedUiTerms 和 quality 都有现成的挂点）、`markdown-validate.js`（`proseText` 已经能从 AST 取正文）、`style-lint.js`、`coverage.js`、`computeClaims`、`manual-model` 的 sections、`collectSensitiveElements` 的 DOM 遍历（可以改造成可见文本采集）、`publicationGate`（已有 waiting 机制）。

#### 推荐改造与验收标准

1. **堵住不加「」的编造（P0）。**
   - 做法：`validateCopy` 增加动作动词探测（点击、选择、输入、打开……）和结果断言探测（"会自动"、"将生成"、"发送到"……）；探测到的名词如果不在 `allowedUiTerms` 或已知动作句里，记为 review-required。同时修改 `model-request.js:68`，改为"结果只能引用 claims 或 readerChecks 的原文"。
   - 验收：上面那段编造文案的 review 或 blocked 结果非空；现有测试仍然全部通过。
2. **用 DOM 文本兜底。**
   - 做法：采集时记录可交互元素的 accessible name 清单，写进 Capture 记录；`allowedUiTerms` 只接受这个清单里的词，不在清单里的标为 `unverified`。
   - 验收：instruction 中写一个界面上不存在的「X」，会阻断，或在 JSON 中给出 `ui-term-not-observed`。
3. **让质量警告可见，并且可配置为阻断。**
   - 做法：draft 把 `pack.quality.warnings` 写入 run，`printRun` 把它们合并到 JSON；新增配置 `quality.blockOn: [...]`。
   - 验收：`generate --json` 输出中有 quality warnings；配置 `blockOn` 后，退出码为 1 或 3。
4. **在正文中标出未执行的步骤。**
   - 验收：`save` 步骤在正文中带有可识别的标记。
5. **补齐 completion 章节的 captureRefs。**
   - 验收：completion 章节的 captureRefs 非空。
6. **增加步骤级 `result` 字段。** 引用 after 断言的 id，等级由证据锁定。

---

### 阶段 6：增量更新与漂移检测（60%）

#### 实际执行链路

```
manual update
  → analyzeProject                 (只读)
      buildSourceGraph → groupBaselines → detectChanges(git diff / 快照 / 内容二次确认) → analyzeImpact
  → selectTargets                  (下线建议、阻塞、全量)
  → refreshModel
  → planUpdateTargets              (每个目标独立规划)
  → executePlanned                 (复用 generate 的节点)
  → 汇总：成功的标 updated；失败的标 stale，并保留上一版
```

#### 逐项结论

| # | 检查项 | 判定 | 证据与问题 |
|---|---|---|---|
| 1 | Git Diff 与快照比较 | **完整** | `git-changes.js`：name-status -M、untracked、非 Git 快照降级、withSnapshot 补漏、内容二次确认 |
| 2 | 页面 / 组件 / 任务 / 章节的依赖映射 | 部分 | 有 file → page → task → Scenario → manualId 的映射，并带 reasonPath。但章节粒度实际上就是整篇文档；`.manual/` 下的定义改动不进入影响分析（`impact.js:99` 排除了 stateDir）；`release.definitionRevisions` 没有消费方；`index/reverse.json` 没有读取方 |
| 3 | 定位受影响的页面 | 部分 | layout、middleware、tsconfig 的 paths 都能处理；动态 import 标为 partial 并保守扩散。**缺陷（已复现）**：`import './api.client'` / `'@/lib/date.utils'` 被 `hasIgnoredExtension` 当成非源码直接 `continue`，既不进依赖，也不记 unresolved，结果仍报 `complete`；`export * as ns from` 没有被匹配（`import-graph.js:19,201-204,246-247`）。另外不支持 webpack/next alias、package `imports` 和 monorepo；未能归属的改动在文本模式下不会显示 |
| 4 | 只重采受影响的页面或 Scenario | **完整** | 每个目标独立规划，互不连累；未受影响的文档字节不变（有测试） |
| 5 | 复用截图和标注 | 部分 | captureKey 组成完整；imageInputs 变化时只重派生不重采。缺陷：`capturePipelineVersion` 没有升级（`RENDERER_VERSION` 已修复）；`detectedActions` 不在 revision 里却进入 inventory；默认 15 分钟 TTL 导致复用窗口很短；`imageKey` / `manualKey` / `sourceKey` 没有生产代码使用 |
| 6 | 视觉漂移 | 部分 | `visual-diff` 已实现，但只接入了 `verify --live` 的页面检查，update 不读取；对有标注的页面必然误报（见阶段 4） |
| 7 | 语义漂移 | 部分 | `semantic-diff` 基于 aria 快照的多重集比较，页面检查已接入。但任务硬编码为 same（`live.js:346`），没有动态内容忽略配置，结果也不回流 |
| 8 | 缓存失效策略 | 部分 | 内容寻址加 miss 原因、三种模式、执行前复查都有。缺陷：config 和模型定义的改动不会触发 update；**`generate` 不刷新指纹**（只有 inspect 和 update 调用 `refreshModel`），在 TTL 内会复用旧截图 |
| 9 | 避免全量重生成 | 部分 | 普通组件和 layout 的影响范围精确。但全局文件过粗：lockfile、package.json 的任何改动都会导致所有页面重采，并且所有页面的源码分析都变成 stale（`fingerprint.js:128,166`），需要宿主模型逐页重新分析 |
| 10 | 删除、重命名、移动 | 部分 | 页面删除会给出下线建议，相关任务被阻塞；路由改名能保留 id。但页面移动后，新页面被静默过滤掉，update 不会提示需要 generate；`renameCandidates` 只在 inspect 中输出 |

#### 风险与问题

- **P0：** import 图静默漏掉依赖。手册和截图会过期，update 却报告"无变化"。
- **P1：** `.manual` 定义或配置的改动不被检测；`generate` 不刷新指纹；`capturePipelineVersion` 没有升级；在线视觉漂移误报。
- **P1（成本）：** 全局文件一改就全量重采，并全量等待模型重新分析。
- **P2：** `task.stale` 在缓存命中时不会被清除；`--plan` 号称只读，但会删除损坏的缓存条目；基线的取值时机存在竞态。

#### 可复用模块

`git-changes.js`、`impact.analyzeImpact`（纯函数）、`fingerprint.impactReport`、`index-store` 的不可变快照、`cache/*`、`semantic-diff`、`visual-diff`、`rederive`。

#### 推荐改造与验收标准

| # | 改造 | 验收标准 |
|---|---|---|
| A | 未知扩展名先尝试按源码解析，失败再记 unresolved；补上 `export * as` | `./api.client`、`@/lib/date.utils`、`export * as` 三种写法都能进入 files，改动后能命中对应页面 |
| B | 升级 `capturePipelineVersion`，加 CI 检查（渲染或标注逻辑改动时必须同时升级版本） | 旧缓存条目返回 miss |
| C | update 比较 `definitionRevisions` 和 `imageInputs`，识别 `definition-changed` / `config-changed` | 改了 guide 或任务步骤后，`update --plan` 会列出受影响的手册；只改 docs 时目标为空 |
| D | 全局文件分级处理（package.json 只看 dependencies 等字段） | 只改 scripts 时目标为空；升级 react 时全量重建并给出原因 |
| E | 文本输出展示 unowned、新增未发布页面、renameCandidates | 新增页面后，文本输出中出现提示 |
| F | `generate` 先执行 `refreshModel` | 改完源码立即 generate，结果显示 `input-changed(sourceHash)` |
| G | `restoreProjection` 清除 `task.stale` | 缓存命中后能通过 `checkEvidenceUsable` |

---

### 阶段 7：自动化质量评测与发布（67.5%）

#### 发布门槛清单（摘要）

| 门槛 | 性质 |
|---|---|
| 任务审批、证据存在且新鲜、草稿新鲜度 | 阻断或等待 |
| 文案块校验（blocked）/ 新数字与承诺（review） | 阻断 / 需人工 `--accept-review` |
| 事实比对（标题、step 顺序、截图引用、UI 原文、claim 等级） | 阻断 |
| 人工编辑保护（三方合并冲突） | 阻断或等待 |
| 图片引用、产物位置、完整性 hash、隐私 | 阻断（internal 模式下缺少隐私记录时放行） |
| 标注覆盖（新增，`validate.js:157-176`） | 阻断。但**旧采集没有元数据时直接跳过**，且**没有测试** |
| 发布记录 schema、资产二次核对、进行中事务、validate 到 publish 之间输入变化 | 阻断 |
| `taskQuality` / `imageQuality` | **只给 warning** |
| 目录、meta.json | 不阻断 |

#### 测试矩阵（阶段 × 测试）

| 阶段 | 覆盖情况 |
|---|---|
| ① 标注 | annotation-coverage、artifacts、image-pipeline、capture、task-executor。**发布门槛的覆盖检查、rederive 的覆盖路径没有测试**；`annotation-coverage.test.js` 写死了 "7 passed"，没有用统一的测试包装 |
| ② Scenario | scenario-model、scenario-fixtures、runtime-planner、cache-*。好，但**任务变体没有测试** |
| ③ 修复 | runtime-recovery、failure-matrix、task-rerun、publication-recovery、finalize-safety。恢复类测试好；**覆盖失败与缓存的交互、alternatives 回退都没有测试** |
| ④ 视觉 | drift-report、live-verify、image-pipeline。**没有标注 golden 测试，也没有覆盖"有标注页面"的漂移** |
| ⑤ 内容 | manual-quality、style-lint、markdown-validation、fact-pack、completion-claims、generate。好，但**没有测试"不加「」的编造"** |
| ⑥ 增量 | git-changes、impact-analysis、incremental-update、update-cli、import-graph 等。好，但**缺少带点号模块名、`.manual` 定义变化、全局文件分级的测试** |
| ⑦ 发布 | publication-gates、paths、recovery、gate0–3、install-smoke。好，**新增的标注门槛除外** |

#### 逐项结论

| # | 检查项 | 判定 | 说明 |
|---|---|---|---|
| 1 | 单元 / 集成 / 端到端测试 | 完整 | 79 个文件 |
| 2 | 七阶段回归测试 | 部分 | 见上表 |
| 3 | 统一质量报告 | 仅基础设施 | 信息分散在 `review-task`、`printRun`、`verifications/*.json` 里，草稿质量警告只写 stderr，events 的字段白名单里也没有 warnings |
| 4 | 独立指标 | 部分 | 有标注覆盖率百分比和任务完整度 checks；**图文一致性没有量化指标** |
| 5 | 阻止不合格产物 | 部分 | 见门槛清单 |
| 6 | CI | 完整 | — |
| 7 | 错误分类、日志、追踪 | 完整 | `runtime/errors.js`、`events.jsonl`、`status`；退出码 0/1/2/3/4 |
| 8 | 跨平台 | 部分 | 路径统一为 POSIX，Windows 的 EBUSY 有处理；**CI 没有 macOS**（`ci-workflow.test.js:48-50` 只要求 ubuntu 和 windows），macOS 表现为 Unknown |
| 9 | 无人值守 | 部分 | `--copy-default` 是确定性的。但页面的 `analyze` 节点必须由宿主模型处理（`planner.js:385-394`），任务需要人工 `approve-tasks`，登录需要人工 `auth login` |
| 10 | 恢复、断点续跑、幂等 | 完整 | 持久化状态加 interrupted 对账；写操作结果未知时不盲目重放；发布 journal 五个状态，repair 幂等；有 6 个故障注入检查点 |

#### 推荐改造与验收标准

1. 为标注门槛补 4 个测试：元数据缺失、hash 被篡改、覆盖不通过、页面已被删除。
2. 增加统一质量报告：events 白名单加入 `metric`；`generate --json` 输出 `quality:{annotationCoverage%, stepsExecuted/Total, claimsVerified, warnings}`；`status` 展示这些字段。
3. 可配置阈值：`quality.blockOn`、`quality.minAnnotationCoverage`，命中时报 `quality-gate-failed`。
4. CI 增加 `macos-latest`。
5. 增加 `--analysis-default`（用于 CI），保证 pages 走 `--copy-default` 时不会进入 waiting_input。

---

## 4. 问题优先级清单

### P0：影响正确性（漏标、伪证据、编造、错误结论）

| # | 问题 | 阶段 | 影响范围 | 根因 | 修复建议 | 验收 |
|---|---|---|---|---|---|---|
| P0-1 | 模型不加「」就能编造按钮、功能、后续流程，校验放行 | 5 | 所有经模型改写的手册 | `termsIn` 只抽取「」内的词；请求指令鼓励补写结果 | 动作和结果探测 + review；修改 `model-request.js:68` | 编造示例被标为 review 或 blocked |
| P0-2 | 任务 Scenario 变体实际按默认 Scenario 执行，却登记在变体缓存键下 | 2 | 所有 `scenario:<任务变体>` | `handlers.js:283` 没有传入 `scenarioDefinition` | 传入参数，并且不更新默认投影 | 变体记录的 scenarioId 和 provenance 都正确 |
| P0-3 | 标注覆盖失败的截图被写入缓存并复用 | 3 | 所有出现过偶发标注失败的主体 | `writeCaptureCache` / `lookup` 不看 coverage | miss 原因 `annotation-incomplete` | 不改模型重跑时会重新采集 |
| P0-4 | Required 清单与标注计划同源（都来自 guide），覆盖率查不出重要功能漏标 | 1 | 所有页面截图 | inventory 中 guide 默认 required，plan 也来自 guide | 清单与计划解耦，Required 由 features 或 describe 确认 | 声明了 X 但 guide 中没有 X 时被阻断 |
| P0-5 | import 图静默漏掉 `*.client` / `*.utils` 和 `export * as`，仍报 complete | 6 | update 的影响分析 | `hasIgnoredExtension` 直接 `continue`；正则缺少 `export * as` | 先尝试解析，失败再记 unresolved | 三种写法都能进入 files |

### P1：正确性风险或会误导用户

| # | 问题 | 阶段 |
|---|---|---|
| P1-1 | `annotation-coverage-failed` 不可达，页面和任务都报出错误原因（`page-usecase.js:109`、`task-draft.js:48`） | 1/3 |
| P1-2 | 没有 target 的 guide 被判为 required，整页没有发布图；非默认 Scenario 页面必然 `missing-from-plan` | 1/2 |
| P1-3 | 任务自动补的动作目标标注被判为 required，截"操作后"图时目标已消失，于是没有图；页面 feature 的 `task_ids` 被注入到每一个步骤 | 1 |
| P1-4 | runtime 丢失 handler 的 warnings；质量警告只写 stderr，不进 JSON | 3/5/7 |
| P1-5 | `verify --live` 对有标注的页面必然误报视觉漂移 | 4/6 |
| P1-6 | 超过 5 个目标时整次采集失败，且错误码被改写成 `navigation-failed` | 4 |
| P1-7 | 整页截图中 fixed/sticky 元素的打码和标注坐标偏移（隐私风险） | 4 |
| P1-8 | 未执行的步骤与已验证步骤在正文中无法区分；`allowedUiTerms` 来源不可信；`detectedActions` 未经核对就进入正文 | 5 |
| P1-9 | `.manual` 定义或配置改动不被 update 检测；`generate` 不刷新指纹；`capturePipelineVersion` 没有升级 | 6 |
| P1-10 | 页面变体缓存命中时覆盖默认页面投影；`page-<id>.yaml` 覆盖只部分生效 | 2 |
| P1-11 | `annotations.json` 和 evidence manifest 位于 gitignore 目录，重新 clone 后 verify 和任务生成会失败 | 跨阶段 |
| P1-12 | 发布门槛用当前模型重算清单（已发布的文档会被后来改动的模型判失败）；Capture 记录为 null 时静默通过 | 1/7 |
| P1-13 | 新增的标注发布门槛没有测试；旧证据和 `--no-screenshot` 可绕过门槛；capture 失败时退出码仍为 0 | 1/7 |
| P1-14 | 定位不等待也不重试；回退定位命中的信息被丢弃 | 3 |
| P1-15 | lockfile 或 package.json 任何改动 → 全量重采，全量等待模型重新分析 | 6 |

### P2：体验或一致性

- 编号与编号、编号与框互相重叠或遮挡；字号写死；部分裁切仍判为 drawn。（阶段 4）
- 每张任务图编号都从 ① 开始。（阶段 4/5）
- completion 章节 captureRefs 为空；`claimLabel` 是死代码。（阶段 5）
- Empty 状态没有判定；没有按角色的断言；Loading 无法稳定复现。（阶段 2）
- 失败原因没有大类；`annotation-*` 错误码不在 HINTS 中。（阶段 3）
- 任务没有语义和视觉漂移检测；默认 TTL 15 分钟；`task.stale` 在缓存命中时不清除。（阶段 6）
- 没有 macOS CI；`finalize-safety` 偶发失败；`annotation-coverage.test.js` 不是统一的测试格式。（阶段 7）
- `merge/` 和 `migrations/` 没有加入 gitignore；`references/quality-workflow.md:32` 仍推荐已废弃的 legacy 命令 `generate-task`。（跨阶段）

---

## 5. 跨阶段架构评估

### 5.1 证据链关联矩阵：`Feature → Task → Scenario → Step → Screenshot → Annotation → Manual Section`

| 链接 | 强度 | 证据 |
|---|---|---|
| Feature → Task | 弱 | `features[].task_ids` 只检查非空（`schema.js:285`）；`guide[].taskId` 只检查格式，渲染时可能产生死链（`render.js:228`）；`step.feature_id` 不在 schema 中，也不受审批约束；`discover-tasks` 复制 guide 时丢掉了来源 |
| Task → Scenario | 中 | `userTaskId` 不检查是否存在；派生 id 靠字符串拼接，且存在碰撞（页面 `x-default` 与任务 `page-x` 都会得到 `page-x-default`）；**runtime 中的任务变体会被丢弃** |
| Task → Step | 强 | 内嵌数组，stepId 唯一 |
| Step → Page | 中，规则冲突 | `schema` 接受 `pageId ?? page`；`tasks/model.js:89` 和 `capture-plan` 只认 `step.page`；`coverage.js:30` 和 `validate.js:104` 也只认 `step.page`。跨实体校验 `validateUserTask(…, {pages})` 在生产代码中**从来没有传入 pages** |
| Step → Screenshot | 生成路径弱 / 复用路径强 | Capture 的 `subject{taskId,stepId,timing}` 是强关联。但生成时读的是 gitignore 目录里的 manifest，`publishedFromCapture` 不核对 subject（`task-draft.js:13-27`）；task-step 的 subject 里没有 pageId |
| Screenshot → Annotation | 中（新增） | 同一个 Capture 中有 `annotations` 产物和 `annotationCoverage`；annotation 没有独立 id，label 等于位置下标 |
| Annotation → Section | **缺失** | Section 没有 featureRefs 或 annotationRefs（`manual-model.js:21-31`）；`guide.<id>` 章节连 captureRefs 都没有；对应关系只靠"下标 + 1"的约定 |
| Page → Section | 发布记录强 / 派生弱 | `sections[].pageRefs` 是 ID 级关联；`pageSectionIndex` 没有调用方；`doc-meta` 用路由字符串匹配，并手工拼接前缀 |
| Release → Capture | 强 | `captureIds` 经过 UUID 校验；但没有和 `sections[].captureRefs` 做一致性校验 |

**稳定的标识：** Page.id（持久化，按 route/entry 匹配）、Task.id、Step.id、Claim.id、guide.id、Section id（`step.<id>` / `guide.<id>`）、Capture UUID、内容寻址的产物。

**不稳定的标识：**
- detectedActions 的 feature_id（基于文案 hash）
- 生成的 Assertion id（位置下标）
- `img-N`（位置下标）
- annotation label（位置下标）
- 超长 id：`routeToId` 不截断，`task-<id>` 可能超过 64 个字符，发布会失败（已验证）

### 5.2 重复定义与字段冲突

1. **任务有三套校验器，规则互相冲突**：`tasks/model.js:64-161`、`model/schema.js:299-436`、`capture-plan.js:40-120`。RISKS 和 goalChecks 各写了两份。
2. **Feature inventory 有四处推导，过滤规则各不相同**：`capture-page.js:171`、`executor.js:72`、`publication/validate.js:96-107`、`annotations/store.js:7-17`。
3. **标注数据有 6 种形态**：spec、隐式 guide.target、plan、layout、rendered、coverage 与 annotations.json。rendered 中 `located` 恒为 true，`outlined` 等于 `intersects`。
4. **证据引用字段重叠**：任务上有 5 个（evidence、evidenceManifest、captureIds、lastCapture.captureIds、capturePlan），页面上有 4 个。
5. **两套 revision**：Scenario 对整个对象取 hash，而 `DEFINITION_FIELDS.scenario` 是死配置。
6. **三条旧数据归一化路径 + 两个迁移命令**；文档路径推导散落在至少 4 处。
7. **命名风格冲突**：新字段 `feature_id`、`task_ids` 用 snake_case，全库其他地方都是 camelCase。
8. **页面和任务两条流程各有一套** FactPack、usecase 和 facts 校验。它们的发布层已经统一，但证据读取方式不一致：页面读 Capture 记录，任务读 manifest。

### 5.3 复杂度评估

- **必要的复杂度，应当保留**：不可变 Capture、内容寻址产物、发布 journal、三方合并、审批 scopeHash、runtime 的 planner 和缓存键。它们直接服务于"证据不可伪造、结果可追溯"。
- **不必要或重复的复杂度**：
  - `generate` 的 runtime 和 legacy 双轨入口（`generate.js:317-349`）。
  - 任务模型的四层投影。
  - 约 14 套 store。
  - `feature-inventory.json` 又多了一个入库的派生物，而且没有消费方。
  - 死代码和死配置：`pageSectionIndex`、`DEFINITION_FIELDS.scenario`、`routeBindingId`、`forward.apis/scenarios`、`imageKey/manualKey/sourceKey`、`claimLabel`。
  - `compat/aliases.js` 体量小、风险低，不建议动。
- **重复建设风险**：正在推进的阶段 1 代码又新建了一份 inventory 推导和一份 inventory 存储，没有复用 index 体系。下一步应该先收敛，再扩展。

### 5.4 打通证据链的最小兼容改造

原则：复用已有 id，新增字段一律可选，缺省时行为不变，只新增一个跨实体校验模块。

1. **统一取 step 所在页面**：新增 `stepPageId(step) = step.pageId ?? step.page`，替换所有直接读 `step.page` 的地方。
2. **补可选引用字段**：
   - `Page.features[]`：新写入使用 `id`，读取时兼容 `feature_id`；`taskIds` 兼容 `task_ids`；新增 `stepIds`。
   - `guide[].featureId`。
   - `Step.featureRefs`（形如 `<pageId>.<featureId>`）、`Step.source.guideId`。
   - Capture（task-step）的 `subject` 补 `pageId`、`checkpointId`，新增 `featureIds[]`（只包含实际画出的项）。
   - annotation 条目 `{featureId, label, rect, drawn, reason}`，引用格式 `annotationRef = <captureId>#<featureId>`。
   - FactPack：`steps[].featureRefs`、`guide[].featureId/artifactRefs`、`entry.pageId`。
   - Section 新增 `featureRefs`、`scenarioRefs`、`annotationRefs`；`guide.<id>` 章节补上 captureRefs。
3. **把 annotations 精简后内嵌进入库的 Capture 记录**，或者写到 `.manual/evidence/annotations/`，解决重新 clone 后无法校验的问题。
4. **新增 `src/model/links.js` 的 `validateLinks()`**，挂在四个校验点：
   - `projectStore.commit`：校验引用存在，同时启用已有的 `validateUserTask(task,{pages})`。
   - `captureStore.commit`：`subject.pageId` 与 step 一致，`featureIds` 是 plan 的子集。
   - `buildTaskDraft`：校验 `capture.subject` 与 step 一致，改为由 `task.captureIds` 构建图片列表，manifest 降级为缓存。
   - `validatePublication` / `verify --artifacts`：`captureRefs ⊆ release.captureIds`；`annotationRefs` 对应的 Capture 中该项确实已画出；`featureRefs` 是 `annotationRefs` 的子集。
5. **验收**：
   - 从任一已发布手册的 `sections[]` 出发，只凭 ID 就能走完 `Section → featureRefs → Page.features → taskIds → Task → Scenario → Step → Capture → annotations(drawn=true)`，并且有测试断言整条链。
   - 负面用例分别报 `missing-reference`、`capture-subject-mismatch`、`section-ref-invalid`、`annotation-coverage-failed`。
   - 没有新字段的旧项目，factsHash 不变。
   - 删除 `.manual/artifacts/` 后，`verify --artifacts` 仍能通过。
   - 全仓库 grep 只剩一个 `buildInventory` 入口。

---

## 6. 推荐实施路线

### 6.1 各阶段成熟度判断

- **已经足够成熟，暂不重点投入**：
  - 阶段 7 的恢复、幂等、CI、错误分类部分。
  - 阶段 6 的 Git diff、影响分析、按目标增量重建主干。
  - 阶段 3 的通用重试和 resume。
  - 阶段 5 的任务式结构渲染和模型白名单。
- **可以合并实施**：
  - 阶段 1 + 阶段 3 + 阶段 5 的"标注与正文对应"：它们共用 `coverage.js`、`annotations.json`、Section 引用。
  - 阶段 4 + 阶段 6 的视觉漂移：修复在线视觉比对和 golden 测试，用的是同一套标注重绘能力。
  - 阶段 7 的质量报告与阶段 3、5 的 warnings 传递：同一条 events/JSON 通道。
- **必须先解决的**：
  1. 标注覆盖未提交改动带来的回归（P1-1/2/3、测试同步、版本号）。不处理的话，现有项目升级后会大面积丢失截图。
  2. 证据正确性的 P0（P0-2、P0-3、P0-5）。
  3. 内容编造的 P0（P0-1）。

### 6.2 开发批次

**批次 0：稳住正在进行的阶段 1 改动（约 1–2 天）**

- 交付内容：
  - 统一使用 `stepPageId`。
  - 没有 target 的 guide 降级为 optional。
  - 非默认 Scenario 的清单只包含本 Scenario 的项。
  - 自动动作标注改为 optional，label 使用步骤号。
  - feature 按步骤关联。
  - 修正 `page-usecase` / `task-draft` 的报错顺序。
  - 升级 `capturePipelineVersion`。
  - 为标注发布门槛补 4 个测试。
  - `annotation-coverage.test.js` 改用统一的测试包装。
- 验收：
  - unit 和 browser 两组测试全部通过。
  - 没有 target 的 guide 页面、Scenario 变体页面、"操作后目标消失"的任务步骤，都能产出发布图。
  - `generate --json` 能报出 `annotation-coverage-failed`。

**批次 1：证据正确性 P0（约 2–3 天）**

- 交付内容：
  - 任务 Scenario 变体正确执行（P0-2）。
  - `restoreProjection` 在 Scenario 变体下提前返回。
  - 缓存挡住覆盖失败的结果（P0-3）。
  - import 图修复（P0-5）。
  - `generate` 先执行 `refreshModel`。
- 验收：对应的 4 条新测试全部通过；改动 `api.client.ts` 后，update 能命中对应页面。

**批次 2：清单与计划解耦 + 证据链引用（约 3–5 天）**

- 交付内容：
  - Required 改由 features 或 describe 确认的结果产生。
  - 只保留一个 `inventoryFor()` 入口，其余收敛。
  - annotations 精简后内嵌进 Capture。
  - Section 增加 featureRefs 和 annotationRefs。
  - 新增 `validateLinks` 的四个挂点。
  - 编号与正文对应校验（`annotation-label-mismatch`）。
- 验收：见 5.4 节的验收标准，以及阶段 1 改造项 1 和 4 的验收标准。

**批次 3：内容防编造 + 质量可见（约 3–4 天）**

- 交付内容：
  - 不加「」时也能检测动作和结果描述（P0-1）。
  - 修改 `model-request` 的指令。
  - 采集可见 DOM 文本清单，用于核对 `allowedUiTerms`。
  - 质量警告进入 JSON 和 events，并支持 `quality.blockOn`。
  - 在正文中标出未执行的步骤。
- 验收：编造示例被拦截；不存在的「X」报 `ui-term-not-observed`；`generate --json` 带 `quality` 字段。

**批次 4：视觉质量（约 3–4 天）**

- 交付内容：
  - 带碰撞检测的布局。
  - 超出上限时自动拆图。
  - 主题参数全部配置化。
  - 坐标自检，fixed 元素单独处理。
  - 修复在线视觉比对。
  - golden 测试。
- 验收：见阶段 4 的验收标准。

**批次 5：Scenario 与增量补全（按需）**

- 交付内容：
  - 页面 setup 前置动作。
  - Empty 和 Loading 状态支持。
  - 截图后复核。
  - update 能识别定义和配置变化。
  - 全局文件分级处理。
  - 漂移检测结果回流。
  - 修复规划（derive-image、重新采集、标记不可修复）。
  - macOS CI。
  - 批量运行用的分析默认值。

### 6.3 可以直接复用的代码

`annotations/coverage.js`、`capture-safe.derivePublished`、`captureStable`、`rederive.js` 与 `derive-image` 节点、`retry` / `runner` / `recovery`、`cache/lookup.js` 的 miss 原因体系、`resolve-target.js`、`fact-pack.js` 的 `allowedUiTerms` 挂点、`markdown-validate.proseText`、`style-lint.js`、`publicationGate` 的 waiting 机制、`manual-model` 的 sections、`visual-diff` / `semantic-diff`、`git-changes` / `impact`。

---

## 7. 最终总结

**1. 七个阶段分别完成了多少？**

| 阶段 | 完成度 |
|---|---|
| 1. 标注完整性 | 43% |
| 2. Scenario 联动 | 47% |
| 3. 智能修复 | 56% |
| 4. 视觉优化 | 35% |
| 5. 内容质量 | 56% |
| 6. 增量更新 | 60% |
| 7. 自动化质量 | 67.5% |

等权平均约 52%。其中阶段 1 的大部分实现还是未提交代码，并且正在被并发修改。

**2. 当前最严重的三个质量问题**

1. **内容可能被编造。** 模型不加「」就能写出不存在的按钮和流程，校验放行；UI 名称白名单来自人工或模型写的文本，没有和 DOM 核对（P0-1、P1-8）。
2. **标注完整性的结论不可靠。** 清单和计划同源，查不出重要功能漏标；覆盖失败的结果会进缓存被复用；报出的错误原因是错的；旧证据和 `--no-screenshot` 能绕过（P0-3、P0-4、P1-1、P1-13）。
3. **证据可能张冠李戴或静默过期。** 任务 Scenario 变体按默认 Scenario 采集，却登记成变体证据；import 图漏掉依赖后，update 报"无变化"（P0-2、P0-5）。

**3. 现在能否稳定生成高质量用户手册？**

还不能。证据可信、发布事务安全、恢复幂等这些底座已经达到生产水平，结构化任务指南的形态也对了。但"截图上标的是不是全部重要功能"、"正文写的是不是界面上真有的东西"这两个核心质量问题，目前还没有可靠的自动判定，相关质量检查也大多只给警告，不会阻断。另外，正在进行的标注覆盖改动会让没有 target 的 guide、Scenario 变体、"操作后"截图集中失去发布图，需要先稳住。

**4. 如果只能做三项优化**

1. **批次 0 + P0-3**：稳住标注覆盖改动（降级规则、报错顺序、测试、版本号），同时让缓存不再复用失败结果。
2. **P0-1 + DOM 文本核对**：在不加「」的文案里检测动作和结果描述，并基于采集到的可见文本核对 `allowedUiTerms`。
3. **清单与计划解耦 + Annotation 到 Section 的 ID 关联**：Required 来源独立于 guide，Section 带 featureRefs 和 annotationRefs，编号与正文的对应关系可以校验。

**5. 是否有不必要的复杂度或重复建设风险？**

有。
- 任务有三套校验器，规则冲突。
- Feature inventory 有四处推导，标注数据有 6 种形态。
- 任务和页面的证据引用字段分别重叠了 5 个和 4 个。
- 约 14 套 store，`feature-inventory.json` 又是一个没有消费方的入库派生物。
- `generate` 有 legacy 双轨入口，还有多处死代码和死配置（`pageSectionIndex`、`DEFINITION_FIELDS.scenario`、`imageKey` / `manualKey` / `sourceKey` 等）。

正在推进的阶段 1 又新建了一套 inventory 推导和存储，建议先收敛成单一入口，再往上扩展。不需要大规模重构：发布、证据、runtime 这几个核心抽象都是合理的。

**6. 距离稳定、可靠、可持续维护的正式版还缺什么？**

- 可信的功能清单，以及"清单 → 计划 → 标注 → 正文"的 ID 级证据链和对应校验。
- 内容真实性校验：DOM 文本核对、不加「」的编造检测。
- 可配置并会阻断的质量门禁，以及统一的质量报告。
- 漏标的自动修复闭环：失败分类、按需重派生或重采、标记不可修复、缓存不复用失败结果。
- 视觉布局质量：碰撞避让、自动拆图、坐标自检、golden 回归测试。
- 页面交互状态采集（setup）和正确执行的任务 Scenario 变体。
- update 能感知定义和配置变化，影响分析不漏依赖，全局文件分级处理。
- macOS CI，以及批量模式（CI 中可以无人值守跑完分析步骤）。

---

*本报告由 8 个并行只读审计 agent 产出、主审汇总并抽查复核。没有修改任何已有项目文件，也没有提交代码。唯一新增的文件就是本报告。审计期间测试只写入系统临时目录。*
