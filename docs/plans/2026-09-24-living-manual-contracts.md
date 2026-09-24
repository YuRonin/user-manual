# Living User Manual：数据与接口契约

> 配套 [总计划](2026-09-24-living-manual-optimization-plan.md)。本文件定义目标契约；不是当前实现文档。跨阶段接口变更以此处为唯一依据。

## C01. 标识、版本与确定性序列化

- projectId：初始化时创建 UUID，写入配置；复制同项目 worktree 保留，复制成新项目时显式 regenerate。
- pageId / userTaskId / scenarioId / manualId：稳定业务 ID；首次可从 route 建议 slug，之后路由变更不重算。
- stepId / assertionId / claimId：所属定义内唯一，使用安全 slug；文件路径只使用通过校验的 ID。
- runId / captureId / releaseId：随机 UUID，禁止用时间戳单独充当唯一 ID。
- schemaVersion：每种实体独立版本；新工具保持读取 config v1，项目模型 v2 由显式迁移启用。启用 snapshot writer 时同时将 config.version 提升为 2；旧工具现有的 version > CONFIG_VERSION 检查会拒绝写入，避免仅增加旧工具不认识的字段却无法阻止旧 writer。
- definition revision：内容 hash，不含 observation、generatedAt、status cache、绝对机器路径。
- sourceFingerprint：文件内容、依赖集合和解析策略的 hash。
- toolVersion / rendererVersion / privacyPolicyRevision：分别进入相关缓存输入。

```js
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k =>
    JSON.stringify(k) + ':' + canonical(value[k])
  ).join(',') + '}';
}
```

schema 先拒绝 undefined、NaN、Infinity、循环引用和非 JSON 类型，再调用 canonical；步骤数组保持顺序，只有具有集合语义的字段在调用前排序去重。路径转 POSIX，但不把大小写不同的路径在所有平台上强行折叠。源文件按字节 hash，记录 git SHA 和 dirty 标记用于定位，不能代替字节 hash。

## C02. 权威数据与提交

| 内容 | 权威来源 | 可否丢弃重建 |
|---|---|---|
| 用户配置 | config.yaml | 否 |
| 当前页面/任务/场景定义 | current.json 指向的已提交 model snapshot；根目录 YAML 是可编辑工作副本 | 不能丢弃已提交快照；工作副本需受保护 |
| 项目身份/框架元信息 | project.yaml 的已提交版本 | 身份不可重新推导；框架可重新检测 |
| 索引 | 指定模型 revision 派生 | 可以 |
| Capture / Assertion 结果 | 不可变 Capture record | 不可伪造重建，只能再次观察 |
| 发布历史 | release manifest | 不可仅由当前 Markdown 推导 |
| 当前执行 | run/task JSON snapshot | 不可用聊天替代 |
| 诊断事件 | events.jsonl | 不作为恢复的唯一来源 |
| cache lookup | cache/ | 可以 |

执行开始先验证工作副本 schema 并计算 revision；与 current 不同则导入为新快照（语义审批是否失效另判），然后固定本 Run 输入。长时间模型步骤和等待用户时不持有项目写锁。提交时重新获取锁并检查预期 revision/CAS；冲突返回 model-conflict，不覆盖。

## C03. 模型形状

以下是最小必要字段；所有路径是业务项目根相对路径，secret 只能以引用出现。

```json
{
  "schemaVersion": 2,
  "id": "dashboard",
  "revision": "sha256:...",
  "title": "工作台",
  "lifecycle": "active",
  "routeBindings": [{
    "id": "dashboard-main",
    "template": "/workspace/:workspaceId",
    "entryFiles": ["app/workspace/[workspaceId]/page.tsx"]
  }],
  "identityAssertions": [{"id":"dashboard-heading","type":"visible","target":{"role":"heading","name":"工作台"}}],
  "dependencies": {"files":[],"unresolved":[],"completeness":"partial"},
  "analysis": {"sourceRevision":"sha256:...","origin":"source","status":"completed"}
}
```

Page.lifecycle = active / missing / excluded / retired。默认缺失不删除，capture/generate 必须明确拒绝 missing/retired 当前目标，历史 release 仍可引用。

