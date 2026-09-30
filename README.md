# Living User Manual

## 客户端调用兼容

主 skill 名为 `manual`，CLI 仍使用 `manual <command>`。运行 `npm run install:compat` 后，同时支持：

- Codex：`$manual-init`、`$manual-inspect`、`$manual-capture`、`$manual-generate` 等。
- Claude Code：`/manual-init`、`/manual-inspect`、`/manual-capture`、`/manual-generate` 等。

兼容安装器为每个子命令生成薄别名，实际逻辑仍由同一份 `bin/manual.js` 执行。Codex 也可继续使用 `$manual` 后在参数中指定子命令。

为任意 Web 项目生成并持续维护图文用户手册：真实浏览器打开页面 → 截图 → 生成 Markdown → 随代码变化持续更新。

以 Claude Code Skill 形式交付，同时是一个可脱离 AI 独立运行的 Node CLI。

## 版本路线

| 版本 | 命令 | 状态 |
|---|---|---|
| V0.1 | `init` 配置项目 | ✅ |
| V0.2 | `inspect` 扫描项目、建立页面模型；`describe` 写回源码分析 | ✅ |
| V0.3 | `capture` 真实浏览器截图 | ✅ |
| V0.4 | `generate` 生成 Markdown 手册（事实草稿 → 中文自然化 → 事实校验） | ✅ |
| V0.5 | Scenario 变体：空状态 / Loading / Error / 不同角色；登记的 mock / hook Fixture | ✅ |
| V0.6 | `update` 基于源码变化（Git 或源码快照）的增量更新，人工编辑三方合并保护 | ✅ |
| V0.7 | `verify --artifacts` / `--live`：离线产物检查与在线回放、语义 / 视觉漂移报告 | ✅ |
| V0.8 | `gc` 保留策略；Windows / Linux CI、干净安装冒烟与性能验收 | ✅ |

能力边界与尚未支持的扩展见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#phase-3-之后的能力边界)；
运行时（Run / 等待输入 / 恢复 / 缓存）见 [docs/RUNTIME.md](docs/RUNTIME.md)，旧项目迁移见 [docs/MIGRATION.md](docs/MIGRATION.md)。

## 安装

```bash
npm ci               # 依赖版本以 package-lock.json 为准（js-yaml、markdown-it、playwright、sharp）
npx playwright install chromium
```

作为 Skill 使用：把本目录复制或软链到 Codex 的 `skills/manual/`，运行 `npm run install:compat`，之后在 Codex 使用 `$manual-init`、在 Claude Code 使用 `/manual-init`；其它子命令同样采用连字符形式。

旧页面原图迁移到隐私隔离目录前，先执行 `manual migrate-artifacts` 查看清单；确认后再加 `--copy`。该命令不会删除旧文件，也不会覆盖已有目标。

## 用法

已有 `.manual/config.yaml` 和页面模型时，直接预览并生成。需要浏览器时 Runtime 自动预检已配置身份断言的登录档案；失效后按返回的 Run ID 登录并继续。

```bash
node bin/manual.js generate page:chat --plan
node bin/manual.js generate page:chat page:credits --copy-default
# 若返回 auth-expired：node bin/manual.js auth login --profile default
# 随后：node bin/manual.js resume <runId>
```

首次接入项目时：

```bash
# 1. 初始化：同时记录手册面向外部公开还是仅内部使用
node bin/manual.js init --base-url http://localhost:3000 --audience public

# 受保护页面：在 .manual/config.yaml 设置 auth.verifyPath 和
# auth.identityAssertions，再运行一次 auth login；后续失效由 Runtime 提前提示。
node bin/manual.js auth login --profile default

# 2. 扫描页面，AI 读完源码后写回标题 / 用途 / 主要操作
node bin/manual.js inspect
node bin/manual.js describe --input describe.json

# 3. 一条命令生成：按需用真实浏览器采集（需要项目已经在跑，可复用有效缓存）→ 草稿 → 文案 → 发布
node bin/manual.js generate page:chat --plan     # 先看计划：动作、风险边界、需要浏览器的场景
node bin/manual.js generate page:chat --copy-default   # 快速生成，不等待模型文案
# 多篇手册可一次生成，共用 Run 与浏览器会话
node bin/manual.js generate page:chat page:credits --copy-default
```

