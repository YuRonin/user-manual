'use strict';

/*
 * 事实提取与一致性校验。
 *
 * 中文自然化是 AI 干的活，而 AI 在润色时最容易犯的错就是「顺手把事实改通顺了」：
 * 把「新对话」改成「开启新会话」、补一句「通常 3 秒内完成」、把三步合成两步。
 * 这个模块把草稿里的事实抽成指纹，定稿时逐项比对——润色阶段改不动事实，
 * 不是靠提示词自觉，是靠这里挡住。
 *
 * 判据只有一条：**改完之后读者照做会不会得到不同结果。**
 *
 * 被保护的：截图路径、「」里的 UI 原文、`` ` ``里的路由/文件名、数字、
 *           操作步骤的数量与顺序、一级标题。
 *
 * 不保护的：步骤条目里的散文本身。「在左侧列表查看历史会话」被润成「查看历史会话」
 *           是允许的——那正是自然化要做的事。只要 UI 原文、数字、顺序不动，
 *           读者照做的结果就不会变。想让某个措辞不可动，就把它写成「」或 `` ` ``。
 */

const { listMarkdownImages } = require('../publication/paths');

/** 去掉围栏代码块和 HTML 注释，避免把它们里的内容当成正文事实。 */
function stripNonProse(markdown) {
  return String(markdown)
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '\n');
}

function matchAll(text, re) {
  const out = [];
  let m;
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = rx.exec(text)) !== null) out.push(m);
  return out;
}

/** 图片引用（Markdown AST，含原始 HTML <img>）。src 是事实（截图路径），alt 是文案，允许润色。 */
function extractImages(text) {
  return listMarkdownImages(text).map((image) => ({ alt: image.alt, src: image.src }));
}

/** 「」包裹的 UI 原文。 */
function extractUiTerms(text) {
  return matchAll(text, /「([^」]*)」/g).map((m) => m[1].trim()).filter(Boolean);
}

