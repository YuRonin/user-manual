# Living User Manual Optimization TODO LIST

> 状态：全部待执行。此文件是实施进度唯一来源；计划已写完不代表下面的工程任务已完成。
> 总入口：[实施总计划](2026-09-24-living-manual-optimization-plan.md)；接口：[数据与接口契约](2026-09-24-living-manual-contracts.md)。

## 使用规则

1. 选择依赖已完成的任务；打开对应阶段文档的同 ID 标题读取全部 Files、步骤、测试和完成条件。
2. 子项全部完成且有实际验收证据，才能勾选任务主项。只写了代码但测试未运行/失败，维持未完成。
3. 用下方“执行记录”保存正在执行、阻塞原因和结果；不在多份文档复制任务状态。
4. 每阶段通过 gate 后再启动下一阶段。任务可拆为多个提交，不为凑一个提交压缩必要验证。
5. 发现契约需要调整时先记录 ADR/修改 contracts，再更新所有依赖任务；不私自换模型语义。

## Phase 0 — 当前流程可信

详细步骤：[Phase 0](2026-09-24-living-manual-phase-0.md)。推荐顺序：08 → 01 → 02 → 03 → 04 → 05 → 06 → 07。

- [x] **P0-08 固定依赖与 doctor**（无依赖）
  - [x] 记录 Node/npm/当前测试基线并隔离认证缓存。
  - [x] 核实并固定 Playwright、sharp、Markdown parser 版本与 Node 支持。
  - [x] 改默认依赖解析，添加只读 doctor，统一 command registry/alias。
  - [x] 干净安装和兼容命令测试通过。
- [x] **P0-01 图片路径和引用**（依赖 P0-08）
  - [x] 区分 artifactPath 与 markdownHref，新增规范解析函数。
  - [x] 页面/任务生成、verify、privacy 共用同一路径规则。
  - [x] AST 图片检查覆盖正常 ../、越界、绝对地址和真实路径逃逸。
  - [x] 历史快照只读/临时副本验证通过。
- [x] **P0-02 统一发布门槛**（依赖 P0-01）
  - [x] 添加 validatePublication，两个 finalize 和 verify 均接线。
  - [x] 缺 privacy 摘要按 unknown 处理，public 阻止 raw。
  - [x] 默认 rawDir 移出 docs，旧配置给明确迁移建议。
  - [x] fallback/no-screenshot 无法绕过完整性和可信度规则。
- [x] **P0-03 页面与前后状态验证**（依赖 P0-08）
  - [x] 提取 HTTP/身份/最终 URL 共享验证。
  - [x] required waitFor 超时失败，任务执行前校验 stateBefore。
  - [x] 空断言不 verified，Error/Loading 按预期 Scenario 解释。
  - [x] 错页、延迟 redirect、500 有按钮等夹具通过。
- [x] **P0-04 completion claim 绑定**（依赖 P0-03）
  - [x] 记录 assertion ID/scope/outcome/checkpoint。
  - [x] completion 由证据计算，不接受输入字符串提升等级。
  - [x] 风险停止后余下步骤显式 not-executed。
  - [x] “编辑器打开”和“资料保存”两种声明区分验证。
- [x] **P0-05 finalize 顺序与原子写入**（依赖 P0-01/02/04）
  - [x] 所有合法性检查移到正式文件写入前。
  - [x] 唯一 temp、fsync、rename 和失败清理统一实现。
  - [x] 非法状态、文件占用、rename 失败不改变旧文档。
  - [x] 格式化压缩核心文件并保留明确 partial-commit 报告。
- [x] **P0-06 同 raw 图像派生**（依赖 P0-02/03/08）
  - [x] Browser 只采 raw/geometry，图像管线离线生成发布图。
  - [x] DPR/clip/scroll/fullPage 坐标及截图时间稳定性处理。
  - [x] after 标注重新定位，高风险无几何返回 unresolved。
  - [x] 真实像素测试及页面安全采集全流程通过。
- [x] **P0-07 认证语义与 CAS 刷新**（依赖 P0-03/05）
  - [x] auth.enabled=false/anonymous 不读取注入认证。
  - [x] stored 与 authenticated 分离，登录验证身份断言。
  - [x] Profile generation/CAS/锁接线，旧刷新不能覆盖新状态。
  - [x] cookie/localStorage 和能力限制、敏感日志测试通过。
