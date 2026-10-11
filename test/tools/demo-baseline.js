'use strict';

/*
 * Demo Capture 基线测量（Demo 方案 P0 / §7 "必须给出的客观数据"）。不在 test/run.js 中，手动运行：
 *
 *   node test/tools/demo-baseline.js [--cli <bin/manual.js>] [--legacy]
 *
 * 用本地测试站的代表页面（公开公告、历史会话、付款抽屉、学生备注、隐私表单、Skill 侧选择器）各采集一次，输出：
 *   门禁结论 / 原因码、发布图遮罩块数、遮罩面积占视口比例、数据来源。
 * --legacy：被测 CLI 是 Demo 模式之前的版本（不写 capture.demo），用来得到改造前的遮罩面积。
 * 只输出计数与比例，不输出页面文本。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const fx = require('../fixtures');
const { startServer } = require('../server');

const argv = process.argv.slice(2);
const cliAt = argv.indexOf('--cli');
const CLI = path.resolve(cliAt >= 0 ? argv[cliAt + 1] : path.join(__dirname, '..', '..', 'bin', 'manual.js'));
const LEGACY = argv.includes('--legacy');
const VIEWPORT = { width: 1000, height: 700 };

const HISTORY_TEXT = { 'account-name': '演示教师', 'account-phone': '138****0000', 'session-title': ['七年级数学：一元一次方程复习', '八年级物理：浮力实验设计'] };
const PAGES = [
  { id: 'announcement', path: '/demo-announcement', demo: {} },
  { id: 'history', path: '/demo-history', demo: { text: HISTORY_TEXT, network: { allow: [{ method: 'GET', path: '/api/demo/conversations' }] } } },
  { id: 'drawer', path: '/demo-drawer', demo: { text: { 'order-no': 'DEMO-2024-0001', 'account-name': '演示教师' } } },
  { id: 'student-note', path: '/demo-note', demo: { text: { 'student-note': '该生课堂表现积极，建议加强计算练习' } } },
  { id: 'privacy-form', path: '/privacy-form', demo: {} },
  { id: 'selectors', path: '/demo-selectors', demo: {
    selectors: { 'account-name': '.user-card .name', nickname: 'input.nickname', 'session-title': '.history .title' },
    text: { 'account-name': '演示教师', nickname: '示例昵称', 'session-title': ['示例会话 {n}'] },
  } },
];

// 测试站与 CLI 在同一个事件循环里：必须异步等待子进程，否则服务器无法响应
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => {
      let json = null;
      try { json = JSON.parse(stdout); } catch (_) { json = null; }
      resolve({ status, json, stderr });
    });
  });
}

(async () => {
  const server = await startServer();
  const rows = [];
  try {
    for (const page of PAGES) {
      const root = fx.captureFixture();
      try {
        let r = await run(['init', '--project-root', root, '--base-url', server.baseUrl, '--profile', 'custom', '--viewport', `${VIEWPORT.width}x${VIEWPORT.height}`, '--dpr', '1']);
        if (r.status !== 0) throw new Error(`init: ${r.stderr}`);
        r = await run(['inspect', '--project-root', root]);
        if (r.status !== 0) throw new Error(`inspect: ${r.stderr}`);
        const file = path.join(root, '.manual', 'config.yaml');
        const config = yaml.load(fs.readFileSync(file, 'utf8'));
        config.privacy = { ...(config.privacy || {}), audience: 'public' };
        if (!LEGACY) config.capture.demo = page.demo;
        fs.writeFileSync(file, yaml.dump(config));
        r = await run(['capture', 'chat', '--project-root', root, '--url', `${server.baseUrl}${page.path}`, '--json']);
        const out = r.json || {};
        const redactions = out.redactions || [];
        const area = redactions.reduce((sum, item) => sum + Math.max(0, item.rect?.width || 0) * Math.max(0, item.rect?.height || 0), 0);
        const demo = out.published?.privacy?.demo || null;
        rows.push({
          page: page.id,
          result: r.status === 0 ? (out.published ? 'published' : 'no-published-image') : (out.reason || 'failed'),
          reasons: r.status === 0 ? [] : [...String(out.message || '').matchAll(/([a-z]+(?:-[a-z]+)+)（/g)].map((m) => m[1]),
          masks: redactions.length,
          maskedRatio: Number((area / (VIEWPORT.width * VIEWPORT.height)).toFixed(4)),
          sources: demo ? demo.kinds || Object.keys(demo.sources || {}).filter((k) => demo.sources[k]) : null,
        });
      } finally { fx.cleanup(root); }
    }
  } finally { await server.close(); }
  process.stdout.write(JSON.stringify({ cli: LEGACY ? 'legacy' : 'demo', viewport: VIEWPORT, rows }, null, 2) + '\n');
})();
