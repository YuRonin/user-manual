# 标注覆盖率（P0）

`inspect`、`describe` 和任务发现/审批会更新 `.manual/feature-inventory.json`。它从页面的 `detectedActions`、`guide`、可选的 `features` 以及任务步骤生成稳定的 `feature_id`。`detectedActions` 中未关联指南或显式决策的功能保持 `undecided`，出现在 `pending`，不能被当作已确认的完整清单。

页面可以在 `describe --input` 的页面条目里显式补充功能决策：

```json
{
  "pages": [{
    "id": "workspace",
    "features": [{
      "feature_id": "upload-attachment",
      "label": "上传附件",
      "priority": "required",
      "description": "选择并上传教学资料。",
      "task_ids": ["upload-material"],
      "scenario": "default",
      "target": { "role": "button", "name": "上传附件" }
    }]
  }]
}
```

`priority` 为 `required`、`optional`、`skip` 或 `undecided`。显式 `features` 的决定优先；没有显式决定时，带 `target` 的 guide 记为 `required`，不带 `target` 的说明性 guide 记为 `optional`（不要求画出）。显式 `required` 的功能即使缺 `target` 也不会降级，而是报 `target-not-declared`。

页面默认截图的计划来自 `guide`，编号等于 guide 下标 + 1（含没有 target 的条目），与正文小节编号一致；显式 Scenario 只校验本 Scenario 的功能和 checkpoint `capture.annotations` 引用的功能，不混入默认 guide。任务截图的计划来自步骤 `capture.annotations`；没有显式标注时使用该步骤动作目标，这个隐式标注默认是 `optional`（截"操作后"图时目标可能已消失），编号等于步骤号。页面功能只有在 `feature_id` 等于步骤的 `feature_id`、或 `target` 与步骤动作目标一致时才归属该步骤；仅写了 `task_ids` 不会注入到任务的每一步。需要在正文中解释的 Required 功能必须有 `description`，并与页面指南块或任务步骤关联；单独声明的功能在最终正文中必须出现其说明文字。

每次新 Capture 私有保存 `raw.png`、`derivation.json` 和 `annotations.json`，发布图仍写入 `annotated` 目录。`annotations.json` 记录 Inventory、Plan、逐项定位与绘制结果，以及 Required 覆盖率。目标在图外、未定位、超出单图标注上限、缺少计划或说明时会记录明确原因；Required 失败时保留原图与报告，但不生成发布图。`rederive` 可用原图和已存坐标重新绘制，旧 Capture 没有新元数据时按兼容格式读取。

`verify --artifacts --json` 的 `annotationCoverage` 报告可区分 `complete`、`pending-review`、`incomplete` 和 `legacy-unknown`；逐张图的 `status` 为 `passed`、`failed` 或 `unknown`（旧 Capture 没有覆盖结果，目前只提示、不阻断发布）。标注无法排版时报 `annotation-layout-failed`，不会被归为导航失败。覆盖率分母只计算当前截图范围内的 Required；Optional 与 Skip 不计入。当前 P0 从已有源码分析与任务模型交叉核对发现清单，不自动判定所有 DOM 控件的业务重要性；交互状态缺失时需在 Scenario 中补采，自动修复留待下一阶段。