- [x] **Gate 0：页面与任务端到端安全发布、错误页拒绝、npm test 通过。**

## Phase 1 — 定义、证据和发布版本化

详细步骤：[Phase 1](2026-09-24-living-manual-phase-1.md)。推荐顺序：01 → 02 → 03 → 05 → 06 → 04 → 08 → 07。

- [ ] **P1-01 schema / ID / revision**（依赖 Gate 0）
  - [ ] 实体 schema 与版本校验、稳定 projectId。
  - [ ] canonical JSON/hash，定义字段与观察字段分离。
  - [ ] action/assertion/ID/path 完整运行时校验。
  - [ ] 旧版只读 normalize，更高版本明确拒绝。
- [ ] **P1-02 不可变 Capture Store**（依赖 P1-01）
  - [ ] staging→hash 校验→资源安装→record commit。
  - [ ] 唯一 Capture ID、内容寻址图片、不可变冲突检测。
  - [ ] page.browser/legacy manifest 只作兼容投影。
  - [ ] 连续采集、半写入、图片替换测试通过。
- [ ] **P1-03 Page / Scenario / UserTask 拆分**（依赖 P1-01/02）
  - [ ] approval、新鲜度、执行状态独立。
  - [ ] 稳定 Page ID、route binding、missing/retired。
  - [ ] Scenario 身份/数据/参数/检查点校验。
  - [ ] 可重复 capture/generate/verify，scope 变化重确认。
- [ ] **P1-05 源码指纹与隐式依赖**（依赖 P1-01/03）
  - [ ] 同路径内容 hash，Next layout/_app 等约定依赖。
  - [ ] 显式 source/glob、样式/资源/翻译纳入图。
  - [ ] 未解析动态依赖标 partial/broad impact。
  - [ ] 保存旧新图并输出失效原因。
- [ ] **P1-06 Project Store 和索引 revision**（依赖 P1-01/03/05）
  - [ ] snapshot/current 提交、工作副本导入和回填。
  - [ ] owner lock、CAS、独立进程并发冲突检查。
  - [ ] 过期索引重建，capture 不全量重写页面定义。
  - [ ] 指针切换前后故障恢复测试通过。
- [ ] **P1-04 旧项目迁移**（依赖 P1-01/02/03/06）
  - [ ] dry-run 清单、固定 ID 映射、输入 hash。
  - [ ] 备份、apply journal、重复执行、故障恢复。
  - [ ] legacy verified→明确 unknown，不伪造验证。
  - [ ] 路径/sidecar 冲突和认证 alias 迁移验证。
- [ ] **P1-08 FactPack 与结构化渲染**（依赖 P1-02/03/06）
  - [ ] 统一步骤、claim、artifact 和 factsHash。
  - [ ] 模型只能修改允许文案块，业务动作确定性渲染。
  - [ ] zh-CN/en-US 模板和旧 Markdown 兼容验证。
  - [ ] stale draft、否定动作、单位变化等反例通过。
- [ ] **P1-07 发布 journal / release**（依赖 P1-02/06/08）
  - [ ] prepare/asset/doc/release/current 提交状态。
  - [ ] old/new doc hash 对账及第三种内容冲突。
  - [ ] 正式验证不再依赖可变 drafts。
  - [ ] 每个边界杀进程和重复恢复测试通过。
- [ ] **Gate 1：迁移可重复、重跑合法、证据不可变、并发不丢更新、发布可对账。**

## Phase 2 — Runtime / cache / resume

详细步骤：[Phase 2](2026-09-24-living-manual-phase-2.md)。推荐顺序：01 → 04 → 05 → 02 → 03 → 06 → 07 → 08。

- [ ] **P2-01 Run Store 与统一错误**（依赖 Gate 1）
  - [ ] Run/Task schema、状态机、attempt/outputRefs。
  - [ ] task snapshot 为恢复依据，events 为诊断。
  - [ ] 日志去敏、损坏末行处理和本地产物 ignore。
  - [ ] 错误 code/scope/retryability 保留完整。
- [ ] **P2-04 BrowserSession**（依赖 P2-01）
  - [ ] Browser ownership 与 Context 创建拆分。
  - [ ] Scenario/角色隔离及 page/popup alias。
  - [ ] Provider capabilities 与 auth 刷新接线。
  - [ ] 1 Browser/3 Context 计数、崩溃和清理测试通过。
