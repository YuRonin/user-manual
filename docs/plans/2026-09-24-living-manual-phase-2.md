# Phase 2：持久化 Runtime、Browser 复用、缓存与恢复

> 前置：Phase 1 集成验收通过。入口：[总计划](2026-09-24-living-manual-optimization-plan.md)，契约：[C07～C11](2026-09-24-living-manual-contracts.md)，进度：[TODO](2026-09-24-living-manual-todo.md)。

建议顺序：P2-01 → P2-04 → P2-05 → P2-02 → P2-03 → P2-06 → P2-07 → P2-08。先串行执行和故障恢复，最后才考虑并发优化。

## P2-01：Run Store、任务状态与事件记录

**Files**

- Create: src/runtime/model.js、src/runtime/store.js、src/runtime/events.js、src/runtime/errors.js、test/run-store.test.js、test/runtime-errors.test.js。
- Modify: src/config/render.js、src/config/load.js、test/run.js。

**实施步骤**

1. 定义 Run envelope：schemaVersion/id/command/target/projectId/modelRevision/planHash/status/tasks/createdAt/updatedAt/budget；每个 Task 保存 inputHash、attempt、outputRefs、error。
2. 使用明确 transition 表校验 C07 状态；succeeded 无有效 outputRefs/integrity 不能接受；failed 重试必须创建新 attempt，保留上次错误摘要。
3. createRun 先写计划与任务定义再发布 run.json；plan 不可变，调整输入建立新 plan/revision，不悄悄改在跑任务。
4. 每个 Task 开始动作前保存 running；成功产物已提交后才保存 succeeded。若进程在两者之间死亡，恢复通过 output integrity/idempotency key 对账。
5. events.jsonl 逐事件 append，最后一行部分写入可截断读取；丢日志不阻止以 task snapshot 恢复。日志不是唯一状态源。
6. 事件白名单字段包含 run/task/page/scenario/capture/attempt/phase/duration/result/code/cache reason；异常 message 去敏，禁止直接序列化浏览器对象或请求体。
7. .manual/.gitignore 增加 runs、drafts 中敏感模型交接、diagnostics、publication staging 等本地产物；可分享 run report 另作去敏导出。
8. 实现错误 mapper：既保留 CaptureError.reason，也保留 TaskExecutionError.code，避免现在任务异常统一丢成 state-assertion-failed。

**验证**

```powershell
node test/run-store.test.js
node test/runtime-errors.test.js
```

**完成条件：** 新进程可只读文件还原任务进度；日志损坏不改项目事实；执行状态与错误含义一致。

## P2-02：确定性 Planner 和依赖 DAG

**依赖：** P2-01、P2-05。

**Files**

- Create: src/runtime/planner.js、src/runtime/resolve-target.js、test/runtime-planner.test.js。
- Modify: src/tasks/capture-plan.js、src/inspect/index-store.js、test/run.js。

**实施步骤**

1. target resolver 支持 page:、task:、manual:、scenario:；无前缀唯一命中可自动解析，多重命中返回 ambiguous-target，列候选但不随意选。
2. planner 输入已固定 snapshot、command、target、策略及 cache decisions；输出纯 JSON DAG，禁止在 plan 函数里访问浏览器或改模型。
3. 根据缺口建立 inspect/analyze/capture/derive-image/draft/rewrite/validate/publish 节点；合并同 Scenario/checkpoint/inputHash 的共享采集，避免两篇文档重复截图。
4. 缓存命中将节点标为 reuse candidate，执行前仍检查完整性；不是在计划里提前把所有任务写 succeeded。
5. 拓扑排序并检查循环、未知依赖、重复 ID、输入修订冲突；对原因输出 dependency reason，例如 source-changed→capture-required。
6. approvals/schema/capability 作为 plan gate；需要新授权则输出 waiting_input 节点，已确认 scope 不重复询问。
7. capture plan 内嵌 scopeHash、definition revision 与 scenario revision；执行使用这份固定 plan，不在 capture-task 里无声重建不同内容。
8. generate --plan 输出 action summary、风险边界、预计需浏览器的场景数、命中原因，不承诺精确耗时。

**计划例子**

