# 架构与演进约定

给后续版本的设计靶子。

## 职责划分

| 角色 | 负责 |
|---|---|
| AI | 理解语义：页面是什么、能做什么、该截哪些图、手册怎么写 |
| 真实浏览器 | 渲染页面、执行操作。**不根据代码伪造截图** |
| 程序（本 CLI） | 确定性的部分：路由扫描、稳定截图、精确标注、读写产物 |

边界原则：**AI 不直接写 YAML/算像素坐标，程序不猜业务语义。**

这条边界在 V0.2 里具体落成了 `inspect` / `describe` 两条命令：`inspect` 扫出确定性骨架并给出「该读哪些文件」的工作清单，AI 读源码后把语义交给 `describe` 落盘。这样 YAML 的格式、字段校验、索引重建只有一处实现，AI 也不必手工拼中文 YAML。

## 目录约定

Skill 代码与项目数据严格分离：

```
<skill>/                Skill 自身，只读，不存任何项目状态
<项目根>/.manual/        项目级状态
  config.yaml             配置，init 产出（入库）
  project.yaml            项目地图 / 页面索引，inspect 产出（入库）
  pages/<id>.yaml         每页详情，页面模型的事实来源（入库）
  .gitignore              让下面这些不入库
  screenshots/raw/        原始截图
  screenshots/annotated/  标注后截图
  session/                浏览器会话（登录态复用）
<项目根>/<docs.outputDir>/  手册 Markdown + images/（入库）
```

原图与标注图都留存：原图可复用、可重新标注；标注图进手册。

`project.yaml` 是**索引**，每次写页面后由 `pages/*.yaml` 重新生成。不双写同一份事实，避免漂移。

## 页面模型

页面的**身份是它的路由**，不是文件名或 id。重扫按 route 匹配已有页面文件，所以即使 id 生成规则将来变了，也不会丢掉分析成果。

字段归属是整套系统的核心约定：

| 归属 | 字段 | 行为 |
|---|---|---|
| 扫描 (`inspect`) | `route` `dynamic` `params` `entry` `status.router` | 每次 `inspect` 重写 |
| 分析 (`describe`) | `title` `purpose` `detectedActions` `source` `includeInManual` | `inspect` 绝不覆盖 |
| 截图 (`capture`) | `browser.*` | 路由变更时清空 |
| 过程 | `confidence` `status.sourceAnalysis` | 由各阶段推进 |

状态机：

```
confidence:      none ──describe──▶ inferred ──capture──▶ verified
                 （只有源码分析完成 且 浏览器验证过，才是 verified——不虚报）
sourceAnalysis:  pending ──describe──▶ completed ──入口/路由变更──▶ stale ──describe──▶ completed
browser.verified: false ──capture──▶ true ──路由变更──▶ false
```

`browser.verified` 从 V0.3 起独立成 `browser` 块（此前记在 `status.browserVerified`）。
`model.normalizePage()` 读老文件时自动迁移，无需手工处理。

`stale` 是 V0.6 增量更新的基础：入口文件变了就说明这页的描述可能过时，不用等 git diff 也能发现。

删除语义保守：代码里消失的路由默认只报告不删，加 `--prune` 才清理——那些文件里有 AI 或人写的分析成果，静默删掉代价太大。

## 配置演进规则

- **加 profile、加 provider、加可选字段 → 不动 `version`。** 注册表 + active 指针的形状就是为此设计的。
- **只有旧配置无法被新代码直接读懂时才 `version + 1`**，并同步提供迁移逻辑。
- 新增的字段一律可选，缺省行为必须与旧配置一致。

已经按这条规则演进过一次：V0.1 的 `config.yaml` 里有 `pages: []`，V0.2 把页面模型迁到了 `project.yaml`，config 只留 `inspect.exclude`。`load.js` 读到老配置时补默认值并对非空的旧 `pages` 给一次提醒，`version` 保持 1。

## Browser Provider 接口契约

Provider 回答「谁来驱动真实浏览器」。配置里 `type` 决定挂哪个 adapter：

| type | 状态 | 说明 |
|---|---|---|
| `playwright` | ✅ 已实现 | `src/browser/playwright.js`，Chromium headless / headed |
| `computer-use` | 预留 | ChatGPT Desktop / Computer Use 等外部代理驱动 |
| `agent-browser` | 预留 | 通过 HTTP 端点驱动的远端 agent 浏览器 |

接口契约（`src/browser/provider.js`）：

```
open(url, { timeout })      -> { status, finalUrl, redirected }   打不开必须抛 CaptureError
waitUntilReady(options)     -> { steps, warnings }                等到可以截图
probe()                     -> { title, hasPasswordField, bodyTextLength, elementCount } | null
screenshot({ path, fullPage, format })
                            -> { path, bytes, meta }
close()                                                            必须可重复调用
```

三条约定：

- `open()` 打不开必须抛**分类过的** `CaptureError`，不能返回一个空页面让上层以为成功。
- `probe()` 只报告页面**事实**，不做业务判断。「是不是需要登录」由 `capture.js` 的
  `assessOutcome()` 决定——provider 不该认识业务语义。无法内省的 provider 返回 null。
