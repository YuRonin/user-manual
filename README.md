# Living User Manual

页面手册按读者要完成的子流程组织小节：一句使用场景、一组连续编号的步骤（截图标注号即步骤号）、做完之后的结果和状态图，再加提示与常见问题；验证码、注册这类写操作可用 mock Fixture 在浏览器内模拟到成功那一屏。菜单、弹窗及结果使用各自状态的证据。多项旧说明通过 Runtime 自动生成分类计划，控件关联由浏览器验证，缺少证据会阻断正式发布。使用方式与模型字段见 [分类图文手册](docs/GROUPED_MANUAL.md)。

为 Next.js 项目生成并持续维护图文使用手册。它读取页面源码，使用真实浏览器采集界面与操作证据，生成页面说明和任务指南；项目变化后，只更新受影响的内容。

可作为 **Claude Code / Codex Skill** 使用，也可直接运行 Node.js CLI。当前路由扫描支持 Next.js App Router 和 Pages Router；其他框架会收到明确的暂不支持提示。

## 它做什么

| 能力 | 结果 |
| --- | --- |
| 建立项目地图 | 扫描路由和源码依赖，记录页面、功能候选与任务入口 |
| 采集真实界面 | 在 Chromium 中访问页面、执行已授权的操作、截图并标注控件 |
| 生成手册 | 输出页面说明、按目标组织的任务指南，以及可选的静态帮助中心 |
| 持续维护 | 根据代码依赖定位受影响手册，并用浏览器回放检查线上变化 |
| 控制发布风险 | 对演示数据、隐私、写操作、截图证据和文案事实执行门禁 |

手册中的操作顺序、界面名称、截图和完成标志来自结构化模型与采集证据。AI 可以把说明写得更自然，不能把未经验证的功能或结果写成事实。

## 快速开始

需要 Node.js **20.9.0 或更新版本**，以及能启动 Chromium 的环境。先安装工具，再在要编写手册的 Next.js 项目中启动应用。

### 1. 安装

克隆本仓库，在仓库根目录运行：

```bash
git clone https://github.com/YuRonin/user-manual.git
cd user-manual
npm ci
npx playwright install chromium
```

Linux 上安装浏览器时可用 `npx playwright install --with-deps chromium` 安装系统依赖；中文截图还需要可用的 CJK 字体。

将仓库链接为两个客户端的 `manual` skill。根据系统选择一组命令；只使用一个客户端时，也建议建立两个链接，因为生成的 Claude Code 命令别名通过 Codex 的 `manual` 路径定位主 skill。

**macOS / Linux**（在仓库根目录）：

```bash
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s "$(pwd)" ~/.claude/skills/manual
ln -s "$(pwd)" ~/.codex/skills/manual
npm run install:compat
```

