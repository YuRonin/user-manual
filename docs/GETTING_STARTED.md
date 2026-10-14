# DocWitness · 安装与接入

## 快速开始

需要 Node.js **20.9.0 或更新版本**，以及能启动 Chromium 的环境。先安装工具，再在要编写手册的 Next.js 项目中启动应用。

### 1. 安装

克隆本仓库，在仓库根目录运行：

```bash
git clone https://github.com/YuRonin/docwitness.git
cd docwitness
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

完整别名还包括 `describe`、`auth`、`site` 和 `doctor`。客户端会按 [SKILL.md](../SKILL.md) 处理源码分析、任务审批、模型文案与需要人工参与的步骤。

### 3. 直接使用 CLI

CLI 无需全局 npm 安装。从工具仓库运行，并用 `--project-root` 指向目标项目：

```bash
node /path/to/docwitness/bin/manual.js doctor --project-root /path/to/your-nextjs-app
node /path/to/docwitness/bin/manual.js init --project-root /path/to/your-nextjs-app --base-url http://localhost:3000
node /path/to/docwitness/bin/manual.js inspect --project-root /path/to/your-nextjs-app
```

以下示例用 `manual` 简写同一个 CLI；直接运行时，替换为上面的 `node .../bin/manual.js` 路径。`doctor` 是只读环境检查，`init` 创建 `.manual/config.yaml`，`inspect` 生成页面地图。`inspect` 之后，需要阅读源码并用 `describe --input <分析.json>` 补充页面用途和操作；AI skill 会引导这一步。[命令细节](../references/command-workflows.md)给出了输入格式。

### 4. 受登录保护的站点

先在 `.manual/config.yaml` 配好 `auth.verifyPath` 与 `auth.identityAssertions`，再运行：

```bash
manual auth login --profile default   # 打开一次可见浏览器，手动登录后保存登录状态
manual auth check                     # 在线确认登录状态仍然有效
```

cookies 与 localStorage 保存在当前系统用户的缓存目录（Windows 为 `%LOCALAPPDATA%`），不写进项目，可跨 worktree 复用。运行中遇到 `auth-missing`（还没有认证档案）或 `auth-expired`（登录已失效）时，运行 `manual auth login --resume <runId>`，登录后自动继续。

两点容易踩坑：侧栏收起这类界面状态如果存在 localStorage，在 `auth.ephemeralStorageKeys` 里列出，避免被写回认证档案；Demo 截图默认中止所有非只读请求，站点靠 `POST` 刷新令牌时要把刷新接口登记到 `capture.demo.network.allow`，否则令牌过期后页面会被登出。细节见[命令细节](../references/command-workflows.md)与 [Demo Capture](DEMO_CAPTURE.md)。
