# 降低建模成本与提升任务手册质量：实施计划

基线：`docs/NEOAGENT-COST-BASELINE.md`、`docs/QUALITY-BENCHMARK.md`，以及 NeoAgent 的 `use-skill`、`review-credits`、`generate-practice`。现有取证、Run、审批、事实包与发布事务继续作为执行基础。下列项目只在有真实证据时提升为“已验证”；静态检查和代理走查不能代替首次阅读者测试。

## P0：建任务与结果覆盖

- [x] **C1 引导式建任务。** 提供一个只读工作表入口，输入任务目标，复用页面模型中的入口、指南步骤、状态断言和同入口任务前提；输出每项建议的来源和待人工确定字段。它不自动批准候选、不执行写动作。验收：可用一条命令取得可审阅工作表，错误页面/空目标有明确提示。
- [x] **C2 目标与完成判断对应。** 在任务模型中声明每项目标的结果类型及证明方式（已绑定断言或读者核对）；质量报告逐项显示证据范围，缺口不能显示为“已完成”。验收：三类结果（已验证、预期、读者核对）分别测试，三篇 NeoAgent 手册覆盖各自目标且不夸大。

## P0：截图与步骤对应

- [x] **S1 截图用途检查。** 对操作前截图核对标注目标与本步动作目标，对操作后截图核对状态说明；无法可靠自动判断的项目列为人工审阅，不能猜测截图内容。验收：错误目标/时机的 fixture 报警，三篇现有任务的报告可解释，既有图不被静默替换。
- [x] **S2 集中审阅报告。** 每步展示动作、操作前后图、图注与核对点，发布前可用同一份报告审稿。验收：可只读生成，不访问网站、不泄露认证或原图。

## P1：读者视角与反馈

- [x] **V1 读者预览。** 从正式 Markdown 生成可浏览的读者视图，维护标记不出现，图片可放大；预览保留来源链接和质量告警。验收：三篇 NeoAgent 手册的标题、编号、图、异常与完成部分在预览中齐全。
- [x] **M1 新任务成本实测。** 在下一项真实新任务中记录从目标描述到发布的时间、人工编辑量、质量警告和返工；只把它与同类任务的实测过程比较，不把旧任务的字段回算当作省时数据。
- [ ] **V2 真实反馈回路。** 使用 `docs/NEOAGENT-READER-TEST.md` 记录首次阅读者的完成率、卡点、求助与耗时；根据实际卡点修订后由另一位首次阅读者复测。依赖独立读者，不能由生成者或自动回放代填。

## 执行和记录规则

每项完成后记录实现文件、针对性测试、安装版同步与 NeoAgent 实践。新能力优先复用现有深模块的接口，避免另建平行的取证和发布流程。衡量总成本用新任务从目标描述到发布的真实耗时、人工编辑量、质量警告与返工次数；旧任务字段回算仅作结构对比。

## 2026-10-05 实施记录

- C1 已实现只读入口 `src/tasks/worksheet.js`、`src/commands/task-guide.js`：NeoAgent 的“查看积分余额与消耗明细”将 `/credits` 排在首位；选定 `chat` 后得到带来源和 `verified: false` 的工作表。实际省时幅度留给 M1 测量。
- C2 已实现 `completion.goalChecks` 的引用校验与 `taskQuality.goalCoverage`，三篇 NeoAgent 任务模型已补目标映射。报告使用 `observed-interface`、`not-verified`、`reader-check-required`，只陈述对应的界面断言与读者责任。目标映射不改变浏览器取证 revision。
- S1 已加入操作前标注目标与动作目标、截图记录时机与任务声明时机的静态冲突提示；操作后图的结果含义无法从结构数据判定，`review-task` 对每张图列出目视审阅问题。三篇现有任务均有图注且报告可解释；没有静默替换旧图。目视审阅仍是交付动作，不得宣称自动检查理解了截图像素。
- S2 已实现 `src/commands/review-task.js`，逐步列出动作、已发布标注图、图注、目标覆盖与完成声明。命令本身只读；`--preview` 才写本地 HTML。
- V1 已用 `review-task --preview` 生成三篇本地读者预览，均隐藏维护注释；图片分别为 3、3、4 张，所有相对链接均能解析。预览存放在 `.manual/previews/`，不是正式发布物。
- 针对性测试：`node test/task-guide.test.js`，5 项通过；`node test/discover-tasks.test.js`，8 项通过（含空目标、错误页面）；`node test/init.test.js`，37 项通过；`npm test` 全部测试文件通过（Gate 3 结束码 0）。最后把标注目标比较改为规范化嵌套对象后，再次运行针对性测试通过。
- 安装版同步：源码复制到 `/Users/steven/.codex/skills/manual`，执行 `npm ci`、`node bin/install-compat.js --client codex`；`rsync -ani` 核对安装目录与源码无差异。旧安装备份在 `/tmp/manual-installed-backup-20261005.tar.gz`。
- NeoAgent 实践：安装版的 `task-guide`、三篇 `review-task --preview` 均成功；三篇预览图片分别为 3、3、4 张，链接存在且维护注释未渲染。`generate --offline` 因缓存输入变化返回 `cache-miss-offline`，没有触发浏览器或重新提交；改用安装版 `generate-task` 从既有有效证据分别草稿/定稿，三篇 `verify --artifacts` 均返回 `artifact-verified`、`onlineChecked=false`、`businessVerified=false`。

