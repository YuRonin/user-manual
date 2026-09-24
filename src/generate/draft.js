'use strict';

/*
 * 事实草稿生成。
 *
 * 草稿只由确定性事实拼成，一个字都不是推断出来的。事实优先级：
 *   真实 Browser Capture  >  Inspect 项目模型  >  （不允许有第三档）
 *
 * 草稿读起来会有点机械，这是故意的——它的职责是「把事实摆全、摆对」，
 * 让中文读起来自然是下一阶段的事。两阶段分开，出问题时才能判断
 * 是事实错了还是润色错了。
 */

const path = require('path');
const { toMarkdownHref } = require('../publication/paths');
const { buildPageFactPack } = require('./fact-pack');
const { renderPage } = require('./render');

/** 截图相对页面正式文档（<docsOutputDir>/<id>.md）的路径，与任务文档共用同一规则。 */
function screenshotRelativeToDocs(docsOutputDir, screenshotPath) {
  return toMarkdownHref({ manualFile: path.join(docsOutputDir, 'page.md'), artifactFile: screenshotPath });
}

/**
 * 拼出事实草稿。
 * @param {object} page    页面模型（pages/<id>.yaml 的内容）
 * @param {object} context { docsOutputDir, pageFilePath, includeScreenshot, image, language }
 *   image: { artifactPath, markdownHref } —— 已通过发布门槛的页面发布图
 * @returns {{ markdown, facts }}  facts 是给用户看的事实来源说明
 */
function buildDraft(page, context) {
  const { docsOutputDir, pageFilePath, includeScreenshot = true, indexContext = null, image = null, language = 'zh-CN' } = context;
  const browser = page.browser || {};
  // 草稿头部只放元信息。它在 HTML 注释里，不参与事实校验，也不会进最终文档。
  const headerComments = ['<!-- 事实草稿，由 `manual generate` 生成。不要手工编辑这个文件。 -->', `<!-- 页面模型: ${pageFilePath} -->`];
  if (Array.isArray(indexContext?.files) && indexContext.files.length > 0) {
    headerComments.push(`<!-- 关联源码: ${indexContext.files.join(', ')} -->`);
  }
  if (browser.screenshot) {
    headerComments.push(`<!-- 截图: ${browser.screenshot} @ ${browser.lastCapture || '未知时间'} -->`);
    headerComments.push(`<!-- 截图时的真实地址: ${browser.url || '未知'} -->`);
  } else {
    headerComments.push('<!-- 这个页面还没有截图 -->');
  }
  headerComments.push('<!-- 注意: 图片路径相对最终文档位置，在草稿里预览会显示不出来，这是正常的。 -->');

  // 截图只引用经过发布门槛的产物（context.image），从不直接引用原图
  const published = includeScreenshot && image
    ? { ...image, markdownHref: image.markdownHref || screenshotRelativeToDocs(docsOutputDir, image.artifactPath) }
    : null;
  const pack = buildPageFactPack({ page, image: published, language, headerComments });
  return {
    markdown: renderPage(pack, {}, { draft: true }),
    pack,
    facts: {
      title: page.title,
      route: page.route,
      purpose: page.purpose,
      actionCount: pack.actions.length,
      screenshot: published ? published.artifactPath : null,
      capturedAt: browser.lastCapture || null,
      capturedUrl: browser.url || null,
      viewport: browser.viewport || null,
      deviceScaleFactor: browser.deviceScaleFactor ?? null,
      factsHash: pack.factsHash,
    },
  };
}

module.exports = { buildDraft, screenshotRelativeToDocs };
