# Demo Capture：演示数据截图

截图只有一种数据模式：`capture.mode: demo`。浏览器打开的是**真实界面**，截图里的数据要么是公开内容，要么是可以证明为虚构的演示数据；证明不了的截图不会进入手册，也不会留下原图。

**这不等于"绝对安全"。** 系统只能证明它审计到的内容；无法审计的位置会在记录中如实标出（见文末"限制"）。

## 数据从哪里来

| 来源 | 适用内容 | 怎么声明 |
|---|---|---|
| `public` | 导航、按钮、公告、价格等公开内容 | 不需要声明，原样呈现 |
| `fixture` | 隔离测试环境里准备好的演示账号与数据 | `.manual/fixtures/<id>.yaml`（`kind: hook`）+ 显式 Scenario |
| `api_mock` | 列表、分页、订单、积分流水等结构化数据 | `.manual/fixtures/<id>.yaml`（`kind: mock`）+ 显式 Scenario |
| `dom_replace` | 昵称、手机号、会话标题等显示文本，以及头像 | 在 `capture.demo.selectors` 中按 CSS 选择器声明区域（推荐，被采集项目无需任何改动），`capture.demo.text` / `images` 给出演示值 |

**被采集项目的源码不需要改。** 敏感区域在 Skill 侧的 `capture.demo.selectors` 里按 CSS 选择器声明即可；如果项目自己愿意在元素上加 `data-redact="<键>"`，效果完全相同，两种方式可以混用。Fixture、演示值和规则都放在 `.manual/` 下（Skill 的受控目录），不写进项目源码、配置或数据库。

每张通过门禁的截图都在 Capture 记录的 `privacy.demo` 里写明：

- `sources: { public, fixture, api_mock, dom_replace }` 与 `kinds`（实际用到的来源类别）；
- `mock.routes`：每条 Fixture 路由的规则 ID（方法 + 路径）与命中次数，`mock.unhit` 列出声明了却没被请求的规则（Fixture 可能已过期）；
- `network`：Mock / 放行 / 已登记的读取 / 授权 / 信标 / 中止 / 未覆盖读取的次数；
- `realDataInBrowser`：真实数据是否曾进入浏览器（被替换下来的原始值、未 Mock 的读取）。为 `true` 时，画面已经证明安全，但不能宣称"没有读取真实数据"；
- 无法审计的区域数量。

记录里不会出现任何页面文本、请求体或查询串。

## 截图前后发生了什么

1. **打开页面之前**，安装网络守卫、Fixture 路由和演示值，并关闭 Service Worker（它的请求会绕过拦截）。
2. **页面稳定之后**，把每个敏感区域（`capture.demo.selectors` 命中的元素和 `data-redact` 元素）替换成演示值。选择器每次都重新查询，SPA 重渲染换掉元素后依然命中。替换是幂等的：页面重渲染后会再替换一次。被换下来的原始值只保存在浏览器内存里，用于第 4 步的检查。
3. **截图。**
4. **只读审计**，并确认审计时的 DOM 和截图时一致。审计内容包括：
   - 每个声明区域是否仍是演示值；
   - 原始值是否还出现在页面其他可见位置，包括正文、输入框的值、空输入框的占位符、加载失败图片的 alt；
   - 敏感区域之外是否有手机号或邮箱；
   - 是否有被中止的写请求，或未登记的 WebSocket；
   - 页面声明了敏感区域时：是否有没被 Fixture 覆盖、也没有登记的数据读取（fetch / XHR / EventSource，含跨域），以及跨域 iframe、Canvas、Shadow DOM 等无法审计的区域。
5. **门禁判定**为 `passed`、`needs_fixture` 或 `blocked`。只有 `passed` 会继续生成发布图和标注；另外两种结果会中止本次采集，原图和派生图一起丢弃。

正常的界面遮罩（抽屉背景蒙层、弹窗遮罩）不是隐私处理，会原样保留。敏感区域换成演示值之后（包括被选择器命中的输入框），也不再盖马赛克。只有没有声明的表单控件里的手机号、邮箱、密码框和姓名类字段，仍然按原规则做精确的小块遮罩。

门禁失败时没有 Capture 记录，原因码单独记在 `.manual/evidence/demo-gate/<主体>.json`（只有原因码与时间，没有页面内容），同一主体之后采集成功即删除。`generate` 据此提示 `demo-recapture-blocked`：最近一次重新采集被阻断，手册仍在使用旧截图。

## 配置演示值

在 `.manual/config.yaml` 中配置：

