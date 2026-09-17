# 任务发现与人工确认

只在执行 `discover-tasks` 或 `approve-tasks` 时读取本文。

## 发现候选

先让 CLI 给出证据工作清单：

```bash
node <skill>/bin/manual.js discover-tasks <page-id> \
  --project-root <业务项目根目录> --json
```

`--all` 可以替代单个页面 ID。读取 `worklist[].read` 中的源码，并结合页面的 `title`、`purpose`、`detectedActions` 和浏览器验证状态提出候选任务。优先保留有明确结果、需要多个动作、入口不明显或存在阻断分支的目标；导航动作、重复入口和没有独立结果的按钮通常不单独成任务。

把候选写成 JSON 文件：

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
          "instruction": "点击「编辑资料」",
          "page": "user-center",
          "action": { "type": "click", "target": { "role": "button", "name": "编辑资料" } }
        },
        {
          "id": "save-profile",
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
