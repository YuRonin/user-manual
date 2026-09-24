# Phase 1：版本化模型、不可变证据与可重跑发布

> 前置：Phase 0 集成验收通过。入口：[总计划](2026-09-24-living-manual-optimization-plan.md)，契约：[C01～C05、C10～C11](2026-09-24-living-manual-contracts.md)，进度：[TODO](2026-09-24-living-manual-todo.md)。

建议顺序：P1-01 → P1-02 → P1-03 → P1-05 → P1-06 → P1-04 → P1-08 → P1-07。先完成 reader 和存储协议，再 apply 迁移；迁移开发与试运行均使用临时副本。

## P1-01：规范化 schema、ID 和 revision

**Files**

- Create: src/model/schema.js、src/model/revision.js、src/model/ids.js、test/model-schema.test.js、test/revision.test.js。
- Modify: src/config/load.js、src/config/schema.js、src/inspect/model.js、src/tasks/model.js、test/run.js。

**实施步骤**

1. 为对象键顺序不同但内容一致、步骤顺序不同、时间戳变化、嵌套 undefined、NaN、重复 ID 建立测试。
2. revision.js 实现 C01 canonical/hash；显式 pickDefinitionFields，不能对完整混合状态对象直接 hash。
3. schema.js 提供 validatePage、validateUserTask、validateScenario、validateCapture、validateRelease，统一返回 {ok,errors:[{path,code,message}]}；先用明确函数和现有依赖实现，不急于引入 schema 框架。
4. 校验 action.type 白名单、target 至少一种有效定位、assertion 类型与值、risk/replay、capture timing、stepId 安全字符、引用存在性；未知字段按版本策略处理，不静默丢失用户字段。
5. 给项目创建稳定 projectId；auth cacheKey 保留 legacy 映射，不能因新增 UUID 强迫所有用户重新登录。
6. 加载更高 schemaVersion 时返回 schema-too-new；旧 reader 通过 normalizeLegacy 转为内存兼容模型，不自动写回。新工具支持 config v1/v2；只有迁移应用 snapshot writer 时才将 config.version 改为 2，使旧二进制按已有版本检查拒绝写入。
7. config 已有 path/profile/DPR/URL 的完整校验复用于 load，不只 init 时校验；所有写入路径限定业务项目允许根内。

**关键行为测试**

```js
assert.equal(revision({ a: 1, b: [2, 3] }), revision({ b: [2, 3], a: 1 }));
assert.notEqual(revision({ steps: ['a','b'] }), revision({ steps: ['b','a'] }));
assert.throws(() => revision({ invalid: NaN }), /invalid-json-value/);
```

**验证**

```powershell
node test/model-schema.test.js
node test/revision.test.js
node test/init.test.js
node test/task-model.test.js
```

**完成条件：** 每种实体有可识别版本和稳定 revision；观察时间不触发定义变化，步骤/风险/断言变化一定触发。

## P1-02：独立 Capture Store 与不可变资源

**依赖：** P1-01。

**Files**

- Create: src/evidence/store.js、src/evidence/integrity.js、test/capture-store.test.js。
- Modify: src/commands/capture.js、src/commands/capture-task.js、src/tasks/executor.js、src/evidence/image-pipeline.js、src/inspect/store.js、test/run.js。

**实施步骤**

1. 测试连续两次同 Scenario 采集得到不同 captureId，旧记录和图片不变；复用记录是引用旧 ID，不复制冒充新观察。
2. Capture 输出写 staging/<captureId>；检查所有文件、尺寸和 SHA-256 后，将 published 资源按内容 hash 安装，record 最后原子写入 captures/<id>.json。
3. 若目标内容 hash 已存在，校验字节后复用；同 ID 不同内容报 immutable-conflict。
4. 定义 commit 顺序：产物存在 → 完整记录可见 → latest 引用更新。记录未提交前不允许 generate 使用。
5. page.browser 改为兼容投影：latestCaptureId、lastCapture、screenshot；实际可信度从 Capture validations 读取，不从投影布尔值读取。
6. task evidenceManifest 迁为 captureIds/观察记录引用；过渡期写 legacy manifest 仅为兼容，包含明确 canonicalCaptureRefs，禁止两份独立维护。
7. Capture 含真实 finalUrl 去敏值、身份引用、Scenario/来源 revision、截图规格和隐私版本；诊断错误另存，不占成功 Capture。
8. integrity.js 检查文件 hash 与 record，不读取敏感 raw 内容到日志。记录缺关键字段拒绝成为 cache candidate。

**验证**

