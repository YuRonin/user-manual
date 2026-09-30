# NeoAgent 使用手册生成实测与问题分析

实测日期：2026-09-28（Asia/Shanghai）。本报告基于当前机器上的真实运行、生成图片目视检查和源码核对，不把历史证据当作本次在线验证。

## 环境与安装

- NeoAgent：`docs/user-manual`，基线 `27e4ffcc`；Web 项目根为 `/Volumes/external/Neostar/NeoAgent/demo/website`。
- user-manual：`main`，基线 `66572b0c26d07d3a103ce7ce39840c0a057b1ed9`。
- 安装目录：`/Users/steven/.codex/skills/manual`，通过 Codex skill-installer 安装仓库根目录，执行 `npm ci`、`npm run install:compat`。已核对 143 个运行代码、入口、引用文档及依赖配置文件，与工作区一致。
- 主 skill 名是 `manual`，并安装了 21 组 Codex/Claude Code 命令别名。安装器会同时写两个客户端目录，缺少仅安装某个客户端的选项。
- Node 26.4.0，Playwright 1.63.0；本机已有 Chromium，doctor 通过运行环境检查。
- 使用已有配置中的测试站 `https://liuxian-test.power.neostaredu.com`，`audience: internal`、1440×900@2x。没有把本地源码当作已部署版本的证明。
- 通过 `manual auth login` 打开的浏览器使用测试账号登录。密码未写入项目；会话由工具保存在系统用户缓存中。未配置身份断言，认证标记为 `unvalidated`。

## 本次运行结果

| 对象 | 实际结果 | 可核对记录 |
|---|---|---|
| 已有 chat、generate-practice、run-combo 手册 | 原有三份文档离线校验通过；不代表当前网站业务流程通过 | `verify --all` 返回 `onlineChecked: false` |
| `task:review-credits` | 失败：点击积分中心后实际到达 `/credits`，执行器仍断言 `/chat` | Run `bde63ffd-6141-4261-a542-a7c708401ecb`，`state-assertion-failed`，约 60 秒 |
| `page:credits` | 新采集、草稿、模型文案交接、校验、发布全部成功；随后离线产物校验通过 | Run `ac2b9bff-d264-4647-a757-25387c1a28b4`；文档 `docs/manual/credits.md` |
| `task:use-skill` | 失败：搜索“备课”后页面显示“没有匹配的能力”，继续选择结果时找不到元素 | Run `642a9d24-2e46-4617-9d8c-cb39d6619b94`，`target-not-visible`，约 65 秒 |
| `task:generate-practice` | 本机重新采集、文案交接、发布成功，离线校验通过；前三步实际执行，发送和生成结果未执行 | Run `06be33bb-075f-4485-88f5-e53926335fab`；文档 `docs/manual/tasks/generate-practice.md` |

运行记录位于 NeoAgent Web 项目的 `.manual/runs/`。失败截图在 `.manual/artifacts/diagnostics/`，属于本机诊断材料，可能包含账号或业务数据，不应作为对外手册插图。

新生成的积分中心发布图：`docs/manual/images/annotated/page--credits--39029a9f7d9e22ab.png`。已目视检查：页面加载正常，但没有序号标注；金额、账号、历史会话标题及积分明细正文大面积遮挡。

出题指南的两张新图已目视检查：第一张标出“我要出题”，第二张标出预填输入框，标注可见。第二张采集时机为修改前，因此展示预填需求，不是本次脚本随后填写的示例需求；没有生成结果图。两张图的标注都为“1”，与正文第 2、3 步没有明确编号对应约定。

本轮共实际执行四次 generate：两次发布成功、两次失败。这个数字是代表性样本结果，不是全站成功率。成功文档各完成一次离线校验；未修改运行代码，未运行与本次评估无关的完整测试套件。

为方便阅读，另外手工补充 NeoAgent `docs/manual/README.md` 作为四份现有手册的导航，并注明各自验证范围；它不是 skill 自动生成首页的能力证明。

复查命令（在 NeoAgent 的 `demo/website` 下运行，不含凭据）：

```bash
node /Users/steven/.codex/skills/manual/bin/manual.js status bde63ffd-6141-4261-a542-a7c708401ecb --json
node /Users/steven/.codex/skills/manual/bin/manual.js status 642a9d24-2e46-4617-9d8c-cb39d6619b94 --json
node /Users/steven/.codex/skills/manual/bin/manual.js verify page:credits --json
node /Users/steven/.codex/skills/manual/bin/manual.js verify task:generate-practice --json
```

