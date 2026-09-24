# Phase 0：修复证据可信度与发布错误

> 入口：[总计划](2026-09-24-living-manual-optimization-plan.md)；契约：[C04～C06、C08](2026-09-24-living-manual-contracts.md)；进度：[TODO](2026-09-24-living-manual-todo.md)。所有任务尚未执行。

目标是先修正现有命令，不提前实现 DAG。建议执行顺序 P0-08 → P0-01 → P0-02 → P0-03 → P0-04 → P0-05 → P0-06 → P0-07。P0-02 初期允许“缺少安全证据则明确阻止”，P0-06 完成后再打通安全产物生成。

## P0-01：统一图片身份与 Markdown 引用

**依赖：** P0-08 的 Markdown 解析依赖。**提交边界：** 一个路径解析修复提交。

**Files**

- Create: src/publication/paths.js、test/publication-paths.test.js。
- Modify: src/generate/task-draft.js、src/generate/task-facts.js、src/generate/draft.js、src/commands/generate-task.js、src/commands/verify.js、src/privacy/publication.js、test/run.js。
- Test: test/generate-task.test.js、test/generate.test.js、test/task-first-e2e.test.js。

**实施步骤**

1. 增加失败测试：文档在 docs/manual/tasks/edit.md，图片在 docs/manual/images/annotated/a.png，期待输出 ../images/annotated/a.png；校验必须按最终文档目录成功解析。
2. 增加路径反例：../../../../outside.png、绝对路径、远程 URL、Windows 盘符、发布目录内指向外部的 junction/symlink；预期 structured code=invalid-artifact-path。具备符号链接权限的测试环境执行该用例，否则明确标 skip。
3. paths.js 提供 toMarkdownHref({manualFile,artifactFile}) 和 resolvePublishedImage({projectRoot,manualFile,href,publishRoot})；后者先解析真实位置，再检查 containment、文件类型、存在性。
4. buildTaskDraft 增加 context 参数，包含 projectRoot、finalPath；facts.images 从字符串迁为 {artifactPath, markdownHref}，兼容读取旧字符串但不把两种语义混用。
5. task-facts 对比 markdownHref；verify 对真实解析结果和 artifactPath 指向的同一文件检查。privacy 校验接收规范化 artifact 对象，移除“href 有 ../ 就拒绝”的规则。
6. 使用 Markdown AST 枚举图片；禁止原始 HTML 图片或将其纳入同样校验，避免只匹配 ![]() 漏检。
7. 将历史保留文档复制到临时夹具，只读提取引用；验证已有 ../images 路径正确，但旧 facts 不一致返回需迁移，而不是默默改基准。

**关键接口示例**

```js
const ref = resolvePublishedImage({ projectRoot, manualFile, href, publishRoot });
// { ok:true, artifactPath:'docs/manual/images/annotated/a.png', absolutePath }
// 或 { ok:false, code:'invalid-artifact-path', message }
```

**验证命令**

```powershell
node test/publication-paths.test.js
node test/generate-task.test.js
node test/generate.test.js
node test/task-first-e2e.test.js
```

**完成条件：** 相对文档位置的所有图片实际存在，合法 ../ 不误拒绝，越界真实路径被阻止；修正 Markdown 不再需要手动绕过 facts。

## P0-02：页面与任务共用发布检查

**依赖：** P0-01。**提交边界：** 统一发布门槛；安全采集实现留给 P0-06。

**Files**

- Create: src/publication/validate.js、test/publication-gates.test.js。
- Modify: src/privacy/publication.js、src/commands/generate.js、src/commands/generate-task.js、src/commands/verify.js、src/config/schema.js、src/config/load.js、src/config/render.js、src/commands/migrate-artifacts.js、test/run.js。

**实施步骤**

1. 增加失败测试：public 页面旧 raw 图、任务缺 privacy summary、空 maskStyles 但未执行 detector、缺图、错误 hash 都不能 finalize。
2. 添加 PrivacyResult：status、policyRevision、detectorVersion、coverage、unresolved、maskStyles。零敏感命中可通过，但必须有实际执行记录；缺对象不是“没有风险”。
3. 实现 validatePublication({manualFile,facts,artifacts,config})；由两个 generate finalize 和 verify 共同调用，统一验证路径、证据归属及隐私状态。
4. 默认 rawDir 改为 .manual/artifacts/raw/pages；旧 rawDir 继续可读，但 public 发布时给 legacy-raw-reference 和重新采集指令。
5. docs.imagesDir 与 annotatedDir 只容纳发布资产；internal 模式也禁止引用 auth/diagnostic/raw，允许的保留差异仅通过 privacy policy 表达。
6. --no-screenshot 仍可产生明确的文字草稿；含未验证操作不能因此获得 verified 标记。--fallback-draft 只能回退文案，不能绕过 privacy/integrity/freshness。
7. migrate-artifacts 保留原默认 report 与 --copy；报告引用、配置及旧公开 raw 的待处理项，不声称复制即完成迁移，不自动删除旧图。

