# 迁移与兼容说明

## 从 v1 项目迁移（Phase 1）

```bash
manual migrate --dry-run --manifest plan.json   # 只读：实体版本变化、固定 ID 映射、无法证明的验证项、需要重新采集的对象
manual migrate --apply --manifest plan.json     # 执行；中途失败再次 --apply 从 journal 继续；重复执行不改动
manual migrate --rollback <迁移 id>             # 用完整备份恢复
```

旧的"已验证"标记在迁移时变为明确的 unknown，不伪造验证；旧页面原图用 `manual migrate-artifacts`（先查看清单，确认后 `--copy`，不删除源文件）移出发布目录。

## Phase 3 带来的变化

| 变化 | 影响 | 需要做什么 |
|---|---|---|
| 模板版本 `render-2`：正文按块标记分段 | 旧草稿判为 `draft-stale` | 重新运行 `generate`（或旧的 `--draft`）生成草稿 |
| 发布记录新增 `sourceBaseline`、`generatedBlob`、`sections`、`acceptedEdits` | 旧发布记录缺这些字段 | 无需迁移：`update` 对旧记录全量重建一次；手改过的旧文档第一次合并会报 `base-missing` 冲突，确认后 `--force` 或采用提案 |
| 已发布文档存在时重新定稿不再要求 `--force` | 未手改的文档可直接重新生成；手改过的走三方合并 | `--force` 只在明确要覆盖人工修改时使用 |
| Capture 记录新增 `semantic` / `environment` | 旧 Capture 的在线漂移比较为 inconclusive / environment-incompatible | 需要漂移比较时重新采集 |
| `verify` 支持 `page:` / `task:` / `--all` / `--live` | 旧用法 `verify <task-id>` 不变（离线产物验证） | 无 |
| `update` 从"计划中"变为正式命令 | — | 无 |
| `manual gc` | 默认只列出 | 审阅后 `--apply --expect <planHash>` |

## 统一 Demo 截图模式

| 变化 | 影响 | 需要做什么 |
|---|---|---|
| 新增 `capture.mode`，唯一取值 `demo` | 旧配置没有这一行时按 demo 读取；写成其他值会被拒绝并提示 | 无（`init` 新生成的配置会带上这一行） |
| `data-redact` 区域不再打马赛克，改为替换成演示值 | 没有配置演示值的键会让截图停在 `needs_fixture`，不再"打码后照常发布" | 按报错列出的键补 `capture.demo.text` / `images`，或用 Fixture 提供数据 |
| 正文里未声明的手机号 / 邮箱不再打码 | 门禁判为 `needs_fixture` | 把所在元素加进 `capture.demo.selectors`，或用 Fixture 提供虚构数据 |
| 浏览器内非只读请求默认中止 | 打开即写的页面判为 `blocked`；只读步骤触发写请求时以 `demo-write-blocked` 失败 | 确认无副作用的请求登记到 `capture.demo.network.allow`；写操作用 `writeAuthorization` 或 Fixture 完整模拟 |
| Service Worker 被屏蔽、未登记的 WebSocket 被关闭 | 依赖它们的页面可能表现不同 | 只读的 WebSocket 登记到 `capture.demo.network.websockets` |
| 门禁失败不再写入 Capture 记录与原图 | 失败只出现在运行结果与原因码中 | 无 |
| 旧 Capture（没有 `privacy.demo`）继续可用，重新派生时沿用旧遮罩规则 | `generate` 提示 `demo-evidence-legacy` | 需要清晰演示截图时重新采集 |
| 新增 `capture.demo.selectors`：敏感区域可在 Skill 侧按 CSS 选择器声明 | `data-redact` 不再是必需的；两种声明方式等价 | 不需要再改被采集项目；已有的 `data-redact` 照常生效 |
| 页面声明了敏感区域时，没有 Fixture 也没有登记的数据读取（含跨域、SSE）判为 `needs_fixture`（`demo-unmocked-read`） | 之前这些读取直接放行且不记录；真实数据进入声明区域之外时无从发现 | 为接口写 Fixture；确认只返回公开数据或内容全部落在已声明区域后，登记到 `capture.demo.network.allow`（GET 也可以登记） |
| 页面声明了敏感区域时，跨域 iframe / Canvas / Shadow DOM 判为 `needs_fixture`（`demo-surface-unaudited`） | 之前只记数量 | 确认其中没有真实数据后登记到 `capture.demo.surfaces` |
| Fixture 的 JSON 响应体在登记时校验（可解析、可选 `shape`、列表 id 唯一） | 写坏的 Fixture 以 `fixture-invalid` 拒绝使用 | 按报错修正 Fixture |
| Service Worker 的注册在 Demo Context 中明确失败 | 之前 `serviceWorkers: block` 在当前 Playwright 下仍可能注册成功 | 无 |

## 标注布局、拆图与 Scenario 状态（B4 / B5）

