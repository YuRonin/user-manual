# 分类图文手册

页面 schemaVersion 3 在 `features` 中定义功能与操作，`sections` 组织读者目标，`figures` 声明需要的状态与局部图。浏览器产生 Binding 与 Capture，程序负责裁剪、编号和图文装配。旧页面保持兼容读取，旧截图不会自动升级为完整证据。

## 日常生成

`manual generate page:<id>` 遇到旧页面的多项 guide、多个 detectedActions 或新操作模型时，先输出 `kind: layout` 请求。宿主读源码和本文件，提交分类计划；Runtime 保存迁移快照并自动创建后继 Run，安排各 Scenario 与检查点。无需手改 YAML 或逐个补 target。

采集按显式 hint 或唯一可访问名称定位。语义不同、重名或缺少线索时输出 `kind: binding` 请求。宿主只能选择报告中的 candidateId；程序重新验证目标，最多接受两轮消歧。缺少候选时修正状态或计划并重新规划，不能猜坐标。

请求响应通用外壳：

```json
{ "requestId": "请求 UUID", "inputHash": "请求中的 hash", "output": {} }
```

提交：`manual resume <runId> --request <requestId> --input <响应.json>`。文案请求仍使用 `output.copy`；分类和绑定请求不适用文案格式。

## 分类计划输入

layout 请求的 `output` 是单页补丁，可包含 title、purpose、features、sections、figures、states、variants 和 scenarios。页面路由、生命周期和任务审批不在授权字段内。独立迁移的输入是 `{ "pages": [{ "id": "chat", ... }], "scenarios": [...] }`。

```json
{
  "title": "AI 对话",
  "purpose": "描述需求并选择教学能力。",
  "features": [{
    "id": "page:chat:send", "label": "发送需求", "priority": "required",
    "contentKind": "operation", "guideId": "send",
    "sourceRefs": ["app/chat/page.tsx"],
    "operations": [{
      "id": "send-request", "instruction": "点击「发送」。",
      "evidenceRequirement": "entry", "risk": "write",
      "bindingIntent": { "role": "button", "name": "发送" }
    }]
  }],
  "sections": [{
    "id": "start", "title": "开始对话", "goal": "描述需求并开始对话。",
    "featureRefs": ["page:chat:send"], "figureRefs": ["input"]
  }],
  "figures": [{
    "id": "input", "sectionId": "start", "operationRefs": ["send-request"],
    "purpose": "entry", "caption": "发送需求的入口",
    "frame": { "mode": "auto", "padding": 64 }
  }]
}
```

| 对象 | 字段与约束 |
|---|---|
| Feature | `id`/`feature_id` 沿用稳定功能身份；label；priority 为 required/optional/skip/undecided；contentKind 为 operation/concept/reference；sourceRefs；operations；旧 guide 必须一对一保留 guideId |
| Operation | 页面内唯一安全 slug id；instruction；evidenceRequirement；可选 targetHint（现有 Target schema）、bindingIntent（role、name）、risk、sourceRefs、taskId、claimId、noImageReason |
| Section | 唯一 slug id；title、goal；featureRefs、figureRefs。一个功能归属一个小节，多状态图放同一小节；required 必须收录，skip/undecided 不能进入正文 |
| Figure | 唯一 slug id；sectionId；operationRefs；caption；purpose 为 entry/state/overview；scenarioId 默认 page-<id>，checkpointId 默认 default；frame |
| Frame | auto：目标集合加上下文留白；region：必须给可定位的命名区域 target；viewport：保留完整视口。padding 为 32～200 CSS px |

类别按读者目标划分。每张图优先 1～3 个相关标注，硬上限沿用主题 maxMarkersPerImage（默认 5），超过时在同一小节中分图。标注号在每张图从 1 开始，与 guide 下标、步骤序号、稳定 ID 分离。优先局部区域；必须保留整页时在 caption 写明理解所需的上下文。

## 证据要求

- `entry`：已验证绑定、有效最终图及实际绘制的标注，只证明入口可见。
- `state`：purpose=state 的独立状态图，Scenario 对应检查点至少有一个非 URL 断言；截图后继续复核状态。
- `result`：入口/状态图之外，引用已有已批准任务的 taskId 与 claimId。必须有已发布的真实 verified claim，模拟、未执行和 legacy-unbound 不满足要求。任务授权与执行继续走现有任务流程。
- `none`：仅 concept/reference，必须提供 sourceRefs 和 noImageReason。缺少定位不能自动改为无图说明。

optional 是范围决定；一旦 featureRefs 收录，该操作也必须满足证据要求。草稿可以报告缺口，internal/public 正式发布均阻断未覆盖操作。范围审核、操作覆盖、绘制、隐私和结果验证在报告中分开显示；零分母为 N/A。

状态通过现有 Scenario setup/checkpoint 回放，新分类 Scenario 只允许 read/local setup。发送、注册、上传、删除交由已授权任务；演示值、Fixture 和网络守卫沿用原有规则。展示模拟界面须保留来源提示。

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

`verify --artifacts` 从发布时冻结事实重新核对操作与图片证据；`verify --live` 按分类 Scenario 和检查点回放状态、核对已发布绑定并比较局部图。通过入口核验不会升级为业务结果成功。
