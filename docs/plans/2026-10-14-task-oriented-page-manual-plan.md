# 页面手册改为任务式写法：去重编号、子流程分节、结果闭环与模拟写操作

日期：2026-10-14

状态：已实施（阶段 A～E），单元与浏览器回归通过。NeoAgent 侧需要按新规则重新提交分类计划并重新采集。

代码核对基线：user-manual `fba4434`（分支 `fix/manual-capture-reliability`），以及 NeoAgent `demo/website/docs/manual/login.md`、`.manual/pages/login.yaml`。

## 1. 要解决的问题

用户审阅「登录与注册」手册后提出四点，结论是现在的页面手册更像「把识别到的页面操作整理成文档」，不是站在读者角度写的操作指南：

1. **操作描述重复**：每个小节先列一遍操作说明，截图下方又按标注编号把同样的话重写一遍，读者读两份内容。
2. **按页面功能分节，而不是按任务流程**：「用手机号登录」混合了密码登录、验证码登录、重新发送、修改手机号和忘记密码，读者要自己理清它们的关系。
3. **流程没有闭环**：「找回密码」「注册新账号」只拍了入口，没有验证码之后的页面、设置新密码的操作和成功后的判断方式。
4. **文案只复述 UI 标签，没有结果说明**：「输入手机号后点击下一步」「点击返回登录」，没有说点了之后会出现什么、怎么判断成功、遇到问题怎么办。

理想结构（用户提供的示例）：一句话说明使用场景 → 每种方式一节，节内是一组有编号的步骤加截图，不重复 → 补充提示（忘记密码？）→ 页面末尾的常见问题。

## 2. 原因（逐条对应源码）

| 问题 | 原因 | 位置 |
|---|---|---|
| 1 | `renderPage` 的分类分支对每个功能输出一个 `guide.*` 块（逐行列出 `operations[].instruction`），再对每张图输出 `figure.*` 块，块内又写 `${label}. ${description}`，而 `description` 就是同一个 `instruction` | `src/generate/render.js`、`src/evidence/grouped-figures.js`、`src/generate/grouped-page.js` |
| 1 | 标注号按「每张图从 1 开始」，与正文顺序是两套编号，只能在图下另列一份图例 | `src/evidence/grouped-figures.js`（`label: String(i + 1)`）、`docs/GROUPED_MANUAL.md` |
| 2 | 页面模型的 `features` 是页面上的功能清单，`sections` 只校验引用合法，不约束「一节一条子流程」；页面也没有承载补充说明 / 常见问题的结构，说明类内容只能塞进步骤 | `src/annotations/section-plan.js::validateLayout` |
| 3 | 新分类 Scenario 只允许 read/local setup，「发送、注册」交给任务；登录类流程没有任务，所以只能停在入口图 | `src/annotations/layout-migration.js`、`src/model/schema.js`（`SETUP_RISKY_RE`）、`docs/GROUPED_MANUAL.md` |
| 4 | 操作只有 `instruction`，没有地方登记「做完之后看到什么」及其证据；而文案门禁对没有依据的后果报 `unsupported-result`，最安全的写法就只剩复述控件名 | `src/annotations/section-plan.js`、`src/generate/grounding.js` |

另外核实到：Demo 网络守卫已经能在浏览器里完整模拟写操作——命中 mock Fixture 的请求（含 POST）直接 `route.fulfill`，没有命中的写请求一律中止并使截图判为 `write-blocked`（`src/browser/playwright.js::installDemoGuard`）。所以「模拟写操作」的运行时安全已经有保证，缺的只是静态规则放行和声明方式。

## 3. 方案

页面模型仍是 schemaVersion 3，新增字段全部可选，旧页面照常读取。

### A. 一组编号步骤 + 截图，不再重复（问题 1）

- 小节内的**步骤**按 `featureRefs` 顺序、再按功能内 `operations` 顺序，从 1 连续编号。说明类功能（`contentKind: concept / reference`）的操作不编号，除非它被图片标注。
- 功能块（`guide.<id>` / `feature.<id>`）直接输出带编号的步骤行；跨功能块继续编号。
- 图片块紧跟在它所标注的**最后一个步骤**所在的功能块之后；没有标注的状态图跟在声明了 `outcomeFigure` 的步骤之后。图片块只有图片本身，不再输出图例。
- 截图上的标注号 = 该操作在小节里的步骤号（`layoutPlan` 计算，`grouped-figures` 直接使用，不再按图从 1 重排）。标注号写进 `captureLayout`，编号变化会使 `layoutRevision` 变化：绑定与状态不变时 `rederive` 重画，否则重新采集。
- `validateRenderedLayout` 改为核对：步骤块的编号与顺序、图片块位置、每个标注号等于对应操作的步骤号。

### B. 一节一条子流程，补充说明有自己的位置（问题 2）

