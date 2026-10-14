# 分类图文手册

页面 schemaVersion 3 在 `features` 中定义功能与操作，`sections` 组织读者要完成的子流程，`figures` 声明需要的状态与图片。浏览器产生 Binding 与 Capture，程序负责编号和图文装配；图片默认保留原尺寸截图，只在上面画标注。旧页面保持兼容读取，旧截图不会自动升级为完整证据。

## 日常生成

`manual generate page:<id>` 遇到旧页面的多项 guide、多个 detectedActions 或新操作模型时，先输出 `kind: layout` 请求。宿主读源码和本文件，提交分类计划；Runtime 保存迁移快照并自动创建后继 Run，安排各 Scenario 与检查点。无需手改 YAML 或逐个补 target。

采集按显式 hint 或唯一可访问名称定位。语义不同、重名或缺少线索时输出 `kind: binding` 请求。宿主只能选择报告中的 candidateId；程序重新验证目标，最多接受两轮消歧。缺少候选时修正状态或计划并重新规划，不能猜坐标。

请求响应通用外壳：

```json
{ "requestId": "请求 UUID", "inputHash": "请求中的 hash", "output": {} }
```

提交：`manual resume <runId> --request <requestId> --input <响应.json>`。文案请求仍使用 `output.copy`；分类和绑定请求不适用文案格式。

## 分类计划输入

layout 请求的 `output` 是单页补丁，可包含 title、purpose、features、sections、figures、states、variants、scenarios 和 faq。页面路由、生命周期和任务审批不在授权字段内。独立迁移的输入是 `{ "pages": [{ "id": "chat", ... }], "scenarios": [...] }`。

```json
{
  "title": "AI 对话",
  "purpose": "描述需求并选择教学能力。",
  "features": [{
    "id": "page:chat:send", "label": "发送需求", "priority": "required",
    "contentKind": "operation", "guideId": "send",
    "sourceRefs": ["app/chat/page.tsx"],
    "operations": [{
      "id": "send-request", "instruction": "在输入框写下需求，点击「发送」。",
      "evidenceRequirement": "entry", "risk": "write",
      "bindingIntent": { "role": "button", "name": "发送" },
      "outcome": "需求出现在对话里，下方开始显示回复。",
      "outcomeFigure": "replying"
    }]
  }],
  "sections": [{
    "id": "start", "title": "开始对话", "goal": "第一次使用时，从这里描述教学需求。",
    "featureRefs": ["page:chat:send"], "figureRefs": ["input", "replying"],
    "tips": ["回复还没出现时先等一会儿，不要重复发送。"]
  }],
  "figures": [{
    "id": "input", "sectionId": "start", "operationRefs": ["send-request"],
    "purpose": "entry", "caption": "发送需求的入口",
    "frame": { "mode": "auto", "padding": 64 }
  }, {
    "id": "replying", "sectionId": "start", "operationRefs": [],
    "purpose": "state", "caption": "发送后开始回复", "scenarioId": "chat-replying"
  }],
  "faq": [{ "id": "no-reply", "question": "发送后一直没有回复怎么办？", "answer": "刷新页面后在历史对话里找到这次对话，回复仍未出现时联系客服。" }]
}
```

| 对象 | 字段与约束 |
|---|---|
| Feature | `id`/`feature_id` 沿用稳定功能身份；label；priority 为 required/optional/skip/undecided；contentKind 为 operation/concept/reference；sourceRefs；operations；旧 guide 必须一对一保留 guideId |
| Operation | 页面内唯一安全 slug id；instruction；evidenceRequirement；可选 targetHint（现有 Target schema）、bindingIntent（role、name）、risk、sourceRefs、taskId、claimId、noImageReason；outcome（做完这一步看到什么）与 outcomeFigure（同小节 purpose=state 的图片 id）必须成对出现 |
| Section | 唯一 slug id；title、goal（一句使用场景）；featureRefs、figureRefs；可选 tips（不属于主流程的提示，字符串数组）。一个功能归属一个小节，多状态图放同一小节；required 必须收录，skip/undecided 不能进入正文 |
| FAQ | 页面级 `faq`：`[{ id, question, answer }]`，渲染在页面末尾「常见问题」 |
| Figure | 唯一 slug id；sectionId；operationRefs；caption；purpose 为 entry/state/overview；scenarioId 默认 page-<id>，checkpointId 默认 default；frame |
| Frame | auto（默认）：保留原尺寸截图，只画标注、不裁剪；region：显式裁到可定位的命名区域 target，仅在读者确实只需看某个区域时使用；viewport：整页截图时取当时可见的一屏。padding 只作用于 region，为 32～200 CSS px |

## 正文结构与编号

小节按读者要完成的子流程划分，不按页面功能清单划分：一节只讲一条读者能独立完成的流程（「使用密码登录」「使用短信验证码登录」「找回密码」各成一节），同一屏上的不同方式分节、各自出图。正文结构固定为：

```text
## 小节标题            ← 读者要完成的事
一句使用场景（goal）
1. 第一步               ← 操作类功能的操作按 featureRefs、operations 顺序连续编号
2. 第二步
   做完看到什么（outcome）
[截图]                  ← 跟在它标注的最后一步之后；图上的 ② 就是正文第 2 步，图下不再列图例
说明类内容（concept / reference 的操作，未被标注时不编号）
> 提示：……（tips）
……
## 常见问题             ← 页面 faq
```

