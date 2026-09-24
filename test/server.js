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

const PAGES = {
  '/task-profile': html(`
<h1>个人中心</h1>
<button aria-label="编辑资料" onclick="document.getElementById('editor').hidden=false">编辑资料</button>
<button aria-label="学校权益" onclick="document.getElementById('benefits').hidden=false">学校权益</button>
<section id="editor" role="dialog" aria-label="编辑资料" hidden>
  <label for="nickname">昵称</label><input id="nickname" value="星河老师">
  <label for="phone">手机号</label><input id="phone" value="13812345678">
  <label for="profile-school">学校</label><input id="profile-school" value="星海中学">
  <p data-redact aria-label="会话标题">七年级数学备课讨论</p>
  <button aria-label="保存修改">保存修改</button>
</section>
<section id="benefits" role="dialog" aria-label="学校权益" hidden>
  <label for="school">学校</label><input id="school" aria-label="学校" value="星海中学">
  <p>当前权益：教师版</p>
  <label for="benefit-option">可用选项</label><select id="benefit-option"><option>教师版</option><option>学校专业版</option></select>
  <p>不可切换原因：需要管理员授权</p>
  <button aria-label="切换权益">切换权益</button>
</section>`),
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
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;

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
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

module.exports = { startServer, TINY_PNG };
