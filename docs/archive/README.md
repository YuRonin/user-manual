# 归档：设计过程与实测记录

这里保存各阶段的设计、实施计划、质量基准与实测记录，用于追溯决策来源。**它们描述的是当时的状态，不是现行约定**；文中的命令、模板措辞和目录可能已经变化。

现行事实源只有三份：

- [ARCHITECTURE.md](../ARCHITECTURE.md)：职责划分、目录与模型、证据与生成管线
- [RUNTIME.md](../RUNTIME.md)：Run、等待输入、缓存、恢复与故障排查
- [MIGRATION.md](../MIGRATION.md)：旧项目迁移与兼容入口

| 文件 | 内容 |
|---|---|
| `plans/` | 2026-09 各阶段（页面模型、正逆索引、任务优先、认证与隐私、Living Manual Phase 0–3、零侵入质量）的设计与实施计划 |
| `OPTIMIZATION_PLAN.md` | 早期整体优化计划 |
| `QUALITY-BENCHMARK.md` / `QUALITY-TODO.md` / `READER-QUALITY-PLAN.md` | NeoAgent 任务手册的质量基准、待办与读者质量计划 |
| `NEOAGENT-COST-BASELINE.md` / `NEOAGENT-READER-TEST.md` / `neoagent-trial-2026-09-28.md` | NeoAgent 试用的成本基线、首次阅读者测试方案与试用记录 |

2026-10 起，正式手册改为帮助中心结构（模板 `render-13`）：入口并入操作步骤，正文不再出现验证范围、截图时间与“此操作未执行”等维护信息。归档文档中引用的旧措辞（“开始前”“完成后怎么检查”“采集时已看到”）以此为准失效。
