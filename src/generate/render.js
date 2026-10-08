'use strict';

/*
 * 确定性渲染（契约 C11）：事实块由结构化数据生成，模型只能提供允许的文案块。
 *
 * 动作动词、UI 目标、步骤顺序、截图位置、完成声明及其验证等级都由这里按模板写出；
 * copy（blockId → 文案）只填充 FactPack.blocks 声明过的说明段落，不能覆盖任何事实块。
 * 语言由模板决定：目前支持 zh-CN / en-US，其它语言明确返回 unsupported-template，
 * 不静默输出中文。
 */

const { revision } = require('../model/revision');

const TEMPLATES = {
  'zh-CN': {
    before: '前提条件',
    steps: '操作步骤',
    entryLead: (link) => `进入 ${link} 页面，按以下步骤操作。`,
    completion: '如何确认已完成',
    readerChecks: '请确认以下内容',
    branches: '常见问题',
    related: '相关文档',
    pageEntry: (link) => `入口：${link}`,
    actionsInferred: '主要功能',
    actionsInferredNote: '> 以下功能根据页面整理，具体以实际界面为准。',
    guideLink: '查看详细步骤',
    // 完成声明的两个标签必须互不包含：等级由程序按证据决定，定稿校验按前缀区分。
    verified: '完成标志：',
    expected: '预期结果：',
    simulated: '> 说明：截图中的数据为示例数据，实际内容以你的页面为准。',
    stepAlt: (n, timing) => `第 ${n} 步${timing === 'before' ? '操作前' : timing === 'after' ? '操作后' : ''}的界面`,
    quote: (text) => `「${text}」`,
    action: {
      click: (t) => `点击${t}`,
      hover: (t) => `将指针移到${t}`,
      fill: (t) => `在${t}中填写内容`,
      select: (t) => `在${t}中选择选项`,
      check: (t) => `勾选${t}`,
      uncheck: (t) => `取消勾选${t}`,
      inspect: (t) => (t ? `查看${t}` : '查看当前页面'),
    },
  },
  'en-US': {
    before: 'Prerequisites',
    steps: 'Steps',
    entryLead: (link) => `Open ${link} and follow these steps.`,
    completion: 'How to confirm it worked',
    readerChecks: 'Please also check',
    branches: 'FAQ',
    related: 'Related articles',
    pageEntry: (link) => `Entry: ${link}`,
    actionsInferred: 'Main features',
    actionsInferredNote: '> These features are summarized from the page; the actual interface takes precedence.',
    guideLink: 'See detailed steps',
    verified: 'You will see: ',
    expected: 'Expected result: ',
    simulated: '> Note: the data in the screenshots is sample data. Your page shows your own content.',
    stepAlt: (n, timing) => `Step ${n} ${timing === 'before' ? 'before the action' : timing === 'after' ? 'after the action' : 'interface'}`,
    quote: (text) => `「${text}」`,
    action: {
      click: (t) => `Click ${t}`,
      hover: (t) => `Hover over ${t}`,
      fill: (t) => `Fill in ${t}`,
      select: (t) => `Choose an option in ${t}`,
      check: (t) => `Check ${t}`,
      uncheck: (t) => `Uncheck ${t}`,
      inspect: (t) => (t ? `Review ${t}` : 'Review the current page'),
    },
  },
};

// render-2：正文按稳定块 ID 分段（<!-- manual:block id=… --> … <!-- /manual:block -->），供人工编辑保护的三方合并定位（P3-06）。
// render-13：面向读者的帮助中心结构——入口并入步骤，正文不暴露采集与验证范围等维护信息。
// render-14：页面指南标题恢复编号，与截图标注 ①②③ 对应。
const TEMPLATE_VERSION = 'render-14';

class TemplateError extends Error {
  constructor(language) {
    super(`unsupported-template: 没有 ${language} 的文档模板（支持 ${Object.keys(TEMPLATES).join(' / ')}）。在 config.yaml 的 docs.language 中选择受支持的语言。`);
    this.name = 'TemplateError';
    this.code = 'unsupported-template';
  }
}

function templateFor(language) {
  const template = TEMPLATES[language];
  if (!template) throw new TemplateError(language);
  return template;
}

