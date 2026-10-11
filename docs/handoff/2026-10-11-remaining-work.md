# 交接：剩余优化项与 NeoAgent 全量重跑（2026-10-11）

基线：`main@2b6f61f`（已推送）。两份计划：
- 《Living User Manual：统一 Demo 截图模式实施方案》（仓库根目录 `Living-User-Manual-Demo-Capture-%E5%AE%9E%E6%96%BD%E6%96%B9%E6%A1%88.md`，第 9 节 DoD、第 11 节实施记录）
- 《七阶段完整优化实施计划》（`docs/living user manual plan.md`，第 15 节状态表）

## 1. 当前进度

| 批次 | 状态 | 提交 |
|---|---|---|
| Demo 截图方案 P0–P5 | 代码完成；真实站点对比待做 | `54490cd` `96e9f7b` `50e7c6a` |
| B0–B3 | 完成 | 更早的提交 |
| B4 标注布局 / 拆图 / 公平视觉比较 | 完成 | `08068e4` |
| B5 Scenario / 增量更新 / 定向修复 | 基本完成（遗留见下） | `08068e4` |
| B6 质量治理 | 基本完成（遗留见下） | `bb1ec2c` |
| Windows 修复、移除 GitHub Actions | 完成 | `ca48d4e` `2b6f61f` |

测试状态：本地 macOS `npm run test:unit` 与 `npm run test:browser` 全部通过（browser 组约 25–30 分钟）。
项目**不使用 CI**；Windows 上一次真实运行暴露的问题已修复但未复验，Linux 从未验证。

相关文档：`docs/DEMO_CAPTURE.md`、`docs/ANNOTATION_COVERAGE.md`、`docs/RUNTIME.md`（§7 Scenario、§9 排查、§10 重跑清单、§11 产品绕法）、`docs/MIGRATION.md`、`docs/audit/2026-10-11-demo-capture-audit.md`。

## 2. 剩余优化项（代码）

按建议顺序。每项都在计划文档里有对应的未勾选条目或备注。

| # | 项 | 现状与切入点 |
|---|---|---|
| R1 | **B5-06 手册引用 Scenario 变体截图** | 变体截图只登记在 `.manual/evidence/latest.json` 的 `scenario:<id>`（`src/evidence/capture-page.js` 的 `setLatest`），手册不引用。切入：`src/generate/page-usecase.js`（`draftPage` 组装 `images`，已支持多张）、`src/generate/fact-pack.js`（`buildPageFactPack` 的 artifacts）、`src/generate/manual-model.js`（`pageSections`）、`src/generate/render.js`（每个 artifact 一张图）。需要：在页面定义里声明哪些变体进入手册（例如 `page.variants: [{ scenarioId, title }]` 或 guide 引用），变体图走同一套发布门槛（隐私、Demo、覆盖、完整性），章节 `captureRefs` 指向变体 Capture，update / verify 能追踪 |
| R2 | **B4-06 任务步骤截图的在线视觉漂移** | `src/verify/live.js` 的 `pageDrift` 只处理页面。任务回放循环（同文件 `verifyLive` 里 `for (const step of plan.steps)`）在 after 截图点可以复用 `captureStable` + `derivePublished` + 冻结计划重绘（参考 `frozenTargets` 与 `readSidecar`），与发布记录里对应步骤的 Capture 逐张比较 |
| R3 | **B5-04 按 auth profile 配置身份断言** | 现在只有全局 `config.auth.identityAssertions`（`src/auth/identity.js` 的 `identityRevision` / `verifyIdentity`）和 Scenario 的 `expected.roleAssertions`。增加 `auth.profiles.<id>.identityAssertions`（`src/config/load.js` 校验），身份不符报 `auth-identity-mismatch`，不改用其他身份 |
| R4 | **B5-16 修复预算可配置** | `src/runtime/repair.js` 的 `DEFAULT_BUDGET = 2`；`src/runtime/planner.js` 调用 `repairDecision` 处传入 `config.runtime?.repairAttempts`（在配置加载处校验范围，例如 0–5） |
| R5 | **B6-10 死字段运行时提示** | 仍被接受但无执行语义：Scenario 的 `entry.routeBindingId`、`data.revision`、检查点 `state`，任务的 `capturePlan`。注意 `src/scenarios/model.js` 的派生 Scenario 自己会写这些字段，**只对用户写的显式文件提示**（`src/scenarios/store.js` 的 `readScenario`、任务文件读取处），提示代码如 `field-deprecated` |
| R6 | Demo：不保留私有原图（`capture.safety.persistRaw: false`） | 原图是重新派生与标注修复的输入。读取方：`src/evidence/rederive.js`、`src/tasks/executor.js` 的 `screenshotFromRecord`（`artifact('raw').path` 会因缺失崩溃）、`src/evidence/integrity.js`、`src/runtime/planner.js` 的 derive 分支。关闭时：记录标 `rawRetained: false`，需要重新派生的地方明确报 `rederive-unavailable` 并走重新采集 |
| R7 | Demo：按角色 / 可访问名称声明敏感区域 | 现在 `capture.demo.selectors` 只支持 CSS（页面内函数在 `src/privacy/demo-page.js`，由 `page.evaluate` 序列化执行）。做法：在 Node 侧用 Playwright locator（`src/browser/playwright.js` 的 `locatorFor`）解析 `{ role, name }`，在 `applyDemo` 前给命中元素打临时属性，再交给页面内函数 |
| R8 | B3 遗留 | 无障碍名称与 locator 的逐项关联（B3-03）；步骤级 `result` 引用 after 断言（B3-07） |
| R9 | B6-11 负例测试 | 构造会被结构化重写改变解析结果的任务 YAML，断言 `approve-tasks` 输出 `task-rewrite-drift` |

