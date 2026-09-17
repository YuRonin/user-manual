# Living User Manual

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

作为 Skill 使用：把本目录复制或软链到 `~/.claude/skills/manual/`，之后在 Claude Code 里用 `/manual init`、`/manual inspect`。

## 用法

```bash
# 1. 初始化：收集截图规格、Browser Provider、访问地址、语言、输出目录
node bin/manual.js init --base-url http://localhost:3000

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
| `login-required` | 被重定向到登录页，或页面就是个登录表单 |
| `timeout` | 加载超时 |
| `blank-page` | 加载完但 body 是空的，通常前端崩了 |
| `http-error` · `unsafe-port` · `dns-failure` | 其余明确可判的情况 |

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
  drafts/<id>.md       事实草稿（generate 产出，保留便于回溯）
  .gitignore           让浏览器会话与缓存不入库

<项目根>/docs/manual/
  <id>.md              正式手册（generate 定稿产出）
  images/raw/<id>.png  截图（capture 产出）
```

页面文件的字段有明确归属：`route`/`dynamic`/`entry` 由扫描拥有，重跑 inspect 会更新；`title`/`purpose`/`detectedActions` 由分析拥有，**inspect 绝不覆盖**；`browser.*` 由 capture 拥有。入口或路由变了，原分析会被标成 `stale` 提示重新分析；路由变了截图状态会被清空；代码里删掉的路由默认只报告，确认后加 `--prune` 才清理。

配置结构靠**具名注册表 + active 指针**保证扩展性：加截图规格、加 Browser Provider 都是纯增量。生成的 config.yaml 里带有 mobile profile 与 computer-use provider 的注释示例。

## 测试

```bash
npm test          # 114 项端到端测试
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

见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