## 1. 页面手册模型承载不了完整操作说明（P1，实测确认）

积分中心生成结果只有用途、地址、截图，以及“查看积分概览 / 查看积分规则 / 查看获得和消耗明细”三个条目。没有说明入口在哪、如何筛选，也没有结果样例。旧 `chat.md` 同样只有五个操作名称。

原因在生成模型：`src/generate/fact-pack.js:105` 将页面操作保存为字符串，允许模型填写的块只有 `intro`（第 122 行）；`src/generate/render.js:165` 固定输出 overview、location、actions 三块。模型被要求只能润色，无法补充缺失的步骤与截图说明。因此加强“中文自然化”提示词不能解决结构缺失。

建议：先扩展事实模型，容纳入口、操作目的、真实 UI 目标、关键状态、步骤和关联任务；再允许文案组织这些事实。发布前检测“只有功能名，没有做法”的低完整度页面。

## 2. 跨页面操作默认校验错误，计划却显示可执行（P1，实测确认）

`review-credits` 的 `open-credit-center` 动作在 chat 页面点击按钮，业务实现跳转到 credits。`src/tasks/capture-plan.js:69` 从同一个页面解析前后状态，未声明 `stateAfter` 时沿用 `default`，于是动作前、动作后都要求 `/chat`。`crossPage` 在下一步 `filter-spending` 才为 true，无法修正当前步骤的后置断言。

`src/tasks/executor.js:197` 点击后执行后置断言，故正常导航被判为失败。失败截图实际显示完整积分中心，排除了“登录失败或目标页面不可达”的解释。用同一任务调用 `buildCapturePlan`，能在无浏览器情况下看到 `open-credit-center` 的前后 URL 都是 `/chat`，而计划仍 `ok: true`。

这同时涉及 NeoAgent 的任务定义缺少跳转后状态，以及 skill 的默认规划规则、校验与指导不足。不能简单断言工具完全不支持跨页；可以显式描述后置 URL，但默认流程没有引导或提前检查。

建议：分别建模动作所在页和预期到达页/状态；计划阶段发现导航动作缺少目的状态时明确指出。补一条真实的“点击入口→跨页→继续筛选”回归用例。

## 3. 数据前提只有文本，定位在采集时才发现不可执行（P1，实测确认）

`use-skill` 的前提写着“技能列表中有适合当前教学目标的可用技能”，但没有可执行检查。任务固定搜索“备课”，真实结果为空，仍按 `div.space-y-1 > button:first-child` 点击。诊断图确认空结果；本轮不足以判断是名称变化、账户权限还是测试站数据变化。

`src/browser/playwright.js:540` 按一条定位策略选择元素，`uniqueVisibleLocator` 发现没有可见结果就报错；没有把空状态解释为数据前提失败。`generate --plan` 通过仅表示静态规划通过，不表示浏览器预演成功。

建议：把任务前提转换成可验证断言；先观察实际列表再绑定稳定示例数据；明确空结果分支。定位保存页面区域和语义目标，避免依赖 CSS 层级和“第一项”；目标无法唯一定位时给出可修订证据。

## 4. 写操作统一截断，使核心业务结果缺少证据（P1，源码及已有文档确认）

`src/tasks/capture-plan.js:27` 将所有 `write` 映射成 `stop-before-action`；`src/tasks/executor.js:181` 遇到边界后中断剩余步骤。已有出题和组合技指南因此在“发送”前结束，正文仍以“生成练习题”“查看流程结果”为目标。

保留执行边界是合理的，但当前缺少明确授权的测试环境执行模式和完成结果证据路径。手册只能描述准备工作，无法证明产物出现、打开、导出等后半程。不能把测试账号本身当成任意写操作的授权。

建议：拆分演示准备与业务完成的验证范围；为明确授权的测试动作建立环境、动作、数据和清理范围。不能执行的步骤继续标记未验证，不能仅隐藏提示让文档看似完整。

## 5. 图片通过隐私门槛，不等于具有说明价值（P1，实测确认）

积分中心新发布图没有序号；明细行、数值等大面积被遮挡。页面采集在 `src/evidence/capture-page.js:199` 调用 `captureStable` 时未提供标注目标；图片位于 `annotated/` 不代表实际存在操作标注。

遮挡并非本轮误识别：NeoAgent `components/user-center/CreditsTab.tsx` 已将余额、记录名称、时间、变动及余额字段标记为 `data-redact`；`src/privacy/detector.js` 将显式标记作为强制遮挡，`internal` 也保留这条规则。工具按规则保护了数据，但没有判断最后是否还剩足够信息供读者理解。

