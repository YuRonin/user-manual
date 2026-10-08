'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../cli/args');
const { loadConfig } = require('../config/load');
const { createProjectStore } = require('../store/project');
const { taskQuality } = require('../generate/quality');
const { computeClaims } = require('../evidence/claims');
const { writeFileAtomic } = require('../util/atomic-write');
const { ensureStateGitignore } = require('../runtime/store');

const KNOWN_FLAGS = new Set(['projectRoot', 'json', 'preview', 'help']);
const HELP = `manual review-task <task-id> [--preview] [--project-root <路径>] [--json]

只读审阅任务目标、步骤、发布截图及完成判断。报告基于现有模型与采集记录，不访问网站；
已验证只指采集时的界面断言，不代表业务目标或当前线上状态。
--preview 从已发布 Markdown 生成本地 HTML 读者预览，写入 .manual/previews/。`;

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function renderPreview(markdown, report, baseHref) {
  const MarkdownIt = require('markdown-it');
  const body = new MarkdownIt({ html: false, linkify: true }).render(markdown.replace(/<!--[\s\S]*?-->/g, ''));
  const alerts = report.quality.warnings.map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const review = alerts ? `<aside class="review"><strong>审阅提示（不属于读者正文）</strong><ul>${alerts}</ul></aside>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base href="${escapeHtml(baseHref)}"><title>${escapeHtml(report.title)}</title><style>body{font:16px/1.7 system-ui,-apple-system,sans-serif;color:#24292f;max-width:780px;margin:36px auto;padding:0 22px}h1,h2,h3{line-height:1.3}h2{border-top:1px solid #ddd;padding-top:22px;margin-top:36px}img{max-width:100%;height:auto;border:1px solid #ddd;border-radius:8px}li{margin:8px 0}a{color:#0969da}.review{background:#fff8db;border:1px solid #eac54f;border-radius:8px;padding:12px 18px;margin-bottom:32px}blockquote{border-left:4px solid #d0d7de;padding-left:12px;color:#57606a}</style></head><body>${review}<main>${body}</main></body></html>\n`;
}

function reviewTask(task, pages, evidence = {}) {
  const entryPage = pages.find(page => page.id === task.entryPage);
  const quality = taskQuality(task, evidence, { entryPage });
  const records = new Map((evidence.steps || []).map(record => [record.id, record]));
  return {
    id: task.id, title: task.title, goal: task.goal,
    entry: entryPage ? { title: entryPage.title, route: entryPage.route } : null,
    quality, completion: {
      claims: computeClaims(task, evidence).map(({ id, text, status }) => ({ id, text, status })),
      readerChecks: task.completion?.readerChecks || [],
    },
    steps: (task.steps || []).map((step, index) => ({
      number: index + 1, id: step.id, instruction: step.instruction, action: step.action ? { type: step.action.type, target: step.action.target || null } : null,
      screenshot: {
        timing: step.capture?.timing || null, readerCaption: step.capture?.readerCaption || null,
        readerVisible: step.capture?.readerVisible !== false,
        reviewQuestions: step.capture?.readerVisible === false || !step.capture ? [] :
          step.capture.timing === 'before'
            ? ['操作前图中的标注是否指向这一步要使用的控件？']
            : ['操作后图是否显示图注所说的界面变化，而非把下一步控件当作完成结果？'],
        images: step.capture?.readerVisible === false ? [] : (records.get(step.id)?.screenshots || [])
          .map(shot => ({ path: shot.annotated, timing: shot.timing || null }))
          .filter(shot => typeof shot.path === 'string' && shot.path.includes('/images/annotated/')),
      },
    })),
    note: '报告是静态审阅材料；目标语义和截图画面仍需人工核对，首次阅读效果需独立读者测试。',
  };
}

function run(argv) {
  const { values, positional, unknownFlags } = parseArgs(argv, { known: KNOWN_FLAGS, booleans: ['preview'] });
  const json = values.json === true;
  if (values.help) { process.stdout.write(HELP + '\n'); return 0; }
  const fail = message => {
    if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
    else process.stderr.write(`[manual review-task] ${message}\n`);
    return 2;
  };
  if (unknownFlags.length) return fail(`未知参数: ${unknownFlags.join(', ')}`);
  if (positional.length !== 1 || !positional[0]) return fail('需要一个 task-id。');
  const root = path.resolve(values.projectRoot || process.cwd());
  const loaded = loadConfig(root);
  if (!loaded.ok) return fail(loaded.errors.join('；'));
  const store = createProjectStore({ stateDirAbs: path.join(root, loaded.config.artifacts.stateDir), docsOutputDir: loaded.config.docs.outputDir });
  let model;
  try { model = store.load().model; } catch (error) { return fail((error.errors || [error.message]).join('；')); }
  const task = model.tasks.find(item => item.id === positional[0]);
  if (!task) return fail(`找不到任务: ${positional[0]}`);
  let evidence = {};
  if (task.evidenceManifest) {
    const file = path.resolve(root, task.evidenceManifest);
    if (!file.startsWith(root + path.sep)) return fail('证据清单路径不在项目内。');
    try { evidence = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return fail(`无法读取证据清单: ${error.message}`); }
  }
  const report = reviewTask(task, model.pages, evidence);
  let preview = null;
  if (values.preview) {
    const manual = path.join(root, loaded.config.docs.outputDir, 'tasks', `${task.id}.md`);
    if (!fs.existsSync(manual)) return fail(`正式手册不存在: ${manual}`);
    const state = path.join(root, loaded.config.artifacts.stateDir);
    ensureStateGitignore(state);
    preview = path.join(state, 'previews', `${task.id}.html`);
    const base = path.relative(path.dirname(preview), path.dirname(manual)).split(path.sep).join('/') + '/';
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    writeFileAtomic(preview, renderPreview(fs.readFileSync(manual, 'utf8'), report, base));
  }
  if (json) process.stdout.write(JSON.stringify({ ok: true, report, preview }, null, 2) + '\n');
  else {
    if (preview) process.stdout.write(`读者预览：${preview}\n`);
    process.stdout.write(`${report.title}\n目标：${report.goal}\n入口：${report.entry?.route || '未定义'}\n`);
    report.steps.forEach(step => process.stdout.write(`${step.number}. ${step.instruction}\n   图：${step.screenshot.images.length} 张；${step.screenshot.readerCaption || '缺少读者图注'}\n${step.screenshot.reviewQuestions.map(item => `   审阅：${item}\n`).join('')}`));
    process.stdout.write(`完成声明：${report.completion.claims.map(c => `${c.id}=${c.status}`).join('、') || '无'}\n`);
    report.quality.goalCoverage.forEach(item => process.stdout.write(`目标核对：${item.text} (${item.status})\n`));
    report.quality.warnings.forEach(warning => process.stdout.write(`警告：${warning}\n`));
  }
  return 0;
}

module.exports = { run, reviewTask, renderPreview, HELP, KNOWN_FLAGS };