## 3. 工作约定（另一个 AI 必须遵守）

- 先读 `git log`、`git status` 与两份计划；以代码为准，计划里的行号会漂移。
- **不修改被采集项目**（NeoAgent）的源码、配置、数据库；Skill 只写 `.manual/` 与 `docs/`。
- 每项一正一负测试；新测试文件登记到 `test/run.js` 的 `FILES`，启动浏览器 / 测试服务器的还要加进 `BROWSER`（`test/test-groups.test.js` 会核对）。测试页面加到 `test/server.js`。
- 每批结束跑全量 `npm run test:unit` 与 `npm run test:browser`；**browser 组运行期间不要改 `src/`**（测试进程会读到半成品）。
- 更新相关文档（RUNTIME / MIGRATION / 专题文档）并在计划里勾选、写清偏离与遗留，不把未完成写成完成。
- 提交信息沿用仓库风格（`✨【功能】：…`，正文按文件分节 + 影响说明），末尾加 `Co-Authored-By` 行；是否推送由用户决定。

---

## 4. Prompt A：完成剩余优化项

复制给执行代码的 AI：

```text
你在仓库 /Volumes/external/Neostar/user-manual（Living User Manual Skill，Node CommonJS + Playwright + Sharp）。
先完整阅读 docs/handoff/2026-10-11-remaining-work.md，以及其中列出的两份计划、docs/RUNTIME.md、docs/ANNOTATION_COVERAGE.md、docs/DEMO_CAPTURE.md。

任务：按交接文档第 2 节 R1 → R9 的顺序完成剩余优化项。要求：
1. 开工前 git status / git log 确认基线是 main@2b6f61f 或其后续；以当前代码为准核对每一项的现状，发现已完成或前提不成立的，记录后跳过。
2. 遵守交接文档第 3 节的工作约定（不改被采集项目、每项正负测试、登记 test/run.js、browser 组运行期间不改 src、文档与计划同步更新）。
3. 优先复用现有实现：captureStable / derivePublished / frozenTargets / publishedParts / runSetup / repairDecision / qualitySummary 等，不新建平行系统。
4. 每完成 2–3 项做一次全量回归（npm run test:unit 与 npm run test:browser 都要通过），通过后按仓库风格提交；不要推送。
5. 结束时给出：每项状态（完成 / 部分 / 跳过及原因）、改动文件、测试命令与通过数、行为变化与兼容影响、仍未完成的事项；同步更新两份计划文档的勾选与 §15 状态表。
测试失败不得声称完成；无法安全实现的项停下来说明原因，而不是绕过安全约束。
```