```text
inspect-delta → analyze-dashboard → capture-member-default
                                      ↓
                              derive-published-image
                                      ↓
                              draft-dashboard → rewrite-dashboard
                                      ↓                 ↓
                                      └──── validate ───┘
                                               ↓
                                            publish
```

validate 的实际依赖同时包含 facts、rewrite 和图像；无模型的 deterministic-only 路径依赖 draft，不能出现循环。

**验证**

```powershell
node test/runtime-planner.test.js
node test/capture-plan.test.js
```

**完成条件：** 相同输入得到相同 DAG/hash；缺少必要证据必有 capture；已知有效证据能复用；计划打印本身不产生业务动作。

## P2-03：串行 Runner、重试与命令用例接线

**依赖：** P2-01、P2-02、P2-04。

**Files**

- Create: src/runtime/runner.js、src/runtime/handlers.js、src/runtime/retry.js、test/runtime-runner.test.js。
- Modify: src/commands/inspect.js、src/commands/capture.js、src/commands/capture-task.js、src/commands/generate.js、src/commands/generate-task.js、test/run.js。

**实施步骤**

1. 从命令 run(argv) 提取可调用的应用用例；run 只 parse/output。handler 调用用例，不通过 spawn CLI 再解析 stdout 作为内部接口。
2. runner 每次挑选依赖全部成功的 pending Task；保存 running，执行 handler，验证 outputRefs，再保存 succeeded。
3. handler 返回 {outputs,validations,warnings} 或统一 error；所有 browser/fs 时限由 task/run budget 约束，避免单步骤最多等 30s 叠成无限总时长。
4. retry policy 按 code 和 replay 分类，最多 3 attempts；只重试失败任务，不重新执行已提交输入一致的前置任务。
5. capture handler 出错确保 Context close；publication 交由已有 journal 对账；不得把之前半完成输出作为成功返回。
6. waiting_input 将后续依赖保留 pending，释放 Browser/项目锁并结束本次执行；Run 不占着内存等待无限消息。
7. 模型/用户输入之外的失败阻止依赖发布；互不依赖目标可以记录各自结果，但初期依次执行。
8. 加 cancellation signal，通过 AbortController/显式 provider close 实现；不可中断库调用仍受最外层 task timeout 约束并将结果标不确定。

**验证**

```powershell
node test/runtime-runner.test.js
node test/run-store.test.js
node test/task-first-e2e.test.js
```

**完成条件：** 失败传播、等待输入和重试可预测；模型步骤失败不重新 capture；没有未持久化的跨命令关键进度。

## P2-04：BrowserSession 与 Context 生命周期

**依赖：** P2-01、P0-07。

**Files**

- Create: src/browser/session.js、src/browser/capabilities.js、test/browser-session.test.js。
- Modify: src/browser/playwright.js、src/browser/provider.js、src/browser/index.js、src/tasks/executor.js、src/auth/runtime.js、test/run.js。

**实施步骤**

1. 把 PlaywrightBrowserProvider.launch 的 browser 创建和 context 创建拆开；factory 可注入 borrowed Browser，记录 ownership，close scenario 不能误关共享 Browser。
2. BrowserSession 按 engine/channel/headless/launch args 兼容组创建 Browser；同 Run 不兼容规格可用不同 Browser，不能复用错误 headless/channel。
3. 每个独立 Scenario 新 Context，注入指定 auth snapshot、viewport、DPR、locale、timezone、colorScheme；同 Scenario 多步和 popup 保持流程内关联。
4. 维护 page alias，导航/弹窗动作显式选择目标；不能默认每次 locator 都作用于旧 Page。
5. Context finally close；Run finally close Browser；Browser 崩溃标记该 Browser 下运行任务 interrupted，下一次安全重放创建新进程。
6. Provider capabilities 明确 capture/semanticActions/assertions/storageExport/privacyGeometry；planner 在执行前检查，不依赖 hasMethod 的隐式猜测。
7. 默认不使用 persistent userDataDir。特殊 SSO opt-in 单独适配，锁定专用目录，禁止共享普通用户浏览器 profile；CI 不默认启用。
8. auth refresh 在 Scenario 正常结束且身份仍正确时执行；共享后端写隔离由 fixture/账号控制，Context 不替代该控制。

**验证**

```powershell
node test/browser-session.test.js
node test/auth-session.test.js
node test/capture-task.test.js
```

