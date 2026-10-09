'use strict';

/*
 * 帮助中心静态站：构建层（读手册、渲染、写产物）。
 *
 * 两阶段：先在内存里渲染全部页面并收集错误——任何一篇有死链就整体失败、一个文件都不写；
 * 全部通过后才落盘。输出目录里的 .manual-site.json 记录本工具生成过的文件，
 * 下次构建只清理清单里出现过、这次不再生成的文件，绝不删除别人放进来的东西；
 * 目录非空却没有清单时拒绝写入（除非 --force），防止把 outputDir 指错后覆盖业务文件。
 */

const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('../util/atomic-write');
const { sha256Hex } = require('../util/hash');
const {
  SiteError, extractTitle, htmlPathFor, imageOutPathFor, parseCatalog,
  renderArticleBody, renderArticlePage, renderHomePage, renderCss,
} = require('./render');

const MANIFEST = '.manual-site.json';
const NON_ARTICLE = new Set(['index.md', 'readme.md']);
const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i;
const CONVERTIBLE_RE = /\.(png|jpe?g)$/i;

/** 递归列出 docs 根下的文件（POSIX 相对路径），跳过隐藏项。 */
function walk(root, dir = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

function defaultConvert(quality) {
  const sharp = require('sharp');
  return (src, out) => sharp(src).webp({ quality }).toFile(out);
}

/**
 * 读手册并在内存中渲染全站，不写任何文件。
 * @returns {{ok:true, plan} | {ok:false, errors:{code,message}[]}}
 */
function planSite({ projectRoot, config }) {
  const site = config.site;
  const docsRoot = path.join(projectRoot, config.docs.outputDir);
  if (!fs.existsSync(path.join(docsRoot, 'index.md'))) {
    return { ok: false, errors: [{ code: 'site-catalog-missing', message: `${config.docs.outputDir}/index.md 不存在；先运行 manual generate 发布手册。` }] };
  }

  const files = walk(docsRoot);
  const docs = files.filter((rel) => /\.md$/i.test(rel) && !NON_ARTICLE.has(rel.toLowerCase()));
  const known = {
    docs: new Set([...docs, 'index.md']),
    images: new Set(files.filter((rel) => IMAGE_RE.test(rel))),
    appBaseUrl: site.appBaseUrl,
  };

  const errors = [];
  const capture = (fn) => {
    try { return fn(); } catch (error) {
      if (!(error instanceof SiteError)) throw error;
      errors.push({ code: error.code, message: error.message });
      return null;
    }
  };

  const catalog = capture(() => parseCatalog(fs.readFileSync(path.join(docsRoot, 'index.md'), 'utf8'), known)) || [];
  const groupOf = new Map(catalog.flatMap((group) => group.items.map((item) => [item.target, group.title])));

  const pages = new Map();
  const usedImages = new Set();
  for (const rel of docs) {
    const markdown = fs.readFileSync(path.join(docsRoot, rel), 'utf8');
    const title = extractTitle(markdown, path.posix.basename(rel, '.md'));
    const bodyHtml = capture(() => renderArticleBody(markdown, rel, known, usedImages, site.labels));
    if (bodyHtml !== null) {
      pages.set(htmlPathFor(rel), renderArticlePage({ site, rel, title, groupTitle: groupOf.get(rel) || null, bodyHtml }));
    }
  }

  // 求助区图片：项目内任意位置，原样复制到 assets/
  const supportItems = [];
  const supportAssets = [];
  site.support.items.forEach((item, index) => {
    let href = null;
    if (item.image) {
      const source = path.join(projectRoot, item.image);
      if (!fs.existsSync(source)) {
        errors.push({ code: 'site-support-image-missing', message: `site.support.items[${index}].image 不存在: ${item.image}` });
      } else {
        href = `assets/support-${index + 1}${path.extname(source).toLowerCase()}`;
        supportAssets.push({ source, rel: href });
      }
    }
    supportItems.push({ ...item, href });
  });

  if (errors.length) return { ok: false, errors };
  pages.set('index.html', renderHomePage({ site, catalog, supportItems }));

  const images = [...usedImages].sort().map((rel) => ({
    source: path.join(docsRoot, rel),
    rel: imageOutPathFor(rel),
    convert: CONVERTIBLE_RE.test(rel),
  }));
  return { ok: true, plan: { pages, css: renderCss(site.theme), images, supportAssets, catalog } };
}

function readManifest(outDir) {
  try { return JSON.parse(fs.readFileSync(path.join(outDir, MANIFEST), 'utf8')); } catch (_) { return null; }
}

/** 产物比源旧（或不存在）才需要重新生成。 */
function stale(source, target) {
  try { return fs.statSync(target).mtimeMs < fs.statSync(source).mtimeMs; } catch (_) { return true; }
}

/**
 * 构建静态帮助中心。
 * @param {{projectRoot:string, config:object, force?:boolean, convert?:(src:string,out:string)=>Promise<unknown>}} options
 */
async function buildSite({ projectRoot, config, force = false, convert }) {
  const planned = planSite({ projectRoot, config });
  if (!planned.ok) return planned;
  const { plan } = planned;
  const outDir = path.join(projectRoot, config.site.outputDir);

  const previous = readManifest(outDir);
  if (!previous && !force && fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    return { ok: false, errors: [{ code: 'site-output-unmanaged', message: `输出目录 ${config.site.outputDir} 非空且不是 manual site 生成的；确认可以覆盖后加 --force。` }] };
  }

  const toWebp = convert || defaultConvert(config.site.webpQuality);
  const written = [];
  const generated = new Set();
  const write = (rel, content) => {
    generated.add(rel);
    const file = path.join(outDir, rel);
    const prior = fs.existsSync(file) ? fs.readFileSync(file) : null;
    if (prior && prior.equals(Buffer.from(content))) return; // 内容未变不重写，保持 mtime 与增量判断稳定
    writeFileAtomic(file, content);
    written.push(rel);
  };

  write('assets/help.css', plan.css);
  for (const [rel, html] of plan.pages) write(rel, html);

  const images = { converted: 0, copied: 0, skipped: 0 };
  for (const image of [...plan.images, ...plan.supportAssets.map((asset) => ({ ...asset, convert: false }))]) {
    generated.add(image.rel);
    const target = path.join(outDir, image.rel);
    if (!stale(image.source, target)) { images.skipped++; continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (image.convert) { await toWebp(image.source, target); images.converted++; }
    else { fs.copyFileSync(image.source, target); images.copied++; }
  }

  // 只清理本工具上次生成、这次不再生成的文件
  const removed = [];
  for (const rel of previous?.files || []) {
    if (generated.has(rel) || typeof rel !== 'string' || rel.split('/').includes('..')) continue;
    const file = path.join(outDir, rel);
    if (fs.existsSync(file)) { fs.rmSync(file); removed.push(rel); }
  }

  const files = [...generated].sort();
  writeFileAtomic(path.join(outDir, MANIFEST), JSON.stringify({ version: 1, files, digest: sha256Hex(files.join('\n')) }, null, 2) + '\n');

  return {
    ok: true,
    outputDir: config.site.outputDir,
    pages: plan.pages.size,
    documents: plan.catalog.reduce((sum, group) => sum + group.items.length, 0),
    images,
    written: written.length,
    removed,
  };
}

module.exports = { buildSite, planSite, MANIFEST };