任务型指南（“怎样完成某件事”）：`discover-tasks` 提出候选 → 人工 `approve-tasks` 确认 → `generate task:<id>`。写操作停在动作前，删除类操作不执行。

持续维护：

```bash
# 代码改了：只更新受影响的已发布手册（先看影响与原因链，再执行）
node bin/manual.js update --plan
node bin/manual.js update --copy-default

# 手册还对吗：离线核对产物；在线回放页面与任务（源码没变、线上变了也能发现）
node bin/manual.js verify --all
node bin/manual.js verify --all --live

# 回收过期的临时文件与原图（默认只列出）
node bin/manual.js gc
node bin/manual.js gc --apply --expect <planHash>
```

正式文档里生成的内容由 `<!-- manual:block … -->` 标记分段：块外可以自由补充说明，`update` / `generate` 会保留；
同一块被人和生成器同时改动时停下来（Run 等待输入，退出码 4），给出提案与逐块对照，不会静默覆盖。

退出码：0 成功 / `--plan`；1 失败或无法下结论；2 参数错误或目标歧义；3 等待输入（登录、审批、文案、人工确认、测试数据清理）；4 检测到漂移或冲突（证据过期、输入变化、人工修改冲突、在线验证失败或内容漂移）。

高级与兼容命令：

| 命令 | 用途 |
|---|---|
| `status [runId]` | 只读查看 Run：任务状态、等待原因、失败 code、缓存复用来源 |
| `resume <runId> [--replan]` | 从任务快照继续；输入变了用 `--replan` 创建新 Run |
| `run-submit <runId> --request <id> --input <响应.json>` | 向等待模型文案的 Run 提交结构化响应，再用 `resume` 继续 |
| `generate <目标> --offline / --refresh / --no-cache` | 只用历史证据 / 强制重新采集 / 不读写缓存 |
| `generate <目标> --copy <文案.json> / --copy-default` | 直接提供文案块 / 使用默认文案 |
| `capture <page-id|task:<id>|scenario:<id>>` | 只采集证据，不生成文档；`scenario:` 采集空状态 / 错误态 / 其他角色 / Fixture 数据 |
| `generate <page-id> --draft` / `--finalize <文件>` | 兼容的页面三段式（草稿 → 润色 → 校验定稿） |
| `plan-capture` / `capture-task` / `generate-task` | 兼容的任务分步命令 |
| `verify <目标> [--live]` / `verify --all` | 离线产物验证（默认）或在线回放与漂移报告；每次写不可变验证报告 |
| `update [--plan] [--base <提交>]` | 按源码变化增量更新已发布手册 |
| `gc [--apply]` | 按保留策略回收未引用的临时文件、原图与旧 Run |
| `publication status / repair` | 查看与恢复中断的发布 |
| `migrate --dry-run / --apply` | 旧项目迁移 |

每条命令都有 `--help`；加 `--json` 得到结构化输出。

### inspect 扫到什么

Next.js（App Router + Pages Router）：

| 文件 | 路由 |
|---|---|
| `app/chat/page.tsx` | `/chat` |
| `app/artifact/[id]/page.tsx` | `/artifact/:id` · `dynamic: true` |
| `app/docs/[...slug]/page.tsx` | `/docs/:slug*` |
| `app/blog/[[...slug]]/page.tsx` | `/blog/:slug?` |
| `app/(marketing)/pricing/page.tsx` | `/pricing`（路由组不进 URL） |
| `pages/user/[id].tsx` | `/user/:id` |

自动跳过：`layout` / `loading` / `error` / `not-found` / `template` / `route`、`api/**`、私有目录 `_foo`、并行插槽 `@modal`、拦截路由 `(.)foo`、`_app` / `_document`、测试与 story 文件。

inspect 还会从每个页面入口递归追踪项目内的静态 `import`、re-export 和字面量 `require()`，支持相对路径以及 `tsconfig.json` / `jsconfig.json` 的 `baseUrl`、`paths`。第三方包、样式和静态资源不会进入依赖图；无法解析的项目内导入会记录 warning，但不会中断其它页面扫描。

