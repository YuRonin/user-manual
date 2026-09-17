# Task-first Living User Manual Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在保留现有页面式工作流的前提下，实现以用户任务为发布主体的发现、审批、采集、脱敏标注、生成和验证链路。

**Architecture:** 页面与任务使用独立事实文件，通过派生索引关联。CLI 只负责确定性校验和落盘，AI 负责语义候选与中文编辑，浏览器负责真实交互证据；所有写操作、隐私检查和正式发布都有硬门禁。

**Tech Stack:** Node.js 18+、CommonJS、js-yaml、现有 Playwright Provider、Node 内置测试与图像处理适配层。

---

### Task 1: 用户任务领域模型

**Files:**
- Create: `src/tasks/model.js`
- Create: `test/task-model.test.js`
- Modify: `test/run.js`

1. 先写失败测试，覆盖必填字段、稳定步骤 ID、生命周期、风险继承和写操作默认停止。
2. 运行 `node test/task-model.test.js`，确认因模块不存在而失败。
3. 实现 `validateTask`、`normalizeTask`、`effectiveRisk`、`transitionTask`。
4. 重跑测试，确认通过。

### Task 2: 任务事实存储与人工审批

**Files:**
- Create: `src/tasks/store.js`
- Create: `src/commands/approve-tasks.js`
- Create: `test/task-store.test.js`
- Modify: `bin/manual.js`
- Modify: `test/run.js`

1. 先写失败测试，覆盖候选 YAML 的稳定序列化、读取错误、只允许人工输入推进 `approved`、拒绝跳级。
2. 运行目标测试并确认正确失败。
3. 实现 `.manual/tasks/` 读写及 `approve-tasks --input <json>`。
4. 重跑目标测试和旧 CLI 测试。

### Task 3: 候选任务发现与任务索引

**Files:**
- Create: `src/tasks/discovery.js`
- Create: `src/commands/discover-tasks.js`
- Create: `test/discover-tasks.test.js`
- Modify: `src/inspect/index-builder.js`
- Modify: `src/inspect/store.js`
- Modify: `bin/manual.js`
- Modify: `test/index-builder.test.js`
- Modify: `test/run.js`

1. 先写失败测试，覆盖页面工作清单、候选输入验证、候选保持 `candidate`、任务到页面/源码的正逆索引。
2. 运行测试确认缺少功能导致失败。
3. 实现两阶段 `discover-tasks`：无输入返回工作清单，有输入写候选任务。
4. 扩展派生索引而不破坏旧页面键。
5. 重跑目标测试和完整测试。

### Task 4: 页面状态与截图计划

**Files:**
- Create: `src/tasks/capture-plan.js`
- Create: `src/commands/plan-capture.js`
- Create: `test/capture-plan.test.js`
- Modify: `src/inspect/model.js`
- Modify: `src/inspect/store.js`
- Modify: `bin/manual.js`

先用失败测试定义可见状态断言、关键截图选择、语义定位优先级和未批准任务门禁，再实现确定性截图计划与页面状态存储。

### Task 5: 安全任务执行

**Files:**
- Modify: `src/browser/provider.js`
- Modify: `src/browser/playwright.js`
- Create: `src/tasks/executor.js`
- Create: `src/commands/capture-task.js`
- Create: `test/capture-task.test.js`
- Modify: `test/server.js`
- Modify: `bin/manual.js`

先以浏览器夹具测试 read/local/write/destructive、歧义目标和断言失败，再增加语义定位、交互、清理与诊断图；write 停在动作前，destructive 不执行。

### Task 6: 配置、隐私与标注

**Files:**
- Modify: `src/config/schema.js`
- Modify: `src/config/load.js`
- Modify: `src/config/render.js`
- Create: `src/artifacts/redaction.js`
- Create: `src/artifacts/annotation.js`
- Create: `src/artifacts/manifest.js`
- Create: `test/redaction.test.js`
- Create: `test/annotation.test.js`
- Modify: `test/init.test.js`

先写失败测试定义默认主题、覆盖校验、产物分层、DOM 到像素转换、敏感信息不落清单和不确定时阻止发布，再实现 sanitized 与 annotated 管线及黄金图验证。

### Task 7: 任务指南与原子发布

**Files:**
- Create: `src/generate/task-draft.js`
- Create: `src/generate/task-facts.js`
- Create: `src/commands/generate-task.js`
- Create: `src/commands/verify.js`
- Create: `test/generate-task.test.js`
- Create: `test/verify-task.test.js`
- Modify: `bin/manual.js`

先写失败测试定义指南章节、结构化事实保护、verified/expected 边界和 Markdown+图片原子替换，再实现草稿、定稿和验证命令。

### Task 8: 增量失效与迁移

**Files:**
- Create: `src/tasks/staleness.js`
- Create: `src/commands/migrate-artifacts.js`
- Create: `test/staleness.test.js`
- Create: `test/migrate-artifacts.test.js`
- Modify: `src/commands/inspect.js`

用测试定义源码、入口、UI 名称与状态变化如何使任务 stale；迁移只报告并复制旧原图，未经确认不删除用户文件。

### Task 9: Skill 路由与验收文档

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Create: `references/task-workflow.md`
- Create: `test/task-first-e2e.test.js`

将 `SKILL.md` 缩成准确路由入口，把详细任务工作流放进 reference。以“修改个人资料”和“查看学校权益”夹具跑通发现、批准、截图计划、安全采集、脱敏标注、生成与验证，并运行 `npm test` 与 skill quick validator。