```yaml
capture:
  mode: demo
  demo:
    selectors:                    # 键 → CSS 选择器；命中的元素就是敏感区域（与 data-redact="<键>" 等价）
      account-name: '.sidebar .user-name'
      account-phone: '.profile-card .phone'
      session-title: '.history-list li .title'
      account-avatar: '.sidebar img.avatar'
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

每个键都需要演示值（文本键在 `text`，图片键在 `images`），或者来自 Fixture 的数据（见下一节）。门禁报错会列出所有缺失的键。选择器只支持 CSS；写错的选择器会以 `demo-selector-invalid` 停在 needs_fixture。

不确定选择器时，在浏览器开发者工具里对目标元素"复制选择器"，再去掉其中随构建变化的部分（哈希类名、`nth-child` 序号）。

## 用 Fixture 提供数据

Fixture 接口返回的字符串本身就是虚构数据：页面上和它**完全相同**的敏感区域内容会被直接认定为演示数据，不必再配演示值。这样列表、详情、分页之间的数据自然保持一致。

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
    - { origin: 'https://api.example.com', path: /v1/me, method: GET, json: { name: 演示教师 } }   # origin：拦截跨域接口
    - path: /api/orders
      method: GET
      json: { items: [{ id: o-1, no: DEMO-0001, amount: 99 }], total: 1 }
      # shape：按真实接口声明响应结构，登记时校验；缺字段、列表元素不完整、id 重复都会拒绝使用这个 Fixture
      shape: { required: [items, total], items: { field: items, required: [id, no, amount] } }
demo:
  text: { account-name: 演示教师 }   # 可选：补充或覆盖项目级演示值
  selectors: { account-name: '.user-card .name' }
```

JSON 响应体（`json`，或 `contentType` 为 JSON 的 `body` / `bodyFile`）在登记时必须能解析；列表元素带 `id` 时必须唯一，分页结果才能前后一致。

再写一个显式 Scenario（`.manual/scenarios/<Scenario id>.yaml`），设置 `data: { mode: fixture, fixture: history-demo }`。Fixture 的环境策略保持不变：生产环境和未登记的 origin 一律拒绝。

接口的路径、方法、参数和字段结构必须以被采集项目的真实接口为准，不要凭猜测编造。结构不对时，界面看起来可能正常，实际却是错误状态。

## 网络与写操作

每个请求都会得到一个判定：

| 判定 | 条件 | 处理 |
|---|---|---|
| mock | 命中 Fixture 路由 | 返回静态响应，不碰后端 |
| pass | 只读的静态资源（文档、脚本、样式、图片、字体）与 OPTIONS 预检，且不在 `network.block` 中 | 放行 |
| unverified | 只读的数据请求（fetch / XHR / EventSource，含跨域），既没有 Fixture 也没有登记 | 放行但逐条记录方法与路径；页面声明了敏感区域时门禁判 `needs_fixture`（`demo-unmocked-read`） |
| allow | 登记在 `network.allow` 中的请求：已审阅的只读数据接口，或已确认无副作用的非只读请求（查询类 POST、令牌刷新；GraphQL 可按 `operationName` 精确登记） | 放行 |
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
        - { method: GET, path: /api/announcements }                     # 已审阅：只返回公开数据
        - { method: POST, path: /graphql, operationName: ListCourses }  # 同一路径的其它操作仍按写请求中止
      block:
        - { method: GET, path: /api/logout }         # 有副作用的 GET
      websockets:
        - { path: /ws/notifications }                # 确认只读的 WebSocket；未登记的连接会被关闭