```powershell
node test/capture-store.test.js
node test/capture.test.js
node test/capture-task.test.js
node test/task-first-e2e.test.js
```

**完成条件：** 不再通过覆盖同名 PNG 更新证据；写到一半的 staging 不可被生成器消费；旧文档资源字节保持不变。

## P1-03：稳定 Page 身份、Scenario 和 UserTask 状态拆分

**依赖：** P1-01、P1-02。

**Files**

- Create: src/scenarios/model.js、src/scenarios/store.js、src/model/approval.js、test/scenario-model.test.js、test/task-rerun.test.js。
- Modify: src/inspect/model.js、src/inspect/store.js、src/tasks/model.js、src/tasks/store.js、src/tasks/capture-plan.js、src/commands/approve-tasks.js、src/commands/discover-tasks.js、src/commands/capture-task.js、src/commands/generate-task.js、src/commands/verify.js、test/run.js。

**实施步骤**

1. 为 approved 用户任务 capture 两次、generated 后再 generate、重复 verify、stale 重新采集建立失败用例。
2. 从 UserTask 中移除执行 status 权威性：approval.status 控制可执行范围；新鲜度是根据输入与证据派生的结果；执行结果先记录 operation/capture，Phase 2 转 RunTask。
3. 旧 transitionTask 保留为 reader/compat 函数；新执行路径不再调用 captured→generated→verified 单向机。
4. capture-plan 的许可条件改为 approval.scopeHash 匹配当前执行定义，而非 task.status==='approved'。
5. Page 使用固定 ID；重扫同 route 可自动匹配，route rename 只在稳定 entry/明确 binding 证明身份一致时更新；歧义生成候选映射要求确认，禁止自动把不相关页面合并。
6. 缺失 route 标 lifecycle=missing，exclude 标 excluded；默认保留定义和历史，但拒绝当前采集。显式 retire 与 prune 分离。
7. Scenario 从 page.states/steps 的默认组合生成兼容定义。每个 Scenario 明确 environment、authProfile、route params、expected state、checkpoints；不自动穷举全部组合。
8. 执行计划解析 catch-all string[]、跨页面跳转、before/after state 和 action risk；未知高风险操作默认需要输入，不把未经分类动作当 read。
9. 审批哈希覆盖动作和断言，复用已有确认范围；标题润色不强制重新审批，动作/角色/fixture 变化必须重新确认。

**验证**

```powershell
node test/scenario-model.test.js
node test/task-rerun.test.js
node test/task-model.test.js
node test/capture-plan.test.js
node test/inspect.test.js
```

**完成条件：** stale 不再是死路；同一获批任务可重复运行；route rename 不无条件丢失 Page 身份；旧证据保留原观察时间。

## P1-04：显式、可重复执行的项目迁移

**依赖：** P1-01～P1-03、P1-06。

**Files**

- Create: src/store/migrate.js、src/commands/migrate.js、test/model-migration.test.js。
- Modify: bin/manual.js、src/commands/migrate-artifacts.js、src/config/load.js、src/inspect/store.js、src/tasks/store.js、test/run.js。

**实施步骤**

1. 构造三种旧项目：仅页面流程、完整任务流程、部分损坏/缺图项目；保留的业务快照仅复制后读取，不修改原目录。
2. manual migrate --dry-run 输出 entity/file/oldVersion/newVersion、拟生成 ID、无法证明的验证项、旧 raw 公共引用和需要重新采集的对象。
3. 在 migration manifest 中固定 ID 映射和输入 hash；--apply 使用同一 manifest，输入已变返回 migration-input-changed。
4. 备份所有将覆盖的定义，写 v2 staging，schema 全部通过后按 Project Store 提交。存阶段 checkpoint；重复 apply 使用既有映射，不重新生成 projectId。
5. 旧 page.browser 生成 legacy Capture record：有文件可算 hash，但 auth/page/interaction scope 为 unknown。不得因为有 screenshot 就写 passed。
6. 旧 task status 转审批/历史：candidate 保留 candidate；后续状态表示曾经批准，可标 legacy approval provenance，但执行前核对 scope；旧 verified 不直接升级为 live verified。
7. facts 图片字符串转换为 artifactPath/markdownHref；现存 Markdown 与 sidecar 不一致时输出冲突，不直接以任一方覆盖另一方。
8. 用户级认证缓存使用 alias 迁移引用；不把缓存值复制进迁移备份。
9. 迁移提交同时写 config.version=2，先备份旧配置；验证旧版 CLI 对该配置明确拒绝。迁移失败保持上一 current；如果根工作副本部分更新，由 journal 回填已提交 snapshot。回滚采用完整备份恢复，禁止旧 writer 写 v2 项目。

