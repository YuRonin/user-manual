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
    tip: '提示：',
    // 完成声明的两个标签必须互不包含：等级由程序按证据决定，定稿校验按前缀区分。
    verified: '完成标志：',
    expected: '预期结果：',
    simulated: '> 说明：截图中的数据为示例数据，实际内容以你的页面为准。',
    // 风险边界之后没有实际执行的步骤（B3-06）：与已验证步骤区分开
    notExecuted: '   > 未验证：生成手册时没有实际执行这一步，结果仅供操作参考。',
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
    tip: 'Tip: ',
    verified: 'You will see: ',
    expected: 'Expected result: ',
    simulated: '> Note: the data in the screenshots is sample data. Your page shows your own content.',
    notExecuted: '   > Not verified: this step was not performed when the guide was generated; treat the result as reference only.',
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
// render-15：任务步骤有 title 时，在 step 注释后写 <!-- step-title: … -->，供帮助中心目录使用；正文不变。
// render-17：分类页面每节一组连续编号的步骤（标注号即步骤号），图片紧跟相关步骤且不再重复图例；
//            步骤可带结果说明，小节可带提示，页面末尾可带常见问题。
const TEMPLATE_VERSION = 'render-17';

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

// 超过这个长度的可访问名称（题目卡、产物按钮的整段 aria-label）不适合写进"点击「……」"
const MAX_ACTION_NAME = 16;

/**
 * 步骤的动作句：由动作类型 + 可见目标确定性生成；没有可见名称时回退到已批准的步骤说明。
 * 名称过长或含换行时也用步骤说明（B3-10）：定位仍用原目标，正文给读者能读懂的话。
 */
function actionSentence(step, template) {
  const action = step.action || {};
  const name = visibleTargetName(action.target);
  const fn = template.action[action.type];
  const unreadable = name && (String(name).length > MAX_ACTION_NAME || /\n/.test(name));
  if (!fn || (!name && action.type !== 'inspect') || (unreadable && step.instruction)) return { text: step.instruction, source: 'instruction' };
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
    // 目录短名称只放在注释里，读者正文不变；格式由 schema 的步骤标题规则保证不会提前闭合注释
    if (step.title) L.push(`<!-- step-title: ${step.title} -->`);
    if (/^(?:选择前|点击前|提交前|操作前)/.test(remainder)) {
      const [, check, after = ''] = /^(?:选择前|点击前|提交前|操作前)[，,]?\s*([^。]+)[。.]?\s*(.*)$/.exec(remainder) || [];
      L.push(`${index + 1}. ${check}，再${action}`);
      if (after) L.push('', `   ${after}`);
    }
    else { L.push(`${index + 1}. ${action}`); if (remainder) L.push('', `   ${remainder}`); }
    if (step.executed === false) L.push('', t.notExecuted);
    for (const claim of pack.claims.filter((c) => c.stepId === step.id)) L.push('', `<!-- claim:${claim.id} -->`, `${claimLabel(claim.status, t)}${claim.text}`);
    for (const ref of step.artifactRefs) {
      const artifact = pack.artifacts.find((a) => a.id === ref);
      L.push(...figure(artifact, artifact?.readerCaption || t.stepAlt(index + 1, artifact?.timing), hrefOf.get(ref), '   '));
    }
    blocks.push([`step.${step.id}`, L]);
  });
  if (pack.claims.length || pack.readerChecks?.length) {
    const completion = [`## ${t.completion}`, ''];
    for (const claim of pack.claims.filter((c) => !c.stepId)) completion.push(`<!-- claim:${claim.id} -->`, `${claimLabel(claim.status, t)}${claim.text}`, '');
    if (pack.readerChecks?.length) completion.push(`### ${t.readerChecks}`, '', ...pack.readerChecks.map((item) => `- ${item}`), '');
    blocks.push(['completion', completion]);
  }
  if (pack.branches.length) blocks.push(['branches', [`## ${t.branches}`, ...pack.branches.flatMap((b) => ['', `**${b.condition}**`, '', b.effect])]]);
  const related = pack.related || (pack.relatedTasks || []);
  if (related.length) blocks.push(['related', [`## ${t.related}`, '', ...related.map(relatedLine)]]);
  return assemble(blocks);
}

/** 分类页面里一个功能的正文块 id：保留旧 guide 块身份，三方合并才能继续保护人工编辑。 */
function stepBlockId(feature) {
  return feature.guideId ? `guide.${feature.guideId}` : `feature.${feature.id ?? feature.feature_id}`;
}

/**
 * 分类页面的一个小节：标题与使用场景 → 连续编号的步骤（结果说明缩进在步骤下）→ 相关截图 → 补充说明 → 提示。
 * 截图跟在它标注的最后一个步骤（或以它为结果图的步骤）所在的功能块之后；图上标注号就是步骤号，图下不再列图例。
 */
