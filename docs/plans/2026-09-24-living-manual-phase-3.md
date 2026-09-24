# Phase 3：增量更新、在线验证、Fixture 与 CI

> 前置：Phase 2 集成验收通过。入口：[总计划](2026-09-24-living-manual-optimization-plan.md)，契约：[C03～C05、C09～C11](2026-09-24-living-manual-contracts.md)，进度：[TODO](2026-09-24-living-manual-todo.md)。

建议顺序：P3-01 → P3-06 → P3-02 → P3-03 → P3-04 → P3-05 → P3-07 → P3-08。先实现保守可靠的影响范围，再优化精准程度。Fixture 基础引用此前已有，本阶段才增加自动 setup/cleanup。

## P3-01：Git 变更检测与旧新依赖图影响分析

**Files**

- Create: src/update/git-changes.js、src/update/impact.js、test/git-changes.test.js、test/impact-analysis.test.js。
- Modify: src/inspect/index-builder.js、src/inspect/index-store.js、src/inspect/fingerprint.js、src/tasks/staleness.js、test/run.js。

**实施步骤**

1. 临时 Git 仓库建立 A/M/D/R、含空格/中文文件、staged+unstaged、untracked 文件、无共同祖先、非 Git 目录夹具。
2. 通过 child_process.execFile('git', argv) 调用，不拼 shell；使用 --name-status -z 解析 NUL 输出，rename 同时保留 oldPath/newPath。
3. 基线优先指定 --base，其次上次 release source snapshot；本地工作树内容与基线比较包含 staged、unstaged、untracked 实际源文件。ignored generated/docs/cache 默认排除，显式源码依赖除外。
4. 旧索引和新索引 union 查询文件归属，删除/rename 不只查新索引；变更文件实际内容 fingerprint 二次确认，避免仅 Git 路径决定。
5. 遍历 file→Page→Scenario/UserTask→ManualSection；每条影响保存 reasonPath，例 [GlobalLayout.tsx,dashboard,member-default,overview]。
6. global CSS/layout/lockfile/未知 dynamic dependency 触发声明范围或全局扩散；coverage=partial 时返回 confidence=conservative，并显示扩大原因。
7. 远端 build/data 漂移不由 Git 检测完成；报告 codeImpact 和 runtimeFreshness 两个维度，后者交给 live verify/TTL。
8. 非 Git 项目使用上次内容 snapshot；无基线输出 full-rebuild-required，不返回空影响。

**验证**

```powershell
node test/git-changes.test.js
node test/impact-analysis.test.js
node test/source-fingerprint.test.js
```

**完成条件：** 删除和 rename 不漏关联；未知范围保守扩大；每个 affected section 可解释来源。

## P3-02：manual update 与局部生成

**依赖：** P3-01、P3-06。

**Files**

- Create: src/commands/update.js、src/update/plan.js、test/update-cli.test.js、test/incremental-update.test.js。
- Modify: bin/manual.js、src/runtime/planner.js、src/publication/publisher.js、src/cache/policy.js、src/compat/aliases.js、test/run.js。

**实施步骤**

1. update --plan 只读分析并显示 affected pages/scenarios/sections、cache 决策、未知依赖和文档冲突；不改 latest/正式文档。
2. update 执行创建新 Run，输入是基线 release/current source snapshot，复用 planner 的 capture/generate/validate/publish handlers。
3. 对 source changed 但 claims 未受影响的结果仍按规则验证所需 Scene；不借“文案没变”直接跳过必要浏览器检查。
4. Manual 分节拥有稳定 sectionId；仅替换受影响生成块，其他 section 字节不变。整个文件 hash 记录新版，但未影响文件不 touch。
5. Page missing/retired 对应文档默认标 pending-retirement，生成删除/重定向建议；不自动删用户文件和旧图片。
6. 每个受影响目标各自记录成功/失败，汇总 incomplete Run；只有通过验证的目标可以提交 release，失败目标保留上一版本并报告 stale。
7. update 自身生成的 docs 不作为下一轮业务源码变化，避免无限自触发；源依赖明确引用文档文件时单独处理。
8. --base 参数、无变更、非 Git 全量回退、--offline 和 --refresh 的组合给明确 help；无变化退出 0 且无正式文件写入。

**验证**

