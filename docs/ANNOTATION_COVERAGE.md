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

每一项记录 `located / drawn / visible / visibleRatio / redactedRatio / outlineRatio / part / locator / reason`；`locator` 是实际命中的定位（`{ strategyIndex, fallback }`，或声明矩形 `{ source: 'declared-rect' }`），用了备选定位时采集给出 `annotation-locator-fallback` 提示。几何上能判定的失败：`target-not-declared`、`target-not-located`（包括元素没有几何）、`target-occluded`（中心点被盖住，或五个取样点中至少三个被盖住）、`outside-image`、`partially-clipped`（露出比例低于主题的 `minVisibleRatio`，默认 0.8，可配置）、`target-redacted`（一半以上被隐私遮罩盖住，多块遮罩按并集计算）、`annotation-layout-crowded`（编号找不到不压住其他目标、编号和遮罩的位置）、`marker-outside-image` / `marker-redacted`（编号出图或压在遮罩上）。Required 只要有一项失败就不生成发布图。

## 布局与拆图

- **编号位置**：依次尝试目标框左侧（与上边线居中）、右侧、上方、下方、左右居中、上下靠右，外侧都放不下时才放进框内角。候选位置必须完整落在画布内，且不能压住已放置的编号、其他目标的元素矩形和隐私遮罩。全部不可用时这一项不画，记 `annotation-layout-crowded`，不会硬塞到重叠位置。贴边目标的框会裁剪到画布边缘，不会整体平移、指向旁边的元素。
- **拆图**：标注数超过主题的 `maxMarkersPerImage`（默认 5）时，按顺序拆成多张发布图（第 1 张 1–5，第 2 张 6–10……）。编号全局连续，正文编号不变。同一条 Capture 记录里每张图是一个 `part: N` 的 `published` 产物，第 2 张起文件名带 `--part-N`；逐项结果与精简证明记录每项在哪张图。页面手册和任务步骤按顺序引用全部分图。
- **坐标**：整页截图前先回到页面顶部；`position: fixed` 的元素不加滚动偏移，贴底的落到文档底部。标注框和隐私遮罩用同一套换算。截图像素尺寸与画布 × DPR 不一致时报 `geometry-scale-mismatch`，不出发布图。
- **主题**：`primary`、`halo` / `haloWidth`、`labelBackground` / `markerStrokeWidth`（编号描边）、`markerText`、`markerSize` / `fontScale`（字号 = 编号直径 × fontScale）、`outlineWidth`、`targetPadding`、`targetRadius` 全部生效。`primaryDark`、`labelText`、`focusMask`、`fallbackColor` 没有消费者，配置里出现时提示 `annotation-theme-deprecated`。布局与主题变化通过渲染器版本（`sharp-svg-3`）和主题修订号触发重新派生，不需要重新登录或采集。

## 在线验证的视觉比较

任务手册的 before / after 步骤截图也使用下述同层比较；`drift.steps` 保留步骤、时机、Capture 与逐图结果。未执行的写操作边界之后不会比较截图。旧任务证据没有采集环境指纹时明确不可比，需要重新采集。

`verify --live` 不拿历史带标注图去比新的无标注图。它用基线 Capture 冻结的标注计划，在当前页面重新定位、重新绘制，然后带标注图对带标注图逐张比较（拆图时每张都比，张数不同即视为变化，`layer: annotated`）。基线没有标注计划时，未标注的 sanitized 对 sanitized（`layer: sanitized`）。只换了标注主题时结果是 `baseline-incompatible`（`annotation-theme-changed`），重新派生即可，不算页面漂移。

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

## 无障碍名称与定位证据（B3-03）

页面、Scenario 与步骤 Capture 的 `semantic.items` 逐项保留 `role / name / level`，新增 `resolution / matchCount / locator`。复用 `locatorFor` 计数：唯一命中为 `unique`，locator 为精确 `{ role, name, level? }`；同名多命中为 `ambiguous`、locator 为 null，不用 `.first()` 猜测。同名摘要条目仍分别保留。未命中为 `missing`；空名称或已脱敏名称为 `redacted-or-unnamed`，无 locator。

不保存控件值或正文；名称沿用语义摘要的 PII 处理，并移除 Demo 替换下来的原始自由文本（包括仍留在 aria-label 的文字、ARIA 归一化空白及快照转义形式）。旧摘要没有关联字段仍可比较；语义 hash 继续只根据角色、名称与层级计算，新增定位元数据不制造漂移。关联代表截图附近时刻的观察，不是永久身份，也不替代实际动作与标注时的唯一定位检查。