function sectionBlocks(pack, section, t) {
  const { sectionSteps } = require('../annotations/section-plan');
  const steps = sectionSteps(pack, section);
  const blocks = [[`section.${section.id}`, [`## ${section.title}`, '', section.goal]]];
  const figures = section.figureRefs.map((id) => pack.figures.find((f) => f.id === id)).filter(Boolean);
  // 每张图挂在哪个功能块后面：取它关联的最大步骤号所在的功能
  const anchorOf = new Map(figures.map((fig) => {
    const related = steps.filter((s) => s.step && (fig.operationRefs.includes(s.op.id) || s.op.outcomeFigure === fig.id));
    return [fig.id, related.length ? related[related.length - 1].op.featureId : null];
  }));
  const figureBlocks = (fig) => pack.artifacts.filter((a) => a.figureId === fig.id).map((artifact) => {
    const lines = [...figure(artifact, fig.caption, artifact.markdownHref)];
    if (artifact.privacy?.demo?.sources?.api_mock || artifact.privacy?.demo?.sources?.fixture) lines.push('', t.simulated);
    return [`figure.${fig.id}.${artifact.part || 1}`, lines];
  });
  for (const id of section.featureRefs) {
    const feature = pack.features.find((f) => (f.id ?? f.feature_id) === id);
    const own = steps.filter((s) => s.op.featureId === id);
    const lines = [''];
    for (const { op, step } of own.filter((s) => s.step)) {
      lines.push(`${step}. ${op.instruction}`);
      // 列表项的续行缩进到序号之后，Markdown 才会把结果说明归到这一步里
      if (op.outcome) lines.push('', `${' '.repeat(String(step).length + 2)}${op.outcome}`);
    }
    // 说明类内容不进编号步骤，写成步骤之后的普通段落
    for (const { op } of own.filter((s) => !s.step)) {
      lines.push('', op.instruction);
      if (op.outcome) lines.push('', op.outcome);
    }
    if (feature.taskId) lines.push('', `[${t.guideLink}](tasks/${feature.taskId}.md)`);
    blocks.push([stepBlockId(feature), lines]);
    for (const fig of figures.filter((f) => anchorOf.get(f.id) === id)) blocks.push(...figureBlocks(fig));
  }
  for (const fig of figures.filter((f) => !anchorOf.get(f.id))) blocks.push(...figureBlocks(fig));
  if (section.tips?.length) blocks.push([`tips.${section.id}`, section.tips.flatMap((tip) => ['', `> ${t.tip}${tip}`])]);
  return blocks;
}

/** 页面手册。detectedActions 没有逐项浏览器证据：只在没有 guide 时列出，并提示以实际界面为准。 */
function renderPage(pack, copy = {}, { draft = false } = {}) {
  const t = templateFor(pack.language);
  const overview = [`# ${pack.title}`];
  const intro = blockText(pack, copy, 'intro');
  if (intro) overview.push('', intro);
  if (pack.sections?.length) {
    const blocks = [['overview', overview], ['location', [t.pageEntry(`[${pack.title}](${pack.route})`)]]];
    for (const section of pack.sections) blocks.push(...sectionBlocks(pack, section, t));
    if (pack.faq?.length) blocks.push(['faq', [`## ${t.branches}`, ...pack.faq.flatMap((item) => ['', `**${item.question}**`, '', item.answer])]]);
    return assemble(blocks, draft ? [...pack.headerComments, ''] : []);
  }
  const location = [t.pageEntry(`[${pack.title}](${pack.route})`)];
  for (const artifact of pack.artifacts.filter((a) => !a.scenarioId)) location.push(...figure(artifact, pack.title, artifact.markdownHref));
  const blocks = [['overview', overview], ['location', location]];
  for (const scenarioId of [...new Set(pack.artifacts.map((a) => a.scenarioId).filter(Boolean))]) {
    const artifacts = pack.artifacts.filter((a) => a.scenarioId === scenarioId);
    const title = artifacts[0].variantTitle;
    const lines = [`## ${title}`];
    for (const artifact of artifacts) lines.push(...figure(artifact, title, artifact.markdownHref));
    for (const explanation of artifacts.flatMap((a) => a.featureExplanations || [])) lines.push('', explanation.text);
    if (artifacts.some((a) => a.privacy?.demo?.sources?.api_mock || a.privacy?.demo?.sources?.fixture)) lines.push('', t.simulated);
    blocks.push([`variant.${scenarioId}`, lines]);
  }
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

module.exports = { BLOCK_CLOSE, blockOpen, TEMPLATES, TEMPLATE_VERSION, TemplateError, templateFor, templateRevision, actionSentence, visibleTargetName, claimLabel, renderTask, renderPage, stepBlockId };