**验收数字：** 同 launch 规格下，3 个独立 Scenario 产生 1 次 Browser launch、3 个 Context、3 次 Context close、1 次 Browser close；member/admin 间 cookies/localStorage 不混用。

## P2-05：分层缓存与失效解释

**依赖：** P2-01、P1-02、P1-05、P1-08。

**Files**

- Create: src/cache/keys.js、src/cache/store.js、src/cache/policy.js、src/cache/lookup.js、test/cache-keys.test.js、test/cache-policy.test.js。
- Modify: src/config/schema.js、src/config/load.js、src/evidence/integrity.js、src/inspect/fingerprint.js、test/run.js。

**实施步骤**

1. 实现 C09 四类 key 的独立 builder，字段白名单固定；没有 deployedBuild/dataRevision 时记录 unknown，不能用空字符串假装确定。
2. cache index 保存 key→immutable outputRefs/inputSummary/observedAt/validation scopes，不复制 Credential 或可变图片。
3. lookup 顺序：key→schema/version→文件存在/hash→scope→privacy policy→freshness。每步 miss 给 reason 和 changedFields。
4. 注入 clock 测试 TTL 边界；默认 live Capture 15 分钟软 TTL，固定 fixture 按内容版本；身份验证按 C09 策略。
5. --offline 允许历史证据生成并标 onlineChecked=false；无证据报 cache-miss-offline；不得伪装本次验证。
6. --refresh 跳过 Capture/生成结果复用但仍可复用 auth；--no-cache 禁止结果读取和写入的具体语义写清，不能顺便删除历史 Capture。
7. privacy policy 改变优先复用 raw 重派生；raw 已清理则必须重采集。模板变化只重建文档，不默认重拍。
8. concurrent cache 写入用原子替换/内容寻址；损坏索引可删除重建，不损坏 canonical Capture。
9. 命中结果报告 observedAt/reusedFrom/inputHash；TTL 内命中不写新的 observedAt。

**验证**

```powershell
node test/cache-keys.test.js
node test/cache-policy.test.js
node test/capture-store.test.js
```

**完成条件：** 角色、租户、DPR、语言、浏览器、Scenario 任一关键输入变化不能误命中；图被替换检测失败；纯文案变化不强迫 Browser 启动。

## P2-06：有界模型交接与输入恢复

**依赖：** P2-01、P2-03、P1-08。

**Files**

- Create: src/runtime/model-request.js、src/runtime/model-response.js、test/model-handoff.test.js。
- Modify: src/commands/describe.js、src/commands/discover-tasks.js、src/commands/generate.js、src/commands/generate-task.js、references/manual-writing-style.md、test/run.js。

**实施步骤**

1. request 保存 requestId/runId/taskId/inputHash/schemaVersion、允许读取的文件及内容 hash、必要 facts、输出 schema、限制和 response path；不把完整仓库/原始浏览器凭据塞进上下文。
2. CLI 无内置模型时返回 waiting_input + requestFile，宿主 Agent 根据 Skill 处理后提交 response。已有 describe/discover 输入成为该机制兼容入口。
3. response 必须带 requestId/inputHash；跨任务、旧版本、缺字段或未授权字段返回 invalid-model-response，不更新模型。
4. 文案响应仅接受 allowedCopyBlocks；页面语义/候选响应标 origin=source/model 和 evidence refs，不直接 approved。
5. 模型失败保留 request 与已提交 Capture；只重试该 task attempt。总 attempts/输出大小/可访问文件数受 budget 限制。
6. 长时间等待期间模型或源码已变，提交响应时 CAS 检测并提示 replan，不把旧响应强套到新 facts。
7. request/response 可包含业务文案，默认本地私有；公开 report 只输出 hash、数量、结果。

**验证**

```powershell
node test/model-handoff.test.js
node test/fact-pack.test.js
node test/discover-tasks.test.js
```

**完成条件：** 新会话仅凭 Run 和交接文件可继续；重复提交同响应幂等；旧/错 request 响应被拒绝；模型不能修改受保护动作。

## P2-07：用户命令、兼容入口和状态展示

**依赖：** P2-02～P2-06。

**Files**