/** 行内代码：路由、文件名、字段名。 */
function extractCodeSpans(text) {
  return matchAll(text, /`([^`\n]+)`/g).map((m) => m[1].trim()).filter(Boolean);
}

/**
 * 正文里的数字。
 * 这是抓「编造响应时间/限额」最有效的一条：草稿里没有 3，定稿里冒出「3 秒内完成」就会被逮到。
 * 有序列表的序号会被排除——重新编号是合法的排版行为，不是事实变化。
 */
function extractNumbers(text) {
  const withoutListMarkers = text.replace(/^[ \t]*\d+[.)][ \t]/gm, '');
  return matchAll(withoutListMarkers, /\d+(?:[.,]\d+)*/g).map((m) => m[0]);
}

/** 有序列表项，按出现顺序。操作步骤就靠它保序。 */
function extractSteps(text) {
  return matchAll(text, /^[ \t]*\d+[.)][ \t]+(.+)$/gm).map((m) => m[1].trim());
}

function extractHeadings(text) {
  return matchAll(text, /^(#{1,6})[ \t]+(.+)$/gm).map((m) => ({
    level: m[1].length,
    text: m[2].trim(),
  }));
}

/**
 * 抽取一份 Markdown 的事实指纹。
 * @returns {{ images, uiTerms, codeSpans, numbers, steps, headings }}
 */
function extractFacts(markdown) {
  const prose = stripNonProse(markdown);
  return {
    images: extractImages(prose),
    uiTerms: extractUiTerms(prose),
    codeSpans: extractCodeSpans(prose),
    numbers: extractNumbers(prose),
    steps: extractSteps(prose),
    headings: extractHeadings(prose),
  };
}

function unique(list) {
  return [...new Set(list)];
}

function missingFrom(expected, actual) {
  const have = new Set(actual);
  return unique(expected).filter((x) => !have.has(x));
}

/**
 * 比对草稿与定稿的事实。
 * @param {object} draft  extractFacts(草稿)
 * @param {object} final  extractFacts(定稿)
 * @returns {{ ok: boolean, violations: Array<{ kind, message, detail }> }}
 */
function compareFacts(draft, final) {
  const violations = [];
  const add = (kind, message, detail) => violations.push({ kind, message, detail });

  // ---- 截图引用：路径必须一模一样，顺序也不能变
  const draftSrc = draft.images.map((i) => i.src);
  const finalSrc = final.images.map((i) => i.src);
  if (draftSrc.length !== finalSrc.length || draftSrc.some((s, i) => s !== finalSrc[i])) {
    add('image', '截图引用被改动了。图片路径属于事实，不能在润色阶段修改。', {
      draft: draftSrc,
      final: finalSrc,
    });
  }

  // ---- UI 原文：不许新增（编造按钮名），不许丢失（操作凭空消失）
  const newTerms = missingFrom(final.uiTerms, draft.uiTerms);
  if (newTerms.length > 0) {
    add('ui-added', '出现了草稿里没有的 UI 名称。这些词是编的，真实页面上可能不存在。', {
      added: newTerms,
    });
  }
  const lostTerms = missingFrom(draft.uiTerms, final.uiTerms);
  if (lostTerms.length > 0) {
    add('ui-missing', 'UI 名称在定稿里消失了。对应的操作说明可能被删掉或改写了。', {
      missing: lostTerms,
    });
  }

  // ---- 行内代码：路由、文件名同理
  const newCode = missingFrom(final.codeSpans, draft.codeSpans);
  if (newCode.length > 0) {
    add('code-added', '出现了草稿里没有的路由 / 文件名 / 字段名。', { added: newCode });
  }
  const lostCode = missingFrom(draft.codeSpans, final.codeSpans);
  if (lostCode.length > 0) {
    add('code-missing', '路由 / 文件名 / 字段名在定稿里消失了。', { missing: lostCode });
  }

  // ---- 数字：只查新增。编造的响应时间、限额、条数都会在这里现形。
  const newNumbers = missingFrom(final.numbers, draft.numbers);
  if (newNumbers.length > 0) {
    add('number-added', '出现了草稿里没有的数字。响应时间、限额、数量这类事实不能在润色阶段补。', {
      added: newNumbers,
    });
  }

  // ---- 操作步骤：数量与顺序都不能变
  if (draft.steps.length !== final.steps.length) {
    add('step-count', `操作步骤数量从 ${draft.steps.length} 变成了 ${final.steps.length}。`, {
      draft: draft.steps,
      final: final.steps,
    });
  } else {
    // 步数没变时，逐步比对该步涉及的 UI 名称，确认顺序没有被调换
    for (let i = 0; i < draft.steps.length; i++) {
      const draftTerms = extractUiTerms(draft.steps[i]);
      const finalTerms = extractUiTerms(final.steps[i]);
      const sameSet =
        draftTerms.length === finalTerms.length &&
        unique(draftTerms).every((t) => finalTerms.includes(t));
      if (!sameSet) {
        add('step-order', `第 ${i + 1} 步涉及的 UI 名称变了，操作顺序可能被调换。`, {
          index: i + 1,
          draft: draft.steps[i],
          final: final.steps[i],
        });
      }
    }
  }

  // ---- 一级标题就是页面名称，属于事实
  const draftH1 = draft.headings.find((h) => h.level === 1);
  const finalH1 = final.headings.find((h) => h.level === 1);
  if (draftH1 && (!finalH1 || finalH1.text !== draftH1.text)) {
    add('title', '页面标题被改了。标题取自页面模型，属于事实。', {
      draft: draftH1.text,
      final: finalH1 ? finalH1.text : null,
    });
  }

  return { ok: violations.length === 0, violations };
}

/** 把违规项渲染成人能直接照着改的文字。 */
function formatViolations(violations) {
  const lines = [];
  for (const v of violations) {
    lines.push(`  ✗ ${v.message}`);
    const d = v.detail || {};
    if (d.added) lines.push(`      新增: ${d.added.map((x) => JSON.stringify(x)).join('  ')}`);
    if (d.missing) lines.push(`      缺失: ${d.missing.map((x) => JSON.stringify(x)).join('  ')}`);
    if (d.draft !== undefined && d.added === undefined && d.missing === undefined) {
      lines.push(`      草稿: ${JSON.stringify(d.draft)}`);
      lines.push(`      定稿: ${JSON.stringify(d.final)}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  extractFacts,
  compareFacts,
  formatViolations,
  extractImages,
  extractUiTerms,
  extractCodeSpans,
  extractNumbers,
  extractSteps,
  extractHeadings,
  stripNonProse,
};
