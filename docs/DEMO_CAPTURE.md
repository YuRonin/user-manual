# Demo Capture：演示数据截图

截图只有一种数据模式：`capture.mode: demo`。浏览器打开的是**真实界面**，截图里的数据要么是公开内容，要么是可以证明为虚构的演示数据；证明不了的截图不会进入手册，也不会留下原图。

**这不等于"绝对安全"。** 系统只能证明它审计到的内容；无法审计的位置会在记录中如实标出（见文末"限制"）。

## 数据从哪里来

| 来源 | 适用内容 | 怎么声明 |
|---|---|---|
| `public` | 导航、按钮、公告、价格等公开内容 | 不需要声明，原样呈现 |
| `api_mock` | 列表、分页、订单、积分流水等结构化数据 | `.manual/fixtures/<id>.yaml`（`kind: mock`）+ 显式 Scenario |
| `dom_replace` | 昵称、手机号、会话标题等显示文本，以及头像 | 页面用 `data-redact="<键>"` 标出区域，`capture.demo.text` / `images` 给出演示值 |

每张通过门禁的截图都在 Capture 记录的 `privacy.demo` 里写明实际用到的来源：`sources: { public, api_mock, dom_replace }`，以及网络计数和无法审计的区域数量。记录里不会出现任何页面文本、请求体或查询串。

## 截图前后发生了什么

1. **打开页面之前**，安装网络守卫、Fixture 路由和演示值，并关闭 Service Worker（它的请求会绕过拦截）。
2. **页面稳定之后**，把每个 `data-redact` 区域替换成演示值。替换是幂等的：页面重渲染后会再替换一次。被换下来的原始值只保存在浏览器内存里，用于第 4 步的检查。
3. **截图。**
4. **只读审计**，并确认审计时的 DOM 和截图时一致。审计内容包括：
   - 每个声明区域是否仍是演示值；
   - 原始值是否还出现在页面其他可见位置，包括正文、输入框的值、空输入框的占位符、加载失败图片的 alt；
   - `data-redact` 之外是否有手机号或邮箱；
   - 是否有被中止的写请求，或未登记的 WebSocket。
5. **门禁判定**为 `passed`、`needs_fixture` 或 `blocked`。只有 `passed` 会继续生成发布图和标注；另外两种结果会中止本次采集，原图和派生图一起丢弃。

正常的界面遮罩（抽屉背景蒙层、弹窗遮罩）不是隐私处理，会原样保留。`data-redact` 区域换成演示值之后，也不再盖马赛克。只有表单控件里的手机号、邮箱和密码框，仍然按原规则做精确的小块遮罩。

## 配置演示值

在 `.manual/config.yaml` 中配置：

```yaml
capture:
  mode: demo
  demo:
    text:
      account-name: 演示教师
      account-phone: 138****0000
      # 数组：同一个键的第 1、2、3… 个元素依次取值，超出后循环
      session-title: ['七年级数学：一元一次方程复习', '八年级物理：浮力实验设计', '古诗词默写练习']
      # {n}：同一个键的第 n 个元素
      order-no: 'DEMO-2024-000{n}'
    images:
      account-avatar: initials   # 浅色圆底加首字；blank 为纯色占位
```

演示值只需要配置被采集项目已经声明过的 `data-redact` 键。门禁报错会列出所有缺失的键。

## 用 Fixture 提供数据

Fixture 接口返回的字符串本身就是虚构数据：页面上和它**完全相同**的 `data-redact` 内容会被直接认定为演示数据，不必再配演示值。这样列表、详情、分页之间的数据自然保持一致。

```yaml
# .manual/fixtures/history-demo.yaml
schemaVersion: 1
id: history-demo
version: 1
kind: mock
environments: [local]
sideEffectClass: none
mock:
  routes:
    - { path: /api/conversations, method: GET, json: { items: [{ id: demo-1, title: 示例会话：分数加减法 }] } }
    - { path: /api/conversations, method: GET, query: { page: '2' }, json: { items: [] } }   # query 中的参数必须完全相等
demo:
  text: { account-name: 演示教师 }   # 可选：补充或覆盖项目级演示值
```

再写一个显式 Scenario（`.manual/scenarios/<Scenario id>.yaml`），设置 `data: { mode: fixture, fixture: history-demo }`。Fixture 的环境策略保持不变：生产环境和未登记的 origin 一律拒绝。

接口的路径、方法、参数和字段结构必须以被采集项目的真实接口为准，不要凭猜测编造。结构不对时，界面看起来可能正常，实际却是错误状态。

## 网络与写操作

每个请求都会得到一个判定：