- Create: src/commands/status.js、src/commands/resume.js、src/commands/run-submit.js、test/runtime-cli.test.js。
- Modify: bin/manual.js、src/compat/aliases.js、src/commands/generate.js、src/commands/capture.js、src/commands/generate-task.js、src/commands/plan-capture.js、SKILL.md、README.md、test/run.js。

**实施步骤**

1. generate <target> 默认走 planner+runner，支持 --plan/--offline/--refresh/--json；用户不必手工串 inspect/capture/draft。
2. capture <target> 只推进到证据提交；generate-task/capture-task 作为兼容目标解析 wrapper，调用同一用例而非保留另一套实现。
3. status [runId] 显示任务 DAG 摘要、当前等待、失败 code、cache reason、产物引用；JSON 可供宿主读取。
4. resume <runId> 读取原 plan；--replan 创建 successor Run 并记录 predecessor，不修改原 Run 的历史输入。
5. run-submit <runId> --request <requestId> --input <file> 验证 P2-06 response 后解除 waiting_input；审批决定沿用 approve-tasks 的明确 scope。
6. verify 默认 artifact，--live 留给 Phase 3；help 必须说清离线不代表当前网页行为。退出码按 C08 切换并提供兼容说明。
7. Skill 缩为“解析意图→调用 command→处理 waiting_input→报告”，不在 prompt 重复实现 cache/retry/状态机。
8. README 演示最小普通用户流程，高级命令单独列出；aliases 由 registry 自动生成覆盖新命令。

**验证**

```powershell
node test/runtime-cli.test.js
node test/compat-aliases.test.js
```

**完成条件：** 一个 generate 可自动完成已授权的必要依赖；所有入口使用同一发布门槛；等待模型/登录时可结束进程后继续。

## P2-08：真正的中断恢复与故障矩阵

**依赖：** P2-01～P2-07。

**Files**

- Create: src/runtime/recovery.js、test/runtime-recovery.test.js、test/runtime-failure-matrix.test.js。
- Modify: src/runtime/runner.js、src/runtime/store.js、src/browser/session.js、src/publication/reconcile.js、test/run.js。

**实施步骤**

1. 为 handler 增加仅测试可用的 fault checkpoint：任务 running 后、raw 后、Capture commit 后、rewrite request 后、doc rename 后、release commit 后。
2. 用独立子进程运行，再 kill；恢复进程不能共享前进程内存。运行租约失效的 running 转 interrupted。
3. 按 inputHash/output integrity 判断复用：产物提交但 Task 未 succeeded 时补记成功；只有 raw staging 时从安全 Scenario 起点重采集。
4. write action 分 before-send/sent/acknowledged，sent 后没有结果记 outcome_unknown；恢复先检查业务状态，有明确幂等键/后置证据才允许受控继续。
5. SIGINT 尽力保存当前状态和关闭 Context；SIGKILL 依靠持久状态、锁/租约和残留 staging 回收。退出时不把未确认任务写 succeeded。
6. 输入已变返回 run-input-changed：保留历史，建议 successor Run；不能继续执行旧审批不涵盖的新动作。
7. 覆盖 browser launch、auth expired、selector zero/many、redirect、404、500、timeout、screenshot、privacy、model、用户取消及磁盘满；每类有预期状态和下一步。
8. 给 status 输出恢复理由和已复用/需重做任务；无变化的重复 resume 不重复发布和业务动作。

**验证**

```powershell
node test/runtime-recovery.test.js
node test/runtime-failure-matrix.test.js
node test/publication-recovery.test.js
npm test
```

**完成条件：** 至少上述六个故障点由全新进程恢复；无 duplicate write；无法确定时明确 waiting_input/outcome_unknown。

## Phase 2 集成验收

1. generate dashboard 首次完成依赖；第二次命中缓存，不新截图；记录命中原因与旧 observedAt。
2. 改模板仅生成文档；改 DPR 重采集；改 privacy 在 raw 存在时只重派生。
3. 3 个 Scenario 的 Browser/Context 计数符合 P2-04；身份不交叉。
4. Capture 完成后终止，resume 从 draft/rewrite 继续。
5. 模型响应错 inputHash 被拒绝，正确响应可由另一宿主会话提交。
6. status 可解释每个失败与未完成任务；日志中无认证值。
7. 无业务数据库写授权时，整个流程仍在 write 前停止，文档只声明已验证范围。