```json
{
  "schemaVersion": 2,
  "id": "edit-profile",
  "revision": "sha256:...",
  "title": "修改个人资料",
  "goal": "查看并编辑个人资料",
  "approval": {"status":"approved","scopeHash":"sha256:...","approvedAt":"...","decisionRef":"..."},
  "entryPage": "user-center",
  "steps": [{
    "id":"open-editor","pageId":"user-center",
    "instruction":"点击「编辑资料」打开编辑面板。",
    "action":{"type":"click","target":{"role":"button","name":"编辑资料"}},
    "risk":"local","replay":"safe",
    "stateBefore":"default","stateAfter":"editor-open"
  }],
  "completionClaims": [{
    "id":"editor-opened","text":"编辑面板已打开。",
    "assertionRefs":["editor-visible"]
  }]
}
```

approval.scopeHash 覆盖步骤、动作目标、valueRef、风险、前后断言、环境限制、fixture 及完成声明。仅标题/语气修改可以不使执行审批失效，但产生新定义 revision。审批记录中的 actor 是宿主传入的审计信息，不把一个字符串当成认证系统。

```json
{
  "schemaVersion": 1,
  "id": "profile-member-editor",
  "revision": "sha256:...",
  "userTaskId": "edit-profile",
  "environment": "local",
  "authProfile": "member",
  "data": {"mode":"live","revision":null},
  "entry": {"pageId":"user-center","routeBindingId":"main","params":{}},
  "expected": {"httpStatuses":[200],"redirects":[],"state":"normal"},
  "setup": [],
  "checkpoints": [{
    "id":"editor","afterStepId":"open-editor","pageId":"user-center",
    "assertions":[{"id":"editor-visible","type":"visible","target":{"role":"dialog","name":"编辑资料"}}],
    "capture":{"mode":"viewport","annotations":[]}
  }]
}
```

匿名必须明确 authProfile=anonymous，不载入任何已有 Profile。动态 catch-all 参数使用 string[]，逐段 encode，再 join('/')；普通参数中的斜杠编码为 %2F。Loading/Error/Empty 是显式 expected state，不适用统一的“错误状态一律失败”。

## C04. Capture、验证结果与 Claim

```json
{
  "schemaVersion": 1,
  "id":"capture-uuid","runId":"run-uuid",
  "scenarioId":"profile-member-editor","checkpointId":"editor",
  "inputHash":"sha256:...","modelRevision":"sha256:...",
  "sourceFingerprint":"sha256:...","environmentFingerprint":"sha256:...",
  "observedAt":"2026-09-24T00:00:00.000Z",
  "finalUrl":{"origin":"http://localhost:5173","pathname":"/user-center"},
  "spec":{"viewport":{"width":1440,"height":900},"dpr":2,"fullPage":false,"browserVersion":"...","locale":"zh-CN","timezone":"Asia/Shanghai"},
  "validations":[{"id":"validation-uuid","scope":"scenario-state","assertionId":"editor-visible","outcome":"passed","checkedAt":"..."}],
  "privacy":{"status":"passed","policyRevision":"sha256:...","detectorVersion":"1","coverage":"declared-dom","unresolved":[],"maskStyles":["neutral-mosaic"]},
  "artifacts":[{"kind":"published","path":"docs/manual/images/annotated/abc.png","sha256":"abc","bytes":1000}],
  "provenance":{"mode":"live","derivedFromRawHash":"sha256:..."}
}
```

Validation.outcome = passed / failed / inconclusive / not_run。scope = artifact-integrity / auth-identity / page-identity / scenario-state / interaction / completion-claim / publication。一个 scope 通过不推导其他 scope 通过。

Claim 验证需匹配：本次 Run 的 Scenario revision、目标 checkpoint、assertion ID、passed 结果和 Capture inputHash；源码 claim 标 inferred，模拟 fixture 标 simulated。任务未执行保存，不妨碍“编辑器已打开”claim 被验证，但“数据已保存”不能由编辑器断言证明。

raw、sanitized 文件可只保留在本机；Capture record 中不含敏感原文、Cookie、完整查询参数。记录 raw hash 可追踪派生，但 raw 删除后不能重新标注，需要重采集。

## C05. 路径与发布引用

- manifest/facts 内 artifact.path 始终为项目根相对路径。
- Markdown 图片 src 始终相对最终 Markdown 位置，统一 POSIX。
- 图片 src 中的 ../ 不是天然错误；先解析，再检查规范路径是否在允许发布根内。
- 拒绝远程 URL、data URL、绝对本机路径和越出发布根的引用，除非未来增加独立明确的外部资源策略。
- 检查 realpath 防止软链接/junction 指向发布根外；不存在文件报 missing，不能回退为“路径看起来合法”。
- facts 不再将 Markdown src 与 artifact.path 混为同一字段。