- [ ] **P2-05 分层缓存**（依赖 P2-01）
  - [ ] source/capture/image/manual 独立 key 与 policy。
  - [ ] hash/scope/privacy/TTL 检查和 miss reason。
  - [ ] offline/refresh/no-cache 语义和 observedAt 保留。
  - [ ] 身份、DPR、模板、privacy 变化命中矩阵通过。
- [ ] **P2-02 Planner DAG**（依赖 P2-01/05）
  - [ ] 显式 target 解析和歧义处理。
  - [ ] 缺口→节点、共享去重、拓扑检查。
  - [ ] plan 固定 scope/revision，gate 处理已有授权。
  - [ ] 同输入同计划，--plan 零业务副作用。
- [ ] **P2-03 Runner**（依赖 P2-01/02/04）
  - [ ] 命令拆应用用例，handler 不 spawn 子 CLI。
  - [ ] 持久状态→执行→产物校验→成功。
  - [ ] 有界 retry/time/action budget、cancel 和 waiting_input。
  - [ ] 失败不重跑已提交依赖、不越过发布门槛。
- [ ] **P2-06 模型文件交接**（依赖 P2-01/03）
  - [ ] request/response schema 和 inputHash 绑定。
  - [ ] 文案字段约束，语义结果保持 source/model 来源。
  - [ ] 超时重试只作用模型任务，等待时释放资源。
  - [ ] 跨会话提交、幂等和旧响应拒绝测试通过。
- [ ] **P2-07 CLI 和 Skill 编排**（依赖 P2-02/03/04/05/06）
  - [ ] generate 自动规划，capture 只产证据。
  - [ ] status/resume/run-submit 及兼容 wrapper。
  - [ ] JSON/退出码/help/alias 对齐。
  - [ ] Skill 将状态/cache/retry 决策交给 Runtime。
- [ ] **P2-08 中断恢复矩阵**（依赖 P2-01～07）
  - [ ] 独立子进程故障注入与锁/租约恢复。
  - [ ] inputHash/output integrity 对账。
  - [ ] 写操作 outcome_unknown 禁止盲目重放。
  - [ ] 六个 checkpoint 和全部错误分类恢复验收。
- [ ] **Gate 2：一条 generate 自动补依赖，新进程 resume，缓存理由与验证范围可解释。**

## Phase 3 — update / live verify / CI

详细步骤：[Phase 3](2026-09-24-living-manual-phase-3.md)。推荐顺序：01 → 06 → 02 → 03 → 04 → 05 → 07 → 08。

- [ ] **P3-01 Git changes / impact**（依赖 Gate 2）
  - [ ] NUL Git 输出、rename old/new、dirty/untracked。
  - [ ] 旧新图 union 与全局依赖保守扩散。
  - [ ] Page→Scenario→Section 可解释影响路径。
  - [ ] 非 Git/无基线/不完整依赖明确回退。
- [ ] **P3-06 ManualSection / 编辑保护**（依赖 Gate 2）
  - [ ] 稳定 section/block ID 与 ownership。
  - [ ] 旧/当前/新三方比较和自由编辑保护。
  - [ ] 冲突保存 proposed diff、等待输入。
  - [ ] 文档移动/手工删除不静默覆盖。
- [ ] **P3-02 update CLI**（依赖 P3-01/06）
  - [ ] --plan 只读，执行复用 Runtime。
  - [ ] 仅更新受影响 section/文件，失败保留旧版。
  - [ ] retired 提案、无变化零写入、避免自触发。
  - [ ] 增量端到端测试通过。
- [ ] **P3-03 live verify**（依赖 P3-01）
  - [ ] artifact/live 范围分开，新验证记录不可变。
  - [ ] 每次 live 真实导航，按 claim/Scenario 回放。
  - [ ] 风险边界和未验证覆盖明确报告。
  - [ ] 无 Git diff 的 API/权限变化检测通过。
- [ ] **P3-04 语义/视觉漂移**（依赖 P3-03）
  - [ ] 安全文本摘要及可比较环境检查。
  - [ ] 像素差异、动态区域和分类报告。
  - [ ] baseline 不自动接受，关键断言不能被 mask 跳过。
  - [ ] 按钮改名、位移、时钟、环境不同测试通过。