| 变化 | 影响 | 需要做什么 |
|---|---|---|
| 渲染器升级为 `sharp-svg-3`（编号避让、拆图、主题参数全部生效） | 已有发布图在下次 `generate` 时重新派生一次（沿用原图，不重新登录或采集）；`verify --live` 对旧图报 `baseline-incompatible` 直到重新发布 | 无 |
| 超过 `maxMarkersPerImage` 不再报 `marker-limit-exceeded`，改为拆成多张图 | 一条 Capture 可有多张 `published`（`part: N`，文件名带 `--part-N`）；页面与任务手册按顺序引用 | 无 |
| 主题新增 `haloWidth`、`markerStrokeWidth`、`markerText`、`fontScale`；`primaryDark`、`labelText`、`focusMask`、`fallbackColor` 弃用 | 旧配置照常读取，出现弃用字段时提示 `annotation-theme-deprecated` | 删除弃用字段即可 |
| 整页截图前回到页面顶部，fixed 元素按贴边方向换算 | 整页截图里 fixed / sticky 元素上的框与遮罩位置更准；截图尺寸与画布 × DPR 不一致时报 `geometry-scale-mismatch` | 无 |
| 源码图解析版本升级（`package.json` / `package-lock.json` 只按运行相关内容计入指纹） | 升级后第一次 `update` / `generate` 会把所有页面视为全局配置变化一次 | 正常重新生成一次；之后只改 scripts 不再触发全量 |
| 显式 Scenario 的 `setup`、`checkpoint.capture.mode`、`expected.redirects` 的查询参数、`preconditions`、`expected.roleAssertions` 开始生效 | 之前被静默忽略的字段现在会执行；`expected.state: empty` 需要 URL 以外的检查点断言；setup 中有副作用的动作被拒绝 | 按 `manual capture scenario:<id>` 的报错补全或删除这些字段 |
| 标注失败按类别定向修复 | 同一失败反复出现时不再无限重拍：清单 / 计划问题与"图像输入没变的绘制失败"直接要求审核，连续两次修复失败报 `annotation-unrepairable` | 按提示修正定义或主题后 `generate --refresh` |
| 发布记录新增 `definitionViews` / `stateRevisions` | `update` 能区分"只改文案"与"需要重采"；旧发布记录按 `model-changed:definition` 保守处理 | 无 |

## 历史产物只留当前版本

早期版本把每次模型提交的完整快照、每次发布的记录和每次验证的报告都留在 `.manual/` 并入库，
实际读取路径却只用当前版本，导致目录随使用线性膨胀（实测一个 33 页项目两周积累 161 份快照、约 44 MB）。
原先为"恢复链"保留历史的设想没有任何命令使用，现改为：

| 变化 | 影响 | 需要做什么 |
|---|---|---|
| 模型提交后只保留 current 指向的快照；`snapshots/` 改为本机产物 | 新克隆缺快照时按工作副本自动重建 | 已有项目执行 `git rm -r --cached .manual/snapshots`（`.manual/.gitignore` 会自动补上条目） |
| 发布完成后删除被取代的旧发布记录及只被它引用的生成正文 | 覆盖前的版本改从 Git 历史找回 | 无 |
| `verifications/` 改为本机产物，按 `runLogDays` 回收 | 验证结果以命令输出为准 | 已有项目执行 `git rm -r --cached .manual/verifications` |
| `manual gc` 把旧发布记录、非当前快照列为立即可回收 | 升级前的存量一次清掉；只被旧发布引用的 Capture 按 `unreferencedCaptureDays` 回收 | `manual gc` 审阅后 `--apply --expect <planHash>` |

## 兼容入口与退出窗口

以下入口继续可用，至少保留到下一个主版本；它们不再出现在 `manual --help` 与 SKILL.md 中，新项目使用右列：

| 兼容入口 | 替代 |
|---|---|
| `generate <page-id> --draft` / `--finalize <文件>`（页面三段式） | `generate page:<id>`（Runtime）+ `resume --request --input` / `--copy` |
| `run-submit <runId> --request <id> --input <文件>` + `resume <runId>` | `resume <runId> --request <id> --input <文件>` |
| `migrate-artifacts` | 仅用于 V0.3 以前的旧原图；新项目不需要 |
| `plan-capture` / `capture-task` | `generate task:<id> --plan` / `capture task:<id>` |
| `generate-task <id> [--copy / --finalize]` | `generate task:<id>` |
| `verify <task-id>` | `verify task:<id>`（同一检查）/ `verify task:<id> --live` |
| Codex `$manual-<命令>` / Claude Code `/manual-<命令>` 别名 | 只为主流程命令生成（init / inspect / describe / auth / generate / update / verify / site / doctor）；`npm run install:compat` 会清理旧版本生成的其它别名，其余命令通过主 skill `manual` 使用 |

旧 schema 的读取器（v1 页面 / 任务 YAML、旧 manifest、没有 Capture 记录的页面投影、无 `sourceBaseline` / `generatedBlob` 的发布记录）
继续保留。本阶段没有删除任何兼容实现：它们仍被兼容入口调用，删除需要先证明没有调用方且有等价替代。
不会删除或改写任何已有的用户产物（文档、图片、发布记录）。
