'use strict';

/*
 * 测试用的真实 HTTP 服务器。
 *
 * capture 的价值就在于「用真浏览器打开真页面」，所以测试也必须是真的：
 * 真服务器、真 Chromium、真 PNG。这里把各种页面形态都造出来，
 * 包括故意坏掉的那几种——失败路径比成功路径更需要被测到。
 */

const http = require('http');

/** 一张 1x1 的透明 PNG，用作即时加载的图片。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function html(body, head = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>测试页面</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 40px; background: #f8fafc; color: #0f172a; }
  h1 { font-size: 32px; }
  .spinner { width: 40px; height: 40px; border: 4px solid #cbd5e1; border-top-color: #0f172a;
             border-radius: 50%; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
${head}
</head>
<body>
${body}
</body>
</html>`;
}

/*
 * 运行态开关（P3-03 / P3-04）：不改源码、只改服务器行为，模拟"Git 无变化但线上变了"。
 *   editLabel   任务页"编辑资料"按钮的可访问名称（按钮改名）
 *   canEdit     权限接口 /api/permissions 与任务页是否提供编辑按钮（权限变化）
 *   benefit     当前权益文字（接口数据变化）
 *   clock       仪表盘时钟区域的文字（动态区域）
 *   shift       仪表盘主内容向下偏移的像素（布局移动）
 *   exportLabel 仪表盘导出按钮名称
 *   missing     返回 404 的路径（页面被下线）
 */
const DEFAULT_STATE = { suppressEditor: false, editLabel: '编辑资料', canEdit: true, benefit: '教师版', clock: '09:00', shift: 0, exportLabel: '导出报表', missing: [], draftPending: true };

const DYNAMIC = {
  // ---- B5 Scenario（test/scenario-states.test.js）：一次性前置数据（"待补充"会话被补完后消失）
  '/drafts': (state) => html(`
<h1>草稿箱</h1>
${state.draftPending ? '<p id="pending">待补充：七年级期中分析</p>' : '<p>没有待补充的会话</p>'}`),
  '/task-profile': (state) => html(`
<h1>个人中心</h1>
${state.canEdit ? `<button aria-label="${state.editLabel}" onclick="${state.suppressEditor ? '' : "document.getElementById('editor').hidden=false"}">${state.editLabel}</button>` : ''}
<button aria-label="学校权益" onclick="document.getElementById('benefits').hidden=false">学校权益</button>
<section id="editor" role="dialog" aria-label="编辑资料" style="margin-top:${Number(state.editorShift) || 0}px" hidden>
  <label for="nickname">昵称</label><input id="nickname" value="星河老师">
  <label for="phone">手机号</label><input id="phone" value="13812345678">
  <label for="profile-school">学校</label><input id="profile-school" value="星海中学">
  <p data-redact="session-title" aria-label="会话标题">七年级数学备课讨论</p>
  <button aria-label="保存修改">保存修改</button>
</section>
<section id="benefits" role="dialog" aria-label="学校权益" hidden>
  <label for="school">学校</label><input id="school" aria-label="学校" value="星海中学">
  <p>当前权益：${state.benefit}</p>
  <label for="benefit-option">可用选项</label><select id="benefit-option"><option>教师版</option><option>学校专业版</option></select>
  <p>不可切换原因：需要管理员授权</p>
  <button aria-label="切换权益">切换权益</button>
</section>`),
  '/dashboard': (state) => html(`
<div style="margin-top:${Number(state.shift) || 0}px">
<h1>数据看板</h1>
<p>本周新增用户 128 人。</p>
<button aria-label="${state.exportLabel}" style="padding:12px 24px;background:#2563eb;color:#fff;border:0;border-radius:6px">${state.exportLabel}</button>
</div>
<div id="clock" data-dynamic style="position:absolute;right:40px;top:40px;width:120px;height:40px;background:#e2e8f0;font-size:24px;text-align:center">${state.clock}</div>`),
};