- [ ] **P3-05 Fixture / 多角色**（依赖 P3-03）
  - [ ] 登记 hook/mock、环境 allowlist、run namespace。
  - [ ] setup/cleanup RuntimeTask 与恢复。
  - [ ] simulated provenance 和 cache 隔离。
  - [ ] 生产拒绝、角色隔离、清理失败报告测试通过。
- [ ] **P3-07 CI / 安装 / 性能**（依赖 P3-02/03/04/05/06）
  - [ ] Windows/Linux、固定 Node/browser/fonts。
  - [ ] 干净安装 smoke 和私有诊断 artifact 策略。
  - [ ] 冷/热/局部更新调用数与耗时报表。
  - [ ] 全量回归在矩阵环境通过。
- [ ] **P3-08 保留策略和文档收尾**（依赖 P3-01～07）
  - [ ] 引用图 roots、gc dry-run/apply 再校验。
  - [ ] 已引用资源保留、raw 清理后重采集说明。
  - [ ] 兼容退出、迁移/Runtime/Skill/README 对齐。
  - [ ] 全部最终场景验收和未实现项说明。
- [ ] **Gate 3：定向 update、在线漂移检测、编辑保护、跨平台 CI 和保留策略全部通过。**

## 建议的首批三个交付包

| 包 | 任务 | 交付价值 |
|---|---|---|
| 可信发布基础 | P0-08、P0-01、P0-02、P0-03、P0-04、P0-05 | 先阻止错误成功与发布 |
| 可追溯证据 | P0-06、P0-07、Phase 1 | 证据不可变、重跑合法、迁移和发布可恢复 |
| 自动维护闭环 | Phase 2、Phase 3 | generate 自动依赖、resume/cache/update/live verify |

交付包不改变逐任务依赖，不意味着一个包必须合成一条巨大提交。

## 执行记录模板

```text
Task ID:
状态: pending / in_progress / blocked / completed
开始时基线 commit / dirty files:
实际修改文件:
契约变更（无则写无）:
执行命令与结果:
失败或跳过的验收及原因:
产物 / commit 引用:
剩余风险:
下一项可执行任务:
```

## 当前记录

- 2026-09-24：已编写总计划、契约、四阶段实施任务和本 TODO。
- 工程实施：Phase 0 完成 8 / 32，Gate 0 已通过（2026-09-24）；按约定在进入 Phase 1 前暂停审阅。下一项：P1-01。

### 执行记录

```text
Task ID: P0-08
状态: completed
开始时基线 commit / dirty files: 7ea73b8；用户未提交修改 README.md、SKILL.md、docs/ARCHITECTURE.md、test/compat-aliases.test.js、preserved-from-neoagent-worktree-2026-09-18/（均不纳入本任务提交）
实际修改文件: package.json、package-lock.json、bin/manual.js、src/cli/commands.js（新）、src/compat/aliases.js、src/browser/playwright.js、src/commands/doctor.js（新）、test/doctor.test.js（新）、test/run.js
契约变更: 无。engines.node 由 >=18 提升为 >=20.9.0（playwright 1.63.0 要求 >=20，sharp 0.35.4 要求 >=20.9.0；Node 18 已 EOL）。
执行命令与结果:
  - 基线 npm test（Node 22.14.0 / npm 10.9.2，使用 ~/gstack 中 playwright 1.58.2）：22 个测试文件全部通过。
  - npm install --save-exact playwright@1.63.0 sharp@0.35.4 markdown-it@15.0.2；三者均可 CommonJS require。
  - npx playwright install chromium：官方 CDN 与 storage.googleapis.com 超时；改用 PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright 成功（chromium-1243）。doctor 的修复建议包含该镜像。
  - npm ci 干净安装后 node bin/manual.js doctor --json：ok=true。
  - node test/doctor.test.js：8 passed；node test/compat-aliases.test.js：2 passed；npm test：23 个文件全部通过（Playwright 改由自身依赖加载）。
失败或跳过的验收及原因: 本任务先写实现后补测试，未严格执行"先失败再实现"；Linux 安装未在本机验证（留给 P3-07 CI）。
产物 / commit 引用: 见 git log（⬆️/✨ P0-08 提交）
剩余风险: 个人目录 Playwright 搜索仅在 MANUAL_PLAYWRIGHT_LEGACY_SEARCH=1 时启用，依赖旧行为的环境需先 npm ci。
下一项可执行任务: P0-01
```