扫描完成后会生成两个可重建的 JSON 索引：

- `.manual/index/forward.json`：页面 → 入口、关联源码、组件、Hook、截图和手册路径。
- `.manual/index/reverse.json`：源码文件 → 受影响页面，为未来的 `manual update` 提供影响范围。

当前路由扫描只支持 Next.js（App Router + Pages Router）。Vite + Vue 等框架能被识别，但 `inspect` 会明确提示暂不支持。

### capture 怎么保证截图质量

截图前依次等待：load 事件 → 网络空闲 → 指定元素（可选）→ Web Font 就绪 → 图片加载完 →
DOM 连续静止 → 冻结 CSS 动画与过渡 → 静置回流。每步有独立上限，单步超时只记 warning 不中断。

尺寸严格按配置的 viewport × DPR：`desktop-standard` 得到 2880×1800 的高清 PNG。
动画被冻结，所以**同一页面连续两次截图字节完全一致**（有测试锁住）。

**页面打不开时绝不产出截图**，而是给出分类原因与可操作建议：

| 原因 | 含义 |
|---|---|
| `server-unreachable` | 项目没启动 / 端口不对 |
| `http-not-found` | 404，route 可能已过期 |
| `auth-missing` | 页面需要登录，但对应认证档案尚未建立 |
| `auth-expired` | 已有认证档案失效，需要重新登录 |
| `auth-corrupt` | 本机认证缓存损坏或属于其它站点 |
| `timeout` | 加载超时 |
| `blank-page` | 加载完但 body 是空的，通常前端崩了 |
| `http-error` · `unsafe-port` · `dns-failure` | 其余明确可判的情况 |

运行 `manual auth login --profile <名称>` 会打开一次可见浏览器。登录成功后，cookies 与 localStorage
保存在当前系统用户的缓存目录，而不是项目或 worktree 中。Windows 默认位置为
`%LOCALAPPDATA%/living-user-manual/auth/`。`status` 只展示档案元数据，绝不输出 cookie 或 token；
`clear` 可清除指定档案。

### 公开截图怎样脱敏

`privacy.audience: public` 会保护完整手机号、邮箱、账号 ID、认证字段和姓名/昵称/学校等个人信息。
已经显示为 `134****1255` 的内容不会重复处理。浏览器按文字内容计算矩形，不再遮住整个输入框；
最终使用完全不透明、与原像素无关的浅色合成马赛克。普通 blur 不能作为公开手册的最终遮罩。

任务产物分为本地 raw、sanitized 中间图和可发布 annotated 图。正式任务文档只能引用
`docs/manual/images/annotated/`，发布校验会阻止 raw、诊断图或不安全遮罩进入外部手册。

### generate 怎么保证「中文自然」又「事实不走样」

两件事分开做：**中文润色是 AI 的活，事实校验是程序的活。**

```
页面模型 + 真实 capture 数据
    → .manual/drafts/<id>.md          事实草稿（程序，只有确定性事实）
    → references/manual-writing-style.md   中文自然化（AI）
    → 事实一致性校验                    （程序，逐项比对）
    → docs/manual/<id>.md              正式文档
```

留中间草稿是为了出问题时能一眼判断：是事实生成阶段错了，还是中文润色阶段错了。

润色阶段**只能改**句式、语序、冗余表达、翻译腔、AI 套话；**不能改**事实、UI 名称、
操作顺序、截图引用、数字。程序会逐项比对并拦截：

```
✗ 出现了草稿里没有的 UI 名称。这些词是编的，真实页面上可能不存在。
      新增: "开启新会话"  "导出"
✗ 出现了草稿里没有的数字。响应时间、限额、数量这类事实不能在润色阶段补。
      新增: "3"
✗ 操作步骤数量从 3 变成了 4。
```

校验不过就不输出正式文档。`--fallback-draft` 可以用草稿原文强行定稿——保事实、丢润色。

写作规范见 [references/manual-writing-style.md](references/manual-writing-style.md)。