**验证命令**

```powershell
node test/publication-gates.test.js
node test/migrate-artifacts.test.js
node test/generate.test.js
node test/generate-task.test.js
```

**完成条件：** 无任何 finalize 分支绕过 validatePublication；隐私未知时失败不写正式文档。旧 fixture 若只有 raw，更新其预期为受阻，或通过真实安全管线补齐证据，不能只给假 summary。

## P0-03：统一导航、页面身份和前后状态断言

**依赖：** P0-08。**提交边界：** 两条采集流程的验证一致性。

**Files**

- Create: src/evidence/validate-page.js、test/page-validation.test.js。
- Modify: src/commands/capture.js、src/tasks/executor.js、src/tasks/capture-plan.js、src/browser/playwright.js、src/browser/provider.js、src/browser/errors.js、test/server.js、test/run.js。
- Test: test/capture.test.js、test/task-executor.test.js、test/capture-task.test.js、test/capture-plan.test.js。

**实施步骤**

1. 夹具加入：返回 500 但有正常按钮、200 软 404、SPA 延迟跳登录、Loading 永不结束、正常账号设置含密码框。
2. 从 capture.js 抽取 HTTP 与页面结果判断到 validate-page；输入 expectedUrl/statuses、最终重新读取的 URL、probe、identityAssertions、expectedState。
3. provider 增加 currentObservation()，在 wait 完成后读取实际 URL/标题/页面事实；不得只使用 goto 时返回的旧 finalUrl。
4. 将 --wait-for 定义为 required 条件：超时抛 readiness-timeout；networkidle/fonts/images 保留独立可配置策略，关键图/font 缺失可标 inconclusive。
5. capture-plan 同时展开 beforeState 与 expectedState，schema 验证断言非空；旧 default URL-only 可用于 legacy observation，不能升级为完整 page-identity。
6. executor 顺序变为 entry identity → before assertions → action → after assertions → screenshot。before 失败时确认 performAction 调用数为 0。
7. 状态断言使用有界自动等待，零/多定位分别分类；空 assertions 不再执行后直接 verified。
8. Error/Loading Scenario 按 expectedState 解释；普通 Scenario 遇到它们失败。显式允许的 redirect 记录 actual route；未知跨 origin 跳转停止。

**验证命令**

```powershell
node test/page-validation.test.js
node test/capture-plan.test.js
node test/task-executor.test.js
node test/capture.test.js
node test/capture-task.test.js
```

**完成条件：** 页面和任务入口都不会把错误页判成功；SPA 跳转以截图时 URL 为准；断言的 scope 明确，before 失败无动作。

## P0-04：完成声明绑定真实断言

**依赖：** P0-03。**提交边界：** completion claim 的最小可信实现。

**Files**

- Create: src/evidence/claims.js、test/completion-claims.test.js。
- Modify: src/tasks/model.js、src/tasks/capture-plan.js、src/tasks/executor.js、src/generate/task-draft.js、src/generate/task-facts.js、src/commands/generate-task.js、test/run.js。

**实施步骤**

1. 添加两个相反用例：保存未执行不能验证“已保存”；保存未执行但 editor-visible 通过，可以验证“编辑器已打开”。
2. 为执行结果保存 assertionId、scope、outcome、checkpoint/step ID 和 checkedAt；不能只存 record.status='verified'。
3. 为 completion 增加 claims 数组或兼容适配；旧 description/verification 没有 assertionRefs 时转 expected/legacy-unbound，不沿用用户输入的 verified。
4. claims.js 计算验证状态：所有所需 assertion 在当前 evidence 中 passed，且属于正确场景/检查点；缺失返回 not_run，失败返回 failed。
5. draft 根据计算结果渲染“已验证界面结果”“预期业务结果”，facts 保存 claimId 与证据引用。
6. task-facts 检查 claim 对应关系，不只搜索“已验证结果：”字样。未知额外声明返回 unsupported-claim。
7. 风险停止后的所有剩余步骤都显式记录 not-executed/skipped-by-boundary；正文说明只验证到哪一步，不把缺失步骤默认补成完成。

**验证命令**

```powershell
node test/completion-claims.test.js
node test/task-executor.test.js
node test/generate-task.test.js
node test/task-first-e2e.test.js
```

**完成条件：** 修改 completion.verification 字符串无法提高验证等级；每条已验证完成声明有对应 passed assertion。

## P0-05：先验证再写入，修复单文件替换