```text
Task ID: P0-01
状态: completed
开始时基线 commit / dirty files: 2dd6351；用户未提交修改同 P0-08（不纳入提交）
实际修改文件: src/publication/paths.js（新）、src/generate/task-draft.js、src/generate/task-facts.js、src/generate/draft.js、src/generate/facts.js、src/commands/generate-task.js、src/commands/generate.js、src/commands/verify.js、src/privacy/publication.js、test/publication-paths.test.js（新）、test/generate-task.test.js、test/task-first-e2e.test.js、test/run.js
契约变更: 无（实现 C05）。facts.images 由字符串改为 {artifactPath, markdownHref}；旧字符串 facts 返回 legacy-image-facts，要求重新生成草稿。
执行命令与结果:
  - 先红：新 e2e 断言在旧源码上失败（正式文档写入 docs/manual/images/annotated/... 项目根路径）。
  - node test/publication-paths.test.js：8 passed（含 Windows junction 逃逸、保留快照临时副本）。
  - node test/generate-task.test.js：8 passed；node test/generate.test.js：28 passed；node test/task-first-e2e.test.js：2 passed。
  - npm test：24 个文件全部通过。
失败或跳过的验收及原因: 无。符号链接用例在无权限环境会标 skip（本机 junction 已实际执行）。
产物 / commit 引用: 见 git log（P0-01 提交）
剩余风险: 页面发布根暂为 docs.outputDir；public 只允许 annotated 与 raw 移出 docs 由 P0-02 收紧。保留快照中的 facts 为旧格式，需重新 generate-task 才能 verify。
下一项可执行任务: P0-02
```

```text
Task ID: P0-02
状态: completed
开始时基线 commit / dirty files: 7258437；用户未提交修改同上（不纳入提交）
实际修改文件: src/publication/validate.js（新）、src/util/hash.js（新）、src/commands/generate.js、src/commands/generate-task.js、src/commands/verify.js、src/commands/migrate-artifacts.js、src/config/schema.js、src/config/load.js、src/config/render.js、src/generate/draft.js、src/generate/task-draft.js、src/tasks/executor.js、test/publication-gates.test.js（新）、test/generate.test.js、test/generate-task.test.js、test/capture.test.js、test/init.test.js、test/migrate-artifacts.test.js、test/run.js
契约变更: 无（实现 C05 发布检查顺序与 C04 privacy 字段）。src/util/hash.js 提供 C01 canonical 的最小实现，P1-01 扩展。
执行命令与结果:
  - 先红：publication-gates 的 3 个 CLI 用例在接线前失败（草稿 facts 无 hash/privacy、缺 privacy 未阻止）。
  - node test/publication-gates.test.js：11 passed；node test/migrate-artifacts.test.js：3 passed；generate：30 passed；generate-task：8 passed；capture：34 passed；init：34 passed。
  - npm test：25 个文件全部通过。
行为变更（有意）:
  - 默认 rawDir 改为 .manual/artifacts/raw/pages；旧配置仍可读取，load 给出 legacy-raw-reference 警告。
  - 页面只有原图时 generate 返回 unsafe-page-artifact 并阻止带图草稿；文字版（--no-screenshot）可用。页面发布图由 P0-06 管线产出（page.browser.published）。
  - 任务证据每张截图记录 privacy（buildPrivacyRecord）；草稿 facts.images 记录 sha256 与 privacy；finalize/verify 重新校验 hash、位置与隐私。
  - migrate-artifacts 输出 pending/complete，不声称复制即完成迁移。
失败或跳过的验收及原因: 页面带图的改截图路径/删截图两条 CLI 用例改为 compareFacts 单元用例 + "凭空加入截图" CLI 用例；P0-06 页面发布图就绪后恢复为 CLI 端到端用例。
产物 / commit 引用: 见 git log（P0-02 提交）
剩余风险: 页面发布在 P0-06 前只能文字版；task privacy 记录的 coverage 仅为 declared-dom。
下一项可执行任务: P0-03
```