/** 模板本身的 revision：模板文字变化 → 事实包变化 → 旧草稿失效。 */
function templateRevision(language) {
  const template = templateFor(language);
  const flatten = (value) => (typeof value === 'function' ? value.toString() : (value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, flatten(v)])) : value));
  return revision({ version: TEMPLATE_VERSION, language, template: flatten(template) });
}

/** 用户可见的目标名：只取界面上真实可见的文字；testId / selector 不是用户能读到的名称。 */
function visibleTargetName(target) {
  if (!target || typeof target !== 'object') return null;
  return target.name || target.label || target.text || null;
}

/** 步骤的动作句：由动作类型 + 可见目标确定性生成；没有可见名称时回退到已批准的步骤说明。 */
function actionSentence(step, template) {
  const action = step.action || {};
  const name = visibleTargetName(action.target);
  const fn = template.action[action.type];
  if (!fn || (!name && action.type !== 'inspect')) return { text: step.instruction, source: 'instruction' };
  return { text: fn(name ? template.quote(name) : null), source: 'action' };
}

function claimLabel(status, template) {
  return status === 'verified' ? template.verified : template.expected;
}

function blockText(pack, copy, blockId) {
  if (copy && Object.prototype.hasOwnProperty.call(copy, blockId)) return String(copy[blockId]).trim();
  return pack.blocks[blockId]?.default ?? '';
}

/** 默认说明若重复动作句开头，只保留它新增的结果说明。 */
function withoutRepeatedAction(note, sentence, language) {
  if (!note || note === sentence) return '';
  if (!note.startsWith(sentence)) return note;
  let remainder = note.slice(sentence.length).trim().replace(/^[，,。.\s]+/, '');
  remainder = language === 'zh-CN'
    ? remainder.replace(/^(并|后)/, '').trim()
    : remainder.replace(/^(and|then)\s+/i, '').trim();
  return remainder;
}

/*
 * 生成块：每个块由成对的注释包围，块外的内容属于人工（ownership=human），生成器从不覆盖。
 * 块 ID 在同一文档内唯一且稳定（与 section / step / claim 身份绑定），不随顺序或文字变化。
 */
function blockOpen(id) {
  return `<!-- manual:block id=${id} -->`;
}

const BLOCK_CLOSE = '<!-- /manual:block -->';

/** 把 [id, lines] 列表拼成文档；块之间以一个空行分隔。 */
function assemble(blocks, prefix = []) {
  const parts = blocks.filter(([, lines]) => lines.length).map(([id, lines]) => {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return [blockOpen(id), ...lines, BLOCK_CLOSE].join('\n');
  });
  return [...prefix, parts.join('\n\n')].filter((x) => x !== undefined).join('\n') + '\n';
}

/** 图片本身链接到原图，读者点击即可放大；只有人工核对过的图注才显示。 */
function figure(artifact, alt, href, indent = '') {
  const lines = ['', `${indent}[![${alt}](${href})](${href})`];
  if (artifact?.readerCaption) lines.push('', `${indent}*${artifact.readerCaption}*`);
  return lines;
}

/** 相关任务文档同在 tasks/ 目录；没有标题时退回任务 id。 */
function relatedLine(item) {
  const { id, title } = typeof item === 'string' ? { id: item, title: null } : item;
  return `- [${title || id}](${id}.md)`;
}

/**
 * 任务指南。copy 只能填充 pack.blocks 中声明的块，调用前应先 validateCopy。
 * 正文只写读者需要的内容；步骤是否实际执行、验证范围等维护信息留在事实包、review-task 与发布记录中。
 */
