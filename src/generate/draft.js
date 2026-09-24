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

/** 截图相对页面正式文档（<docsOutputDir>/<id>.md）的路径，与任务文档共用同一规则。 */
function screenshotRelativeToDocs(docsOutputDir, screenshotPath) {
  return toMarkdownHref({ manualFile: path.join(docsOutputDir, 'page.md'), artifactFile: screenshotPath });
}

/**
 * 拼出事实草稿。
 * @param {object} page    页面模型（pages/<id>.yaml 的内容）
 * @param {object} context { docsOutputDir, pageFilePath, includeScreenshot }
 * @returns {{ markdown, facts }}  facts 是给用户看的事实来源说明
 */
function buildDraft(page, context) {
  const { docsOutputDir, pageFilePath, includeScreenshot = true, indexContext = null } = context;
  const browser = page.browser || {};
  const L = [];

  // 草稿头部只放元信息。它在 HTML 注释里，不参与事实校验，也不会进最终文档。
  L.push('<!-- 事实草稿，由 `manual generate` 生成。不要手工编辑这个文件。 -->');
  L.push(`<!-- 页面模型: ${pageFilePath} -->`);
  if (Array.isArray(indexContext?.files) && indexContext.files.length > 0) {
    L.push(`<!-- 关联源码: ${indexContext.files.join(', ')} -->`);
  }
  if (browser.screenshot) {
    L.push(`<!-- 截图: ${browser.screenshot} @ ${browser.lastCapture || '未知时间'} -->`);
    L.push(`<!-- 截图时的真实地址: ${browser.url || '未知'} -->`);
  } else {
    L.push('<!-- 这个页面还没有截图 -->');
  }
  L.push('<!-- 注意: 图片路径相对最终文档位置，在草稿里预览会显示不出来，这是正常的。 -->');
  L.push('');

  // ---- 标题：页面的真实名称
  L.push(`# ${page.title}`);
  L.push('');

  // ---- 用途：这段是最需要润色的部分
  if (page.purpose) {
    L.push(page.purpose);
    L.push('');
  }

  // ---- 访问地址：路由是事实，用行内代码标出来防止被改写
  L.push(`访问地址：\`${page.route}\``);
  L.push('');

  // ---- 截图
  if (includeScreenshot && browser.screenshot) {
    const src = screenshotRelativeToDocs(docsOutputDir, browser.screenshot);
    L.push(`![${page.title}](${src})`);
    L.push('');
  }

  // ---- 主要操作
  const actions = Array.isArray(page.detectedActions) ? page.detectedActions.filter(Boolean) : [];
  if (actions.length > 0) {
    L.push('## 主要操作');
    L.push('');
    actions.forEach((action, i) => L.push(`${i + 1}. ${action}`));
    L.push('');
  }

  return {
    markdown: L.join('\n'),
    facts: {
      title: page.title,
      route: page.route,
      purpose: page.purpose,
      actionCount: actions.length,
      screenshot: browser.screenshot || null,
      capturedAt: browser.lastCapture || null,
      capturedUrl: browser.url || null,
      viewport: browser.viewport || null,
      deviceScaleFactor: browser.deviceScaleFactor ?? null,
    },
  };
}

module.exports = { buildDraft, screenshotRelativeToDocs };