**Windows PowerShell**（在仓库根目录）：

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills", "$HOME\.codex\skills" | Out-Null
New-Item -ItemType Junction -Path "$HOME\.claude\skills\manual" -Target (Get-Location).Path
New-Item -ItemType Junction -Path "$HOME\.codex\skills\manual" -Target (Get-Location).Path
npm run install:compat
```

如果 `manual` 目录已存在，先确认它指向哪里，再决定是否更新；不要用上述命令覆盖已有安装。`install:compat` 为两个客户端各生成 9 个主流程别名，并清理旧版本由本工具生成、现已停用的别名。源码是目录链接，修改本仓库后两个客户端都会读取到最新内容。

### 2. 在 AI 客户端中使用

在目标项目里打开 Claude Code 或 Codex，直接描述目标，例如：

> 为这个项目建立图文使用手册，先检查环境并扫描页面。发布前让我确认任务范围。

也可以使用主 skill `manual`，或使用命令别名：

| 阶段 | Claude Code | Codex |
| --- | --- | --- |
| 初始化 | `/manual-init` | `$manual-init` |
| 扫描页面 | `/manual-inspect` | `$manual-inspect` |
| 生成手册 | `/manual-generate` | `$manual-generate` |
| 更新 / 核对 | `/manual-update`、`/manual-verify` | `$manual-update`、`$manual-verify` |

完整别名还包括 `describe`、`auth`、`site` 和 `doctor`。客户端会按 [SKILL.md](SKILL.md) 处理源码分析、任务审批、模型文案与需要人工参与的步骤。

### 3. 直接使用 CLI

CLI 无需全局 npm 安装。从工具仓库运行，并用 `--project-root` 指向目标项目：

```bash
node /path/to/user-manual/bin/manual.js doctor --project-root /path/to/your-nextjs-app
node /path/to/user-manual/bin/manual.js init --project-root /path/to/your-nextjs-app --base-url http://localhost:3000
node /path/to/user-manual/bin/manual.js inspect --project-root /path/to/your-nextjs-app
```

以下示例用 `manual` 简写同一个 CLI；直接运行时，替换为上面的 `node .../bin/manual.js` 路径。`doctor` 是只读环境检查，`init` 创建 `.manual/config.yaml`，`inspect` 生成页面地图。`inspect` 之后，需要阅读源码并用 `describe --input <分析.json>` 补充页面用途和操作；AI skill 会引导这一步。[命令细节](references/command-workflows.md)给出了输入格式。

### 4. 受登录保护的站点

先在 `.manual/config.yaml` 配好 `auth.verifyPath` 与 `auth.identityAssertions`，再运行：

```bash
manual auth login --profile default   # 打开一次可见浏览器，手动登录后保存登录状态
manual auth check                     # 在线确认登录状态仍然有效
```

cookies 与 localStorage 保存在当前系统用户的缓存目录（Windows 为 `%LOCALAPPDATA%`），不写进项目，可跨 worktree 复用。运行中遇到 `auth-missing`（还没有认证档案）或 `auth-expired`（登录已失效）时，运行 `manual auth login --resume <runId>`，登录后自动继续。

两点容易踩坑：侧栏收起这类界面状态如果存在 localStorage，在 `auth.ephemeralStorageKeys` 里列出，避免被写回认证档案；Demo 截图默认中止所有非只读请求，站点靠 `POST` 刷新令牌时要把刷新接口登记到 `capture.demo.network.allow`，否则令牌过期后页面会被登出。细节见[命令细节](references/command-workflows.md)与 [Demo Capture](docs/DEMO_CAPTURE.md)。

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

`generate` 默认在需要模型文案时暂停，返回等待输入状态；客户端按请求文件填写文案后通过 `resume` 继续。直接使用 CLI 时，运行 `manual status <runId>` 查看下一步，再按 [Runtime 使用说明](docs/RUNTIME.md)提交响应。`--plan` 可先查看执行范围，`--offline` 只用已有证据，`--refresh` 重新采集。`--copy-default` 可生成未经润色的粗稿，交付前需要人工审阅。

输出在目标项目中，默认结构如下：

```text
.manual/                       配置、模型、运行记录和本地中间产物
docs/manual/index.md           手册目录
docs/manual/<page-id>.md       页面说明
docs/manual/tasks/<task-id>.md 任务指南
docs/manual/images/annotated/ 通过发布校验的标注截图
docs/manual/meta.json          文档更新时间和相关文章
```

生成的 Markdown 可以继续用 `manual site` 转成静态帮助中心，默认输出到 `.manual/site/`。网站包含目录、页面导航、任务完成提示和 WebP 截图；配置见[命令细节](references/command-workflows.md#帮助中心网站manual-site)。

## 更新与核对

```bash
manual update --plan       # 预览代码变化会影响哪些手册
manual update              # 更新受影响的已发布手册
manual verify --all        # 离线核对文档与证据
manual verify --all --live # 在真实浏览器中回放可安全执行的步骤
```

`update` 依据源码依赖关系定位影响范围。远端数据、权限或部署发生变化但源码未变时，用 `verify --live` 检查。在线核对不会自动重做写操作；结果会区分失败、内容漂移和环境导致的无法判断。人工写在生成块之外的内容会保留；生成块和人工修改冲突时会暂停，等待处理。[Runtime 使用说明](docs/RUNTIME.md)解释缓存、恢复和冲突流程。

## 截图与发布边界

- **真实界面**：截图来自浏览器实际渲染。页面打不开或证据不足时会报告原因，不用猜测内容补图。
- **演示数据**：公开内容、Fixture、精确 API Mock 或受控的页面替换可用于构造演示场景。敏感内容未处理完时，截图状态为 `needs_fixture` 或 `blocked`，不能发布。
- **写操作**：未授权的提交、删除、支付等请求会被阻断；需要展示结果时，应使用完整的 Fixture 模拟或经过明确授权的测试操作。
- **可追溯**：正式文档只引用通过门禁的发布图。原图和诊断产物保留在本地受控目录，不进入公开手册。

如何配置 `capture.demo`、Fixture 和网络规则，见 [Demo Capture](docs/DEMO_CAPTURE.md)；标注覆盖与发布条件见 [标注覆盖率](docs/ANNOTATION_COVERAGE.md)。

## 常用命令

| 目的 | 命令 |
| --- | --- |
| 环境检查与首次接入 | `doctor`、`init`、`inspect`、`describe`、`auth` |
| 编写页面与任务指南 | `task-guide`、`discover-tasks`、`approve-tasks`、`generate`、`review-task` |
| 查看和继续运行 | `status`、`resume` |
| 维护与发布 | `update`、`verify`、`site` |
| 高级操作 | `capture`、`plan-capture`、`capture-task`、`publication`、`gc`、`migrate` |

运行 `node bin/manual.js --help` 或 `node bin/manual.js <命令> --help` 查看完整参数；加 `--json` 获取结构化结果。旧命令的迁移方式见 [迁移与兼容说明](docs/MIGRATION.md)。

旧入口 `run-submit`、`generate-task`、`migrate-artifacts` 仍可执行，分别迁移到 `resume --request --input`、`generate task:<id>`、`migrate`；新项目从上表的命令开始。

## 开发与测试

```bash
npm run test:unit
npm run test:browser
npm test
```

浏览器测试使用本地测试服务器和真实 Chromium。本仓库不配置 GitHub Actions；跨平台验证需在相应机器安装依赖并运行测试。架构、模型和扩展约定见 [架构文档](docs/ARCHITECTURE.md)。