```powershell
node test/update-cli.test.js
node test/incremental-update.test.js
```

**完成条件：** 修改共享组件仅更新关联范围；未关联文档 bytes/mtime 不变；受影响失败不破坏旧版；计划可在执行前审阅。

## P3-03：在线 verify 与可重复验证记录

**依赖：** P2-08、P3-01。

**Files**

- Create: src/verify/artifacts.js、src/verify/live.js、src/verify/report.js、test/live-verify.test.js。
- Modify: src/commands/verify.js、src/runtime/planner.js、src/browser/session.js、src/evidence/store.js、test/server.js、test/run.js。

**实施步骤**

1. 保留 verify --artifacts，检查 release、文档 refs、hash、privacy、facts；返回 artifact-integrity/publication 范围，不宣称在线行为正确。
2. verify --live 基于 ManualSection 的 claim→Scenario/checkpoint 关系规划回放，恢复身份、验证 Page、执行安全动作及断言。
3. 每次 live verify 必须实际导航和断言；可复用认证和同 Run Browser，不能从旧 Capture 缓存直接返回通过。
4. 写/破坏性步骤默认不执行；相应 completion-claim 返回 not_run/inconclusive，报告验证覆盖比例和停止边界。只有明确允许的隔离 Fixture 写流程可扩展。
5. 不修改历史 Capture outcome；生成新的 verification report，记录基线 release、观察时间、输入 revisions、新证据引用和结果。
6. 404、UI 名称改变、目标消失、角色不符、步骤后置状态改变分别分类；网络故障标 verification-inconclusive，不能冒充产品回归。
7. 文档 generated/verified 状态不再是 verify 的前置条件；合法 release 可重复检查。退出码按 failure/drift/inconclusive 策略在 JSON 中明确。
8. 夹具增加“Git 无变化但 API 响应/权限改变”开关，证明 live verify 真在查运行态。

**验证**

```powershell
node test/live-verify.test.js
node test/runtime-failure-matrix.test.js
node test/task-first-e2e.test.js
```

**完成条件：** verify --live 能发现无 Git diff 的实际行为变化；报告证明验证了哪些 claim，不用单个 verified 布尔代替。

## P3-04：语义和视觉漂移报告

**依赖：** P3-03、P0-06。

**Files**

- Create: src/verify/semantic-diff.js、src/verify/visual-diff.js、test/drift-report.test.js。
- Modify: src/verify/live.js、src/verify/report.js、src/config/schema.js、test/server.js、test/run.js。

**实施步骤**

1. 语义比较使用 allowlisted 文本/角色/可见状态/route 断言的规范摘要，忽略运行日志和未经许可的个人信息；不是保存整页敏感 DOM。
2. 视觉比较只在 browser/platform/viewport/DPR/font/locale 等规格一致时执行；不一致标 baseline-incompatible，不能报告页面回归。
3. 对处理后的发布图像比较同一隐私/标注版本，避免把 renderer 升级当 UI drift；比较阈值与动态区域由项目显式配置。
4. 默认产出像素差异数量、比例、关键区域变化及 diff PNG；可以用 sharp 解码后计算，不必引入大型视觉测试系统。
5. 动态区域 mask 只用于比较，不用来跳过业务状态断言；含金额/权限/完成结果等关键区域默认不能被泛化忽略。
6. 分类：behavior-breaking、content-changed、visual-only、environment-incompatible、inconclusive；视觉轻微差异不能自动否定已验证行为，语义失败也不能被“图很像”覆盖。
7. baseline 更新必须关联新的已验证 Capture；不能在 verify 发现 diff 后自动接受自己生成的新图。

**验证**

```powershell
node test/drift-report.test.js
node test/live-verify.test.js
```

**完成条件：** 按钮改名、布局移动、时钟区域变化和浏览器规格变化得到不同报告；产物足以定位差异。

## P3-05：受控 Fixture 与多角色 Scenario

**依赖：** P2-08、P3-03。

**Files**

- Create: src/scenarios/fixtures.js、src/scenarios/policy.js、test/scenario-fixtures.test.js。
- Modify: src/scenarios/model.js、src/runtime/planner.js、src/runtime/handlers.js、src/browser/session.js、src/evidence/store.js、test/server.js、test/run.js。

