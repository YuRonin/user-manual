# Demo Capture 现状审计与基线（2026-10-11）

> 对应《Living User Manual：统一 Demo 截图模式实施方案》P0。基线提交 `950bd06`（Demo 核心已在 `54490cd`、`96e9f7b` 落地），
> 本次补齐缺口后的状态见方案 §9 勾选与文末"剩余限制"。所有结论以代码为准，行号会随后续提交漂移。

## 1. 数据流（从打开页面到发布图）

```text
capture-page.capturePage / tasks/executor.executeCapturePlan / verify/live.verifyLive
  │  prepareScenarioData（scenarios/fixtures）→ mock 路由、Fixture 演示值、数据准备方式
  ▼
provider.installDemoGuard（browser/playwright）——在 goto 之前
  ├─ context.route：mock / pass / unverified / allow / authorized / suppress / block（privacy/demo.classifyRequest）
  ├─ context.routeWebSocket：未登记即关闭
  └─ newContext：serviceWorkers: block + 注册改为明确失败（init script）
  ▼
provider.open → 就绪等待 / 导航校验 / 身份断言
  ▼
evidence/capture-safe.captureStable
  ├─ applyDemo（privacy/demo-page.applyDemoInPage）：选择器 + data-redact 区域换成演示值（幂等）
  ├─ collectGeometry → resolveTargets（标注目标）→ collectSensitiveElements → screenshot → collectGeometry
  └─ auditDemo（只读）：残留 / 改回 / 联系方式 / 无法审计区域；DOM 计数必须与截图时刻一致
  ▼
derivePublished → demoGate（privacy/demo.decide）：passed / needs_fixture / blocked
  ├─ 未通过：抛 demo-blocked / demo-needs-fixture → 调用方 abort staging（原图、派生图都不留）
  │          → evidence/demo-gate-log 记原因码（generate 据此提示 demo-recapture-blocked）
  └─ 通过：planRedactions（只剩未声明的表单控件 / 凭据）→ layoutAnnotations → deriveImages（sanitized / published）
  ▼
captureStore.commit（privacy.demo：来源、规则命中、网络计数、realDataInBrowser）→ generate / verify
```

## 2. 审计问题与结论

| 维度 | 结论（文件 / 函数） |
|---|---|
| 截图管线 | 页面：`evidence/capture-page.capturePage`；任务：`tasks/executor.takeScreenshot`；在线验证：`verify/live.pageDrift`。三者都先 `installDemoGuard` 再 `open`。截图 → 门禁 → 遮罩 → 标注，顺序固定在 `capture-safe.derivePublished` |
| 大片棋盘格成因 | Demo 之前：`privacy/detector` 把 `data-redact` 区域（`explicit`）与正文手机号 / 邮箱（`text-pattern`）整块交给 `artifacts/redaction` 打 `neutral-mosaic`，历史会话栏因此整栏被盖。Demo 之后这两类交给门禁；剩余马赛克来源：未声明的表单控件、`privacy.rules.redact`、重新派生的旧证据 |
| Scenario / Fixture | `scenarios/fixtures`（mock / hook）、`scenarios/policy`（环境策略）；在 `installDemoGuard` 中随网络守卫一起安装 |
| 请求拦截 | `context.route` + `context.routeWebSocket`；Service Worker 在 Context 级屏蔽。基线缺口：GET 一律放行且不记录、Mock 只能同源、GraphQL 只能按路径登记 |
| 登录态 | `auth/cache`：storageState 存在项目外（0600），`refreshAuth` 在 Set-Cookie 时持久化；不进入 `.manual/` |
| 交互安全 | 网络层（`classifyRequest`）+ 动作层（`executor` 动作后 `drainBlockedWrites` → `demo-write-blocked`）双重保护；已授权写步骤开写入窗口 |
| 项目侵入 | Skill 只写 `.manual/` 与 `docs/`。基线缺口：文档要求在被采集项目中加 `data-redact`，与"不改目标项目"冲突 |
| 产物 | raw / sanitized / derivation / annotations 在 `.manual/artifacts`（不入库）；published 在 `docs/manual/images/annotated`；没有 HAR / trace 输出；失败现场图先审计再保存 |
| 校验 | `verify --artifacts` 输出 `demo_privacy` / `write_safety`；基线缺口：任务的状态在 Demo 判定前写入 |
| 命令兼容 | `capture.mode` 缺省即 demo，其他取值拒绝；无 CLI 参数变化 |

## 3. 本次补齐的缺口（D-1 ~ D-8）

