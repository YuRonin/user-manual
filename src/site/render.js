'use strict';

/*
 * 帮助中心静态站：纯渲染层（不碰文件系统，便于单测）。
 *
 * 输入是已发布的 Markdown 手册（docs.outputDir），输出是一组可直接托管的 HTML：
 *   - 文档互链  tasks/x.md      → 相对的 tasks/x.html（file:// 与任意子路径都能用）
 *   - 截图      images/…/a.png  → 相对的 images/…/a.webp（构建层转码）
 *   - 产品入口  /credits        → 原样；配置了 site.appBaseUrl 时拼成绝对地址
 *   - 外链      http(s)://      → 新标签页打开
 *   - 其它协议 / 协议相对 URL   → 丢弃链接、只留文字
 * 链接指向不存在的文档或图片时抛 SiteError，构建整体失败（不发布死链）。
 *
 * Markdown 里的 HTML 只有 manual 的 block 注释：渲染前剥掉，并以 html:false 解析，
 * 不留任何原始 HTML 注入面。
 */

const path = require('path');
const MarkdownIt = require('markdown-it');

class SiteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const CATALOG_RE = /<!--\s*manual:catalog\s*-->([\s\S]*?)<!--\s*\/manual:catalog\s*-->/;
const CATALOG_ITEM_RE = /^-\s+\[([^\]]+)\]\(([^)\s]+)\)\s*(?:[：:]\s*(.+?))?\s*$/;
const COMPLETION_RE = /<!--\s*manual:block id=completion\b[^>]*-->([\s\S]*?)<!--\s*\/manual:block\s*-->/;
const CONVERTIBLE_RE = /\.(png|jpe?g)$/i;
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** docs 根相对的 md 路径 → 站点内的 html 路径。 */
const htmlPathFor = (rel) => rel.replace(/\.md$/i, '.html');
/** docs 根相对的图片路径 → 站点内的发布路径（png/jpg 转 webp，其余原样）。 */
const imageOutPathFor = (rel) => rel.replace(CONVERTIBLE_RE, '.webp');
/** 从某个站点文件回到站点根的相对前缀，如 tasks/x.html → '../'。 */
const rootPrefixFor = (siteRel) => '../'.repeat(siteRel.split('/').length - 1);

function extractTitle(markdown, fallback) {
  const match = String(markdown).match(/^#\s+(.+?)\s*$/m);
  return match ? match[1] : fallback;
}

/**
 * 手册内链接的唯一改写入口。
 * @param {string} href       Markdown 里写的链接
 * @param {string} fromRel    当前文档（docs 根相对，POSIX）
 * @param {{docs:Set<string>, images:Set<string>, appBaseUrl?:string|null}} known
 * @returns {{kind:'doc'|'image'|'internal'|'external', href:string, target?:string} | {kind:'drop'}}
 *   target 是 docs 根相对的目标路径（doc 为 md、image 为源图），供构建层收集需要转码的图片
 */
function rewriteHref(href, fromRel, known) {
  const value = String(href || '').trim();
  if (!value || value.startsWith('//')) return { kind: 'drop' };
  if (value.startsWith('#')) return { kind: 'internal', href: value };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return /^https?:\/\//i.test(value) ? { kind: 'external', href: value } : { kind: 'drop' };
  }
  if (value.startsWith('/')) {
    return { kind: 'internal', href: known.appBaseUrl ? known.appBaseUrl.replace(/\/+$/, '') + value : value };
  }

  const hashAt = value.indexOf('#');
  const pathPart = hashAt >= 0 ? value.slice(0, hashAt) : value;
  const hash = hashAt >= 0 ? value.slice(hashAt) : '';
  let decoded;
  try { decoded = decodeURI(pathPart); } catch (_) { throw new SiteError('site-invalid-link', `链接编码无效「${href}」（${fromRel}）`); }
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), decoded));
  if (target === '..' || target.startsWith('../')) {
    throw new SiteError('site-invalid-link', `链接越出手册目录「${href}」（${fromRel}）`);
  }
  const relFrom = (siteRel) => {
    const relative = path.posix.relative(path.posix.dirname(htmlPathFor(fromRel)), siteRel);
    return relative || path.posix.basename(siteRel);
  };

  if (IMAGE_RE.test(target)) {
    if (!known.images.has(target)) throw new SiteError('site-dead-link', `截图不存在「${href}」（${fromRel}）`);
    return { kind: 'image', href: relFrom(imageOutPathFor(target)), target };
  }
  if (/\.md$/i.test(target)) {
    if (!known.docs.has(target)) throw new SiteError('site-dead-link', `链接指向不存在的文档「${href}」（${fromRel}）`);
    return { kind: 'doc', href: relFrom(htmlPathFor(target)) + hash, target };
  }
  throw new SiteError('site-invalid-link', `无法识别的相对链接「${href}」（${fromRel}）`);
}

