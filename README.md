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
| V0.5 | Scenario：空状态 / Loading / Error / 不同业务状态 | ⏳ |
| V0.6 | `update` 基于 git diff 的增量更新 | ⏳ |
| V0.7 | `verify` 校验手册是否过期 | ⏳ |

## 安装

```bash
npm install          # 唯一依赖 js-yaml
```

作为 Skill 使用：把本目录复制或软链到 Codex 的 `skills/manual/`，运行 `npm run install:compat`，之后在 Codex 使用 `$manual-init`、在 Claude Code 使用 `/manual-init`；其它子命令同样采用连字符形式。

旧页面原图迁移到隐私隔离目录前，先执行 `manual migrate-artifacts` 查看清单；确认后再加 `--copy`。该命令不会删除旧文件，也不会覆盖已有目标。

## 用法

```bash
# 1. 初始化：同时记录手册面向外部公开还是仅内部使用
node bin/manual.js init --base-url http://localhost:3000 --audience public

# 受保护页面只需登录一次；命名档案可跨 worktree 复用
node bin/manual.js auth login --profile default
node bin/manual.js auth status --profile default

# 2. 扫描：识别技术栈、扫出全部用户可访问页面
node bin/manual.js inspect

# 3. 写回：AI 读完源码后补上标题/用途/主要操作
node bin/manual.js describe --input describe.json

# 4. 截图：用真实浏览器打开页面（需要项目已经在跑）
node bin/manual.js capture chat

# 5. 出手册：先出事实草稿，AI 按写作规范润色，再校验定稿
node bin/manual.js generate chat
#    → .manual/drafts/chat.md，按 references/manual-writing-style.md 改写
node bin/manual.js generate chat --finalize <润色后的文件>
#    → 事实校验通过才写 docs/manual/chat.md
```

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
npm test          # 129 项单元与端到端测试
npm run test:init
npm run test:inspect
npm run test:capture
npm run test:generate
```

全程真实：真 spawn CLI、真 HTTP 服务器、真 Chromium、真 PNG。覆盖配置校验与幂等、15 个错误用例、
Next.js 两套路由的扫描与全部跳过规则、动态路由转换、重扫不覆盖分析结果、stale 标记、prune、
中文长文本 YAML 往返、截图像素尺寸与可重复性、7 类截图失败路径、10 类事实越界拦截、零侵入校验。

capture 与 generate 测试会真的启动 Chromium，跑完约需 3-4 分钟。

## 设计

- [架构与演进约定](docs/ARCHITECTURE.md)
- [正逆索引设计](docs/plans/2026-09-17-forward-reverse-index-design.md)
- [正逆索引实施计划](docs/plans/2026-09-17-forward-reverse-index.md)