**实施步骤**

1. 初期只支持两类：专用测试环境的已登记 setup/cleanup hook，以及 BrowserContext 请求拦截的静态响应；不执行来自模型的任意 shell/JS。
2. fixture 定义包含 id/version/environment allowlist、dataset reference、setup、cleanup、sideEffectClass；schema 要求明确范围。
3. setup 前验证 baseUrl/environment/tenant，生产或未登记环境直接拒绝；测试数据采用 run namespace，防止并行或历史 run 串数据。
4. setup/cleanup 是独立 RuntimeTask，记录 output token 和 revision；中断后可幂等清理，cleanup 失败显示 fixture-cleanup-required，不吞掉。
5. browser mocking 标 provenance.mode=simulated；只证明 UI 状态呈现，不能产生真实后端保存成功 claim。
6. Empty/Loading/Error/权限不同分别声明 Scenario，使用独立 Context 和对应 auth profile；同角色不同数据状态也保留独立 scenario revision。
7. Fixture 数据进入 capture key；内容改动失效。live 与 fixture Capture 不互相命中。
8. Fixture 包只引用演示值，secret 由外部 ref 注入；manifest 不记录实际认证值。

**验证**

```powershell
node test/scenario-fixtures.test.js
node test/live-verify.test.js
node test/runtime-recovery.test.js
```

**完成条件：** 生产目标无法执行 fixture setup；中断可清理；simulated 明确标识；角色和数据状态隔离。

## P3-06：ManualSection 与人工编辑保护

**依赖：** P1-07、P1-08、P2-03。

**Files**

- Create: src/generate/manual-model.js、src/generate/merge.js、src/generate/manual-store.js、test/manual-merge.test.js。
- Modify: src/generate/render.js、src/publication/publisher.js、src/inspect/index-builder.js、test/run.js。

**实施步骤**

1. 定义 Manual {id,audience,language,sections[]}，Section {id,kind,pageRefs,taskRefs,claimRefs,captureRefs,ownership}；route/page/manual 不再强制一对一。
2. 初期将旧页面文档映射为单页 overview，旧 task 文档映射为 task guide；保持现有 URL，不为了新模型强行移动文档。
3. renderer 用稳定 section/block ID 定位生成块；自由编辑区 ownership=human，生成器不得覆盖。
4. release 保存上一生成内容或可恢复 blob；merge 对 old-generated/current-edited/new-generated 做三方比较。
5. 不重叠自由文案修改可保留；同事实块、步骤或 claim 修改产生冲突，写 proposed.md/diff，Run waiting_input。
6. 手工删除/改名文档视为需要处理的外部修改，不能根据 missing 就直接重建覆盖意图；status 给出选择范围。
7. 图片 href 按最终文档位置重新计算；移动路径不改变 artifact ID 和事实身份。
8. finalize 手工调整后创建新 release，记录 accepted edits；不能直接改旧 release hash 使检查静默通过。

**验证**

```powershell
node test/manual-merge.test.js
node test/publication-recovery.test.js
node test/publication-paths.test.js
```

**完成条件：** 普通 update 不丢人工修改；冲突有具体 block 与提案；同一 Page 可参与多个任务/章节。

## P3-07：CI、干净安装与性能验收

**依赖：** P3-02～P3-06。

**Files**

- Create: .github/workflows/manual-tests.yml、test/install-smoke.test.js、test/performance.test.js、test/ci-workflow.test.js。
- Modify: package.json、test/run.js、src/commands/doctor.js、README.md。

**实施步骤**

1. 建立 Windows/Linux matrix，使用 P0-08 明确支持的 Node 版本，npm ci 后安装固定 Playwright Chromium；CI 不搜索宿主个人工具目录。
2. 单元测试和 Browser integration 分组；图像黄金图固定 OS/font/浏览器规格，在跨平台不适用时建立各自基线。
3. fixture server 端口由系统分配，认证缓存使用临时目录；失败上传去敏 report/diff，raw/trace 作为受限 artifact 且短保留期，不公开上传凭据。
4. install smoke 在只含工具包+业务 fixture 的临时目录执行 doctor/init/generate，确保不依赖仓库外 gstack。
5. 性能场景记录 cold generate、warm generate、template-only、shared-component change；断言正确的 launch/navigation/screenshot 数量，耗时仅报告中位数/分位数。
6. 建议验收预算：warm unchanged 不新增 Capture，template-only 不启动 Browser，同规格批量 Scenario 每 worker 一次 launch；具体耗时阈值以首次 CI 基线建立后再锁定。
7. CI verify failure 按退出码失败或待人工处理；禁止失败时自动接受新 baseline/自动发布旧证据。
8. workflow 仅用于测试本工具；业务站点部署与 PR 自动合并不纳入本计划。