const PAGES = {
  '/role-demo': html(`<h1>演示目标</h1><button class="private">私人说明甲</button><button class="private">私人说明甲</button>
<label>昵称<input aria-label="昵称" value="不应记录的值"></label><p>不应记录的正文</p>
<button aria-label="联系 person@private.org">联系</button><button>唯一入口</button>`),
  '/': html('<h1>首页</h1><p>Home</p>'),

  // 典型页面：有异步内容、有慢图片、有无限动画——三样都是截图不稳定的来源
  '/chat': html(`
<h1 id="title">工作台</h1>
<div class="spinner"></div>
<img id="fast" src="/img/fast.png" width="20" height="20" alt="fast">
<img id="slow" src="/img/slow.png" width="20" height="20" alt="slow">
<div id="async">加载中…</div>
<script>
  setTimeout(function () {
    document.getElementById('async').textContent = '异步内容已就绪';
  }, 400);
</script>`),

  // 内容来得很晚，用来验证等待策略不是「打开就截」
  '/slow': html(`
<h1>慢页面</h1>
<div id="late">尚未就绪</div>
<script>
  setTimeout(function () {
    document.getElementById('late').textContent = '迟到的内容';
    document.body.setAttribute('data-ready', 'true');
  }, 900);
</script>`),

  // body 里什么都没有：前端崩了的典型样子
  '/blank': '<!doctype html><html><head><title>空</title></head><body></body></html>',

  '/login': html(`
<h1>登录</h1>
<form>
  <input type="text" name="account" placeholder="账号">
  <input type="password" name="password" placeholder="密码">
  <button type="submit">登 录</button>
</form>`),

  // 隐私像素测试：视口内有手机号，页面很长、底部（视口外）还有邮箱
  '/privacy-page': html(`
<h1>通讯录</h1>
<p id="phone" style="background:#ff0000;color:#ff0000;display:inline-block">13812345678</p>
<div style="height:1600px"></div>
<p id="email" style="background:#ff0000;color:#ff0000;display:inline-block">teacher@example.com</p>`),

  // 被祖先 overflow 裁掉的表单控件不出现在像素里，不能在裁剪框外留下马赛克（横向滑屏卡片的离屏输入框）；
  // 绝对定位越过非包含块祖先的控件仍然可见，必须照常遮盖。
  '/privacy-clipped': html(`
<h1>滑屏卡片</h1>
<div id="viewport" style="width:300px;height:60px;overflow:hidden;background:#e2e8f0">
  <div style="display:flex;width:900px;transform:translateX(-300px)">
    <div style="width:300px;flex:none"><input id="offscreen-left" value="13900001111" style="background:#ff0000;color:#ff0000;border:0;font-size:16px;width:200px"></div>
    <div style="width:300px;flex:none"><input id="onscreen" value="13812345678" style="background:#ff0000;color:#ff0000;border:0;font-size:16px;width:200px"></div>
    <div style="width:300px;flex:none"><input id="offscreen-right" value="13600003333" style="background:#ff0000;color:#ff0000;border:0;font-size:16px;width:200px"></div>
  </div>
</div>
<div style="position:relative;height:120px">
  <div style="width:100px;height:20px;overflow:hidden">
    <input id="escaped" value="13700002222" style="position:absolute;left:0;top:60px;background:#ff0000;color:#ff0000;border:0;font-size:16px;width:200px">
  </div>
</div>`),

  // 表单控件里的手机号 / 邮箱：仍按原规则精确遮罩（Demo 门禁只接管 data-redact 区域与可见正文）
  '/privacy-form': html(`
<h1>通讯录</h1>
<input id="phone" value="13812345678" style="background:#ff0000;color:#ff0000;border:0;font-size:16px;width:200px">
<div style="height:1600px"></div>
<input id="email" value="teacher@example.com" style="background:#ff0000;color:#ff0000;border:0;font-size:16px;width:240px">`),

  // ---- Demo Capture（见 test/demo-capture.test.js）：真实数据经接口渲染，data-redact 声明敏感区域
  '/demo-history': html(`
<aside style="width:260px;float:left;background:#eef2f7;padding:12px">
  <p data-redact="account-name" id="account-name">王小明</p>
  <p data-redact="account-phone">13912345678</p>
  <ul id="history"></ul>
</aside>
<main style="margin-left:300px">
  <h1>历史会话</h1>
  <p id="notice">公开公告：本周六系统维护。</p>
  <button id="del">删除会话</button>
  <p id="status"></p>
</main>
<script>
  fetch('/api/demo/conversations').then((r) => r.json()).then((data) => {
    document.getElementById('history').innerHTML = data.items.map((item) => '<li><span data-redact="session-title">' + item.title + '</span></li>').join('');
  });
  document.getElementById('del').onclick = async () => {
    try { const r = await fetch('/api/demo/conversations/1', { method: 'DELETE' }); document.getElementById('status').textContent = r.ok ? '已删除' : '删除失败'; }
    catch (_) { document.getElementById('status').textContent = '删除失败'; }
  };
</script>`),
  // 原始值出现在 data-redact 之外（问候语）：替换了声明区域也不能发布
  '/demo-leak': html(`
<p data-redact="account-name">王小明</p>
<h1>欢迎回来，王小明</h1>`),
  // 不规则的私人文本：不像手机号 / 邮箱，正则识别不了；只能靠声明 + 原始值残留检查
  '/demo-note': html(`
<h1>学生档案</h1>
<p data-redact="student-note">该生数学基础薄弱，父母离异由祖母照顾，需要关注情绪变化</p>
<input id="note-copy" value="该生数学基础薄弱，父母离异由祖母照顾，需要关注情绪变化" style="width:600px">`),
  // 页面每次被改写都立刻恢复真实值：替换无法稳定
  '/demo-revert': html(`
<h1>个人中心</h1>
<p data-redact="account-name" id="name">王小明</p>
<script>
  const el = document.getElementById('name');
  new MutationObserver(() => { if (el.textContent !== '王小明') el.textContent = '王小明'; }).observe(el, { childList: true, characterData: true, subtree: true });
</script>`),
  '/demo-ws': html(`
<h1>实时课堂</h1>
<script>try { new WebSocket('ws://' + location.host + '/ws'); } catch (_) {}</script>`),
  '/demo-avatar': html(`
<h1>个人中心</h1>
<img data-redact="account-avatar" src="/img/fast.png" width="48" height="48" alt="头像">`),
  // 打开页面就发出写请求（自动保存 / 心跳）：默认被中止，登记放行后才到达服务端
  '/demo-autosave': html(`
<h1>草稿箱</h1>
<script>fetch('/api/demo/autosave', { method: 'POST', body: 'draft' }).catch(() => {});</script>`),
  '/demo-beacon': html(`
<h1>统计页</h1>
<script>navigator.sendBeacon('/api/demo/track', 'view');</script>`),
  // 正常 UI 遮罩（抽屉背景蒙层）与抽屉内的敏感字段
  '/demo-drawer': html(`
<h1>会员中心</h1>
<p>付款记录在右侧抽屉中查看。</p>
<div id="backdrop" style="position:fixed;inset:0;background:rgba(15,23,42,0.45)"></div>
<div role="dialog" aria-label="付款记录" style="position:fixed;top:0;right:0;bottom:0;width:360px;background:#ffffff;padding:24px">
  <h2>付款记录</h2>
  <p>订单号 <span data-redact="order-no">WX20240501883921</span></p>
  <p>付款人 <span data-redact="account-name">王小明</span></p>
</div>`),

  // ---- Demo Capture 补充（D-2 ~ D-8）
  // 公开公告页：没有敏感区域；公告来自读接口（只记录，不阻断），画面原样保留
  '/demo-announcement': html(`
<h1>系统公告</h1>
<p id="notice">公开公告：本周六 22:00 起系统维护两小时。</p>
<p id="extra"></p>
<script>fetch('/api/demo/announcements').then((r) => r.json()).then((d) => { document.getElementById('extra').textContent = d.text; });</script>`),
  // 页面没有任何 data-redact：敏感区域只靠 Skill 侧的 capture.demo.selectors 声明
  '/demo-selectors': html(`
<div class="user-card" style="width:260px;float:left;background:#eef2f7;padding:12px">
  <span class="name">王小明</span>
  <label for="nick">昵称</label><input id="nick" class="nickname" value="星河老师" style="width:200px">
  <ul class="history"><li class="title">期中成绩分析：李华</li><li class="title">家长沟通记录：张伟</li></ul>
</div>
<main style="margin-left:300px"><h1>历史会话</h1><button>新建会话</button></main>`),
  // 会话列表与个人资料来自两个接口：只 Mock 列表时，资料接口仍是未覆盖的真实数据来源
  '/demo-profile': html(`
<aside><span class="name" id="name"></span><ul id="list"></ul></aside>
<h1>历史会话</h1>
<script>
  fetch('/api/demo/profile').then((r) => r.json()).then((d) => { document.getElementById('name').textContent = d.name; });
  fetch('/api/demo/conversations').then((r) => r.json()).then((d) => {
    document.getElementById('list').innerHTML = d.items.map((i) => '<li class="title">' + i.title + '</li>').join('');
  });
</script>`),
  // 分页列表：Fixture 按 query 返回每一页的虚构订单
  '/demo-orders': html(`
<h1>付款记录</h1>
<ul id="orders"></ul>
<button id="next">下一页</button>
<script>
  let page = 1;
  const load = () => fetch('/api/demo/orders?page=' + page).then((r) => r.json()).then((d) => {
    document.getElementById('orders').innerHTML = d.items.map((i) => '<li><span class="order-no">' + i.no + '</span></li>').join('');
  });
  document.getElementById('next').onclick = () => { page++; load(); };
  load();
</script>`),
  '/demo-sse': html(`
<p data-redact="account-name">王小明</p>
<h1>实时通知</h1>
<script>try { new EventSource('/api/demo/events'); } catch (_) {}</script>`),
  // GraphQL：查询与修改走同一路径，只能按操作名区分
  '/demo-graphql': html(`
<h1>课程列表</h1>
<p id="courses"></p>
<script>
  fetch('/api/demo/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationName: 'ListCourses', query: 'query ListCourses { courses { title } }' }) })
    .then((r) => r.json()).then(() => { document.getElementById('courses').textContent = '七年级数学'; }).catch(() => {});
</script>`),
  // 跨域接口（localhost 与 127.0.0.1 不同源）：真实姓名经跨域读取进入声明区域
  '/demo-cross': (req) => html(`
<p data-redact="account-name" id="name">加载中</p>
<h1>个人中心</h1>
<script>
  fetch('http://localhost:${String(req.headers.host || '').split(':')[1]}/api/demo/profile').then((r) => r.json()).then((d) => { document.getElementById('name').textContent = d.name; });
</script>`),
  // Service Worker 注册结果写在页面上：Demo Context 必须阻止注册（它的请求不经过网络守卫）
  '/demo-sw': html(`
<h1>离线缓存</h1>
<p id="sw">pending</p>
<script>
  const el = document.getElementById('sw');
  if (!('serviceWorker' in navigator)) el.textContent = 'unavailable';
  else navigator.serviceWorker.register('/sw.js').then(() => { el.textContent = 'registered'; }, () => { el.textContent = 'rejected'; });
</script>`),

  // ---- B4 标注几何（test/annotation-golden.test.js）：sticky 顶栏、长页面深处的按钮、fixed 底栏里的手机号输入框
  '/layout-golden': `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>布局</title><style>
  body { margin: 0; font-family: sans-serif; background: #ffffff; }
  header { position: sticky; top: 0; height: 56px; background: #0f766e; }
  header button { position: absolute; left: 24px; top: 10px; width: 120px; height: 36px; background: #facc15; border: 0; }
  .spacer { height: 1100px; }
  #deep { display: block; margin-left: 300px; width: 160px; height: 48px; background: #1d4ed8; color: #fff; border: 0; }
  .tail { height: 600px; }
  footer { position: fixed; left: 0; right: 0; bottom: 0; height: 64px; background: #7c2d12; }
  footer button { position: absolute; right: 40px; top: 12px; width: 140px; height: 40px; background: #16a34a; border: 0; }
  footer input { position: absolute; left: 40px; top: 16px; width: 200px; height: 30px; background: #ffffff; border: 0; font-size: 16px; }
</style></head><body>
<header><button id="menu">菜单</button></header>
<div class="spacer"></div>
<button id="deep">深处按钮</button>
<div class="tail"></div>
<footer><label for="phone" style="display:none">手机号</label><input id="phone" value="13812345678"><button id="buy">立即购买</button></footer>
</body></html>`,
  // 7 个功能按钮的工具栏：单图最多 5 个标注，必须拆成两张图（AC-16）
  '/layout-dense': html(`
<h1>批改工具栏</h1>
<div style="display:grid;grid-template-columns:repeat(4,160px);gap:60px 80px;margin-top:40px">
${['新建', '导入', '导出', '分享', '打印', '归档', '删除'].map((name) => `<button style="height:40px">${name}</button>`).join('\n')}
</div>`),
  // ---- B5 Scenario 状态：标签页、下拉菜单、弹窗、悬停提示、自动消失的浮层
  '/scenario-ui': html(`
<h1>班级管理</h1>
<div role="tablist"><button role="tab" aria-selected="true" id="tab-a">成员</button><button role="tab" id="tab-b">账单</button></div>
<section id="panel-a" role="tabpanel" aria-label="成员">成员列表</section>
<section id="panel-b" role="tabpanel" aria-label="账单" hidden><button>下载账单</button></section>
<div style="margin-top:20px"><button id="more" aria-haspopup="menu">更多</button>
<ul role="menu" aria-label="更多操作" id="menu" hidden><li role="menuitem">导出名单</li><li role="menuitem">打印</li></ul></div>
<button id="create" style="margin-top:20px">新建班级</button>
<div role="dialog" aria-label="新建班级" id="dialog" hidden style="position:fixed;top:120px;left:300px;width:320px;padding:20px;background:#fff;border:1px solid #ccc">
  <label for="class-name">班级名称</label><input id="class-name"><button>创建</button></div>
<span id="help" style="display:inline-block;margin-top:20px;padding:4px">帮助</span>
<span role="tooltip" id="tip" style="visibility:hidden">查看帮助文档</span>
<button id="notice" style="margin-left:20px">通知</button>
<div id="toast" role="status" hidden>有 3 条新通知</div>
<script>
  document.getElementById('tab-b').onclick = () => { document.getElementById('panel-a').hidden = true; document.getElementById('panel-b').hidden = false; };
  document.getElementById('more').onclick = () => { document.getElementById('menu').hidden = false; };
  document.getElementById('create').onclick = () => { document.getElementById('dialog').hidden = false; };
  document.getElementById('help').onmouseenter = () => { document.getElementById('tip').style.visibility = 'visible'; };
  // 浮层打开后很快自己关闭：用来复现"截图之后状态不再成立"
  document.getElementById('notice').onclick = () => { const t = document.getElementById('toast'); t.hidden = false; setTimeout(() => { t.hidden = true; }, 150); };
</script>`),
  // 加载中状态：数据接口由 Fixture 延迟响应
  '/loading-report': html(`
<h1>月度报表</h1>
<div id="report" aria-busy="true">加载中…</div>
<script>fetch('/api/demo/report').then((r) => r.json()).then((d) => { const el = document.getElementById('report'); el.removeAttribute('aria-busy'); el.textContent = d.title; });</script>`),
  // 角色：只有管理员看得到"系统设置"（这里固定为普通成员视图）
  '/member-home': html('<h1>首页</h1><nav><a href="/member-home">我的课程</a></nav>'),

  // 状态码 200，但内容是「页面不存在」：软 404
  '/soft-404': html('<h1>页面不存在</h1><p>你访问的页面已被移除。</p><a href="/">返回首页</a>'),

  // 先渲染正常内容，300ms 后前端跳去登录：goto 时的 URL 还是原地址
  '/spa-redirect': html(`
<h1>工作台</h1>
<p>会话已过期，即将跳转。</p>
<script>setTimeout(function () { location.href = '/login'; }, 300);</script>`),

  // 加载永远不结束（语义标记 aria-busy）
  '/loading-forever': html('<h1>报表</h1><div aria-busy="true">加载中…</div>'),
  // 不确定进度条（没有当前值）= 仍在加载；确定进度条（带 aria-valuenow）是页面内容
  '/loading-progressbar': html('<h1>报表</h1><div role="progressbar" aria-label="加载报表" style="height:6px;width:200px;background:#ccc"></div>'),
  // 首屏以下的懒加载图片：整页截图不会把它滚进视口，必须在截图前改成立即加载（命中次数见 /img/lazy-hits）
  '/lazy-images': html(`<h1>帮助文章</h1><div style="height:2600px">很长的正文</div><img id="lazy" loading="lazy" src="/img/lazy.png" width="300" height="200" alt="懒加载截图">`),
  // 图片地址 404（例如帮助中心展示的截图还没由构建步骤生成）：截出来是空框，不能发布
  '/broken-image': html('<h1>帮助文章</h1><img src="/img/missing.png" width="300" height="200" alt="缺失的截图">'),
  '/static-progress': html('<h1>新手入门</h1><div role="progressbar" aria-label="入门进度" aria-valuenow="2" aria-valuemin="0" aria-valuemax="4" style="height:6px;background:#ccc"></div><p>2 / 4</p>'),

  // 渲染的是错误提示而不是正常内容
  '/error-state': html('<h1>报表</h1><div role="alert">加载失败，请稍后重试</div>'),

  '/public-with-password': html(`
<h1>账号设置</h1>
<p>这是一个已登录用户才能看到的设置页，内容很长，不该被误判成登录页。</p>
${'<p>设置项说明文字，用来把正文长度撑过登录页判据的阈值。</p>'.repeat(20)}
<form><input type="password" name="newPassword" placeholder="新密码"></form>`),
};