- 小节新增 `tips: string[]`：不属于主流程的提示（忘记密码？收不到验证码？），渲染为步骤后的 `> 提示：…`。
- 页面新增 `faq: [{ id, question, answer }]`：渲染为页面末尾 `## 常见问题`，每项 `**问题**` + 回答（与任务指南的 branches 同一写法）。
- 说明类功能（concept / reference）在小节里渲染为步骤之后的普通段落，不再混进编号步骤。
- 写作规范与 layout 请求说明明确：一节只讲一条读者能独立完成的子流程；标题写「使用短信验证码登录」这类目标；同一屏上的不同方式分节，各自出图。
- 质量提示（进入 `quality.warnings`，可用 `quality.blockOn` 升级为阻断）：
  - `section-too-broad:<id>`：编号步骤超过 6 步，或包含超过 3 个操作功能。
  - `section-outcome-missing:<id>`：操作小节的最后一步没有 `outcome`。
- 分类计划提交时（`prepareLayouts`）对新写的标题、目标、步骤、结果、提示、问答做风格检查（`style-lint`，命中即拒绝）。

### C. 每一步写清结果，并有截图证据（问题 4）

- 操作新增 `outcome`（做完这一步后界面上出现什么、怎么判断成功）与 `outcomeFigure`（同一小节内 `purpose: state` 的图片 id）。`outcome` 必须带 `outcomeFigure`，状态图本身已要求检查点有非 URL 断言、截图后复核。
- 渲染：`N. 指令` 下缩进一段结果说明，结果状态图紧随其后。
- `documentCoverage` 增加结果证据核对：`outcomeFigure` 必须有已验证的最终图、状态已复核（`stateVerified` 且 `scenario-state` 断言通过），否则 `manual-outcome-unproven`，与操作证据一样在正式发布时阻断。
- `outcome` 与 `tips`、`faq` 的文字进入事实包的依据文本（`supportText` / 页面 `results`），页面导语改写时可以复述这些已有截图证明的结果，不再被 `unsupported-result` 误拦。

### D. 用 Demo mock 走完写操作流程（问题 3）

- 页面 Scenario 的 setup 动作新增 `mocked: true`：表示这一步会发出写请求，由本 Scenario 的 mock Fixture 拦截并返回虚构响应。
  - 只允许在 `data.mode: fixture` 的 Scenario 中使用（schema 校验）；带 `mocked: true` 的动作跳过 `SETUP_RISKY_RE` 的只读判断。
  - `prepareLayouts` 放行 `risk: write` + `mocked: true` 的 setup，但要求引用的 Fixture 是 `kind: mock`（`sideEffectClass` 已强制为 none）。
  - 采集时若 setup 含 `mocked: true` 而数据模式不是 `simulated`（mock Fixture），直接报 `mock-write-unbacked`，不打开页面。
  - 运行时安全沿用 Demo 网络守卫：漏写 mock 的写请求被中止，截图判 `write-blocked`，服务端收不到。
- 模拟截图沿用现有来源提示（「截图中的数据为示例数据」）。
- 这样「验证码登录」「找回密码」「注册」可以在页面手册里完整拍到：输入手机号 → 验证码页 → 设置密码 → 成功提示，每个状态一个 Scenario（setup 从头回放）。真实短信、真实账号都不会发生，`verify --live` 可以自动回放。
- 跨页面的最终结果（注册后进入工作台）仍以本页能观察到的成功信号为证据；进入后的页面由对应页面手册说明。

### E. 文档

- `docs/GROUPED_MANUAL.md`：字段表、编号规则、tips / faq、outcome、模拟写操作。
- `references/manual-writing-style.md`：页面小节的写法（场景一句 → 编号步骤 → 结果 → 提示；常见问题）。
- `docs/DEMO_CAPTURE.md`：页面 Scenario 的 `mocked: true`。
- `src/runtime/model-request.js`：layout 请求的说明同步新规则。
- 模板版本 `render-17`（旧草稿全部失效，需要重新生成）。

## 4. 兼容性与迁移

- 旧页面不改也能生成，但版式会变：步骤编号连续、图下不再有图例、标注号改为步骤号。因为 `layoutRevision` 包含标注号，已有分类截图会被判为需要重新派生或重新采集。
- 旧 `guide.<id>` 块身份保留，三方合并仍能保护人工编辑。
- NeoAgent 需要：按新规则重新提交登录等页面的分类计划（拆分子流程、补 `outcome` / `tips` / `faq`）；为验证码、注册、找回密码写 mock Fixture（短信发送、校验、注册、重置接口）和对应 Scenario；在 `capture.demo.selectors` 里登记手机号、验证码输入框的演示值；然后重新采集、生成、发布。

## 5. 验证

- `test/grouped-manual.test.js`：编号连续且不重复、图片位置、tips / faq / outcome 渲染、`outcome` 缺 `outcomeFigure` 被拒、`mocked` 只允许在 fixture Scenario、质量提示。
- `test/grouped-manual-browser.test.js`：真实浏览器里用 mock Fixture 拦截 POST，setup 带 `mocked: true` 进入结果状态，状态图作为 `outcomeFigure` 通过覆盖检查并发布；标注号等于步骤号。
- 全量 `node test/run.js`。