建议：页面操作与编号、局部截图相互对应；增加最终图片的可读性检查。需要数值示例时使用经过批准的演示数据或有明确来源的模拟场景，不直接取消真实数据遮挡。把“隐私通过”与“图示可用”作为两个独立结果。

## 6. 校验通过容易被误读为功能已验证（P2，实测及模型检查确认）

已有三份手册离线校验全部通过，但两条本次在线任务失败。离线校验本来只负责文件、哈希及发布记录一致性，返回的 `onlineChecked: false` 是正确的；问题在于任务投影仍可变成笼统的 `status: verified`（`src/verify/artifacts.js`）。

八个已有任务的 completion 都没有绑定 `claims/assertionRefs`，`src/evidence/claims.js` 会将其视为 `legacy-unbound`。多数默认状态只有 URL 断言，不能证明业务结果。登录后 doctor 也将存在的认证缓存列为 `ok`，即使 auth status 明确为 `unvalidated`（`src/commands/doctor.js:208`）。

建议：分别展示产物完整性、页面身份、步骤交互、业务完成和隐私状态。发现缺少完成断言时给出可操作缺口；doctor 区分“已保存”“已验证”“未知/过期”，不把磁盘上有缓存等同于可用。

## 7. 文档组织和措辞保护仍有空缺（P2，已有产物及源码确认）

- 初始输出只有 chat 页面和两篇任务指南，没有手册首页、阅读顺序或页面到任务的导航。
- `renderTask` 同时输出生成的动作句与原始 instruction；仅字符串完全相同时去重。旧组合技文档因此同时出现“点击「能力」”和“点击「选择能力」”，同一步骤有两个名称。
- 允许的 UI 词汇同时来自 action 和 instruction（`src/generate/fact-pack.js`），只能证明模型没新增词，不能证明原始定义中的名称互相一致或符合线上界面。
- `src/generate/task-draft.js:66` 只要求至少一张图，不要求入口、关键操作和完成状态都有证据。
- `SKILL.md` 同时保留新 Runtime 和多个兼容路径；截图章节仍写 raw 位于文档目录且应随手册入库，与前文仅发布 annotated 的要求冲突。

建议：生成首页和任务导航；统一 UI 事实的来源；按关键状态检查截图覆盖；用一条默认工作流描述安装到发布，兼容命令移到迁移说明。

## 建议实施顺序与验收方式

1. **先修可执行性**：跨页前后状态、数据前提、定位预演。验收：积分任务实际完成三步；空技能列表在选择前返回明确的数据前提错误，而不是模糊的元素不可见。
2. **再修内容模型和图片**：页面总览与任务互链、步骤完整度、编号截图、演示数据。验收：新读者仅靠手册能找到积分入口、切换消耗筛选并识别结果。
3. **补业务完成证据与状态分层**：明确授权的测试写操作、结果断言、验证范围。验收：产物校验通过不能被解释成未执行的生成/保存/导出成功。
4. **整理交付体验**：默认工作流、首页、安装目标选择、步骤进度。当前两个失败 Run 都等待约一分钟才输出错误，期间状态只显示 capture 运行中，定位成本偏高。

已有 `docs/plans/2026-09-28-manual-quality-zero-intrusion.md` 覆盖了若干类似问题。本轮为其补充了可复现记录，尤其是跨页后置断言与真实空搜索结果；该旧计划中“8 个任务全部未发布”的描述已不符合当前基线，当前基线已有两份任务指南。

本轮评估范围为安装、已有产物检查和代表性在线生成流程，不是全站所有页面与权限组合的验收。运行代码保持原样，便于用这份结果评估当前版本的真实能力。

---

## 2026-09-29 修复与重新实践

本节记录针对上述七类问题的修复。代码位于 `user-manual` 工作区，已复制安装到 `~/.codex/skills/manual`，并在安装目录执行 `npm ci` 与仅 Codex 客户端的兼容入口安装。实践命令均调用安装目录的 `bin/manual.js`。