```text
Task ID: P0-03
状态: completed
开始时基线 commit / dirty files: 10bebf9；用户未提交修改同上（不纳入提交）
实际修改文件: src/evidence/validate-page.js（新）、src/commands/capture.js、src/commands/capture-task.js、src/tasks/executor.js、src/tasks/capture-plan.js、src/browser/playwright.js、src/browser/provider.js、src/browser/errors.js、src/inspect/store.js、test/page-validation.test.js（新）、test/server.js、test/run.js
契约变更: 无（实现 C04 Validation.scope 与 C08 分类错误）。新增 REASON：readiness-timeout、unexpected-redirect、soft-not-found、unexpected-page-state、page-identity-failed。
执行命令与结果:
  - 先红：仅回退 capture.js/playwright.js 时，软 404、Loading 不结束、错误提示、跨 origin、--wait-for 超时、身份断言 6 个真浏览器用例在旧代码上"成功截图"。
  - node test/page-validation.test.js：19 passed；capture-plan 4、task-executor 3、capture 34、capture-task 1、task-first-e2e 2 均通过。
  - npm test：26 个文件全部通过。
行为变更（有意）:
  - --wait-for 超时由 warning 改为 readiness-timeout 失败，不截图。
  - 页面结果以等待后重新读取的 URL/页面事实为准（provider.currentObservation）。
  - capture 按 page.states.default 的非 URL 断言验证页面身份，记录 browser.identity（verified / url-only）与 actualRoute。
  - 任务执行顺序：入口导航与身份 → before 断言 → 动作 → after 断言 → 截图；before 失败动作 0 次；只有 URL 断言的 after 状态记为 observed。
  - 截图计划拒绝没有断言的状态。
  - inspect/store 序列化补上 browser.actualRoute/identity/published（P0-02 的 published 此前会在写回时丢失）。
失败或跳过的验收及原因: 无。
产物 / commit 引用: 见 git log（P0-03 提交）
剩余风险: 软 404 / 错误提示为启发式检测（标题/h1 文本、role=alert、aria-busy），无法覆盖所有页面；有声明的身份断言才是可靠依据。
下一项可执行任务: P0-04
```

```text
Task ID: P0-04
状态: completed
开始时基线 commit / dirty files: 35bc3c2；用户未提交修改同上（不纳入提交）
实际修改文件: src/evidence/claims.js（新）、src/evidence/validate-page.js、src/tasks/model.js、src/tasks/executor.js、src/generate/task-draft.js、src/generate/task-facts.js、test/completion-claims.test.js（新）、test/generate-task.test.js、test/task-first-e2e.test.js、test/run.js
契约变更: 无（实现 C03 completionClaims.assertionRefs 与 C04 claim 验证规则）。completion.verification 改为可选旧字段，不再影响验证等级。
执行命令与结果:
  - 先红：completion-claims 8 个用例中 5 个在实现前失败（模型不校验 claims、草稿仍按字符串渲染、边界后步骤缺失等）。
  - node test/completion-claims.test.js：8 passed；task-executor 3、generate-task 8、task-first-e2e 2 通过（e2e 中保存未执行时"编辑器已打开"为已验证、"资料已保存"为预期）。
  - npm test：27 个文件全部通过。
行为变更（有意）:
  - 完成标志按 claim 渲染：<!-- claim:id --> + 已验证界面结果 / 预期业务结果；并标注验证范围。
  - 旧任务（无 claims）转为 legacy-unbound，一律渲染为预期业务结果，即使 verification: verified。
  - facts 以 claims（含 status、assertionRefs、evidence）替代 completionVerification；旧 facts 要求重新生成。
  - validation 记录 assertionId/scope/phase/stepId/checkedAt；风险停止后余下步骤记录 skipped-by-boundary。
失败或跳过的验收及原因: 无。
产物 / commit 引用: 见 git log（P0-04 提交）
剩余风险: 断言 id 未显式声明时为 <page>:<state>#<index>，状态中调整断言顺序会改变 id；P1-01 引入稳定 assertionId 校验。
下一项可执行任务: P0-05
```