## 5. Prompt B：NeoAgent 全量重跑与验收

在 Prompt A 完成后使用。需要你补全 `<>` 中的信息：

```text
你要在 NeoAgent 测试站上用 Living User Manual Skill 全量重新生成用户手册，并完成验收记录。

环境：
- Skill 仓库：/Volumes/external/Neostar/user-manual（CLI：node bin/manual.js，命令说明见 SKILL.md 与 docs/RUNTIME.md）
- 被采集项目：<NeoAgent 仓库路径>
- 测试站地址：<baseUrl>；可用账号 / 认证档案：<账号与 profile 名>
- 已有重跑记录：<NeoAgent 仓库>/demo/website/docs/manual-full-rerun-plan.md（含已知问题与对策）

硬性约束：
- 不修改 NeoAgent 的源码、项目配置、数据库与数据；Skill 只写 <NeoAgent 仓库>/.manual 与手册输出目录。
- 敏感区域用 Skill 侧的 capture.demo.selectors 声明，不在 NeoAgent 里加 data-redact；数据接口用 Fixture（kind: mock）或经审阅后登记 capture.demo.network.allow。
- 写操作只走任务的 writeAuthorization 或 Fixture 完整模拟；不在测试站执行未授权写入。
- 截图门禁未通过（needs_fixture / blocked）就修配置或 Fixture，不能为了出图放宽隐私规则。

步骤：
1. 阅读 docs/handoff/2026-10-11-remaining-work.md、docs/RUNTIME.md §10 重跑检查清单、docs/DEMO_CAPTURE.md。
2. manual doctor；manual auth check 确认各身份可用；按清单核对 Scenario id、一次性前置数据（用 preconditions 声明）、写授权有效期、外部服务（不可用时用 Empty Fixture）、next dev 的热更新与开发指示器。
3. 记录改造前基线：用当前已发布手册跑 manual verify --all --json，保存 demo.metrics、annotationCoverage 与图片清单。
4. 为历史会话、个人信息、订单 / 积分、抽屉等页面配置 capture.demo（selectors / text / images / network）与必要的 Fixture；逐个 manual capture page:<id> / scenario:<id>，直到门禁 passed。
5. 全量 manual generate（页面与任务），处理 waiting_input（describe / 审批 / 登录）后 resume；再跑 manual verify --all（离线）与 manual verify --all --live。
6. 验收并写报告（中文，放在 <NeoAgent 仓库>/demo/website/docs/ 下新文件）：
   - Demo：每页改造前后的遮罩面积与成对截图、通过率、needs_fixture / blocked 原因分布、Fixture 数量与命中率、未覆盖读取、写请求计数（应为 0）。
   - 七阶段计划里依赖真实站点的验收：B1 未勾选的那条（侧栏状态、流式回复、慢接口超时、保存提示条遮挡）、B6 验收最后一条（长 aria-label 动作句、授权过期、Scenario ID 失效、一次性数据已消费、付款服务缺配置的诊断）、B5 的合法跳转 / 前置数据 / 变体截图在手册中的呈现。
   - 质量：每份手册的 quality（planCoverage / renderCoverage / documentationCoverage / verified）与“质量 vs 上次”。
   - 失败与遗留：逐条列出，区分工具缺陷、配置 / 数据问题、NeoAgent 产品缺陷（如对话内产物二次编辑 409）。
7. 发现工具缺陷时：记录最小复现，不在本任务里改 Skill 代码（除非我另行授权）；不要提交或推送任何仓库。
完成后在两份计划文档中只勾选你实际验证通过的条目，并附报告路径。
```