**依赖：** P0-01、P0-02、P0-04。**提交边界：** 当前代码的失败安全；多文件 journal 在 P1-07。

**Files**

- Create: src/util/atomic-write.js、test/finalize-safety.test.js、test/atomic-write.test.js。
- Modify: src/commands/generate-task.js、src/commands/generate.js、src/commands/verify.js、src/generate/task-draft.js、src/util/fsx.js、test/run.js。

**实施步骤**

1. 为 candidate/stale/verified 非法 finalize 建立夹具，保存正式文件原始 hash，期待退出失败且 hash 不变；当前代码会暴露先发布后 transition 的错误。
2. 在写文件前计算合法 nextState、加载 facts、校验图片存在/hash、publication 和输入一致性；所有前置校验通过才 prepare 内容。
3. atomic-write 使用同目录唯一 temp（pid + random）、打开独占文件、写入、fsync、关闭、rename；失败清理自身 temp，不删除目标文件。
4. 注入 fsImpl 验证 write/fsync/rename 失败保留旧文件；Windows 目标被打开导致 rename 失败时返回 file-busy，不先删目标再 rename。
5. 将 publishAtomic 迁到共享函数；格式化 generate-task.js/verify.js，拆为 load、validate、prepare、commit 小函数。
6. 保留 Phase 0 的旧生命周期约束，不临时放开任意状态；如果写文档成功但写 task 失败，返回明确 partial-commit，需要 P1-07 对账，不能伪称全事务成功。
7. verify 只做报告的准备逻辑与状态推进分离，为 Phase 1 可重复验证做准备。

**验证命令**

```powershell
node test/atomic-write.test.js
node test/finalize-safety.test.js
node test/generate-task.test.js
node test/generate.test.js
```

**完成条件：** 所有可提前发现的失败都发生于正式文件替换前；单文件替换失败保留旧字节，不留下固定 .tmp 冲突。

## P0-06：同一 raw 派生脱敏与标注图片

**依赖：** P0-02、P0-03、P0-08。**提交边界：** 图像管线与真实像素回归。

**Files**

- Create: src/evidence/image-pipeline.js、test/image-pipeline.test.js。
- Modify: src/browser/playwright.js、src/tasks/executor.js、src/commands/capture.js、src/privacy/detector.js、src/privacy/geometry.js、src/privacy/renderer.js、src/artifacts/annotation.js、test/server.js、test/run.js。

**实施步骤**

1. 增加动态夹具：文字在 screenshot 前后变化、点击后目标移动、DPR=1/2、页面滚动、fullPage 和超出视口的隐私字段。
2. provider 负责 collectGeometry 和 captureRaw，不再用 DOM overlay 重新截图生成发布图；image-pipeline 通过 sharp 读取 raw 并组合确定性 SVG/像素遮罩。
3. collectGeometry 保存 viewport、scroll、clip、DPR、document size、mutation generation。raw 前后 generation/关键区域几何不同则有限重试；超限 geometry-unstable。
4. after screenshot 的 annotation 用 capture.annotations 指定的 screenshot-time target；原动作元素消失时要求另指定目标，不保留旧 rect。
5. CSS → image 坐标明确使用 clip/scroll origin；fullPage 的敏感区域按文档坐标收集，无法覆盖 iframe/canvas 等区域时用显式 mask 或 unresolved。
6. 遮罩先完全覆盖原像素再绘制图案；输出 sanitized 后叠加标注成为 annotated。每个产物记录 source raw hash、geometry hash、policy revision、renderer version。
7. detector 对已脱敏内容只按命中敏感片段判断，不能因为整段包含省略号就跳过其他完整手机号/邮箱；高风险候选缺 rect 时返回 unresolved。
8. 页面 capture 接入同一 pipeline；无标注也可生成已安全处理的 published artifact，annotated 只是兼容目录名。
9. 成功输出 P0-02 要求的 privacy record；失败产物只留私有诊断，不进入文档根。

**验证命令**

```powershell
node test/image-pipeline.test.js
node test/artifacts.test.js
node test/capture.test.js
node test/task-first-e2e.test.js
```

**完成条件：** 图像后处理不调用第二次浏览器截图；遮罩覆盖目标像素，输入 raw 不变；几何不稳定/隐私未知明确失败。黄金图只覆盖固定环境夹具，不推导任意页面像素确定性。

## P0-07：明确认证状态、匿名模式和刷新竞争

**依赖：** P0-03、P0-05。**提交边界：** 认证有效性及刷新一致性。

**Files**

- Create: src/auth/identity.js、test/auth-identity.test.js。
- Modify: src/auth/runtime.js、src/auth/cache.js、src/auth/session.js、src/commands/auth.js、src/browser/playwright.js、src/config/load.js、src/config/schema.js、test/run.js。
- Test: test/auth-cache.test.js、test/auth-command.test.js、test/auth-session.test.js。

