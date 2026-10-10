# 任务发现与人工确认

只在执行 `discover-tasks` 或 `approve-tasks` 时读取本文。

## 发现候选

先让 CLI 给出证据工作清单：

```bash
node <skill>/bin/manual.js discover-tasks <page-id> \
  --project-root <业务项目根目录> --json
```

`--all` 可以替代单个页面 ID。先看 `worklist[].stepHints`（页面指南的步骤线索）、`assertionHints`（页面状态断言）、`preconditionHints`（同入口任务已写的前提）和 `existingTasks`（避免重复建模），再读取 `worklist[].read` 中与候选相关的源码，结合页面的 `title`、`purpose`、`detectedActions` 和浏览器验证状态提出候选任务。`page.browserObservation` 只指向**入口页面**的真实 Capture；其余线索都标为 `verified: false`，属于模型或已有任务推断。已有断言也要核对是否证明该任务的目标，不能把页面已验证等同于任务完成。步骤目标与动作类型仍需核对。优先保留有明确结果、需要多个动作、入口不明显或存在阻断分支的目标；导航动作、重复入口和没有独立结果的按钮通常不单独成任务。

把候选写成 JSON 文件：

若步骤直接沿用入口页 `guide` 中带目标的条目，可写 `{ "guideStep": "practice", "action": { "type": "click" } }`。写入时工具会填入该指南的步骤 ID、说明、页面和目标，指南小标题符合步骤标题规则时也作为步骤 `title`；动作类型必须由建模者明确给出，也可显式覆盖说明或目标。引用不存在或无目标、缺少动作类型时整批拒绝。此简写只减少候选输入字段，仍是 `candidate`，需要人工核对并批准。

```json
{
  "tasks": [
    {
      "id": "edit-profile",
      "title": "修改个人资料",
      "goal": "更新昵称、性别或教学信息",
      "entryPage": "user-center",
      "priority": "high",
      "preconditions": ["已登录"],
      "risk": "local",
      "steps": [
        {
          "id": "open-editor",
          "title": "打开编辑面板",
          "instruction": "点击「编辑资料」",
          "page": "user-center",
          "action": { "type": "click", "target": { "role": "button", "name": "编辑资料" } }
        },
        {
          "id": "save-profile",
          "title": "保存修改",
          "instruction": "确认资料无误后，点击「保存修改」",
          "page": "user-center",
          "action": { "type": "click", "target": { "role": "button", "name": "保存修改" } },
          "risk": "write"
        }
      ],
      "completion": {
        "description": "个人中心显示更新后的内容",
        "verification": "expected"
      },
      "evidence": [
        { "kind": "source", "file": "components/user/ProfileSheet.tsx" }
      ]
    }
  ]
}
```

写入候选：

```bash
node <skill>/bin/manual.js discover-tasks <page-id> \
  --project-root <业务项目根目录> --input <候选.json> --json
```

CLI 会把状态强制为 `candidate`，并按风险补充执行边界：`read` / `local` 自动执行，`write` 停在动作前，`destructive` 永不执行。

## 人工确认

向用户展示每个候选的名称、目标、入口页面、预计步骤数、风险、证据摘要和保留/合并/舍弃建议。用户可以改标题、目标和优先级，或拒绝候选。

确认后写决策文件：

```json
{
  "decisions": [
    {
      "id": "edit-profile",
      "decision": "approve",
      "title": "修改个人资料",
      "priority": "high"
    },
    { "id": "duplicate-task", "decision": "reject" }
  ]
}
```

再执行：

```bash
node <skill>/bin/manual.js approve-tasks \
  --project-root <业务项目根目录> --input <决策.json> --json
```

所有决策先整体校验再落盘。只有 `candidate` 可以批准或拒绝；批准后状态为 `approved`，拒绝会删除尚未进入后续阶段的候选文件。不要手工编辑任务 YAML 来绕过审批。

## 批准之后：生成、维护与验证

- 生成：`manual generate task:<id> --plan --json` 先展示动作、风险边界与需要浏览器的场景，用户确认后去掉 `--plan` 执行。
- 维护：代码变化后用 `manual update --plan` 查看哪些任务指南受影响（`reasonPaths` 给出原因链），确认后 `manual update`。
  指南里块外的人工补充会被保留；与生成内容冲突时停在退出码 4，按 `proposed.md` 与用户确认处理。
- 验证：`manual verify task:<id>` 是离线产物检查；`manual verify task:<id> --live` 真实回放安全步骤与完成声明，
  写 / 破坏性步骤不执行（对应声明 `not_run`），报告验证覆盖与停止边界。不要把 `not_run` 说成"已验证"。
- 不同数据状态或角色：在 `.manual/scenarios/<id>.yaml` 声明 Scenario（`authProfile`、`data.mode: fixture` 引用
  `.manual/fixtures/` 中登记的 Fixture），用 `manual capture scenario:<id>` 采集；mock Fixture 的结果是 `simulated`，
  只说明界面如何呈现，完成声明不能写成"已验证"。生产环境与未登记环境一律拒绝执行 Fixture。
