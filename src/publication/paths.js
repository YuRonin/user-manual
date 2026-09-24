'use strict';

/*
 * 发布图片的两种身份，不能混用：
 *   artifactPath  —— 项目根相对的 POSIX 路径，用于 manifest / facts / 完整性检查；
 *   markdownHref  —— 相对最终 Markdown 所在目录的 POSIX 路径，只写进文档。
 *
 * href 里出现 ../ 不是错误；先按文档目录解析，再检查真实位置是否仍在发布根内。
 */

const fs = require('fs');
const path = require('path');
const MarkdownIt = require('markdown-it');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathError(code, message, extra = {}) {
  return { ok: false, code, message, ...extra };
}

/** 两个绝对路径（或同基准相对路径）之间的 Markdown 图片引用。 */
function toMarkdownHref({ manualFile, artifactFile }) {
  return toPosix(path.relative(path.dirname(manualFile), artifactFile));
}

function isExternalOrAbsolute(href) {
  return (
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href) || // http:、data:、file:，也覆盖 C: 盘符
    href.startsWith('/') ||
    href.startsWith('\\')
  );
}

function realpathOrNull(target) {
  try { return fs.realpathSync.native(target); } catch (_) { return null; }
}

/**
 * 把文档里的图片引用解析为真实产物。
 * @returns {{ok:true, href, artifactPath, absolutePath} | {ok:false, code, message}}
 *   code: invalid-artifact-path / invalid-artifact-type / missing
 */
function resolvePublishedImage({ projectRoot, manualFile, href, publishRoot }) {
  const raw = String(href || '').trim();
  if (!raw) return pathError('invalid-artifact-path', '图片引用为空。', { href: raw });
  if (isExternalOrAbsolute(raw) || /[?#]/.test(raw)) {
    return pathError('invalid-artifact-path', `图片引用必须是相对文档位置的本地路径: ${raw}`, { href: raw });
  }
  let decoded;
  try { decoded = decodeURI(raw); } catch (_) {
    return pathError('invalid-artifact-path', `图片引用编码无效: ${raw}`, { href: raw });
  }

  const root = path.resolve(projectRoot);
  const publishAbs = path.resolve(root, publishRoot);
  const absolutePath = path.resolve(path.dirname(path.resolve(root, manualFile)), decoded);
  if (!inside(publishAbs, absolutePath)) {
    return pathError('invalid-artifact-path', `图片引用越出发布目录 ${toPosix(publishRoot)}: ${raw}`, { href: raw });
  }
  if (!IMAGE_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
    return pathError('invalid-artifact-type', `不支持的图片类型: ${raw}`, { href: raw });
  }
  if (!fs.existsSync(absolutePath)) {
    return pathError('missing', `图片不存在: ${raw}`, { href: raw, artifactPath: toPosix(path.relative(root, absolutePath)) });
  }
  // 词法路径合法还不够：软链接 / junction 可以把文件指到发布根外。
  const realFile = realpathOrNull(absolutePath);
  const realRoot = realpathOrNull(publishAbs);
  if (!realFile || !realRoot || !inside(realRoot, realFile)) {
    return pathError('invalid-artifact-path', `图片真实位置不在发布目录内: ${raw}`, { href: raw });
  }
  if (!fs.statSync(realFile).isFile()) {
    return pathError('invalid-artifact-type', `图片引用不是文件: ${raw}`, { href: raw });
  }
  return { ok: true, href: raw, artifactPath: toPosix(path.relative(root, absolutePath)), absolutePath };
}

const parser = new MarkdownIt({ html: true });
const HTML_IMG_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function collectHtmlImages(content, out) {
  for (const match of String(content).matchAll(HTML_IMG_RE)) {
    out.push({ src: match[1] ?? match[2] ?? match[3], alt: null, kind: 'html' });
  }
}

/**
 * 用 Markdown AST 枚举全部图片（含原始 HTML <img>），按文档顺序返回。
 * 代码块中的内容不是图片，不会被计入。
 */
function listMarkdownImages(markdown) {
  const out = [];
  const walk = (tokens) => {
    for (const token of tokens) {
      if (token.type === 'image') {
        out.push({ src: token.attrGet('src'), alt: token.content, kind: 'markdown' });
      } else if (token.type === 'html_block' || token.type === 'html_inline') {
        collectHtmlImages(token.content, out);
      }
      if (token.children) walk(token.children);
    }
  };
  walk(parser.parse(String(markdown || ''), {}));
  return out;
}

/**
 * facts.images 条目规范化。旧版是项目根相对字符串（同时被当作 Markdown src），
 * 这种条目标记为 legacy，只能要求重新生成，不能静默当成任一种新语义。
 */
function normalizeImageFact(entry) {
  if (typeof entry === 'string') return { artifactPath: toPosix(entry), markdownHref: null, legacy: true };
  return { artifactPath: toPosix(entry && entry.artifactPath), markdownHref: entry && entry.markdownHref ? toPosix(entry.markdownHref) : null, legacy: false };
}

/**
 * 核对一份将要发布/已发布的 Markdown 中的图片：
 * 每个引用都按文档位置解析成功，且与 facts 记录的 artifactPath / markdownHref 一致。
 */
function checkDocumentImages({ projectRoot, manualFile, markdown, publishRoot, expected = null }) {
  const errors = [];
  const images = listMarkdownImages(markdown);
  const resolved = [];
  for (const image of images) {
    if (image.kind === 'html') {
      errors.push({ code: 'invalid-artifact-path', message: `正式文档不允许原始 HTML 图片: ${image.src}` });
      continue;
    }
    const ref = resolvePublishedImage({ projectRoot, manualFile, href: image.src, publishRoot });
    if (!ref.ok) errors.push({ code: ref.code, message: ref.message });
    else resolved.push(ref);
  }
  if (expected) {
    const facts = expected.map(normalizeImageFact);
    if (facts.some((item) => item.legacy)) {
      errors.push({ code: 'legacy-image-facts', message: '事实文件使用旧版图片路径格式（无法区分产物路径与文档引用），请重新运行 generate-task 生成草稿。' });
    } else {
      const hrefs = images.map((image) => image.src);
      if (JSON.stringify(hrefs) !== JSON.stringify(facts.map((item) => item.markdownHref))) {
        errors.push({ code: 'image-mismatch', message: '截图引用与事实文件不一致。' });
      }
      const artifacts = new Set(resolved.map((ref) => ref.artifactPath));
      for (const item of facts) {
        if (!artifacts.has(item.artifactPath)) {
          errors.push({ code: 'image-mismatch', message: `事实记录的产物未被文档正确引用: ${item.artifactPath}` });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, images: resolved };
}

module.exports = {
  toPosix,
  inside,
  toMarkdownHref,
  resolvePublishedImage,
  listMarkdownImages,
  normalizeImageFact,
  checkDocumentImages,
  IMAGE_EXTENSIONS,
};