## 2026-10-06 登录身份变化后的离线提示

- 复现：安装版 `manual generate task:use-skill --offline --copy-default --plan --json` 返回 `cache-miss-offline`；规划中的差异仅为 `identityRevision`。这是认证身份断言定义的缓存隔离，不能把旧采集当作当前身份的新证据。
- 改进：规划和执行阶段的离线错误现在列出变化字段；遇到身份定义变化时，说明旧证据不可作为当前身份的在线证明，并指向 `generate-task` 的既有证据文案重发流程。未放宽缓存键，也未重放提交动作。
- 验证：回归测试先复现旧错误、再通过；`node test/runtime-planner.test.js` 12 项、`node test/cache-policy.test.js` 10 项通过。源码同步安装后，在 NeoAgent 用安装版同一 `--plan` 命令确认提示包含 `identityRevision` 和安全后续路径。

## 2026-10-06 M1：新建「查看会员账单记录」

- 任务范围：仅打开 `/membership` 的付款记录抽屉并查看已有记录或空状态；未执行购买、付款或退款请求。测试账号当时可正常访问。入口工作表在约 02:05 UTC 生成，最终任务 Capture 和发布于 02:11 UTC 完成，约 6 分钟；包含目录语义修复、安装同步和审阅的本轮工作到 02:13 UTC，约 8 分钟。这是代理辅助建模的真实墙上时间，不等于独立人工作者工时，也没有可比的同类新任务数据，不能据此声称节省了多少时间。
- 工作表只给出 `/membership` 入口、1 条路由断言、0 条步骤、0 条前提。建模者实际补了 1 个操作步骤、1 个页面结果状态、1 条完成声明、1 个目标映射、1 条读者核对项、1 个空状态分支和 2 条源码出处。浏览器实跑前没有人工撰写的正式 Markdown；成品由事实包生成。
- 首跑因源码按钮「查看账单」与站点实际按钮「付款记录」不一致而在点击前失败，保留诊断截图；改定位后成功。随后为让入口和空状态文案遵从实测界面，再修订页面标题和任务文案并重新采集。共 1 次失败、2 次成功的只读 Capture，2 轮模型返工。质量报告最终 0 条警告、7/7 结构检查通过；结果仍标为 `reader-check-required`，不能据此推断首次阅读者完成率。
- 实现反馈：`task-guide` 在无浏览器观察的入口页增加核对当前按钮名称与位置的提示；目录在存在读者核对项时追加「需读者核对实际结果」，避免把已验证的界面声明误读成整个目标已完成。针对性测试 `node test/task-guide.test.js` 5 项、`node test/manual-quality.test.js` 22 项通过；安装版与源码 `rsync -ani` 无差异。
- NeoAgent 实践：安装版完成只读 Run，手册位于 `demo/website/docs/manual/tasks/view-billing.md`，目录已收录；`review-task --preview` 目视核对截图和完成段，`verify --artifacts` 返回 `artifact-verified`、`onlineChecked=false`、`businessVerified=false`。截图为测试账号的付款记录示例，文档明确要求读者以自己账号为准。
