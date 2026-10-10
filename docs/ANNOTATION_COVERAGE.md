# 标注覆盖率

## 功能清单：Required 从哪里来

**Required 只来自显式确认**：页面 `features` 里由 `describe --input` 写入的决定。其余来源都只是待确认候选（`undecided`），照常进入标注计划、出图，但不计入 Required 分母，避免"计划核对计划"：

| 来源 | 优先级 |
|---|---|
| `features` 的显式决定 | 按声明：`required` / `optional` / `skip` / `undecided` |
| 带 `target` 的 guide（没有对应的显式功能） | `undecided`（候选） |
| 不带 `target` 的说明性 guide | `optional`（不要求画出） |
| `detectedActions` | `undecided`（候选） |
| 截图时页面上发现、清单未覆盖的按钮 / 标签页 / 菜单项 / 开关 / 复选框 / 下拉框（无障碍树） | 候选（`unresolvedCandidates`） |
| 任务步骤的隐式动作目标 | `optional`（截"操作后"图时目标可能已消失） |

显式功能与 guide 的对应顺序：`guide.featureId` → 目标相同 → 唯一同名（重名不猜）。`detectedActions` 动作句里「」标出的控件名与功能名称或目标名一致，也算已覆盖。页面上发现的元素不计链接与输入框；全站通用控件可在 `config.yaml` 的 `inventory.ignoreCandidates` 里列出名称（`前缀*` 为前缀匹配）。显式 `required` 的功能缺 `target` 不会降级，而是报 `target-not-declared`。

```json
{
  "pages": [{
    "id": "workspace",
    "features": [
      { "id": "upload-attachment", "label": "上传附件", "priority": "required", "description": "选择并上传教学资料。",
        "taskIds": ["upload-material"], "target": { "role": "button", "name": "上传附件" } },
      { "id": "help", "label": "帮助中心", "priority": "skip" }
    ],
    "guide": [{ "id": "upload", "title": "上传附件", "instruction": "点击「上传附件」选择文件。", "target": { "role": "button", "name": "上传附件" }, "featureId": "upload-attachment" }]
  }]
}
```

`id` / `taskIds` 是新写法，旧的 `feature_id` / `task_ids` 仍可读取。功能 id 由作者写定，标题改动不会让 id 变化。`guide.featureId`、任务步骤的 `feature_id` 必须指向页面上声明过的功能，否则模型提交报 `missing-reference`；批准任务时引用的页面与状态也必须存在。

## 作用域与编号

页面默认截图的计划来自 `guide`，编号等于 guide 下标 + 1（含没有 target 的条目），与正文小节编号一致。显式 Scenario 只校验本 Scenario 的功能和 checkpoint `capture.annotations` 引用的功能。任务截图的计划来自步骤 `capture.annotations`，没有声明时用动作目标，编号等于步骤号。页面功能只有在 id 等于步骤的 `feature_id`、或 `target` 与动作目标一致时才归属该步骤，仅写 `taskIds` 不会注入到每一步。任务级的 Required 功能（页面 `features` 里 `taskIds` 含该任务）只需在任务的任一张截图里画出；一张都没有时定稿报 `missing-from-task-plan`。

## 逐项结果

每一项记录 `located / drawn / visible / visibleRatio / redactedRatio / locator / reason`；`locator` 是实际命中的定位（`{ strategyIndex, fallback }`，或声明矩形 `{ source: 'declared-rect' }`），用了备选定位时采集给出 `annotation-locator-fallback` 提示。几何上能判定的失败：`target-not-declared`、`target-not-located`、`target-occluded`（中心点被别的元素盖住）、`outside-image`、`partially-clipped`（露出比例低于主题的 `minVisibleRatio`，默认 0.8，可配置）、`target-redacted`（一半以上被隐私遮罩盖住）、`marker-limit-exceeded`。Required 只要有一项失败就不生成发布图。

## 证据：随仓库提交的精简证明

每次 Capture 私有保存 `raw.png`、`derivation.json` 和 `annotations.json`（`.manual/artifacts/`，可重建），同时把**精简标注证明**（清单、计划、逐项结果、候选、修订号）内嵌进 `.manual/evidence/captures/<id>.json`。重新 clone 或删除 artifacts 后，发布门槛与 `verify --artifacts` 仍能从证明核对覆盖率与正文说明。旧记录没有证明且 `annotations.json` 缺失时报 `annotation-metadata-invalid`，需要重新采集。

## 发布门槛

| 错误码 | 含义 |
|---|---|
| `annotation-coverage-failed` | Required 未进计划、未画出、不可见或缺说明 |
| `inventory-review-required` | 存在未确认的候选功能：public 定稿阻断，internal 与草稿阶段只提示 |
| `annotation-plan-changed` | 截图之后功能清单（id、优先级、对应 guide、目标）变了；只改标题与说明文字不算 |
| `annotation-label-mismatch` | guide 顺序变了，图上编号与正文编号不再对应 |
| `annotation-coverage-unknown` | 旧证据没有覆盖记录：public 阻断，internal 只提示 |
| `screenshot-required` | public 页面有已确认的必标功能，不能用 `--no-screenshot` 跳过截图 |
| `missing-reference` / `section-ref-invalid` / `capture-subject-mismatch` | 章节引用的 Capture 不存在、不属于本手册、不是该步骤的截图，或标注引用不是图上实际画出的项；Capture 写入时主体字段缺失、证明内部引用不一致也会被拒绝 |
| `missing-from-task-plan` | 任务的必标功能没有在任何一张任务截图里画出 |

发布记录的章节带 `captureRefs`、`annotationRefs`（`<captureId>#<featureId>`）和 `featureRefs`，从章节出发只凭 ID 能走到截图上画出的那一项。`verify --artifacts` 核对已发布的冻结证据：截图之后定义变化只作提示（`annotation-plan-changed` 出现在 warnings），不改写历史截图的结论；重新发布前则必须重采。定义变化后重新派生（只换主题 / 隐私规则）也会被 `annotation-plan-changed` 拒绝。

`verify --artifacts --json` 的 `annotationCoverage` 区分 `complete`、`not-applicable`（没有已确认 Required，也没有待确认项）、`pending-review`、`incomplete` 和 `legacy-unknown`；没有已确认 Required 时覆盖率百分比是 `null`（N/A），不是 100%。