| 判定 | 条件 | 处理 |
|---|---|---|
| mock | 命中 Fixture 路由 | 返回静态响应，不碰后端 |
| pass | GET / HEAD / OPTIONS，且不在 `network.block` 中 | 放行 |
| allow | 登记在 `network.allow` 中、已确认无副作用的请求（查询类 POST、令牌刷新） | 放行 |
| authorized | 已获授权的任务写步骤（`writeAuthorization`）执行期间，发往授权站点的请求 | 放行 |
| suppress | 浏览器信标（`sendBeacon` / ping） | 直接回 204，不计入门禁 |
| block | 其余所有非只读请求，以及 `network.block` 命中的 GET | 在浏览器内中止 |

```yaml
capture:
  demo:
    network:
      allow:
        - { method: POST, path: /api/auth/refresh }
        - { method: POST, path: /api/search }
      block:
        - { method: GET, path: /api/logout }         # 有副作用的 GET
      websockets:
        - { path: /ws/notifications }                # 确认只读的 WebSocket；未登记的连接会被关闭
```

- **页面采集**：只要有写请求被中止，截图就判为 `blocked`（`write-blocked`），服务端不会收到这个请求。
- **任务采集**：动作触发了未授权的写请求时，步骤以 `demo-write-blocked` 失败，**不会把界面上的失败状态当作完成**。
- **"删除""支付""提交"类步骤**：要么经 `writeAuthorization` 在登记的测试环境里真实执行；要么用 Fixture 拦截写请求，**同时**拦截之后的读取请求，在浏览器内完整模拟；两者都做不到时，保持 `risk: write` / `destructive`，让流程停在动作之前。
- **`verify --live`**：回放时同样安装守卫（不装 Fixture 路由），只读步骤触发写请求也会被中止并记为失败。

## 排查 needs_fixture / blocked

采集失败的输出会带上原因码和建议：

| 原因码 | 结论 | 怎么做 |
|---|---|---|
| `demo-text-unconfigured` | needs_fixture | 为列出的键在 `capture.demo.text` 中配置演示值 |
| `demo-image-unconfigured` | needs_fixture | 在 `capture.demo.images` 中选 `initials` 或 `blank` |
| `demo-surface-unreplaceable` | needs_fixture | 区域是 Canvas、视频或嵌入框，无法替换：用 Fixture 提供数据，或把它拆到不截图的步骤 |
| `undeclared-sensitive-text` | needs_fixture | `data-redact` 之外出现了手机号或邮箱：用 Fixture 提供虚构数据（`example.com` 这类保留域名视为虚构） |
| `websocket-unverified` | needs_fixture | 确认只读后登记到 `network.websockets`，或用 Fixture 替代 |
| `original-value-leaked` | blocked | 替换下来的真实值还出现在别处（问候语、标题、输入框……）：用 Fixture 从数据源头替换 |
| `demo-replacement-reverted` | blocked | 页面持续重渲染，把演示值改回了真实值：用 `--wait-for` 等数据加载完，或用 Fixture 提供稳定数据 |
| `write-blocked` / `demo-write-blocked` | blocked | 确认请求无副作用后登记到 `network.allow`，否则用 Fixture 完整模拟 |
| `demo-guard-unavailable` | blocked | 当前 Browser Provider 不支持 Demo，改用 playwright |

`needs_fixture` 不是成功。没有通过门禁的页面或步骤，不会出现在正式手册里。

## 限制（请如实告知读者）

- 浏览器仍会从真实服务器加载页面，真实数据会进入浏览器内存（SSR 首屏 HTML、接口响应）。Demo 只保证**截图内容**经过审计，不等于数据隔离。需要数据隔离时，使用隔离的演示账号和测试环境，或用 Fixture 从源头提供数据。
- 原始值残留检查覆盖可见文本、表单值、空输入框的占位符和加载失败图片的 alt。`title`、`aria-*` 属性和页面标题不会出现在截图里，只记数量（`hiddenMatches`）。跨域 iframe、Canvas 和 Shadow DOM 无法审计，只在 `surfaces` 里记数量。
- 长度小于 2 的值，以及少于 4 位数字的短数字，不参与残留检查（误报太多）。
- 页面没有用 `data-redact` 声明、也没有被 Fixture 覆盖的自由文本，无法自动识别是否为隐私。正则没有命中**不代表安全**。公开手册中，登录后才能看到的页面，应该在被采集项目中声明敏感区域，或者改用 Fixture。
- 网络守卫只作用于浏览器发出的请求。后端自身的定时任务或副作用不在保护范围内，高风险业务请在隔离环境中验证。
