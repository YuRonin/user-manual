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
