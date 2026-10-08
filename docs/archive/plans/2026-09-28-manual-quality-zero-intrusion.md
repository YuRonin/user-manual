# 手册质量与零侵入适配：下一阶段需求

> 状态：待方案评审。来源：NeoAgent `/chat` 页面实际运行（页面手册过薄、8 个任务全部未发布、public 截图泄露手机号掩码）。
> 本文件末尾的「执行 Prompt」可直接交给 Claude Code / Codex 使用；方案确认前不写代码。

## 背景：这次暴露的问题

| 类别 | 现象 | 根因 |
|---|---|---|
| 页面手册过薄 | `chat.md` 只有 5 个操作名词 + 1 张图 | 页面模板只有 overview / location / actions 三块；detectedActions 只是名词；未走任务流程也能发布 |
| 截图无标注 | 位于 `images/annotated/`，图上没有序号 | 页面流程没有接入 `src/artifacts/annotation.js` |
| 内部状态外泄 | 正文出现"根据源码推断，尚未在浏览器中逐项验证" | `render.js` 的 actionsInferred 直接写入读者文档 |
| 隐私误报通过 | `134****1255` 带 `data-redact` 仍未遮挡 | 已修复：检测顺序让"含星号即已脱敏"先于显式标记（见同批提交） |
| 任务定位失败 | 8 个任务：文案猜错（新会话/新对话）、20 个匹配、目标不在本页、依赖前置数据、少一步 | 计划只由源码推断，没有在真实页面上预演定位 |
| 反馈太晚 | 关键截图缺失到起草阶段才失败 | 采集阶段不检查关键状态截图是否齐全 |
| 认证状态误导 | doctor 无警告，但认证是 unvalidated，实际要重新登录 | doctor 未把 unvalidated 当作风险 |
| 缺少导航 | `docs/manual` 只有单页文件 | 没有手册首页 / 目录 |

## 设计原则：默认零侵入，源码标记只作增强

工具要能用于任何 Web 项目，包括改不了源码的第三方系统和只有线上地址的站点，所以**不能把"给业务代码打补丁"作为前提**。

| 级别 | 做法 | 适用 |
|---|---|---|
| L0 零侵入（默认） | 只用页面现有信息：可访问性语义、已有 `data-testid` / `id` / `aria-label`、文本、区域、真实渲染结果 | 所有项目 |
| L1 项目外配置 | 规则写在业务项目的 `.manual/`（定位覆盖、隐私规则、前置数据），不改源码 | 自动识别不准时补充 |
| L2 源码标记（可选） | 项目方自愿加 `data-testid` / `data-manual` / `data-redact`；工具只**建议**，不自动修改 | 自有、需要长期稳定的项目 |

约束：任何命令仍不修改业务项目源码；L2 最多产出建议清单或补丁文件，由人按正常流程合入。

## 目标

1. **定位以真实页面为准（L0）**
   - 计划阶段在真实浏览器里预演每个步骤的目标：可见、唯一、所在页面正确，结果写回计划；不满足就退回修改，不进入审批 / 采集。
   - 每个目标保存多策略定位并按序回退：已有测试属性 / id → role + name → 文本 → 区域限定（landmark、列表行）→ 位置；记录实际命中的策略。
   - 多个匹配时用区域收窄（"历史会话列表第 1 行的更多按钮"），收窄不了就问人，不猜。
   - verify 时主策略失效、回退命中记为 drift，而不是 failed。
   - 步骤按元素编号引用目标（元素与任务多对多），不以任务 id 作为元素标识。
2. **前置状态显式化（L1）**：依赖已有数据或前置操作的任务（产物、待补充会话、弹层）必须在计划里声明前置步骤或 Fixture，预演阶段就检查。
3. **隐私默认从严（L0 + L1）**
   - public 下半掩码（号段 + 尾号、部分邮箱）仍遮挡。
   - `.manual/config.yaml` 支持按选择器、文本模式、页面区域声明遮挡，效果等同 `data-redact`。
   - 发布前对**最终图片**做文字识别复核（手机号、邮箱、账号类），作为 DOM 检测之外的兜底；复核失败阻止发布。
4. **页面总览升级**：detectedActions 扩展为结构化条目（名称、定位、一句话作用、关联任务），截图按条目生成①②③标注，正文"序号 + 名称 + 作用 + 关联任务链接"对照截图；仍遵守 C11（事实块确定性渲染）。
5. **读者文案与验证状态分离**：未验证等内部状态写入块元数据或 verify 报告，不出现在 public 正文。
6. **完整度门槛**：页面文档只有名称没有做法、没有关联任务、截图未标注时，发布前提示并建议先 `discover-tasks`（在方案中决定 warning 还是 waiting_input）。
7. **尽早失败**：采集阶段检查关键状态截图是否齐全；doctor 把 `unvalidated` / 过期认证列为 warn。
8. **手册首页**：自动汇总已发布页面与任务，按"快速开始 → 页面 → 常见任务 → 常见问题"组织，受 manual:block 保护；update / verify 识别它。
9. **L2 建议（可选命令）**：在 inspect / describe 之后输出"建议增加的定位属性与 data-redact"清单及补丁文件，沿用项目已有属性约定；不自动写入源码。

## 执行 Prompt

```text
在 E:\NeoStar\user-manual（manual skill 本体）实现 docs/plans/2026-09-28-manual-quality-zero-intrusion.md。
先出方案，我确认后再写代码。

原则：默认零侵入（L0），项目外配置补充（L1），源码标记仅可选增强（L2）；任何命令都不修改业务项目源码。
工具必须能用于改不了源码的项目，所以方案里每项能力都要说明在"没有任何源码标记"时如何工作。

步骤：
1. 读 SKILL.md、docs/ARCHITECTURE.md、docs/RUNTIME.md、docs/plans/2026-09-24-living-manual-contracts.md、
   references/task-workflow.md，以及 src/tasks/*、src/browser/playwright.js（locatorFor / performAction）、
   src/generate/*、src/artifacts/*、src/privacy/*、src/publication/*、src/commands/doctor.js。
2. 按本计划"目标"1～9 给出方案：改动模块、数据模型与契约变更（含 schema、migrate、旧页面模型与已发布文档的兼容）、
   测试计划（unit 优先，浏览器测试放 browser 分组）、分阶段交付顺序（建议先做 1 定位预演、3 隐私、7 尽早失败）。
3. 需要我决策的点用选项列出（例如完整度门槛用 warning 还是 waiting_input、文字识别用什么依赖、L2 属性名约定），停下来等我确认。
4. 确认后按阶段实现，每阶段：先写测试 → 实现 → node test/run.js --group unit 与相关 browser 测试 →
   同步更新 SKILL.md / docs 与 docs/plans/2026-09-24-living-manual-todo.md → 用 /git-commit-format 单独提交。
5. 保持文件原有换行（CRLF / LF 不变）。
6. 全部完成后在 NeoAgent（E:\NeoStar\NeoAgent\demo\website）上端到端验证：
   重新 discover-tasks chat 与 8 个已批准任务的 plan 预演，报告每个任务的定位结果；
   重新 generate page:chat，对比新旧文档；确认 public 截图中账号信息全部遮挡。
   验证时不得修改 NeoAgent 源码，只允许写它的 .manual/ 与 docs/manual/。
```