| 编号 | 缺口 | 处理 |
|---|---|---|
| D-1 | 没有基线与量化手段 | 本文；`test/tools/demo-baseline.js`；`verify` 输出 `demo.metrics`；门禁失败原因码落盘（`evidence/demo-gate-log`） |
| D-2 | 依赖被采集项目加 `data-redact` | `capture.demo.selectors`（CSS 选择器），与 `data-redact` 等价，Fixture 也可声明 |
| D-3 | 未 Mock 的读取静默放行 | 数据请求（fetch / XHR / EventSource，含跨域）记为 `unverified`；有敏感区域时 `demo-unmocked-read` → needs_fixture；`network.allow` 可登记 GET 与 GraphQL `operationName`；Mock 支持跨域 `origin`；记录规则命中 / 未命中、`kinds`、`realDataInBrowser` |
| D-4 | Fixture 响应结构不校验 | JSON 必须可解析；可选 `shape`（必需字段、列表元素字段）；列表 id 唯一 |
| D-5 | SW / SSE / 无法审计区域 | Service Worker 注册明确失败（实测 `serviceWorkers: block` 仍可注册成功）；SSE 走 `unverified`；有敏感区域时 iframe / Canvas / Shadow DOM → `demo-surface-unaudited`，可用 `capture.demo.surfaces` 登记 |
| D-6 | 产物与 generate | 任务不派生发布图的截图也过门禁；generate 提示 `demo-evidence-legacy` / `demo-recapture-blocked`（可进 `quality.blockOn`）；verify 先判 Demo 再写任务状态 |
| D-7 | 残留马赛克 | 已换成演示值的输入框不再按表单控件打码；重新派生的旧证据标 `demo-evidence-legacy` |
| D-8 | 测试缺口 | `test/demo-capture.test.js` 新增 9 项、`test/demo-contract.test.js` 新增 6 项 |

## 4. 基线（本地测试站，视口 1000×700，DPR 1，audience: public）

`node test/tools/demo-baseline.js --legacy --cli <600e8eb 的 bin/manual.js>` 与 `node test/tools/demo-baseline.js` 的结果：

| 页面 | 改造前（600e8eb）结论 | 遮罩块 / 面积占比 | 现在结论 | 遮罩块 / 面积占比 | 数据来源 |
|---|---|---|---|---|---|
| 公开公告 | 发布 | 0 / 0 | 发布 | 0 / 0 | public |
| 历史会话 | 发布 | 5 / 2.54% | 发布 | 0 / 0 | public、dom_replace |
| 付款抽屉 | 发布 | 2 / 0.53% | 发布（蒙层逐像素保留） | 0 / 0 | public、dom_replace |
| 学生备注 | **发布**（只盖了声明区域，同一段私人文本在输入框里原样可见） | 1 / 2.89% | blocked（`original-value-leaked`） | — | — |
| 隐私表单 | 发布 | 1 / 0.17% | 发布 | 1 / 0.17% | public |
| 无 data-redact 的会话页 | **发布**（只有昵称输入框被盖，真实姓名与会话标题原样可见） | 1 / 0.10% | 发布（Skill 侧选择器替换） | 0 / 0 | public、dom_replace |

解读：

- 有演示值的页面马赛克面积降到 0，正常 UI 蒙层不受影响；隐私表单中未声明的手机号仍是精确小块遮罩（预期行为）。
- 改造前有两类页面会"带着真实数据发布"：私人文本在声明区域之外重复出现、页面根本没有声明。现在前者被阻断，后者可以在 Skill 侧声明后替换。
- 测试站数据，不代表 NeoAgent 真实页面；真实站点的前后对比需要在测试站重跑同一脚本的思路（见"待现场验证"）。

## 5. 剩余限制与待现场验证

- **待现场验证**：NeoAgent 测试站上历史会话、个人信息、订单 / 积分、抽屉页的前后对比与通过率；Linux CI 实跑结果（本地为 macOS）。
- **未做**：`capture.safety.persistRaw: false`（不保留私有原图）。原图是重新派生、标注修复的输入，多处读取方假定它存在；关闭它需要同时改重新派生与完整性校验，本次没有改动，私有原图仍在 `.manual/artifacts/raw`（不入库、不发布）。
- SSR 首屏中的真实值不单独阻断：进入画面的部分由替换与残留检查覆盖，`realDataInBrowser` 如实标记；需要"不读取真实数据"的保证只能用隔离账号 / 环境或 Fixture。
- 选择器只支持 CSS；没有声明、也不像手机号 / 邮箱的自由文本仍无法自动识别。
- 网络守卫只覆盖浏览器发出的请求；后端自身副作用不在范围内。