- `meta` 必须带回实际视口与 DPR —— 标注环节要靠它把 CSS 像素坐标换算成图片像素坐标。

加新 provider：写一个实现上述契约的类，在 `src/browser/index.js` 的 `ADAPTERS` 里按 type 登记。
`capture.js` 一行都不用改。

### 截图稳定性

同一页面两次截图必须字节一致，否则手册每次重跑都产生无意义的 diff。做法：

- `reducedMotion: 'reduce'` 建 context
- 截图前先 `document.getAnimations()` 逐个 `finish()`（无限循环的 `pause()`），**再**注入
  `FREEZE_CSS` 把动画/过渡时长清零。顺序反了的话 CSS 会先把动画结束掉，
  `getAnimations()` 返回空集，计数永远是 0，等于没有可观测性。
- `caret-color: transparent` 去掉光标闪烁，`scroll-behavior: auto` 去掉平滑滚动

### Playwright 依赖解析

本机没有全局 Playwright。`loadPlaywright()` 按候选路径解析，策略沿用
`~/.claude/skills/manual-shot/scripts/shot.js`（`~/gstack/node_modules/playwright` 是本机现成的可用副本），
避免为这个 Skill 单独装一份浏览器内核。

## 标注

`~/.claude/skills/manual-shot/scripts/annotate.py` 已经验证可用（红框 / 箭头 / ①②③ 圆圈序号 / 文字标签，中文字体走微软雅黑）。本项目选了 Node 单栈，做标注时需要把这套逻辑用 Node 重写（SVG 合成叠加即可），行为对齐那份 Python 实现。

## 框架支持

V0.2 只做 Next.js —— 先把一个框架做透，而不是每个框架都做一半。`detect.js` 认得出 Nuxt / Remix / SvelteKit / Angular / React Router / Vue Router，但只用于给出准确的「暂不支持」提示。

加新框架时：写一个 `src/inspect/<framework>.js`，导出同样形状的 `{ pages, skipped, conflicts }`，`pages[]` 每项形如 `{ route, dynamic, params, entry, router }`。`model.js` 的合并逻辑与框架无关，不用动。

## 中文自然化：为什么要留中间草稿

`generate` 是三段式，不是一步到位：

```
页面模型 + capture 数据 ──程序──▶ .manual/drafts/<id>.md  事实草稿
                        ──AI───▶ 按 references/manual-writing-style.md 改写
                        ──程序──▶ 事实一致性校验 ──▶ docs/manual/<id>.md
```

两个理由：

1. **可归因。** 手册出问题时能一眼判断是事实生成阶段错了（草稿就是错的），
   还是中文润色阶段错了（草稿对、定稿错）。一步到位就只能猜。
2. **可强制。** AI 润色时最容易犯的错是「顺手把事实改通顺」——把「新对话」改成
   「开启新会话」、补一句「通常 3 秒内完成」、把三步合成两步。这些靠提示词自觉挡不住，
   得由程序逐项比对（`src/generate/facts.js`）。

### 事实指纹保护什么

| 保护 | 怎么查 |
|---|---|
| 截图路径 | `![](src)` 的 src 列表，顺序与值都要一致 |
| UI 原文 | `「」` 内容，不许新增（编按钮名）也不许丢失（操作消失） |
| 路由 / 文件名 | 行内代码 `` ` `` 内容，同上 |
| 数字 | 定稿不许出现草稿里没有的数字（抓编造的响应时间与限额）|
| 操作步骤 | 有序列表条目数量，以及每一步涉及的 UI 名称（保序）|
| 页面标题 | 一级标题 |

**不保护**步骤条目里的散文本身。「在左侧列表查看历史会话」润成「查看历史会话」是允许的——
那正是自然化要做的事。想让某个措辞不可动，就把它写成 `「」` 或 `` ` ``。

有序列表的序号会在数字检查前被剥掉：重新编号是排版行为，不是事实变化。

## 不伪造原则

这套系统的可信度全押在一条上：**手册里的每张图都来自真实渲染的页面。**

所以 `capture` 在页面打不开时不产出任何文件，而是抛分类错误。没有截图是个可见的缺口，
伪造的截图会悄悄混进手册——谁都不知道那页其实是坏的。同理，`confidence` 只有在
源码分析完成**且**浏览器验证过时才升到 `verified`，截了图但没分析语义不算。

登录判定刻意保守：只有「除了登录表单没别的内容」才下结论。宁可漏判
（截到一张登录页，用户一眼看得出来），也不要误判（把正常页面挡在外面，用户还以为是权限问题）。

## 尚未处理（按优先级）

1. Scenario：空状态 / Loading / Error / 不同业务状态（含动态路由的真实 id 从哪来）
2. 登录态：`session/` 目录已在结构里预留，需要持久化 context + 登录流程
3. 手册索引页（把各页 `docs/manual/<id>.md` 汇成一个目录）
4. 批量处理（`capture --all` / `generate --all`）与并发
5. 标注（红框 / 箭头 / 序号），产出进 `annotatedDir`
6. `update`：基于 git diff 的增量更新
7. 移动端 profile
8. 其它前端框架的扫描
9. 数据库 Fixture、多角色复杂状态
10. CI 自动更新