/**
 * 解析 index.md 的 manual:catalog 段：`## 分组` + `- [标题](路径)：摘要`。
 * 结构对不上就抛错，宁可构建失败也不出一个空目录。
 */
function parseCatalog(markdown, known) {
  const block = String(markdown).match(CATALOG_RE);
  if (!block) throw new SiteError('site-catalog-missing', 'index.md 缺少 <!-- manual:catalog --> 段；先运行 manual generate 生成目录。');
  const groups = [];
  for (const raw of block[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^#\s/.test(line)) continue;
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) { groups.push({ title: heading[1].trim(), items: [] }); continue; }
    const item = line.match(CATALOG_ITEM_RE);
    if (!item || !groups.length) throw new SiteError('site-catalog-invalid', `无法解析目录行「${line}」`);
    const link = rewriteHref(item[2], 'index.md', known);
    if (link.kind !== 'doc') throw new SiteError('site-catalog-invalid', `目录项必须指向手册文档「${line}」`);
    groups[groups.length - 1].items.push({ title: item[1].trim(), summary: (item[3] || '').trim(), target: link.target });
  }
  if (!groups.length || groups.some((group) => !group.items.length)) {
    throw new SiteError('site-catalog-invalid', 'manual:catalog 段为空或存在空分组。');
  }
  return groups;
}

