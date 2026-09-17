# Task-first Living User Manual 设计

## 决策

在现有页面模型之外新增独立任务模型。页面继续描述位置、源码与可见状态；任务描述用户目标、前置条件、步骤、风险、分支与完成标志。旧的 `inspect`、`describe`、`capture`、`generate` 保持可用，新能力以独立命令渐进加入。

## 架构

任务能力分四层：

1. `src/tasks/model.js` 负责稳定 ID、结构校验、风险继承和生命周期转换。
2. `src/tasks/store.js` 负责 `.manual/tasks/*.yaml` 的确定性读写；AI 和用户不直接拼 YAML。
3. `discover-tasks` 输出带源码、页面语义和运行态摘要的工作清单，并接收 JSON 候选结果；`approve-tasks` 接收人工决策后才把任务推进到 `approved`。
4. 页面与任务共同生成正逆索引，使源码变化能够追踪到受影响任务。

后续阶段在同一任务模型上增加截图计划、安全交互、脱敏标注、任务指南生成与原子发布，不把这些职责塞进发现命令。

## 数据流

```text
pages/*.yaml + 页面索引
        ↓
discover-tasks 工作清单
        ↓ AI/人工提供候选 JSON
tasks/*.yaml (candidate)
        ↓ 人工审批 JSON
tasks/*.yaml (approved)
        ↓
截图计划 → 安全执行 → 证据清单 → 任务指南 → verify
```

## 安全与兼容

- 候选任务永远不会自动批准。
- `approved` 之前不能进入任务截图与发布阶段。
- 页面式命令与旧配置继续工作。
- 新增配置都提供默认值，不提升 `config.version`。
- 写操作默认 `stop-before-action`；破坏性操作不执行。
- 原图和脱敏中间图最终迁入 `.manual/artifacts/`，迁移前只报告旧发布目录中的文件，不静默删除。

## 验证

每层先写行为测试再实现。第一阶段覆盖模型校验、状态机、风险继承、候选写入、人工审批、页面—任务—源码索引和 CLI 兼容；后续阶段分别增加浏览器夹具、图片黄金图、脱敏和端到端原子发布测试。