**验证**

```powershell
node test/model-migration.test.js
node test/migrate-artifacts.test.js
```

**完成条件：** dry-run 零写入；apply 两次结果相同；中途故障恢复不丢原定义；旧不可靠 verified 被降为明确 unknown，而非静默失真。

## P1-05：内容指纹、隐式依赖与保守失效

**依赖：** P1-01、P1-03。

**Files**

- Create: src/inspect/fingerprint.js、src/inspect/framework-dependencies.js、test/source-fingerprint.test.js。
- Modify: src/inspect/import-graph.js、src/inspect/nextjs.js、src/inspect/model.js、src/commands/inspect.js、src/inspect/index-builder.js、src/tasks/staleness.js、test/run.js。

**实施步骤**

1. 加失败测试：entry 路径不变但按钮文本变；只改上级 layout/global CSS/翻译 JSON；依赖删除/新增；tsconfig alias 配置变化。
2. fingerprint.js 对真实依赖内容计算 hash，并加入解析器版本、配置文件、dependency set；mtime 仅可做本轮读取优化，不做最终正确性依据。
3. framework-dependencies 为 Next App Router 加祖先 layout/template/loading/error 等渲染约定，为 Pages Router 加 _app/_document；全局文件作为 scope dependency，不当独立 Page。
4. 将 page.source 中显式文件和受限 glob 展开进依赖集合，包含相关 CSS/图片/字体/本地翻译；不扫描 node_modules 全树，依赖包变化由 lockfile fingerprint 表达。
5. 正则 scanner 无法解析的动态表达式、tsconfig extends、配置别名等记录 coverage=partial/unresolved；已知影响无法归属时标 broad-impact。
6. 依赖结果改变使 analysis freshness、Capture applicability 派生为 stale；不改写旧 Capture 的历史验证结果。
7. 对新增/删除 Page 和歧义 rename 记录 lifecycle 与 change reason；不再把不存在的 Page 混作当前有效页面。
8. 保留旧图和新图快照，供 Phase 3 删除/重命名影响计算；尚未实现 update 时通过 inspect --json 输出明确影响清单。

**验证**

```powershell
node test/source-fingerprint.test.js
node test/import-graph.test.js
node test/index-builder.test.js
node test/inspect.test.js
node test/staleness.test.js
```

**完成条件：** 同路径修改被识别；全局依赖变更保守扩散；不支持解析的情况有显式不确定性，不能返回“零影响”。

## P1-06：Project Store 快照、写锁和 revision 索引

**依赖：** P1-01、P1-03、P1-05。

**Files**

- Create: src/store/project.js、src/store/lock.js、src/store/snapshot.js、test/project-store.test.js、test/project-lock.test.js。
- Modify: src/inspect/store.js、src/tasks/store.js、src/scenarios/store.js、src/inspect/index-store.js、src/inspect/index-builder.js、src/commands/inspect.js、src/commands/describe.js、test/run.js。

**实施步骤**

1. 使用两个独立进程复现 lost update；期待第二个旧 revision 提交得到 model-conflict，而非覆盖第一个。
2. 锁文件用 exclusive create，包含 owner token、pid、host、createdAt；清理锁必须核对 owner。失效判断不能只看 PID（可能复用），同时检查持有进程/租约；跨主机未知锁明确提示恢复。
3. Project Store 读工作副本、schema 校验和 revision；导入时写 snapshots/<revision> 完整不可变集合，最后原子更新 current.json。
4. 当前根 YAML 作为可编辑工作副本回填；Runtime 固定 snapshot 读。工作副本与 current 不同时先验证导入，不允许 index 偷换事实。
5. commit({expectedRevision}) 在锁内 CAS；长浏览器/模型任务在锁外工作，提交前再次检查。
6. index envelope 包含 schemaVersion/modelRevision/generatedBy；不匹配则重建或回退权威 snapshot，不能以可解析 JSON 判定可用。
7. capture 只提交观察/latest 引用，不重写所有 pages 定义；定义 revision 不因 lastCapture 改变。
8. 对 current 写入前后故障注入：前故障读旧 snapshot；后故障读新 snapshot；工作副本和索引可按指针修复。

**验证**

```powershell
node test/project-store.test.js
node test/project-lock.test.js
node test/index-store.test.js
node test/task-store.test.js
```

**完成条件：** reader 始终选择一个完整已提交模型；并发旧输入提交被拒绝；索引缺失/过期可重建；不存在“capture 覆盖 describe 修改”。

## P1-07：发布 journal、release manifest 与恢复