```text
Task ID: P0-05
状态: completed
开始时基线 commit / dirty files: f16cd02；用户未提交修改同上（不纳入提交）
实际修改文件: src/util/atomic-write.js（新）、src/util/fsx.js、src/generate/task-draft.js、src/commands/generate-task.js、src/commands/generate.js、src/commands/verify.js、test/atomic-write.test.js（新）、test/finalize-safety.test.js（新）、test/run.js
契约变更: 无（实现 C10 中单文件 temp + rename 的部分；多文件 journal 仍属 P1-07）。
执行命令与结果:
  - 先红：finalize-safety 9 个用例中 7 个在接线前失败（candidate/approved/stale/verified/generated 状态下正式文档仍被改写；file-busy、partial-commit 无报告）。
  - node test/atomic-write.test.js：7 passed（write/fsync/rename 故障注入、EPERM 重试后 file-busy、不删除目标）。
  - node test/finalize-safety.test.js：9 passed（Windows 只读文件模拟占用；POSIX 上这两条会 skip）。
  - npm test：29 个文件全部通过。
行为变更（有意）:
  - generate-task finalize 先计算状态流转并完成全部校验，才替换正式文档；状态非法时文档字节不变。
  - fsx.writeText 与 publishAtomic 统一为唯一 temp + fsync + rename；不再使用固定 .tmp 名。
  - 文档已替换但任务状态写入失败时返回 code=partial-commit 与 committed 列表。
  - verify 拆为 load / prepareVerify（只读）/ commit；generate-task、verify 已从单行压缩格式拆分为小函数。
失败或跳过的验收及原因: "文件占用"用例依赖 Windows 只读属性阻止 rename，POSIX 上 skip（原子写单元测试用注入的 EPERM 覆盖同一分支）。
产物 / commit 引用: 见 git log（P0-05 提交）
剩余风险: partial-commit 只报告不自动对账，需 P1-07 journal；auth/cache.js 仍用自己的原子写实现（P0-07 统一）。
下一项可执行任务: P0-06
```

```text
Task ID: P0-06
状态: completed
开始时基线 commit / dirty files: 2397bd7；用户未提交修改同上（不纳入提交）
实际修改文件: src/evidence/image-pipeline.js（新）、src/evidence/capture-safe.js（新）、src/tasks/executor.js、src/commands/capture.js、src/browser/playwright.js、src/browser/errors.js、src/privacy/detector.js、test/image-pipeline.test.js（新）、test/task-executor.test.js、test/generate.test.js、test/artifacts.test.js、test/server.js、test/run.js
契约变更: 无（实现 C06）。src/privacy/geometry.js、renderer.js、artifacts/annotation.js 无需修改（renderer 的 DEFAULT_MOSAIC 被管线复用）。
执行命令与结果:
  - 先红：image-pipeline 的执行器用例在接线前 4 个失败（沿用动作前矩形、无 geometry-unstable、无 derivedFromRawHash 等）。
  - node test/image-pipeline.test.js：11 passed（纯红 raw 像素级校验 DPR=1/2、遮罩完全覆盖、raw 字节不变；真浏览器页面采集 DPR=1/2/整页，视口外邮箱在整页中按文档坐标遮罩）。
  - generate 35 passed（恢复 P0-02 暂缓的带图 CLI 用例：改截图路径、删截图、草稿后替换发布图 hash-mismatch）；artifacts 10、capture 34、task-first-e2e 2 通过。
  - npm test：30 个文件全部通过。
行为变更（有意）:
  - 浏览器只做 collectGeometry + 一次 raw 截图；sanitized/发布图由 sharp 在同一份 raw 上合成，provider.renderEvidence（DOM 覆盖层二次截图）已移除。
  - 截图前后 mutation generation/滚动/尺寸不一致时丢弃重试，3 次后 geometry-unstable；Playwright 截图隐藏光标造成的表单控件 style 变化不计入。
  - 标注目标在截图时刻重新定位，找不到返回 annotation-target-missing。
  - 隐私检测未通过（无几何的高风险项 → unresolved）时只写私有 sanitized，不向文档目录写发布图。
  - 页面 capture 产出 docs/manual/images/annotated/page--<id>.png 与 page.browser.published（sha256、privacy、derivedFromRawHash、geometryHash、rendererVersion）。
  - detector：含省略号的文字仍按手机号/邮箱片段检测；整段已脱敏才跳过语义判断。
失败或跳过的验收及原因: 无。黄金图只覆盖固定夹具，不推导任意页面像素确定性；iframe/canvas/shadow DOM 仍需显式遮罩（未实现，coverage 仍标 declared-dom）。
产物 / commit 引用: 见 git log（P0-06 提交）
剩余风险: 发布图文件名仍按页面/步骤命名（非内容 hash），重采集会覆盖旧文件——旧草稿会因 hash-mismatch 被阻止而非误用；内容寻址在 P1-02。
下一项可执行任务: P0-07
```