**实施步骤**

1. 测试 auth.enabled=false 时即使已有缓存也不读、不注入、不刷新；匿名状态同样处理。
2. status 输出 stored/missing/corrupt 及 lastValidatedAt，不把可解析文件称为线上 ready；兼容 JSON 提供 storageStatus 与 validationStatus。
3. 配置 auth.identityAssertions / verifyPath。登录完成必须先访问验证目标并通过身份断言；仅离开 /login 不能确认登录成功。
4. auth cache envelope 增加 generation、identityRevision、validatedAt；不保存未经允许的 identity 明文，角色/租户用非秘密稳定引用。
5. refresh 前再次确认身份。使用独占 profile lock + generation CAS，避免两个 Context 的旧快照覆盖新快照；CAS 冲突丢弃较旧更新并给 warning。
6. cookie 到期可作为预检查，但最终以服务端/UI 身份断言为准；expired 后不无限重试登录。
7. IndexedDB/sessionStorage 作为显式 capabilities 配置；默认只支持实际实现的状态；加载不支持版本时报告 capability-unavailable。
8. 日志使用白名单字段，测试 token 和表单值不出现在 stdout/stderr/manifest。缓存仍留用户目录，不复制到项目。
9. 创建缓存目录/文件使用当前用户私有权限；POSIX 验证目录 0700、文件 0600，Windows 验证用户目录 ACL 继承及共享目录覆盖配置的风险。不把 chmod 在 Windows 上成功当作 ACL 已限制的证明；无法保证受限目录时 doctor 报告具体路径和处理建议。

**验证命令**

```powershell
node test/auth-identity.test.js
node test/auth-cache.test.js
node test/auth-command.test.js
node test/auth-session.test.js
```

**完成条件：** stored 与 authenticated 区分；匿名不带凭据；刷新有 CAS；失效不破坏上次快照且给明确恢复命令。

## P0-08：固定依赖、诊断环境和测试基线

**依赖：** 无，建议最先执行。**提交边界：** 可复现依赖与只读 doctor。

**Files**

- Create: src/commands/doctor.js、test/doctor.test.js。
- Modify: package.json、package-lock.json、src/browser/playwright.js、src/browser/index.js、bin/manual.js、src/compat/aliases.js、test/run.js。

**实施步骤**

1. 记录 Node/npm 版本和当前测试基线；测试使用临时项目与 MANUAL_AUTH_CACHE_DIR，不访问真实用户缓存。
2. 核查 Playwright、sharp、markdown-it 的官方支持版本、CommonJS 用法和 Windows/Linux 包支持；选择确切版本并更新 lockfile。若所选依赖要求更高 Node，明确提升 engines 并记录迁移说明，而不是安装后运行时崩溃。
3. 正常加载从工具自身依赖解析；显式 MANUAL_PLAYWRIGHT_PATH 作为受控覆盖；个人 gstack/npx 搜索退出默认路径，可在过渡期通过显式 legacy 开关保留。
4. doctor 检查 Node、工具版本、Playwright 版本、Chromium 可执行文件、配置 schema、输出可写性及 auth 元数据；不打印凭据，不自动安装依赖或启动业务服务器。
5. 浏览器安装由明确安装命令完成，例如固定本项目依赖后运行 npx playwright install chromium；CI Linux 使用对应系统依赖安装步骤。doctor 提供建议命令。
6. 将 CLI command registry 提取为可读共享数据，兼容 alias 由它生成，补 auth；避免两份手工命令数组。
7. 新测试登记 runner；旧测试如存在预期漂移，逐条分类，不能删测试来得到绿色。

**验证命令**

```powershell
npm ci
node bin/manual.js doctor --json
node test/doctor.test.js
node test/compat-aliases.test.js
npm test
```

**预期：** 依赖缺失时 doctor 分类失败并给修复命令；安装完成后输出固定版本。全量测试若失败须区分历史失败、新行为变更及环境失败，不宣称全部通过。

## Phase 0 集成验收与回滚

1. 在临时项目 init public → inspect/describe → capture → generate/finalize；图片可按 Markdown 位置打开，原图不位于发布目录。
2. task 流程逐步验证入口、before、after、completion；错误 HTTP 和缺断言失败。
3. 删除 privacy record、替换图片、修改 completion 字符串都不能产生合法发布。
4. 非法 finalize/rename 失败时旧文件字节不变。
5. npm test 与实际 Markdown 渲染 smoke test 通过，才进入 Phase 1。

回滚按独立提交回退实现；不要自动把 public raw 通道重新打开。旧项目只读浏览及旧文档保留，重新发布需满足新门槛。