| 原问题 | 修复 | NeoAgent 实践证据 |
|---|---|---|
| 页面只有功能名 | 页面模型增加 `guide`（标题、说明、语义目标与可选任务链接）；生成器按编号输出操作说明，并对只有总览的页面给出完整度警告 | `chat.md` 与 `credits.md` 已包含具体做法；两张页面图带与文字一致的序号。 |
| 跨页状态错误 | 步骤支持 `pageAfter`；未显式声明状态且下一步切页时可推断目的页；目的页断言进入审批范围 | `review-credits` 的第二步导航到 `/credits`，第三步完成筛选，三步均采集成功。 |
| 数据前提与定位不稳 | 增加 `step.requires`、`plan-capture --live` 只读预演、语义定位唯一性检查及 `within` 范围；备选定位用时记录回退 | 原“备课”空结果改为线上确认存在的“教案生成”；搜索结果先校验，再在技能菜单范围内选择，预演前五步通过。 |
| 写操作无法验证结果 | 增加登记测试环境、精确 origin/步骤/期限/授权依据的写操作范围；写动作不自动重试，失败返回结果不明 | `use-skill` 的“发送”单步授权限定在测试站点；教案和助手回复已在测试站生成，详见下文。 |
| 图可发布但难用 | 页面关键目标自动标号；记录无标注、大面积遮挡和任务步骤缺图提示；保留强制隐私遮挡 | 积分页面图标出“当前积分”“消耗”，任务第三步截图显示“消耗”已选中；已目视检查清晰度。 |
| 离线验证混同业务通过 | 离线结果返回 `artifact-verified`、`onlineChecked=false`、`businessVerified=false`，任务投影保留 `generated`；doctor 区分已保存和已验证认证状态 | 页面和积分任务的离线核验通过；积分任务另做在线回放，3/3 步、1/1 声明通过，无漂移。 |
| 导航、措辞、覆盖不足 | 发布后维护 `index.md` 导航及证据范围；报告名称不一致、未绑定完成声明和步骤缺图；修正 skill 中 raw 发布说明，新增质量工作流 | `docs/manual/index.md` 已列出页面与任务、执行数和声明数；积分任务有三张对应截图。 |

本次身份缓存的 `validationStatus=unvalidated`，因为 NeoAgent 配置尚未提供身份断言；doctor 如实显示 `warn`。页面和任务采集仍通过各自的在线状态断言。目录里的旧“组合技”与“我要出题”任务仍保留原有未执行边界，不能当作本轮完成验证。

代表性回归：最初新质量测试 7 项通过；后续增加已有会话 URL 拒绝测试，现为 8/8。完整 unit 批次中仅原动作句兼容测试在首次修改后失败，恢复确定性动作句后 `fact-pack` 13 项通过；完整 browser 批次仅两项旧测试继续要求离线核验把任务标为 `verified`，更新期望后这两项分别 2/2、8/8 通过。页面与积分任务产物核验通过；积分任务在线验证 `result=passed`、`drift=none`。

### 2026-09-30：教案生成任务结果核对

第一次写操作运行在旧的 120 秒预算内耗尽，留下用户消息，未观察到回复。第二次运行提交了教学需求；诊断截图已经显示助手回复和生成的教案，但采集器仍将结果标为 `outcome-unknown`。原因是完成断言指向只在悬停时才可见的“复制”按钮。即使业务回复存在，这个控件在无头浏览器等待期间也不可见。

将 `chat.reply-ready` 改为观察实际回复容器，并重新确认任务范围后，新增 `capture-task --reconcile-url --prior-captures` 只读恢复路径。首次恢复校验了当前站点与会话、提交前截图的任务定义、回复状态，并补采结果图；没有重新执行“发送”。最终截图显示助手文字“已生成《教案：认识时分》并推送到右侧产物区”及教案卡片。之后源码又加上截图时序与会话中本次输入的校验；测试站随后要求重新登录，因此这两项增强尚未在站点上再次实测。`use-skill` 任务的四张发布图已目视检查，步骤 3–6 的标号清楚；步骤 1–2 没有专用截图，质量检查明确提示缺图。

`manual generate task:use-skill --offline --copy-default` 命中恢复后的采集缓存并成功发布 `docs/manual/tasks/use-skill.md`。目录显示 6/6 步、1/1 完成声明，离线产物核验返回 `artifact-verified`、`onlineChecked=false`、`businessVerified=false`。这些数字是生成时的证据范围；此次没有再次在线回放写操作。旧的 `generate-practice`、`run-combo` 仍有未执行的写边界和未绑定声明。

恢复过程中还发现旧证据清单会保存包含会话查询参数的 URL。源码已改为在后续清单中只保留 origin 和 pathname；已有本机 `.manual/` 清单属于私有诊断材料，不作为手册发布。恢复命令第二次尝试时测试站要求重新登录，因此未再次更新成功清单；已发布结果引用首次核对成功时提交的证据。