```text
Task ID: P0-07
状态: completed
开始时基线 commit / dirty files: c7aab8f；用户未提交修改同上（不纳入提交）
实际修改文件: src/auth/identity.js（新）、src/auth/cache.js、src/auth/runtime.js、src/auth/session.js、src/commands/auth.js、src/commands/doctor.js、src/browser/playwright.js、src/config/load.js、src/config/schema.js、src/config/render.js、test/auth-identity.test.js（新）、test/auth-command.test.js、test/run.js
契约变更: 无（实现 C09 中"认证快照 generation 用于刷新 CAS、身份 revision 用于语义隔离"）。配置新增 auth.identityAssertions、auth.capabilities（默认 cookies/localStorage）。
执行命令与结果:
  - 先红：回退 auth 相关源码后 auth-identity 12 个用例中 9 个失败（含真浏览器：auth.enabled=false 时仍注入有效 cookie 访问受保护页）。
  - node test/auth-identity.test.js：12 passed；auth-cache 7、auth-command 5、auth-session 2、doctor 8 通过。
  - npm test：31 个文件全部通过。
行为变更（有意）:
  - auth.enabled=false 或 profile=anonymous：不读取、不注入、不刷新缓存；auth status 返回 disabled，login 拒绝。
  - auth status 的 status 由 ready 改为 stored/missing/corrupt，并输出 storageStatus、validationStatus、lastValidatedAt、cookieExpiry。
  - 登录后在 verifyPath 执行 auth.identityAssertions，通过才记 validatedAt；未配置时保存为 unvalidated 并给出提示。
  - 缓存信封新增 generation/identityRevision/validatedAt；写入加 profile 锁（残留锁 30s 后清理），刷新使用 generation CAS，冲突时丢弃较旧快照；刷新前确认未回到登录页。
  - capabilities 显式声明，支持 indexedDB（Playwright storageState），sessionStorage 报 capability-unavailable。
  - doctor 新增 auth:permissions：POSIX 检查 0700/0600，Windows 只报告继承用户 ACL（未逐项验证）或共享目录风险。
失败或跳过的验收及原因: POSIX 权限断言在 Windows 上走 ACL 分支，未在 Linux 实机运行（留给 P3-07 CI）。
产物 / commit 引用: 见 git log（P0-07 提交）
剩余风险: 登录流程的身份断言需要用户在 config 中声明；cookie 到期只是预检查信号。
下一项可执行任务: Gate 0 集成验收
```

```text
Task ID: Gate 0
状态: completed
开始时基线 commit / dirty files: e85ba3f；用户未提交修改同上（不纳入提交）
实际修改文件: test/gate0.test.js（新）、test/run.js
执行命令与结果:
  - node test/gate0.test.js：6 passed —— 干净 public 项目中页面流程（init→inspect→describe→capture→generate→finalize）与任务流程（候选→审批→计划→采集→生成→定稿→verify）；
    markdown-it 实际渲染全部正式文档，图片按文档位置均可打开且都在 annotated 目录；docs 中无任何原图；
    删除 privacy 记录、替换发布图、把预期结果改为已验证均使 verify 失败；HTTP 500 采集失败不截图。
  - npm ci 后 node bin/manual.js doctor --json：ok=true。
  - npm test：32 个测试文件全部通过，无 skip（Windows 11 / Node 22.14.0）。
Gate 0 对照: 1 页面端到端 ✓；2 任务入口/before/after/completion 与错误 HTTP、缺断言 ✓（page-validation、completion-claims）；3 篡改无法发布 ✓；4 非法 finalize / rename 失败旧字节不变 ✓（finalize-safety、atomic-write）；5 npm test + 渲染冒烟 ✓。
未覆盖: Linux 环境未运行（P3-07 CI）；README/SKILL/ARCHITECTURE 中与新行为相关的说明未更新（这些文件有用户未提交修改，未触碰）。
下一项可执行任务: P1-01（需用户审阅后再启动 Phase 1）
```