```js
// projectRoot/manualAbsolute/artifactAbsolute 均先做 containment 校验。
function imageHref(manualAbsolute, artifactAbsolute) {
  return require('path').relative(
    require('path').dirname(manualAbsolute), artifactAbsolute
  ).replace(/\\/g, '/');
}
```

发布检查依次确认：引用解析 → 文件存在 → hash → Capture 归属 → privacy 成功及策略版本 → claim scope → 定义 revision → 用户编辑冲突。public 模式缺少 privacy 摘要等于 unknown，阻止发布；internal 仍不得发布 credential、token、原始诊断图。

## C06. 图像管线

1. 验证页面身份和 checkpoint 断言。
2. 重新解析截图时刻的标注目标；after 目标失效则返回 annotation-target-missing，不能使用动作前旧 rect。
3. 采集几何快照与 DOM mutation generation。
4. 截 raw；重新读取 generation/关键目标几何。若变化则丢弃本次尝试并有限重试，不声称 DOM 与像素完全原子。
5. 将 CSS 坐标按实际 DPR、clip 和 scroll origin 转为图像像素坐标，clip 到实际 PNG 宽高。
6. 在同一 raw 字节上执行完全不透明的合成遮罩，再叠加标注；不重新拍浏览器生成 sanitized/annotated。
7. 校验文件、尺寸、hash 和处理摘要，写不可变记录。

对 iframe、canvas、shadow DOM 等检测覆盖不足的区域，允许项目显式遮罩或安全 fixture；无法确认的敏感区域标 unresolved。几何缺失不能静默 filter 掉后认为安全。普通 DOM 检测不对所有隐私作绝对保证。

## C07. Runtime 与模块接口

```js
// 下列均为目标接口；以结构化结果交接，不返回未声明字段。
projectStore.loadSnapshot({ projectRoot });
projectStore.commit({ projectRoot, expectedRevision, definitions });
captureStore.commit({ stagedFiles, record });
planner.plan({ command, target, snapshot, policy, cacheDecisions });
runner.run({ runId, handlers, signal, clock });
runner.resume({ runId, handlers, signal, clock });
browserSession.withScenario({ scenario, authRef, spec }, async session => {});
cache.lookup({ kind, inputHash, freshnessPolicy, now });
publisher.prepare({ manualId, facts, content, expectedRevision });
publisher.commit({ transactionId });
publisher.reconcile({ transactionId });
```

RuntimeTask kinds 第一版固定为 inspect、analyze、capture、derive-image、draft、rewrite、validate、publish；仅按 kind 注册 handler，不建设动态插件系统。

```json
{
  "id":"capture-profile","kind":"capture","dependsOn":["analyze-profile"],
  "inputHash":"sha256:...","status":"pending","attempt":0,
  "retry":{"maxAttempts":3,"backoffMs":[1000,3000],"replay":"safe"},
  "outputRefs":[],"error":null
}
```

maxAttempts=3 表示首次加两次重试。Task 状态为 pending/running/waiting_input/succeeded/failed/interrupted/cancelled；新进程见 running 且租约失效时转 interrupted，再依据 replay policy 恢复。Run 中等待模型不保留 Browser 和项目锁。

起步默认预算：单次导航 30 秒、required assertion 10 秒、单 Scenario 活跃执行 120 秒、单 Run 活跃执行 30 分钟、单 Run 最多 200 次动作。等待模型/用户期间不计活跃执行时间，但记录 wall-clock；resume 沿用已消费预算，新增预算必须显式给出。重试也消耗同一预算，预算耗尽返回 budget-exceeded。以上均允许项目配置覆盖，JSON 输出记录实际有效值。

## C08. 错误契约与退出码

```json
{"ok":false,"runId":"...","error":{"code":"auth-expired","phase":"capture","message":"登录已失效","retryable":false,"requiresInput":true,"scope":{"pageId":"profile","scenarioId":"member"},"hint":"manual auth login --profile member"}}
```

暂时保留旧 errors/reason 字段作为兼容投影。内部只生成统一 ErrorResult，命令层决定文本/JSON 输出。敏感输入不能拼进 message/stack；详细私有诊断使用诊断引用。