**依赖：** P1-02、P1-06、P1-08。

**Files**

- Create: src/publication/publisher.js、src/publication/reconcile.js、src/publication/release-store.js、test/publication-recovery.test.js。
- Modify: src/commands/generate.js、src/commands/generate-task.js、src/commands/verify.js、src/generate/task-draft.js、test/run.js。

**实施步骤**

1. 定义 C10 状态：prepared/assets-installed/document-installed/release-committed/completed。每次持久状态更新用 atomic-write。
2. prepare 检查 approval、定义 revision、Capture hash、claim、privacy、目标文档旧 hash；将内容/facts/图片复制或引用到 staging，记录 transactionId。
3. commit 安装不可变图片；在目标文档目录用唯一 temp 原子替换 Markdown；写 release manifest 记录 manualId、definition revisions、captureIds、factsHash、documentHash、artifact hashes、language/template version。
4. 更新 current release 指针；旧 release 和资源保留。正式文档本身不承担唯一历史记录职责。
5. reconcile 按 oldDocHash/newDocHash 判断继续动作；第三种 hash 视为用户修改，返回 conflict，不回滚覆盖。
6. 在每个状态边界杀子进程，重新启动 reconcile；逐一验证旧版可读或新版可完整提交，重复恢复不重复资源。
7. 将 P0-05 的 partial-commit 错误纳入恢复入口；未知事务提供只读 status 和 repair --dry-run 结果。
8. verify artifact 读取 release 的 facts/captures，而非可变 drafts；草稿删除后已发布文档仍可检查。

**验证**

```powershell
node test/publication-recovery.test.js
node test/finalize-safety.test.js
node test/generate.test.js
node test/generate-task.test.js
```

**完成条件：** 发布每个边界中断可对账；facts 与正式版本绑定；人工中途修改不被恢复逻辑吞掉。文档明确这不是多文件瞬时原子事务。

## P1-08：统一事实包和结构化生成

**依赖：** P1-02、P1-03、P1-06。

**Files**

- Create: src/generate/fact-pack.js、src/generate/render.js、src/generate/markdown-validate.js、test/fact-pack.test.js、test/markdown-validation.test.js。
- Modify: src/generate/draft.js、src/generate/task-draft.js、src/generate/facts.js、src/generate/task-facts.js、src/commands/generate.js、src/commands/generate-task.js、test/run.js。

**实施步骤**

1. 构造同 UI 名称但否定动作、重复/遗漏 stepId、图片换内容、同数字换单位、插入未知业务承诺的测试，区分硬拦截和需审阅。
2. FactPack 结构包含 schemaVersion、manualId、inputRevision、steps、claims、artifactRefs、allowedCopyBlocks、language/template/style revision；对规范化包计算 factsHash。
3. action 动词、目标、顺序、条件、完成声明和截图位置由确定性 renderer 生成；模型只返回 blockId→文案，不允许覆盖 action/claim/ref。
4. 页面式 detectedActions 没有浏览器证据时保留 inferred 标签，并限制正文为明确推断或待验证草稿；不能通过页面截图提升全部动作。
5. 文案语言由 templates/locale 映射，先支持 zh-CN/en-US；未知语言返回 unsupported-template 或需配置，不静默输出中文。
6. 旧 --finalize Markdown 用 AST 校验步骤、图片、UI、数字单位和事实块；自由散文语义无法完全证明，未知承诺进入 review-required，不能宣称 regex 完整证明正确性。
7. tasks/page 两条生成入口均消费 FactPack；旧 facts.js 保留兼容 reader，停止扩展第二套新规则。
8. 草稿保存输入 revision 和 factsHash；finalize 时检查当前引用，无效返回 draft-stale 并指出重建范围。

**验证**

```powershell
node test/fact-pack.test.js
node test/markdown-validation.test.js
node test/generate.test.js
node test/generate-task.test.js
```

**完成条件：** 新生成路径不让模型改业务动作；文档可追溯至 FactPack/Capture；旧草稿在模型变化后不能继续盲目发布。

## Phase 1 集成验收

1. 旧项目 dry-run→apply→重复 apply；备份和映射稳定。
2. 同任务连续采集两次，旧截图不变；重新生成和重复 verify 合法。
3. 修改相同组件内容，inspect 报关联证据 stale；新的观察不删除旧记录。
4. 修改图片内容而不改路径，完整性检查失败。
5. 发布故障逐边界恢复；两个写进程发生 CAS 冲突而非数据丢失。
6. 删除 drafts 后已发布版本仍可验证。
7. npm test 通过后再进入 Runtime；不要先在不可靠文件写入上构建 resume。
