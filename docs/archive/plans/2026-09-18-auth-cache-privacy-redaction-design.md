# Auth Cache 与精准隐私脱敏设计

日期：2026-09-18

## 背景

Living User Manual 在真实项目中执行截图时，受保护页面需要登录。当前实现没有持久化浏览器认证状态，代理只能临时编写一次性登录脚本，重复执行成本高，也容易形成不一致的认证处理。

任务截图已经通过 Playwright 获取 DOM 元素坐标，但隐私候选收集范围较宽，并对整个元素绘制深色不透明矩形。实际产物中出现了输入框整块遮盖、已脱敏内容再次遮盖，以及非敏感字段被遮盖的问题。最终手册通常公开给外部用户，因此不能直接移除隐私保护，而应提高识别精度并改善视觉表现。

## 目标

- 用户只需在可见浏览器中完成一次登录，后续截图自动复用 cookies 与 localStorage 登录状态。
- 登录状态可跨同一项目的 Git worktree 复用，并支持多个账号或角色。
- 认证值不进入项目目录、Git、日志、manifest 或正式手册。
- 初始化时记录手册面向外部公开还是仅内部使用，并据此选择隐私策略。
- 公开手册默认执行可靠脱敏，同时减少误伤和过度遮盖。
- 遮罩只覆盖敏感内容本身，使用不可逆的浅色合成马赛克代替黑色块。
- 任何旧配置在缺少新增字段时仍可读取并保持现有行为。

## 非目标

- 第一版不复用完整 Chromium 用户目录。
- 第一版不解决数据库 Fixture、复杂多角色数据预置或验证码自动破解。
- 第一版不把普通高斯模糊作为公开手册的安全脱敏方式。
- 第一版不强制接入跨平台系统凭据库；先通过用户级缓存目录、文件权限和禁止输出降低泄露风险。

## 方案比较

### 方案一：单一 Playwright storageState

只保存一个 `storageState` 文件，开发成本最低，但账号切换、状态检查、清理和跨项目隔离能力不足。

### 方案二：命名 Auth Profile 与策略化精准脱敏

按项目缓存键和 Profile 保存认证状态，提供登录、状态检查和清理命令；隐私处理分为检测、坐标和渲染三层。该方案兼顾可维护性、安全性和使用体验，是本设计采用的方案。

### 方案三：持久化 Chromium 用户目录

能保留更完整的浏览器状态，但目录大、可能被浏览器锁定、包含无关历史与缓存，并降低截图确定性，不采用。

## 初始化与配置

`manual init` 增加“手册发布范围”问题，并通过 CLI 参数写入配置。建议配置形状如下：

```yaml
privacy:
  audience: public
  redaction: balanced
  maskStyle: neutral-mosaic
  rules:
    redact: []
    preserve: []

auth:
  enabled: true
  cacheKey: neoagent-test
  activeProfile: default
  loginUrl: /login
  verifyPath: /user-center
```

`privacy.audience` 支持：

- `public`：面向外部发布，默认保护个人标识和所有高风险认证信息。
- `internal`：允许通过项目规则保留昵称、学校等普通字段，但仍强制保护 token、密码、完整手机号和邮箱等高风险内容。

`auth.cacheKey` 在项目配置中稳定保存，因此同一配置复制到不同 worktree 后仍指向同一份认证缓存。缓存键需经过安全名称校验，不允许路径穿越。

新增字段保持可选。读取旧配置时补充默认值，不提升配置版本；只有旧配置无法被新代码直接理解时才提升版本。

## Auth Cache

### 存储位置

认证状态不放在项目的 `.manual/session/`，因为该目录随 worktree 分离，无法解决重复登录问题。真正的状态保存在操作系统用户级缓存目录。例如 Windows：

```text
%LOCALAPPDATA%/living-user-manual/auth/<cacheKey>/<profile>.state
```

其它平台使用各自的用户缓存目录。项目中只保存缓存引用，不保存认证值。

缓存文件使用临时文件加原子替换写入，并尽可能限制为当前系统用户可读。任何日志、JSON 输出和错误消息都不得包含缓存内容。

### 命名 Profile

CLI 提供：

```text
manual auth login --profile default
manual auth status --profile default
manual auth clear --profile default
manual auth login --profile teacher
```

Profile 用于隔离不同账号、角色或环境。未指定时使用 `auth.activeProfile`。

### 登录流程

```text
manual auth login
  → 启动可见 Chromium
  → 打开 loginUrl 或项目 baseUrl
  → 用户手动完成登录
  → 验证 verifyPath 不再重定向至登录页
  → 导出 cookies 与 localStorage
  → 原子保存到用户级缓存
```

Playwright `storageState` 覆盖 cookies 与 localStorage。若具体项目依赖 sessionStorage 或额外浏览器存储，后续通过 Provider 扩展处理，不扩大第一版范围。

### 截图流程

```text
capture / capture-task
  → 根据 cacheKey 与 activeProfile 读取认证状态
  → 使用状态创建 BrowserContext
  → 打开目标页面并验证未进入登录页
  → 执行任务、截图和脱敏
  → 认证仍有效时保存刷新后的 cookies 与 localStorage
```

公开页面在缓存不存在时仍可正常截图。需要登录的页面返回明确错误：

- `auth-missing`：尚未创建认证缓存。
- `auth-expired`：缓存存在，但页面重新进入登录流程。
- `auth-corrupt`：缓存无法解析或结构不合法。