| 情况 | 策略 |
|---|---|
| browser crash、只读导航 timeout、瞬时 5xx | 最多两次重试，指数/表内退避 |
| provider unavailable、schema、404、模糊 locator | fail；解释修复途径 |
| auth missing/expired、审批范围变化、人工编辑冲突 | waiting_input，关闭浏览器 |
| 写动作结果不明 | outcome_unknown；核查结果，不重放 |
| 模型无响应/格式错误 | 只重试 rewrite/analyze，不重截 |
| 用户 SIGINT/SIGTERM | 记录 interrupted/cancelled；finally 清理；强杀由租约恢复 |
| hash mismatch、privacy unknown | fail，禁止发布或 cache hit |

退出码：0 成功或显式 dry-run；1 执行失败；2 参数/不支持命令；3 等待输入；4 检测到漂移或需处理冲突。切换退出码时更新兼容文档与测试，调用方以 JSON code 作细分。

## C09. Cache Key、TTL 和版本

```text
sourceHash = H(file bytes + dependency set + resolver version + framework config)
captureKey = H(project + environment + deployedBuild + scenario revision + checkpoint
  + sourceHash + identity revision + data revision + viewport/DPR/locale/timezone
  + browser/platform + capture mode + readiness policy)
imageKey = H(rawHash + geometryHash + privacy revision + annotation theme + renderer version)
manualKey = H(factsHash + artifactHashes + language + template/style version + generator version)
```

- Cookie 值不进入 key；认证快照 generation 用于刷新 CAS，身份 revision 用于语义隔离。
- 纯静态/fixture Capture 在所有内容输入一致时可无时间 TTL；live 数据缺少可信 revision 时默认软 TTL 15 分钟。
- 同 Run 身份验证最长复用 5 分钟，权限异常立即失效；新 Scenario 仍需确认预期身份。
- TTL 未过只表示策略允许复用历史观察，不证明远端未变；release 保留 observedAt，报告 onlineChecked=false。
- verify --live 必须导航和断言，不能仅查旧 Capture；可复用 auth 与本次同场景会话。
- cache entry 引用不可变产物；lookup 校验存在性、hash 和验证范围，不只检查 key 存在。
- cache miss 原因枚举：not-found、input-changed、expired、artifact-missing、hash-mismatch、validation-insufficient、policy-changed、environment-unknown。
- index 不完整、远端 build 未知或 data revision 缺失时必须显式记录不确定性。

## C10. 发布和恢复协议

publication transaction 放于 runs/<runId>/publication/<transactionId>/；Phase 1 尚无 Run 时使用 .manual/publication/<transactionId>/，Phase 2 兼容读旧位置。

```text
prepared → assets-installed → document-installed → release-committed → completed
```

prepared 记录 oldDocHash/newDocHash、备份、定义 revision、facts/artifact hash。先检查 task/approval、用户编辑、输入 CAS，再写任何正式文件。assets 为内容寻址，不覆盖旧图；document 用唯一 temp 同目录 rename；release 最后记录关联。

重启时：document 若是 newDocHash，继续提交 manifest；若是 oldDocHash，继续安装；若是第三种内容，返回 publication-conflict 保留用户修改。恢复过程幂等。current 指针最后更新。普通 docs 路径存在极短的文档与 manifest 不一致窗口，恢复协议解决一致性，不能宣称多文件整体原子；整本发布原子切换留给未来 release directory/deployer。

## C11. 手工编辑、模型输出与事实

生成正文的事实块与自由说明块分离：事实块由结构化 action/claim 渲染；模型返回按 blockId 对应的描述文案，只能修改允许字段。对于关键动词、UI 名称、顺序、单位和完成条件，保持结构化数据控制，不依赖正则或模型自检。

旧 --finalize Markdown 兼容入口用 AST 解析限定结构并对照 facts；声明其为结构一致性检查，不保证任意自由文本的语义等价。新增未知步骤、未引用 claim 或散文中的业务承诺进入 review-required。

release 记录上次生成文档 hash。更新时当前文件不等于上次生成版本，则执行三方比较（旧生成 / 当前手改 / 新生成）；不重叠修改可合并，重叠区保存 proposed diff 并等待输入。

## C12. 参考边界

实施 Playwright 版本相关能力时核查固定版本官方文档：[认证](https://playwright.dev/docs/auth)、[storageState](https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state)、[持久化 Context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。storageState 能力不能被当成所有浏览器存储的完整快照；Context 隔离也不隔离共享后端业务状态。
