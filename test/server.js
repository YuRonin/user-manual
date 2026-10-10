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
const DEFAULT_STATE = { editLabel: '编辑资料', canEdit: true, benefit: '教师版', clock: '09:00', shift: 0, exportLabel: '导出报表', missing: [] };

const DYNAMIC = {
  '/task-profile': (state) => html(`
<h1>个人中心</h1>
${state.canEdit ? `<button aria-label="${state.editLabel}" onclick="document.getElementById('editor').hidden=false">${state.editLabel}</button>` : ''}
<button aria-label="学校权益" onclick="document.getElementById('benefits').hidden=false">学校权益</button>
<section id="editor" role="dialog" aria-label="编辑资料" hidden>
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

  // 状态码 200，但内容是「页面不存在」：软 404
  '/soft-404': html('<h1>页面不存在</h1><p>你访问的页面已被移除。</p><a href="/">返回首页</a>'),

  // 先渲染正常内容，300ms 后前端跳去登录：goto 时的 URL 还是原地址
  '/spa-redirect': html(`
<h1>工作台</h1>
<p>会话已过期，即将跳转。</p>
<script>setTimeout(function () { location.href = '/login'; }, 300);</script>`),

  // 加载永远不结束（语义标记 aria-busy）
  '/loading-forever': html('<h1>报表</h1><div aria-busy="true">加载中…</div>'),

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
      if (pathname === '/api/demo/conversations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ items: [{ title: '王小明的期中成绩分析' }, { title: '家长沟通记录：李华' }] }));
        return;
      }
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
      res.end(PAGES[pathname]);
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