```

- **数据读取**：页面声明了敏感区域时，每个数据接口都要有着落：用 Fixture 返回虚构数据（推荐），或者确认接口只返回公开数据、或其内容全部落在已声明的区域里之后登记到 `network.allow`。没有敏感区域的公开页面只记录，不阻断。
- **页面采集**：只要有写请求被中止，截图就判为 `blocked`（`write-blocked`），服务端不会收到这个请求。
- **任务采集**：动作触发了未授权的写请求时，步骤以 `demo-write-blocked` 失败，**不会把界面上的失败状态当作完成**。
- **"删除""支付""提交"类步骤**：要么经 `writeAuthorization` 在登记的测试环境里真实执行；要么用 Fixture 拦截写请求，**同时**拦截之后的读取请求，在浏览器内完整模拟；两者都做不到时，保持 `risk: write` / `destructive`，让流程停在动作之前。
- **`verify --live`**：回放时同样安装守卫（不装 Fixture 路由），只读步骤触发写请求也会被中止并记为失败。

## verify 中的 Demo 结果

`manual verify`（离线产物验证）在输出与报告中给出独立于标注覆盖率的 `demo` 字段：

- `demo_privacy`：手册引用的截图有多少通过了 Demo 门禁（`passed`）；采集于 Demo 模式之前的旧证据记为 `legacy`（沿用旧遮罩规则，只提示、不判失败）；并汇总数据来源（`api_mock` / `dom_replace`）与无法审计区域数量。
- `write_safety`：这些截图采集期间的网络计数（Mock / 放行 / 授权 / 信标），被中止的写请求必须为 0。

- `metrics`：可量化指标，用来跟踪改造效果与 Fixture 健康度：
  - `maskedArea`：每张图被遮罩的面积占比上界（平均值、最大值、超过 15% 的张数）；
  - `mock`：Fixture 规则数、命中次数、未命中的规则；
  - `uncoveredReads`：未覆盖的数据读取次数（只可能出现在没有敏感区域的页面上）；
  - `realDataInBrowser`：真实数据曾进入浏览器的截图数；
  - `gateFailures`：这份手册涉及的主体中，最近一次采集被门禁阻断的数量与原因码分布。

记录显示门禁未通过或有写请求被中止时，`verify` 以 `demo-privacy-failed` / `write-safety-failed` 失败；任务的状态在 Demo 结果通过之后才写入。

`generate` 的质量提示里也会出现 Demo 状态：`demo-evidence-legacy`（采集于 Demo 模式之前、带旧马赛克的图）与 `demo-recapture-blocked`（之后的重新采集被门禁阻断）。两者都可以加入 `quality.blockOn` 升级为阻断。

## 排查 needs_fixture / blocked

采集失败的输出会带上原因码和建议：

| 原因码 | 结论 | 怎么做 |
|---|---|---|
| `demo-text-unconfigured` | needs_fixture | 为列出的键在 `capture.demo.text` 中配置演示值 |
| `demo-image-unconfigured` | needs_fixture | 在 `capture.demo.images` 中选 `initials` 或 `blank` |
| `demo-surface-unreplaceable` | needs_fixture | 区域是 Canvas、视频或嵌入框，无法替换：用 Fixture 提供数据，或把它拆到不截图的步骤 |
| `demo-selector-invalid` | needs_fixture | `capture.demo.selectors` 中的选择器无法解析：改成合法的 CSS 选择器 |
| `undeclared-sensitive-text` | needs_fixture | 敏感区域之外出现了手机号或邮箱：把它所在的元素加进 `capture.demo.selectors`，或用 Fixture 提供虚构数据（`example.com` 这类保留域名视为虚构） |
| `demo-unmocked-read` | needs_fixture | 列出的数据接口没有 Fixture 也没有登记：为它写 Fixture；确认只返回公开数据（或内容全部落在已声明区域）后登记到 `network.allow`。跨域接口标 `cross-origin`，事件流标 `stream` |
| `demo-surface-unaudited` | needs_fixture | 页面有跨域 iframe、Canvas 或 Shadow DOM，内容无法审计：确认其中没有真实数据后登记到 `capture.demo.surfaces`，或用 Fixture 替代 |
| `websocket-unverified` | needs_fixture | 确认只读后登记到 `network.websockets`，或用 Fixture 替代 |
| `original-value-leaked` | blocked | 替换下来的真实值还出现在别处（问候语、标题、输入框……）：把那处也加进 `capture.demo.selectors`，或用 Fixture 从数据源头替换 |
| `demo-replacement-reverted` | blocked | 页面持续重渲染，把演示值改回了真实值：用 `--wait-for` 等数据加载完，或用 Fixture 提供稳定数据 |
| `write-blocked` / `demo-write-blocked` | blocked | 确认请求无副作用后登记到 `network.allow`，否则用 Fixture 完整模拟 |
| `demo-guard-unavailable` | blocked | 当前 Browser Provider 不支持 Demo，改用 playwright |

`needs_fixture` 不是成功。没有通过门禁的页面或步骤，不会出现在正式手册里。

## 限制（请如实告知读者）

- 浏览器仍会从真实服务器加载页面，真实数据可能进入浏览器内存（SSR 首屏 HTML、已登记的接口响应）。Demo 只保证**截图内容**经过审计，不等于数据隔离；记录中的 `realDataInBrowser` 如实标出这种情况。需要数据隔离时，使用隔离的演示账号和测试环境，或用 Fixture 从源头提供数据。
- SSR 首屏 HTML 中的真实值不会被单独阻断：它们进入画面的部分已由替换与残留检查覆盖；不进入画面的部分（如页面内联的数据脚本）不在截图里。私有原图（`.manual/artifacts/raw`）是替换之后的画面，但未声明的表单控件值只在发布图中遮罩，原图里仍是原样；该目录不入库、不发布。
- 原始值残留检查覆盖可见文本、表单值、空输入框的占位符和加载失败图片的 alt。`title`、`aria-*` 属性和页面标题不会出现在截图里，只记数量（`hiddenMatches`）。跨域 iframe、Canvas 和 Shadow DOM 无法审计：页面声明了敏感区域时它们会让门禁停在 needs_fixture（`demo-surface-unaudited`），除非登记在 `capture.demo.surfaces`。
- 长度小于 2 的值，以及少于 4 位数字的短数字，不参与残留检查（误报太多）。
- 没有被声明（选择器或 `data-redact`）、也没有被 Fixture 覆盖的自由文本，无法自动识别是否为隐私。正则没有命中**不代表安全**。公开手册中，登录后才能看到的页面，应该在 `capture.demo.selectors` 中声明敏感区域，或者改用 Fixture。
- 选择器只支持 CSS，不支持按角色 / 可访问名称声明。
- 页面没有任何敏感区域声明时，未覆盖的数据读取只记录、不阻断（否则所有调用接口的公开页面都无法截图）。
- 网络守卫只作用于浏览器发出的请求。后端自身的定时任务或副作用不在保护范围内，高风险业务请在隔离环境中验证。