错误消息给出固定恢复命令，不再建议临时编写登录脚本。

缓存损坏时隔离原文件并要求重新登录。刷新后的状态保存失败只产生 warning，不使已完成的截图失败。只有确认当前页面仍处于认证状态时才更新缓存。

## 隐私策略

### 识别层级

隐私检测按可信度和风险分层：

1. 强制脱敏：密码、token、完整手机号、邮箱、账号 ID，以及 `[data-manual-redact]` 明确标记的内容。
2. 项目规则：按 selector、字段 label、属性和页面范围配置的 `redact` 规则。
3. 模糊个人字段：姓名、昵称、学校等。`public` 模式默认保护；明确的安全演示数据可由规则保留。
4. 已脱敏显示值：如 `134****1255`，不再次覆盖。

高风险强制规则优先于普通 `preserve`。配置冲突在采集前报告。manifest 只记录脱敏种类、来源类别和矩形，不保存命中的原始文字。

### 精准坐标

当前实现对整个 input 或元素调用 `getBoundingClientRect()`，导致遮罩范围过大。新实现按内容类型计算：

- 普通文本节点：用 DOM `Range.getBoundingClientRect()` 获取文字本身边界。
- input/textarea：读取字体、padding、border 和 line-height，计算值文本区域，不遮住控件外框。
- 明确要求遮住整个组件时：使用元素完整边界。
- 页面滚动时：统一坐标系并裁剪到当前截图范围。
- 重叠候选：去重，仅在同一敏感内容的相邻矩形间做有限合并。
- DPR：DOM 中保持 CSS 像素；若进入图片后处理，再依据截图元数据转换为图片像素。

坐标为空、越界或无法稳定解析时，公开模式不得静默生成正式产物。

### 遮罩视觉

公开模式默认使用 `neutral-mosaic`：

- 先以完全不透明的浅灰或品牌浅色覆盖原始内容。
- 在覆盖层上绘制与原始像素无关的细小格纹。
- 使用与文字或控件协调的圆角和最小宽度。
- 不从原始图像采样，因此无法通过马赛克反推内容。

普通 blur 会保留原始轮廓，不允许作为 `public` 模式的最终发布样式。可以保留 `soft-solid` 作为可选的安全样式。

## 产物与发布边界

```text
.manual/artifacts/raw/         原始截图，本地敏感产物
.manual/artifacts/sanitized/   已脱敏中间图
docs/manual/images/annotated/  已脱敏并标注，可公开发布
```

正式 Markdown 只能引用 annotated 图片。raw、sanitized、诊断图和认证缓存均不得被正式文档引用或提交。高风险内容无法可靠定位时阻止发布；普通模糊字段默认安全遮盖，避免频繁中断。

## 组件职责

```text
src/auth/cache.js          缓存键、路径、读取、原子保存和删除
src/auth/session.js        登录、验证、过期判断和刷新
src/commands/auth.js       login/status/clear CLI
src/privacy/detector.js    隐私候选与置信度判断
src/privacy/geometry.js    文字级矩形、裁剪、去重和合并
src/privacy/renderer.js    neutral-mosaic 与安全样式渲染
```

Playwright Provider 负责加载和导出浏览器状态、收集 DOM 事实以及渲染覆盖层；是否敏感、是否允许发布由上层策略决定。Provider 不承担项目业务语义判断。

## 错误处理

- 缓存不存在、过期或损坏时给出分类错误和固定恢复命令。
- 不在任何异常对象、调试输出或 manifest 中附带认证值和敏感原文。
- 认证刷新写入失败不破坏旧缓存。
- 隐私坐标异常时保留本地诊断信息，但诊断图继续视为原始敏感产物。
- `public` 模式发现高风险信息却无法安全处理时停止发布。
- 已成功生成的 raw 图不能因为后续脱敏失败而被误当成可发布图片。

## 测试设计

### Auth Cache

- HTTP-only cookie 与 localStorage token 可跨命令复用。
- 同一配置可跨 worktree 命中相同缓存。
- 不同 cacheKey 和 Profile 相互隔离。
- 登录过期、缓存损坏、清理和刷新状态行为正确。
- 原子写入失败时保留旧缓存。
- stdout、stderr、JSON 输出和 manifest 不包含认证值。

### 隐私处理

- DPR 1 与 2 下普通文字和 input 值的矩形正确。
- 页面滚动、视口裁剪和重叠元素去重正确。
- 已脱敏手机号不会重复处理。
- 显式 redact、preserve 和强制规则优先级正确。
- `neutral-mosaic` 使用黄金图验证视觉结果。
- `public` 模式拒绝 raw、sanitized 和普通 blur 进入正式文档。
- 无法定位的高风险内容会阻止发布。

### 兼容性

- 旧配置不含 `auth` 或 `privacy` 时仍可读取。
- 不需要登录的页面保持现有 capture 行为。
- 现有任务采集、标注、生成和 verify 流程继续通过。

## 实施顺序

1. 扩展配置、初始化参数与 Skill 提问。
2. 实现用户级 Auth Cache 与命名 Profile CLI。
3. 将认证状态接入 Playwright context、capture 和 capture-task。
4. 将现有 redaction 拆成 detector、geometry 和 renderer。
5. 实现内容级坐标与 `neutral-mosaic`。
6. 加强发布校验和敏感数据不落盘约束。
7. 补齐单元、集成、黄金图和向后兼容测试。