/** 切出任务篇的「如何确认已完成」段（去掉其首个二级标题），供渲染成提示框。 */
function splitCompletion(markdown) {
  const match = String(markdown).match(COMPLETION_RE);
  if (!match) return { before: markdown, completion: null, after: '' };
  return {
    before: markdown.slice(0, match.index),
    completion: match[1].replace(/^\s*##\s+.+$/m, '').trim(),
    after: markdown.slice(match.index + match[0].length),
  };
}

/** 构造带链接改写的 markdown-it 实例；used 收集本篇实际引用的图片源路径。 */
function createRenderer(fromRel, known, used) {
  const md = new MarkdownIt({ html: false, linkify: false });
  // 校验交给 rewriteHref：markdown-it 默认会把 javascript: 等链接降级成纯文本，这里统一由改写层决定
  md.validateLink = () => true;

  md.core.ruler.push('manual_site_links', (state) => {
    const walk = (tokens) => {
      const dropped = [];
      for (const token of tokens) {
        if (token.children) walk(token.children);
        if (token.type === 'link_open') {
          const link = rewriteHref(token.attrGet('href'), fromRel, known);
          if (link.kind === 'drop') {
            token.type = 'text'; token.tag = ''; token.content = ''; token.attrs = null;
            dropped.push(true);
            continue;
          }
          dropped.push(false);
          token.attrSet('href', link.href);
          if (link.kind === 'image') { used.add(link.target); token.attrSet('class', 'shot-link'); token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener'); token.attrSet('title', '在新标签页查看大图'); }
          if (link.kind === 'external') { token.attrSet('target', '_blank'); token.attrSet('rel', 'noopener noreferrer'); }
        } else if (token.type === 'link_close') {
          // 与 link_open 配对：被丢弃的链接，其闭合标签也只留空文本
          if (dropped.pop()) { token.type = 'text'; token.tag = ''; token.content = ''; }
        } else if (token.type === 'image') {
          const link = rewriteHref(token.attrGet('src'), fromRel, known);
          if (link.kind !== 'image') throw new SiteError('site-invalid-link', `图片必须引用手册内的截图「${token.attrGet('src')}」（${fromRel}）`);
          used.add(link.target);
          token.attrSet('src', link.href);
          token.attrSet('loading', 'lazy');
          token.attrSet('decoding', 'async');
        }
      }
    };
    walk(state.tokens);
  });

  // 手册里的斜体只用于截图说明
  md.renderer.rules.em_open = () => '<em class="caption">';
  return md;
}

/** 渲染一篇正文的 HTML 片段（含完成段提示框）；used 收集引用到的图片。 */
function renderArticleBody(markdown, fromRel, known, used, labels) {
  const render = (text) => createRenderer(fromRel, known, used).render(String(text).replace(COMMENT_RE, ''));
  const { before, completion, after } = splitCompletion(markdown);
  let html = render(before);
  if (completion !== null) {
    html += `<section class="completion" aria-labelledby="completion-title"><h2 id="completion-title">${escapeHtml(labels.completion)}</h2>${render(completion)}</section>`;
  }
  if (String(after).trim()) html += render(after);
  return html;
}

function layout({ site, title, rootPrefix, body, isHome }) {
  const home = site.homeUrl
    ? `<a class="back" href="${escapeHtml(site.homeUrl)}">${escapeHtml(site.labels.backToApp)}</a>`
    : '';
  const pageTitle = isHome ? site.title : `${title} · ${site.title}`;
  return `<!doctype html>
<html lang="${escapeHtml(site.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${site.noindex ? '<meta name="robots" content="noindex,follow">\n' : ''}<title>${escapeHtml(pageTitle)}</title>
<link rel="stylesheet" href="${rootPrefix}assets/help.css">
</head>
<body>
<header class="topbar"><div class="wrap topbar-inner"><a class="brand" href="${rootPrefix}index.html">${escapeHtml(site.title)}</a>${home}</div></header>
${body}
</body>
</html>
`;
}

function renderArticlePage({ site, rel, title, groupTitle, bodyHtml }) {
  const rootPrefix = rootPrefixFor(htmlPathFor(rel));
  const crumbs = [`<li><a href="${rootPrefix}index.html">${escapeHtml(site.title)}</a></li>`];
  if (groupTitle) crumbs.push(`<li aria-hidden="true">/</li><li>${escapeHtml(groupTitle)}</li>`);
  crumbs.push(`<li aria-hidden="true">/</li><li aria-current="page">${escapeHtml(title)}</li>`);
  const body = `<main class="wrap article-wrap">
<nav class="crumbs" aria-label="面包屑"><ol>${crumbs.join('')}</ol></nav>
<article class="article">${bodyHtml}</article>
<footer class="article-foot"><a href="${rootPrefix}index.html">← ${escapeHtml(site.labels.backToIndex)}</a></footer>
</main>`;
  return layout({ site, title, rootPrefix, body, isHome: false });
}

function renderHomePage({ site, catalog, supportItems }) {
  const groups = catalog.map((group, index) => `<section class="group" aria-labelledby="group-${index}">
<h2 id="group-${index}">${escapeHtml(group.title)}</h2>
<ul class="cards">${group.items.map((item) => `<li><a class="card" href="${escapeHtml(htmlPathFor(item.target))}"><span class="card-title">${escapeHtml(item.title)}</span>${item.summary ? `<span class="card-desc">${escapeHtml(item.summary)}</span>` : ''}</a></li>`).join('')}</ul>
</section>`).join('\n');
  const support = supportItems.length ? `<section class="support" aria-labelledby="support-title">
<h2 id="support-title">${escapeHtml(site.support.title)}</h2>
${site.support.description ? `<p class="lead">${escapeHtml(site.support.description)}</p>` : ''}
<div class="support-grid">${supportItems.map((item) => `<div class="support-card">${item.href ? `<img src="${escapeHtml(item.href)}" alt="${escapeHtml(item.alt || item.title)}" loading="lazy">` : ''}<div><h3>${escapeHtml(item.title)}</h3>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ''}</div></div>`).join('')}</div>
</section>` : '';
  const body = `<main class="wrap home-wrap">
<div class="hero"><h1>${escapeHtml(site.title)}</h1>${site.description ? `<p class="lead">${escapeHtml(site.description)}</p>` : ''}</div>
${groups}
${support}
</main>`;
  return layout({ site, title: site.title, rootPrefix: '', body, isHome: true });
}

/** 站点样式：只用 CSS 变量承载主题，颜色值已在配置层校验为十六进制。 */
function renderCss(theme) {
  return `:root{--primary:${theme.primary};--text:${theme.text};--muted:${theme.muted};--bg:${theme.background};--surface:${theme.surface};--border:${theme.border};--soft:${theme.soft}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.75 system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--primary)}
a:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-radius:4px}
.wrap{max-width:1040px;margin:0 auto;padding:0 24px}
.topbar{border-bottom:1px solid var(--border);background:var(--surface)}
.topbar-inner{display:flex;align-items:center;justify-content:space-between;min-height:60px}
.brand{font-weight:600;color:var(--text);text-decoration:none}
.back{font-size:14px;font-weight:600;text-decoration:none}
.home-wrap{padding-top:40px;padding-bottom:64px}
.hero h1{margin:0;font-size:28px;line-height:36px}
.lead{margin:8px 0 0;font-size:14px;line-height:22px;color:var(--muted)}
.group{margin-top:40px}
.group h2,.support h2{margin:0;font-size:20px;line-height:28px}
.cards{list-style:none;margin:16px 0 0;padding:0;display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.card{display:block;height:100%;padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--surface);text-decoration:none;transition:border-color .16s,background-color .16s}
.card:hover{border-color:var(--primary)}
.card-title{display:block;font-size:16px;line-height:24px;font-weight:600;color:var(--text)}
.card:hover .card-title{color:var(--primary)}
.card-desc{display:block;margin-top:4px;font-size:13px;line-height:20px;color:var(--muted)}
.support{margin-top:48px}
.support-grid{margin-top:20px;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))}
.support-card{display:flex;align-items:center;gap:20px;padding:20px;border:1px solid var(--border);border-radius:16px;background:var(--surface)}
.support-card img{width:112px;height:112px;border-radius:8px;flex-shrink:0;object-fit:contain}
.support-card h3{margin:0;font-size:16px;line-height:24px}
.support-card p{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--muted)}
.article-wrap{max-width:808px;padding-top:24px;padding-bottom:64px}
.crumbs ol{list-style:none;margin:0 0 24px;padding:0;display:flex;flex-wrap:wrap;gap:4px 8px;font-size:13px;line-height:20px;color:var(--muted)}
.crumbs a{color:inherit;text-decoration:none}.crumbs a:hover{color:var(--primary)}
.crumbs [aria-current]{color:var(--text)}
.article h1{margin:0;font-size:28px;line-height:36px}
.article h1+p{color:var(--muted)}
.article h2{margin:40px 0 12px;font-size:20px;line-height:28px}
.article h3{margin:24px 0 8px;font-size:16px;line-height:24px}
.article p{margin:12px 0}
.article ol,.article ul{padding-left:24px}
.article ol>li::marker{font-weight:600;color:var(--primary)}
.article li{margin:8px 0}
.article img{display:block;width:100%;height:auto;margin:8px 0;border:1px solid var(--border);border-radius:12px;background:var(--surface)}
.shot-link{display:block;cursor:zoom-in;border-radius:12px}
.caption{display:block;font-style:normal;text-align:center;font-size:13px;line-height:20px;color:var(--muted)}
.completion{margin-top:40px;padding:16px 24px;border:1px solid var(--border);border-radius:16px;background:var(--soft)}
.completion h2{margin:0;font-size:16px;line-height:24px}
.article-foot{margin-top:48px;padding-top:24px;border-top:1px solid var(--border)}
.article-foot a{font-size:14px;font-weight:600;text-decoration:none}
@media (max-width:640px){.wrap{padding:0 16px}.hero h1,.article h1{font-size:24px;line-height:32px}.article h2{font-size:18px;line-height:26px}}
@media (prefers-reduced-motion:reduce){.card{transition:none}}
`;
}

module.exports = {
  SiteError,
  escapeHtml,
  extractTitle,
  htmlPathFor,
  imageOutPathFor,
  rewriteHref,
  parseCatalog,
  splitCompletion,
  renderArticleBody,
  renderArticlePage,
  renderHomePage,
  renderCss,
};
