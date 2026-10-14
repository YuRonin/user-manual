# DocWitness · 使用与维护

## 一份手册怎样生成

```text
源码与路由 → 页面 / 任务模型 → 浏览器采集与标注 → 事实草稿
           → AI 填写说明文案 → 事实和发布校验 → Markdown 手册
```

页面说明介绍页面用途、选项和操作。任务指南围绕读者要完成的目标，列出前提条件、步骤截图和完成标志。候选任务必须经过用户批准才会采集或发布。

```bash
manual task-guide "修改个人资料"             # 查找入口和操作线索
manual discover-tasks <page-id>             # 保存候选任务
manual approve-tasks --input decisions.json # 批准要采集的任务
manual generate task:edit-profile           # 采集、出稿并进入发布流程
```

`generate` 默认在需要模型文案时暂停，返回等待输入状态；客户端按请求文件填写文案后通过 `resume` 继续。直接使用 CLI 时，运行 `manual status <runId>` 查看下一步，再按 [Runtime 使用说明](RUNTIME.md)提交响应。`--plan` 可先查看执行范围，`--offline` 只用已有证据，`--refresh` 重新采集。`--copy-default` 可生成未经润色的粗稿，交付前需要人工审阅。

输出在目标项目中，默认结构如下：

```text
.manual/                       配置、模型、运行记录和本地中间产物
docs/manual/index.md           手册目录
docs/manual/<page-id>.md       页面说明
docs/manual/tasks/<task-id>.md 任务指南
docs/manual/images/annotated/ 通过发布校验的标注截图
docs/manual/meta.json          文档更新时间和相关文章
```

生成的 Markdown 可以继续用 `manual site` 转成静态帮助中心，默认输出到 `.manual/site/`。网站包含目录、页面导航、任务完成提示和 WebP 截图；配置见[命令细节](../references/command-workflows.md#帮助中心网站manual-site)。

## 更新与核对

```bash
manual update --plan       # 预览代码变化会影响哪些手册
manual update              # 更新受影响的已发布手册
manual verify --all        # 离线核对文档与证据
manual verify --all --live # 在真实浏览器中回放可安全执行的步骤
manual verify --routes     # 浏览器路由审计：找出页面模型里没有登记的路由
```

`update` 依据源码依赖关系定位影响范围。远端数据、权限或部署发生变化但源码未变时，用 `verify --live` 检查。在线核对不会自动重做写操作；结果会区分失败、内容漂移和环境导致的无法判断。`verify --routes` 用已授权的认证档案打开站点，对照页面里的站内链接（Vue 3 应用另读运行时路由表），只报告疑似遗漏，不修改页面模型。人工写在生成块之外的内容会保留；生成块和人工修改冲突时会暂停，等待处理。[Runtime 使用说明](RUNTIME.md)解释缓存、恢复和冲突流程。

## 截图与发布边界

- **真实界面**：截图来自浏览器实际渲染。页面打不开或证据不足时会报告原因，不用猜测内容补图。
- **演示数据**：公开内容、Fixture、精确 API Mock 或受控的页面替换可用于构造演示场景。敏感内容未处理完时，截图状态为 `needs_fixture` 或 `blocked`，不能发布。
- **写操作**：未授权的提交、删除、支付等请求会被阻断；需要展示结果时，应使用完整的 Fixture 模拟或经过明确授权的测试操作。
- **可追溯**：正式文档只引用通过门禁的发布图。原图和诊断产物保留在本地受控目录，不进入公开手册。

如何配置 `capture.demo`、Fixture 和网络规则，见 [Demo Capture](DEMO_CAPTURE.md)；标注覆盖与发布条件见 [标注覆盖率](ANNOTATION_COVERAGE.md)。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 环境检查与首次接入 | `doctor`、`init`、`inspect`、`describe`、`auth` |
| 编写页面与任务指南 | `task-guide`、`discover-tasks`、`approve-tasks`、`generate`、`review-task` |
| 查看和继续运行 | `status`、`resume` |
| 维护与发布 | `update`、`verify`、`site` |
| 高级操作 | `capture`、`plan-capture`、`capture-task`、`publication`、`gc`、`migrate` |

运行 `node bin/manual.js --help` 或 `node bin/manual.js <命令> --help` 查看完整参数；加 `--json` 获取结构化结果。旧命令的迁移方式见 [迁移与兼容说明](MIGRATION.md)。

旧入口 `run-submit`、`generate-task`、`migrate-artifacts` 仍可执行，分别迁移到 `resume --request --input`、`generate task:<id>`、`migrate`；新项目从上表的命令开始。

## 开发与测试

```bash
npm run test:unit
npm run test:browser
npm test
```

浏览器测试使用本地测试服务器和真实 Chromium。本仓库不配置 GitHub Actions；跨平台验证需在相应机器安装依赖并运行测试。架构、模型和扩展约定见[架构文档](ARCHITECTURE.md)。