**验证**

```powershell
node test/install-smoke.test.js
node test/performance.test.js
node test/ci-workflow.test.js
npm test
```

**完成条件：** Windows/Linux 干净安装均可执行；缓存带来可测的调用减少；失败报告可定位且无敏感数据。

## P3-08：产物保留、兼容退出与文档收尾

**依赖：** P3-01～P3-07。

**Files**

- Create: src/store/retention.js、src/commands/gc.js、test/retention.test.js、docs/MIGRATION.md、docs/RUNTIME.md。
- Modify: bin/manual.js、src/compat/aliases.js、SKILL.md、README.md、docs/ARCHITECTURE.md、references/task-workflow.md、references/manual-writing-style.md、src/config/schema.js、test/run.js。

**实施步骤**

1. 计算 roots：current releases、保留的历史 releases、活动/可恢复 Run、显式 pinned Capture；遍历引用图标记保留资源。
2. gc 默认 dry-run，输出每个拟清理对象、原因、大小和引用数；--apply 只清理计划列出的未引用对象，执行前重新核对 revision 和活动锁。
3. 默认建议：未引用 staging/diagnostics 7 天、已完成 Run 的私有日志 30 天、raw 30 天；均可配置。已引用发布图和最小去敏 Capture/release 元数据不因短 TTL 删除。
4. 删除 raw 后，记录只能验证发布 artifact 完整性、不能重新标注；下次隐私/主题修改需要重采集，不能伪造派生源。
5. 验证路径位于允许 artifact 根内，拒绝 symlink/junction 越界；Windows 使用原生路径 API，不拼 shell 递归删除。
6. 更新能力矩阵：明确 artifact/live verify、Scenario 支持范围、auth 存储能力、privacy 检测覆盖和模板语言；删除“同页必然字节相同”等错误保证。
7. 标出旧命令为 compatibility aliases，旧 schema reader 保留至少一个明确迁移窗口；本阶段只删除已无调用且测试证明可替代的重复实现，不删除旧用户产物。
8. 文档给出安装、首次登录、generate、waiting_input、resume、update、verify、迁移、故障排查完整示例；以实际 --help/JSON 为准。
9. 完成总计划最终验收；记录仍未实现的扩展（非 Next 自动扫描、跨进程 daemon、受控并发），不要混入已支持能力。

**验证**

```powershell
node test/retention.test.js
node test/compat-aliases.test.js
node test/runtime-cli.test.js
npm test
```

**完成条件：** gc 不删除被引用证据和发布图；活跃 Run 不受影响；用户文档与 CLI 一致；所有兼容退出有明确迁移路径。

## Phase 3 最终场景验收

| 场景 | 预期 |
|---|---|
| 新项目首次 generate | 完整 Run、可信 Capture、有效 Markdown |
| 无变化再次 generate | 命中缓存，保留 observedAt，零新截图 |
| 只改模板/语言 | 按输入影响重生成；语言影响界面时重采集 |
| 改共享组件 | 只更新关联页面/Scenario/Section |
| 改全局样式/未知动态依赖 | 保守扩大，给出理由 |
| Git 无 diff，权限改变 | live verify 失败或漂移，不能 cache hit 通过 |
| 改人工说明、再 update | 保留或明确冲突，无静默覆盖 |
| 模型失败/进程中断 | resume 不重做已提交证据 |
| Fixture Error/Loading | 标 simulated/预期状态，不误判正常成功 |
| public 发布 | 无 raw/diagnostics/token，图片 hash 和隐私链完整 |
| 删除未引用过期 staging | dry-run 可审阅，apply 只删清单内对象 |

验收记录必须包含实际命令、环境版本、结果、产物引用和限制；待执行任务不能用设计文档存在作为完成证据。