## 生成什么

```
<项目根>/.manual/
  config.yaml          项目配置（init 产出，应入库）
  project.yaml         项目地图 / 页面索引（inspect 产出）
  pages/<id>.yaml      每个页面的详情
  index/forward.json   页面到源码、截图与手册的正索引（派生产物）
  index/reverse.json   源码文件到受影响页面的逆索引（派生产物）
  drafts/<id>.md       事实草稿（generate 产出，保留便于回溯）
  .gitignore           让本地截图中间产物不入库

<项目根>/docs/manual/
  <id>.md              正式手册（generate 定稿产出）
  images/raw/<id>.png  截图（capture 产出）
```

页面文件的字段有明确归属：`route`/`dynamic`/`entry`/`dependencies` 由扫描拥有，重跑 inspect 会更新；`title`/`purpose`/`detectedActions` 由分析拥有，**inspect 绝不覆盖**；`browser.*` 由 capture 拥有。入口或路由变了，原分析会被标成 `stale` 提示重新分析；路由变了截图状态会被清空；代码里删掉的路由默认只报告，确认后加 `--prune` 才清理。

capture 和 generate 会读取正索引：capture 使用索引中的当前路由，generate 把关联源码作为结构化上下文与草稿元数据。索引缺失或 JSON 损坏时，两条命令都会回退到页面 YAML，旧项目无需迁移。

配置结构靠**具名注册表 + active 指针**保证扩展性：加截图规格、加 Browser Provider 都是纯增量。生成的 config.yaml 里带有 mobile profile 与 computer-use provider 的注释示例。

## 测试

```bash
npm test               # 全部测试文件（node test/run.js）
npm run test:unit      # 不启动浏览器的测试（秒级到数十秒）
npm run test:browser   # 真实 Chromium + 本地测试服务器的集成测试
node test/run.js --list --group browser   # 查看分组
```

全程真实：真 spawn CLI、真 HTTP 服务器、真 Chromium、真 PNG。测试服务器提供运行态开关（按钮改名、权限收回、
页面 404、布局偏移、时钟区域），用来证明 `verify --live` 在源码没有变化时也能发现线上变化。

- `test/performance.test.js` 断言调用次数：冷启动 1 次 Browser 启动、每个 Scenario 一个 Context；无变化再生成不启动
  Browser、不新增截图；只改模板不启动 Browser；改共享组件只重新导航受影响的页面。耗时只报告中位数 / p90
  （设 `MANUAL_PERF_REPORT_DIR` 时写入 `performance.json`），不设硬阈值。
- `test/install-smoke.test.js` 把 `npm pack` 的包解到临时目录，HOME 指向空目录，依次执行 doctor / init / inspect /
  describe / generate / update，证明安装后的工具不依赖仓库外的个人工具目录。

### CI

`.github/workflows/manual-tests.yml`：Ubuntu 与 Windows × Node 20.19.0 / 22.14.0（精确固定），`npm ci` 后安装固定版本的
Chromium（Linux 另装 `fonts-noto-cjk`），先跑 doctor，再依次跑 unit 与 browser 两组。
只上传 `test-results/`（测试日志、doctor 与性能报告，已去敏，保留 7 天）；原图、trace 与认证缓存留在 runner 临时目录，
从不上传；工作流只有只读权限，不使用 secrets，不部署、不合并、不自动接受视觉基线。

## 设计

- [架构与演进约定](docs/ARCHITECTURE.md)
- [正逆索引设计](docs/plans/2026-09-17-forward-reverse-index-design.md)
- [正逆索引实施计划](docs/plans/2026-09-17-forward-reverse-index.md)

## 手册质量改进

页面支持 guide 操作说明和编号标注；任务支持 pageAfter、requires 和限定测试环境的 writeAuthorization。`manual plan-capture <id> --live` 可在发布前检查安全步骤。离线验证不会再把任务标为业务已验证；Runtime 发布后更新 index.md 导航。详见 [质量工作流](references/quality-workflow.md)。

仅安装当前客户端入口：`node bin/install-compat.js --client codex`（支持 claude / all，默认 all 保持兼容）。