- 步骤号与截图标注号是同一个数，由程序计算（`sectionSteps`），写进 `layoutRevision`：调整步骤顺序后，绑定与状态不变时重新派生，否则重新采集。
- 每张图优先 1～3 个相关标注，硬上限沿用主题 maxMarkersPerImage（默认 5），超过时在同一小节中分图。同一屏的不同小节各出一张原尺寸图、各自标注本节的操作，不要把图裁成只剩标注区，读者需要看到控件在整页中的位置。
- 每节最后一步写 outcome，并用状态图证明，读者才知道做完会看到什么、怎么判断成功。
- 写法提示（进入 quality.warnings，可用 `quality.blockOn` 升级为阻断）：`section-too-broad`（编号步骤超过 6 步或操作功能超过 3 个，多半混了几条子流程）、`section-outcome-missing`（最后一步没有结果说明）。
- 提交分类计划时，小节标题与场景、步骤、结果、提示、常见问题都按 `references/manual-writing-style.md` 做风格检查，命中即拒绝。

## 证据要求

- `entry`：已验证绑定、有效最终图及实际绘制的标注，只证明入口可见。
- `state`：purpose=state 的独立状态图，Scenario 对应检查点至少有一个非 URL 断言；截图后继续复核状态。
- `result`：入口/状态图之外，引用已有已批准任务的 taskId 与 claimId。必须有已发布的真实 verified claim，模拟、未执行和 legacy-unbound 不满足要求。任务授权与执行继续走现有任务流程。
- `none`：仅 concept/reference，必须提供 sourceRefs 和 noImageReason。缺少定位不能自动改为无图说明。
- `outcome`：outcomeFigure 的最终图必须已验证、状态在截图前后都复核通过（检查点有非 URL 断言）；否则 `manual-outcome-unproven`，正式发布阻断。

optional 是范围决定；一旦 featureRefs 收录，该操作也必须满足证据要求。草稿可以报告缺口，internal/public 正式发布均阻断未覆盖操作。范围审核、操作覆盖、绘制、隐私和结果验证在报告中分开显示；零分母为 N/A。

状态通过现有 Scenario setup/checkpoint 回放。新分类 Scenario 的 setup 只允许 read/local 动作，或**由 mock Fixture 在浏览器内完整模拟的写操作**；需要真实执行的发送、上传、删除仍交由已授权任务。演示值、Fixture 和网络守卫沿用原有规则，展示模拟界面会自动带上来源提示。

### 用 mock 走完写操作流程

验证码登录、注册、找回密码这类流程，读者需要看到「提交之后」的每一屏。不发真实短信、不建真实账号的做法：

1. 在 `.manual/fixtures/<id>.yaml` 登记 `kind: mock` 的 Fixture（`sideEffectClass: none`），为流程里的写请求（发送验证码、校验、注册、重置密码）和之后的读取写好虚构响应。
2. 每个要截的状态一个 Scenario：`data: { mode: fixture, fixture: <id> }`，setup 从头回放到该状态；会发出写请求的动作标 `mocked: true`（可同时写 `risk: write`）。
3. 在 `capture.demo.selectors` 登记手机号、验证码等输入框的演示值，避免截图里出现像真实手机号的文字。

约束：`mocked: true` 只能用在 `data.mode: fixture` 的 Scenario（schema 校验）；提交分类计划时要求引用的 Fixture 是 `kind: mock`；采集时数据模式不是 mock 直接报 `mock-write-unbacked`。漏写 mock 的写请求照旧被 Demo 网络守卫中止，截图判 `write-blocked`，服务端收不到。`verify --live` 回放这类 Scenario 时装上同一组 mock 路由。

跨页面的最终结果（注册后进入工作台）以本页能观察到的成功信号作为 outcome 证据；进入后的页面由对应的页面手册说明。

## Binding 响应

```json
{ "choices": { "input/send-request": { "candidateId": "control-候选中的值" } } }
```

choices 是 binding 请求的 output。候选只保留角色、隐私处理后的可访问名称与定位策略，精确定位唯一性由浏览器确认。候选 ID 失效、遮挡或角色/状态不符会留下缺口，不静默跳过。

## 迁移、缓存与核验

```text
manual migrate --layout --dry-run
manual migrate --layout --dry-run --input <分类计划.json>
manual migrate --layout --apply --input <分类计划.json>
manual migrate --layout --rollback <迁移 UUID>
```

预览列出旧块映射、小节、图片、状态和待关联操作；apply 保存 `.manual/migrations/layout/<UUID>/snapshot.json`，重复执行幂等；定义或新建 Scenario 后续改变时禁止自动 rollback。迁移保留旧 guide.<id> 块身份，三方合并保留人工 owner 与块间内容；冲突通过 proposed 文档审阅。

同状态一次采集可以派生多张分类图。统一隐私处理完整底图后才裁剪，CSS 像素、DPR、滚动、遮罩与标注进入同一几何管线。Figure/operation/part/label 到 Capture 的关系保存在 annotationProof 和事实包 evidenceCoverage.links。

文案变化复用图；裁剪、标注集合或顺序变化在绑定与状态不变且原图/几何仍有效时重新派生；绑定、状态或来源变化补采。相关缓存键分别包含 bindingRevision 与 layoutRevision，原图回收时明确重采。

`verify --artifacts` 从发布时冻结事实重新核对操作与图片证据；`verify --live` 按分类 Scenario 和检查点回放状态、核对已发布绑定并比较分类图。通过入口核验不会升级为业务结果成功。
