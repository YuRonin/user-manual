# Living User Manual

为 Web 项目生成并持续维护图文使用手册：读源码建立页面与任务模型 → 真实浏览器操作并截图 → 按帮助中心的结构出稿 → 代码变化后只更新受影响的文档。

以 Claude Code / Codex Skill 形式交付（主 skill 名 `manual`），同时是一个可脱离 AI 独立运行的 Node CLI。路由扫描目前支持 Next.js（App Router + Pages Router）。

## 安装

```bash
npm ci                          # 依赖版本以 package-lock.json 为准（js-yaml、markdown-it、playwright、sharp）
npx playwright install chromium
npm run install:compat          # 安装客户端别名；--client codex / claude / all（默认 all）
```

把本目录链接到 `~/.claude/skills/manual`（Claude Code）或 `~/.codex/skills/manual`（Codex）。别名只覆盖主流程命令：Claude Code 用 `/manual-init`、`/manual-generate` 等，Codex 用 `$manual-init`、`$manual-generate` 等；其它命令通过主 skill `manual` 使用。重新安装会清理旧版本生成的其它别名。

## 生成出来的手册长什么样

正式文档按读者完成任务的顺序组织，参照飞书、Notion 等帮助中心：

```markdown
# 修改个人资料

修改昵称和简介，其他成员会看到更新后的信息。

## 前提条件
- 已登录账号

## 操作步骤

进入 [个人中心](/profile) 页面，按以下步骤操作。

1. 点击「编辑资料」

   [![编辑面板打开后的界面](images/annotated/edit-profile--open.png)](images/annotated/edit-profile--open.png)

2. 在「昵称」中填写内容

   昵称最多 20 个字，例如“李老师”。

3. 点击「保存」

## 如何确认已完成

完成标志：编辑面板已关闭，个人中心显示新昵称。

## 常见问题

**提示登录已过期**

重新登录后从第 1 步开始。

## 相关文档
- [更换头像](change-avatar.md)
```

步骤动作句、顺序、截图和完成标志由程序从结构化模型生成；导语与步骤说明由模型按[写作规范](references/manual-writing-style.md)填写，程序校验它没有改动事实。验证范围、截图时间等维护信息不进入正文，用 `review-task` 和发布记录查看。`docs.outputDir/index.md` 自动维护目录，分“操作指南”和“功能介绍”两组。

## 用法

首次接入：

```bash
manual init --base-url http://localhost:3000 --audience public
manual auth login --profile default        # 有登录保护时；先在 .manual/config.yaml 配 auth.verifyPath 与 auth.identityAssertions
manual inspect                              # 扫描页面，列出需要阅读的源码
manual describe --input describe.json       # AI 读完源码后写回标题、用途、主要操作
```

建模任务（“怎样完成某件事”）：`task-guide "目标"` 找入口 → `discover-tasks` 保存候选 → 用户确认后 `approve-tasks`。

生成：

```bash
manual generate task:edit-profile page:chat
# 采集（可复用有效缓存）→ 事实草稿 → 退出码 3 等待模型文案
manual resume <runId> --request <requestId> --input <响应.json>
# 提交文案并继续 → 发布；结果里的 documents 给出正式文档路径
manual review-task edit-profile --preview   # 对照截图审阅
```

`--plan` 只预览动作与风险边界；`--offline` 只用已有证据；`--refresh` 强制重新采集；`--copy-default` 跳过模型文案出粗稿（交付前必须审阅）。登录失效时 `manual auth login --resume <runId>` 登录后自动继续。

持续维护：

```bash
manual update --plan       # 代码改了：先看影响范围与原因链
manual update              # 只更新受影响的已发布手册
manual verify --all        # 离线核对产物
manual verify --all --live # 在线回放，源码没变、线上变了也能发现
manual gc                  # 列出可回收的临时文件与原图；确认后 --apply --expect <planHash>
```

发布成网站：

```bash
manual site                # 把 docs.outputDir 渲染成静态帮助中心（默认输出 .manual/site/）
```

首页是目录（操作指南 / 功能介绍）加可选的求助区，正文页带面包屑，任务篇的「如何确认已完成」渲染为「完成后你会看到」提示框，截图转为 WebP。文档互链改写为相对 `.html`，`file://` 直接打开或放到任意子路径都能用；手册里的 `/credits` 这类产品入口原样保留（独立部署时用 `site.appBaseUrl` 补全域名）。任何死链都会让构建失败且不写文件；只清理自己上次生成的文件，输出目录非空且不是它生成的会拒绝写入（确认后 `--force`）。标题、主题色、求助区等在 `config.yaml` 的 `site:` 段配置（`init` 生成的模板里有注释示例）。

正式文档里生成的内容由 `<!-- manual:block … -->` 标记分段：块外可以自由补充说明，`update` / `generate` 会保留；同一块被人和生成器同时改动时停下来（退出码 4），给出提案与逐块对照，不会静默覆盖。

退出码：0 成功 / `--plan`；1 失败；2 参数错误或目标歧义；3 等待输入（文案、登录、审批、人工确认、测试数据清理）；4 漂移或冲突。

## 命令

`manual --help` 按分组列出：

| 分组 | 命令 |
|---|---|
| 主流程 | `init` · `inspect` · `describe` · `auth` · `generate` · `update` · `verify` · `site` · `doctor` |
| 任务型指南 | `task-guide` · `discover-tasks` · `approve-tasks` · `review-task` |
| Run 查看与继续 | `status` · `resume` |
| 高级与维护 | `capture`（只采集）· `plan-capture`（只读预演）· `capture-task`（写操作核对与续采）· `publication`（发布事务恢复）· `gc` · `migrate` |

兼容入口仍可执行，但不在帮助与主文档中列出：`run-submit`（改用 `resume --request --input`）、`generate-task`（改用 `generate task:<id>`）、`migrate-artifacts`，以及 `generate <page-id> --draft / --finalize`。迁移说明见 [docs/MIGRATION.md](docs/MIGRATION.md)。

每条命令都有 `--help`；加 `--json` 得到结构化输出。运行时细节（Run、等待输入、缓存、恢复）见 [docs/RUNTIME.md](docs/RUNTIME.md)，架构见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 实现细节

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
  tasks/<id>.md        任务操作指南
  index.md             目录（manual:catalog 区块自动维护）
  images/annotated/    发布图（原图与诊断图留在 .manual/ 下，不发布）
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
- [运行时](docs/RUNTIME.md)、[迁移与兼容入口](docs/MIGRATION.md)
- 历史设计、实施计划与实测记录：[docs/archive/](docs/archive/README.md)
