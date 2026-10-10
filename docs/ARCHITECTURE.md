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
  index/forward.json      页面 → 源码 / 截图 / 手册的派生正索引（入库）
  index/reverse.json      源码文件 → 受影响页面的派生逆索引（入库）
  tasks/ scenarios/ fixtures/  任务、Scenario 与 Fixture 定义（入库）
  evidence/ releases/     Capture 证据记录与发布记录（入库）
  .gitignore              让下面这些本机产物不入库
  artifacts/raw/          原始截图（另有 diagnostics/、manifests/）
  runs/ drafts/ snapshots/ verifications/ site/   Run 状态、草稿、模型快照、验证报告、帮助中心站点
<项目根>/<docs.outputDir>/  手册 Markdown + images/annotated/ + index.md + meta.json（入库）

%LOCALAPPDATA%/living-user-manual/auth/   Windows 用户级认证缓存（不入库）
```

原图与标注图都留存：原图可复用、可重新标注；标注图进手册。

`project.yaml` 与 `index/*.json` 都是**派生索引**，每次写页面后由 `pages/*.yaml` 重新生成。不手工维护、不把派生产物当成唯一事实源，避免漂移。

## Auth Cache

项目配置只记录稳定的 `auth.cacheKey` 与 `activeProfile`。真正的 Playwright storage state 保存在
操作系统用户级缓存中，因此同一项目的多个 Git worktree 可以复用登录状态。Windows 默认目录是
`%LOCALAPPDATA%/living-user-manual/auth/<cacheKey>/<profile>.state.json`。

`manual auth login` 用有头浏览器完成一次人工登录，验证成功后原子保存 cookies 与 localStorage；
`capture` 和 `capture-task` 在创建 BrowserContext 时加载状态，并在成功执行后刷新旋转过的 cookie。
缓存不存在、过期和损坏分别归类为 `auth-missing`、`auth-expired`、`auth-corrupt`。日志、JSON 输出、
manifest 和正式手册都不得包含认证值。

## 隐私处理

隐私管线分为三层：`privacy/detector` 根据发布范围和证据分类，`privacy/geometry` 负责文字级矩形、
裁剪和去重，`privacy/renderer` 绘制不可逆的 `neutral-mosaic`。普通文本使用 DOM Range；输入控件根据
字体和 padding 估算值文本区域，只有显式元素级规则才遮住整个控件。

公开模式仅允许完全不透明的安全遮罩，普通 blur 会被发布校验拒绝。正式 Markdown 只能引用 annotated
图片；raw、sanitized、diagnostics 和认证缓存始终视为本地敏感产物。

## 页面模型

页面的**身份是它的路由**，不是文件名或 id。重扫按 route 匹配已有页面文件，所以即使 id 生成规则将来变了，也不会丢掉分析成果。

字段归属是整套系统的核心约定：

| 归属 | 字段 | 行为 |
|---|---|---|
| 扫描 (`inspect`) | `route` `dynamic` `params` `entry` `dependencies` `status.router` | 每次 `inspect` 重写 |
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

页面可以有多个可复用的稳定状态。`states.default` 兼容旧式页面截图，其它状态必须提供可见断言；任务步骤通过 `stateBefore` / `stateAfter` 引用状态。`plan-capture` 在启动浏览器前解析这些引用，并把语义目标、断言和风险边界写入 `.manual/artifacts/manifests/`。

## 用户任务模型

任务事实位于 `.manual/tasks/<id>.yaml`，生命周期为 `candidate → approved → captured → generated → verified`。候选只能经 `approve-tasks` 的人工决策进入 `approved`；`capture-task` 只接受已批准任务。任务索引写入 `index/task-forward.json` 与 `index/task-reverse.json`，连接源码、页面、步骤和任务文档，同时页面正索引保留关联任务 ID。

任务采集使用语义定位，优先级为 role+accessible name、label、可见文字、test id、人工 selector。匹配零个或多个可见元素都视为失败。每次交互后必须通过页面状态断言；失败时诊断图只进入 `.manual/artifacts/diagnostics/`。

任务生成保护 `step.id` 与顺序、UI 原文、annotated 图片引用和完成验证边界。`generate-task` 先生成事实草稿与 facts sidecar，定稿校验通过后使用同目录临时文件原子替换；`verify` 再检查正式文档、图片存在性和事实指纹，之后任务才能进入 `verified`。页面入口变化或删除时，`inspect` 会把关联的非候选任务标为 `stale`。

删除语义保守：代码里消失的路由默认只报告不删，加 `--prune` 才清理——那些文件里有 AI 或人写的分析成果，静默删掉代价太大。

## 源码依赖索引

inspect 从页面入口递归追踪项目内的静态 `import`、re-export 和字面量 `require()`。相对路径与 `tsconfig.json` / `jsconfig.json` 的 `baseUrl`、`paths` 都走同一套扩展名和目录 `index.*` 解析；第三方包、样式、图片和动态表达式不进入依赖图。循环引用由 visited set 截断，所有路径统一为项目相对 POSIX 路径并稳定排序。

依赖结果先写入页面模型的 `dependencies.files` / `dependencies.unresolved`，再派生两份 JSON：

```text
pages/*.yaml
    ├──▶ index/forward.json   route → entry/files/components/hooks/apis/scenarios
    └──▶ index/reverse.json   file → affected routes
```

inspect、describe、capture 每次改写页面模型后都会重建索引。capture 与 generate 通过容错读取器消费正索引；索引缺失、损坏或找不到页面时回退页面 YAML。V1 的 `apis` 与 `scenarios` 保留为空数组，props、API 调用和运行时关系留给后续版本。

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

目标是**同一输入下的截图尽量稳定**，而不是保证字节一致：字体栅格化、GPU / 平台差异、动态数据都会让像素变化。
稳定性手段：

- `reducedMotion: 'reduce'` 建 context
- 截图前先 `document.getAnimations()` 逐个 `finish()`（无限循环的 `pause()`），**再**注入
  `FREEZE_CSS` 把动画/过渡时长清零。顺序反了的话 CSS 会先把动画结束掉，
  `getAnimations()` 返回空集，计数永远是 0，等于没有可观测性。
- `caret-color: transparent` 去掉光标闪烁，`scroll-behavior: auto` 去掉平滑滚动
- 采集时检查几何稳定（`captureStable` 多次取几何比较，仍在变化报 `geometry-unstable`）

"是否变了"不靠字节比较判断：缓存按输入 key 复用（C09），在线验证用语义摘要 + 同规格、同隐私版本的像素比较
（`src/verify/visual-diff.js`），规格不同直接报 environment-incompatible。

### Playwright 依赖解析

Playwright、sharp、markdown-it 都是本工具 `package.json` 里精确固定的依赖，`npm ci` 后从工具自己的
`node_modules` 加载；浏览器用 `npx playwright install chromium` 安装。不再从个人工具目录（如 `~/gstack`）借用，
`test/install-smoke.test.js` 在空 HOME 的临时安装里验证这一点。

## 标注

标注（红框 / 序号 / 文字标签）与隐私遮罩都由 `src/evidence/image-pipeline.js` 用 sharp + SVG 合成，
从同一份原图离线派生；主题与遮罩样式变化只需重新派生，不需要重新打开浏览器（原图被 gc 回收后除外）。

## 框架支持

V0.2 只做 Next.js —— 先把一个框架做透，而不是每个框架都做一半。`detect.js` 认得出 Nuxt / Remix / SvelteKit / Angular / React Router / Vue Router，但只用于给出准确的「暂不支持」提示。

加新框架时：写一个 `src/inspect/<framework>.js`，导出同样形状的 `{ pages, skipped, conflicts }`，`pages[]` 每项形如 `{ route, dynamic, params, entry, router }`。`model.js` 的合并逻辑与框架无关，不用动。

## 中文自然化：为什么要留中间草稿

`generate` 是三段式，不是一步到位：

```
页面模型 + 正索引上下文 + capture 数据 ──程序──▶ .manual/drafts/<id>.md  事实草稿
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

## 读者视图与维护视图分离

Runtime 路径下，正文由事实包确定性渲染（`src/generate/render.js`，模板 `render-15`），模型只填写导语与步骤补充说明两类文案块，默认由宿主模型填写（`model-input-required`）；`--copy-default` 只用于粗稿。

正式文档按帮助中心的读法组织：标题 → 导语 → 前提条件 → 操作步骤（首行给入口链接，图片紧跟步骤并可点击放大）→ 如何确认已完成 → 常见问题 → 相关文档。目录页分“操作指南”与“功能介绍”两组，每项一行说明。

证据覆盖属于维护视图，不进入正文：步骤是否实际执行（`scope`）、截图时机、Capture 来源和验证等级的推导都保留在事实包、发布记录与 `review-task` 报告中。正文只保留两个必须让读者知道的区别：完成声明写成“完成标志”（有界面断言证据）还是“预期结果”（没有），以及 Fixture 模拟数据的示例说明。前者由定稿校验锁定，模型不能改动。

## 不伪造原则

这套系统的可信度全押在一条上：**手册里的每张图都来自真实渲染的页面。**

所以 `capture` 在页面打不开时不产出任何文件，而是抛分类错误。没有截图是个可见的缺口，
伪造的截图会悄悄混进手册——谁都不知道那页其实是坏的。同理，`confidence` 只有在
源码分析完成**且**浏览器验证过时才升到 `verified`，截了图但没分析语义不算。

登录判定刻意保守：只有「除了登录表单没别的内容」才下结论。宁可漏判
（截到一张登录页，用户一眼看得出来），也不要误判（把正常页面挡在外面，用户还以为是权限问题）。

## Phase 3 之后的能力边界

已经提供：

| 能力 | 范围与限制 |
|---|---|
| `update` 增量更新 | Git（已提交 + staged + unstaged + untracked）或发布时的源码图快照；旧新依赖图并集；全局配置 / 无法归属的源码保守扩大；无基线时全量重建 |
| 人工编辑保护 | 块标记 + 块外人工内容；三方合并，冲突写提案并等待输入；已发布文档被删除不静默重建 |
| `verify --artifacts` | 离线：文档与发布记录、图片 hash、隐私门槛、结构事实；不代表线上行为 |
| `verify --live` | 在线：真实导航回放页面身份、安全步骤与完成声明；写 / 破坏性步骤不执行；页面手册另做语义与视觉漂移比较 |
| Scenario 变体与 Fixture | 显式 Scenario（空状态 / 错误态 / 其他角色）；mock（请求拦截，simulated）与 hook（测试环境 setup / cleanup）两类登记 Fixture；生产与未登记环境拒绝 |
| 认证 | 命名档案、CAS 刷新、cookie / localStorage；匿名必须显式声明 |
| 隐私检测 | 声明的 DOM 候选（输入框、`data-redact`、文本中的手机号 / 邮箱 / 证件号等）；无法定位的敏感内容阻止公开发布 |
| 模板语言 | zh-CN、en-US |
| 保留策略 | `manual gc`：dry-run / apply，引用图保护发布记录与被引用证据 |

尚未提供（不要当作已支持）：

1. 非 Next.js 框架的自动扫描（其它框架只给出"暂不支持"提示）
2. 跨进程常驻 daemon / 受控并发执行（Runtime 是单进程串行，一个 Run 内复用 Browser）
3. 多个 Scenario 截图同时渲染进同一页面手册（变体证据目前只作为独立 Capture）
4. 任务手册的视觉漂移比较（任务只做行为断言回放）
5. 移动端 profile、操作系统凭据库加密认证缓存
6. 业务站点部署或 PR 自动合并（CI 只测试本工具）
