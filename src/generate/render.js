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
    before: '开始前',
    steps: '操作步骤',
    completion: '完成标志',
    branches: '条件分支',
    related: '相关任务',
    actionsInferred: '主要操作（根据源码推断，尚未在浏览器中逐项验证）',
    route: (route) => `访问地址：\`${route}\``,
    notExecuted: '> 此操作未执行，指南停在提交前。',
    scopeNone: '> 验证范围：本指南的步骤均未实际执行。',
    scopePartial: (n) => `> 验证范围：只实际执行到第 ${n} 步，之后的步骤未执行。`,
    simulated: '> 数据来源：界面状态由测试数据模拟（Fixture），未连接真实后端；以下结果只说明界面如何呈现。',
    verified: '已验证界面结果：',
    expected: '预期业务结果：',
    stepAlt: (n) => `步骤 ${n}`,
    quote: (text) => `「${text}」`,
    action: {
      click: (t) => `点击${t}`,
      fill: (t) => `在${t}中填写内容`,
      select: (t) => `在${t}中选择选项`,
      check: (t) => `勾选${t}`,
      uncheck: (t) => `取消勾选${t}`,
      inspect: (t) => (t ? `查看${t}` : '查看当前页面'),
    },
  },
  'en-US': {
    before: 'Before you start',
    steps: 'Steps',
    completion: 'Completion',
    branches: 'Conditions',
    related: 'Related tasks',
    actionsInferred: 'Main actions (inferred from source code, not yet verified in a browser)',
    route: (route) => `Address: \`${route}\``,
    notExecuted: '> This action was not executed; the guide stops before submitting.',
    scopeNone: '> Verification scope: none of the steps in this guide were executed.',
    scopePartial: (n) => `> Verification scope: only steps up to step ${n} were executed.`,
    simulated: '> Data source: the UI state was simulated with test fixtures, not a live backend; results below only describe how the UI presents it.',
    verified: 'Verified in the UI: ',
    expected: 'Expected result: ',
    stepAlt: (n) => `Step ${n}`,
    quote: (text) => `「${text}」`,
    action: {
      click: (t) => `Click ${t}`,
      fill: (t) => `Fill in ${t}`,
      select: (t) => `Choose an option in ${t}`,
      check: (t) => `Check ${t}`,
      uncheck: (t) => `Uncheck ${t}`,
      inspect: (t) => (t ? `Review ${t}` : 'Review the current page'),
    },
  },
};

// render-2：正文按稳定块 ID 分段（<!-- manual:block id=… --> … <!-- /manual:block -->），供人工编辑保护的三方合并定位（P3-06）。
const TEMPLATE_VERSION = 'render-4';

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

/** 任务指南。copy 只能填充 pack.blocks 中声明的块，调用前应先 validateCopy。 */
function renderTask(pack, copy = {}) {
  const t = templateFor(pack.language);
  const hrefOf = new Map(pack.artifacts.map((a) => [a.id, a.markdownHref]));
  const blocks = [];
  const overview = [`# ${pack.title}`];
  const intro = blockText(pack, copy, 'intro');
  if (intro) overview.push('', intro);
  blocks.push(['overview', overview]);
  blocks.push(['before', [`## ${t.before}`, '', ...pack.preconditions.map((item) => `- ${item}`)]]);
  blocks.push(['steps', [`## ${t.steps}`]]);
  pack.steps.forEach((step, index) => {
    const L = [`<!-- step:${step.id} -->`, `${index + 1}. ${step.sentence}`];
    const note = withoutRepeatedAction(blockText(pack, copy, `step.${step.id}`), step.sentence, pack.language);
    if (note) L.push('', `   ${note}`);
    for (const ref of step.artifactRefs) L.push('', `   ![${t.stepAlt(index + 1)}](${hrefOf.get(ref)})`);
    if (step.executed === false) L.push('', `   ${t.notExecuted}`);
    blocks.push([`step.${step.id}`, L]);
  });
  const completion = [`## ${t.completion}`, ''];
  if (pack.provenance === 'simulated') completion.push(t.simulated, '');
  if (pack.scope.firstSkipped === 0) completion.push(t.scopeNone, '');
  else if (pack.scope.firstSkipped > 0) completion.push(t.scopePartial(pack.scope.firstSkipped), '');
  for (const claim of pack.claims) completion.push(`<!-- claim:${claim.id} -->`, `${claimLabel(claim.status, t)}${claim.text}`, '');
  blocks.push(['completion', completion]);
  if (pack.branches.length) blocks.push(['branches', [`## ${t.branches}`, '', ...pack.branches.map((b) => `- **${b.condition}**：${b.effect}`)]]);
  if (pack.relatedTasks.length) blocks.push(['related', [`## ${t.related}`, '', ...pack.relatedTasks.map((id) => `- ${id}`)]]);
  return assemble(blocks);
}

/** 页面手册。detectedActions 没有逐项浏览器证据，一律带"推断"标题；截图不能把它们提升为已验证。 */
function renderPage(pack, copy = {}, { draft = false } = {}) {
  const t = templateFor(pack.language);
  const overview = [`# ${pack.title}`];
  const intro = blockText(pack, copy, 'intro');
  if (intro) overview.push('', intro);
  const location = [t.route(pack.route)];
  for (const artifact of pack.artifacts) location.push('', `![${pack.title}](${artifact.markdownHref})`);
  const blocks = [['overview', overview], ['location', location]];
  for (const [i, item] of (pack.guide || []).entries()) {
    const lines = [`## ${i + 1}. ${item.title}`, '', item.instruction];
    if (item.taskId) lines.push('', `[查看操作指南](tasks/${item.taskId}.md)`);
    blocks.push([`guide.${item.id}`, lines]);
  }
  if (!pack.guide?.length && pack.actions.length) blocks.push(['actions', [`## ${t.actionsInferred}`, '', ...pack.actions.map((action, i) => `${i + 1}. ${action.text}`)]]);
  // 草稿头部的来源注释只用于人工核对，不进入正式文档
  return assemble(blocks, draft ? [...pack.headerComments, ''] : []);
}

module.exports = { BLOCK_CLOSE, blockOpen, TEMPLATES, TEMPLATE_VERSION, TemplateError, templateFor, templateRevision, actionSentence, visibleTargetName, claimLabel, renderTask, renderPage };