function renderTask(pack, copy = {}) {
  const t = templateFor(pack.language);
  const hrefOf = new Map(pack.artifacts.map((a) => [a.id, a.markdownHref]));
  const blocks = [];
  const overview = [`# ${pack.title}`];
  const intro = blockText(pack, copy, 'intro');
  if (intro) overview.push('', intro);
  if (pack.provenance === 'simulated' && pack.artifacts.length) overview.push('', t.simulated);
  blocks.push(['overview', overview]);
  if (pack.preconditions.length) blocks.push(['before', [`## ${t.before}`, '', ...pack.preconditions.map((item) => `- ${item}`)]]);
  const stepsHead = [`## ${t.steps}`];
  if (pack.entry?.route) stepsHead.push('', t.entryLead(`[${pack.entry.title || pack.title}](${pack.entry.route})`));
  blocks.push(['steps', stepsHead]);
  pack.steps.forEach((step, index) => {
    const note = withoutRepeatedAction(blockText(pack, copy, `step.${step.id}`), step.sentence, pack.language);
    // 已批准的短位置说明可放在动作前，读者先知道到哪里操作。
    const location = pack.language === 'zh-CN' && step.sentenceSource === 'action'
      ? /^(?:入口(?:图标)?|发送按钮)位于([^。]+)。?/.exec(note) : null;
    const inlineLocation = pack.language === 'zh-CN' && step.sentenceSource === 'action'
      ? new RegExp(`^在([^。]+?)${step.sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}。?$`).exec(note) : null;
    const action = location ? `在${location[1]}，${step.sentence}` : inlineLocation ? `在${inlineLocation[1]}${step.sentence}` : step.sentence;
    const remainder = location ? note.slice(location[0].length).trim() : inlineLocation ? '' : note;
    const L = [`<!-- step:${step.id} -->`];
    if (/^(?:选择前|点击前|提交前|操作前)/.test(remainder)) {
      const [, check, after = ''] = /^(?:选择前|点击前|提交前|操作前)[，,]?\s*([^。]+)[。.]?\s*(.*)$/.exec(remainder) || [];
      L.push(`${index + 1}. ${check}，再${action}`);
      if (after) L.push('', `   ${after}`);
    }
    else { L.push(`${index + 1}. ${action}`); if (remainder) L.push('', `   ${remainder}`); }
    for (const ref of step.artifactRefs) {
      const artifact = pack.artifacts.find((a) => a.id === ref);
      L.push(...figure(artifact, artifact?.readerCaption || t.stepAlt(index + 1, artifact?.timing), hrefOf.get(ref), '   '));
    }
    blocks.push([`step.${step.id}`, L]);
  });
  if (pack.claims.length || pack.readerChecks?.length) {
    const completion = [`## ${t.completion}`, ''];
    for (const claim of pack.claims) completion.push(`<!-- claim:${claim.id} -->`, `${claimLabel(claim.status, t)}${claim.text}`, '');
    if (pack.readerChecks?.length) completion.push(`### ${t.readerChecks}`, '', ...pack.readerChecks.map((item) => `- ${item}`), '');
    blocks.push(['completion', completion]);
  }
  if (pack.branches.length) blocks.push(['branches', [`## ${t.branches}`, ...pack.branches.flatMap((b) => ['', `**${b.condition}**`, '', b.effect])]]);
  const related = pack.related || (pack.relatedTasks || []);
  if (related.length) blocks.push(['related', [`## ${t.related}`, '', ...related.map(relatedLine)]]);
  return assemble(blocks);
}

/** 页面手册。detectedActions 没有逐项浏览器证据：只在没有 guide 时列出，并提示以实际界面为准。 */
function renderPage(pack, copy = {}, { draft = false } = {}) {
  const t = templateFor(pack.language);
  const overview = [`# ${pack.title}`];
  const intro = blockText(pack, copy, 'intro');
  if (intro) overview.push('', intro);
  const location = [t.pageEntry(`[${pack.title}](${pack.route})`)];
  for (const artifact of pack.artifacts) location.push(...figure(artifact, pack.title, artifact.markdownHref));
  const blocks = [['overview', overview], ['location', location]];
  // 编号与截图标注一致：标注按 guide 下标 i + 1 编号（含没有 target 的条目），标题用同一编号
  for (const [i, item] of (pack.guide || []).entries()) {
    const lines = [`## ${i + 1}. ${item.title}`, '', item.instruction];
    if (item.taskId) lines.push('', `[${t.guideLink}](tasks/${item.taskId}.md)`);
    blocks.push([`guide.${item.id}`, lines]);
  }
  if (!pack.guide?.length && pack.actions.length) blocks.push(['actions', [`## ${t.actionsInferred}`, '', t.actionsInferredNote, '', ...pack.actions.map((action, i) => `${i + 1}. ${action.text}`)]]);
  // 草稿头部的来源注释只用于人工核对，不进入正式文档
  return assemble(blocks, draft ? [...pack.headerComments, ''] : []);
}

module.exports = { BLOCK_CLOSE, blockOpen, TEMPLATES, TEMPLATE_VERSION, TemplateError, templateFor, templateRevision, actionSentence, visibleTargetName, claimLabel, renderTask, renderPage };