/**
 * 起一个测试服务器。
 * @returns {Promise<{ port, baseUrl, close }>}
 */
function startServer() {
  let lazyHits = 0;
  const state = { ...DEFAULT_STATE };
  const writes = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

    if ((state.missing || []).includes(pathname)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html('<h1>404 Not Found</h1>'));
      return;
    }
    // Demo 测试接口：读接口返回"真实"数据；任何写请求都记账，测试据此证明写请求没有到达服务端
    if (pathname.startsWith('/api/demo/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        writes.push(`${req.method} ${pathname}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      // 跨域读取（/demo-cross）需要 CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      if (pathname === '/api/demo/profile') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: '王小明', phone: '13912345678' }));
        return;
      }
      if (pathname === '/api/demo/announcements') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '新版作业批改功能已上线。' }));
        return;
      }
      if (pathname === '/api/demo/orders') {
        const page = url.searchParams.get('page') || '1';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ no: `WX2024050${page}883921` }] }));
        return;
      }
      if (pathname === '/api/demo/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.write('data: hello\n\n');
        setTimeout(() => res.end(), 200);
        return;
      }
      if (pathname === '/api/demo/conversations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ title: '王小明的期中成绩分析' }, { title: '家长沟通记录：李华' }] }));
        return;
      }
    }
    // 合法跳转：找回密码入口落到登录页的重置视图
    if (pathname === '/password-reset') {
      res.writeHead(302, { Location: '/login?view=reset' });
      res.end();
      return;
    }
    if (pathname === '/api/permissions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ canEdit: state.canEdit }));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(DYNAMIC, pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DYNAMIC[pathname](state));
      return;
    }
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript' });
      res.end("self.addEventListener('fetch', () => {});");
      return;
    }

    if (pathname === '/img/lazy.png') {
      lazyHits++;
      // 故意慢一点：不等图片加载完就截图的话，画面里只有空白占位
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(TINY_PNG);
      }, 800);
      return;
    }
    if (pathname === '/img/lazy-hits') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hits: lazyHits }));
      return;
    }

    if (pathname === '/img/fast.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }

    // 慢图片：验证 capture 会等图片加载完再截
    if (pathname === '/img/slow.png') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(TINY_PNG);
      }, 500);
      return;
    }

    if (pathname === '/protected') {
      const authenticated = String(req.headers.cookie || '').includes('manual_sid=cookie-secret');
      if (authenticated) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html('<h1>受保护页面</h1><p>Authenticated content</p>'));
      } else {
        res.writeHead(302, { Location: '/login' });
        res.end();
      }
      return;
    }

    if (pathname === '/error500') {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html('<h1>服务器错误</h1>'));
      return;
    }

    // 500，但页面上有正常的标题和按钮：不能因为"看起来正常"就放行
    if (pathname === '/error500-with-button') {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html('<h1>工作台</h1><button aria-label="发送">发送</button>'));
      return;
    }

    // 跳到另一个 origin（localhost 与 127.0.0.1 不同源）
    if (pathname === '/cross-origin') {
      const port = String(req.headers.host || '').split(':')[1];
      res.writeHead(302, { Location: `http://localhost:${port}/` });
      res.end();
      return;
    }

    // 挂起不响应：用来测导航超时
    if (pathname === '/hang') return;

    if (Object.prototype.hasOwnProperty.call(PAGES, pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(typeof PAGES[pathname] === 'function' ? PAGES[pathname](req) : PAGES[pathname]);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html('<h1>404 Not Found</h1>'));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        /** 修改运行态（不改源码）；reset() 恢复默认。 */
        set: (patch) => Object.assign(state, patch),
        reset: () => Object.assign(state, DEFAULT_STATE, { missing: [] }),
        state,
        /** 到达服务端的写请求（/api/demo/*）。 */
        writes,
        close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
      });
    });
  });
}

module.exports = { startServer, TINY_PNG };
