'use strict';

/*
 * 文案真实性（B3-02 / B3-04 / B3-05）：不只看「」。
 *
 * 文案里声称的两类东西必须能在事实里找到依据：
 *   控件     "点击右上角的导出按钮"这类动作表达里的控件名（带不带「」都算）
 *   结果     "系统会生成 PDF 报告""发送到邮箱"这类操作后果
 * 依据来源分两级：observed（采集时在页面上真实观察到：执行过的动作目标、截图时的无障碍树）与
 * declared（作者 / 模型写下的 instruction、goal、guide、claims）。
 *
 * 结论只有两种（不把正则命中当作事实证明）：
 *   ui-term-not-observed   控件名没有被观察到（只在声明里出现，或哪里都没有）→ 需要人确认
 *   unsupported-result     操作后果在已执行的断言、完成声明、读者检查与默认文案里都找不到 → 需要人确认
 * 名称完全不在事实里的「」由 validateCopy 的 ui-term-unknown 直接拒绝。
 */

const CONTROL_RE = /(点击|单击|点按|轻触|选择|打开|上传|保存|发送|勾选|切换到|进入|展开)(?:页面)?(?:右上角|右下角|左上角|左下角|顶部|底部|左侧|右侧|上方|下方|旁边)?的?([^\s，。；、！？「」,.()（）]{1,12}?)(按钮|菜单项|菜单|选项|标签页|标签|链接|开关|入口|图标)/g;
const RESULT_RE = /(?:系统|页面|平台|随后|然后)?(?:会|将会|将|就会|自动)\s*(?:自动)?(生成|发送|导出|下载|同步|通知|推送|删除|扣费|扣款|提交|创建|发布|上传|保存)([^，。；！？\n]{0,16})/g;
const DESTINATION_RE = /(?:发送|推送|同步|转发)(?:到|至)(?:你的|您的)?([^\s，。；！？]{1,8})/g;
const FILLER_RE = /^(?:一份|一个|一条|这份|该|新的|你的|您的|相应的|对应的|并|到|至|给)+/;

const norm = (text) => String(text || '').replace(/\s+/g, '').toLocaleLowerCase();

function covered(name, terms) {
  const n = norm(name);
  if (!n) return true;
  return terms.some((term) => { const t = norm(term); return t && (t === n || t.includes(n) || n.includes(t)); });
}

/** 结果宾语的核心词：去掉量词与连接词后取前几个字。 */
function objectCore(text) {
  return norm(text).replace(FILLER_RE, '').replace(/[并和及与].*$/, '').slice(0, 6);
}

/** 依据文本：块默认值、完成声明、读者检查、步骤句与说明、页面用途与指南。 */
function supportText(pack, blockId) {
  return norm([
    pack.blocks?.[blockId]?.default,
    ...(pack.claims || []).map((claim) => claim.text),
    ...(pack.readerChecks || []),
    ...(pack.steps || []).map((step) => step.sentence),
    ...Object.values(pack.blocks || {}).map((block) => block.default),
    ...(pack.guide || []).map((item) => `${item.title} ${item.instruction}`),
    ...(pack.results || []),
    // 界面上真实存在的控件名本身就说明了它的作用（「保存修改」支撑"会保存修改"）
    ...(pack.allowedUiTerms || []),
    ...(pack.uiEvidence?.observed || []),
  ].filter(Boolean).join('\n'));
}

/**
 * @param {object} pack   事实包（含可选 uiEvidence: { observed[], declared[] }）
 * @param {string} blockId
 * @param {string} value  文案文本
 * @returns {Array<{ code, detail }>} review 级别的发现
 */
function groundingFindings(pack, blockId, value) {
  const findings = [];
  const text = String(value || '');
  const evidence = pack.uiEvidence || null;
  const observed = evidence?.observed || [];
  const known = [...new Set([...(pack.allowedUiTerms || []), ...observed])];
  const defaults = String(pack.blocks?.[blockId]?.default || '');
  const notObserved = new Set();
  // 「」里的名称：在白名单里但只出现在声明中（没被观察到），且默认文案里也没有
  if (evidence) {
    for (const [, term] of text.matchAll(/「([^」]+)」/g)) {
      if ((pack.allowedUiTerms || []).includes(term) && !covered(term, observed) && !defaults.includes(term)) notObserved.add(term);
    }
  }
  // 不带「」的控件表达：控件名既不在白名单也没被观察到
  for (const match of text.matchAll(CONTROL_RE)) {
    const name = match[2];
    const withKind = `${match[2]}${match[3]}`;
    if (defaults.includes(withKind) || defaults.includes(name)) continue;
    if (!covered(name, known) && !covered(withKind, known)) notObserved.add(withKind);
  }
  if (notObserved.size) findings.push({ code: 'ui-term-not-observed', detail: [...notObserved] });
  // 操作后果：动词 + 宾语核心在依据文本里找不到
  const support = supportText(pack, blockId);
  const unsupported = new Set();
  for (const match of text.matchAll(RESULT_RE)) {
    const core = objectCore(match[2]);
    const phrase = `${match[1]}${core}`;
    // 依据里要同时出现这个动作和它的对象（取对象前两个字，容忍"报告 / 报表"一类的尾字差异）
    const supported = support.includes(norm(match[1])) && (!core || support.includes(core.slice(0, 2)));
    if (!supported) unsupported.add(phrase || match[1]);
  }
  for (const match of text.matchAll(DESTINATION_RE)) {
    const target = objectCore(match[1]);
    if (target && !support.includes(target.slice(0, 2))) unsupported.add(`发送到${target}`);
  }
  if (unsupported.size) findings.push({ code: 'unsupported-result', detail: [...unsupported] });
  return findings;
}

/** 采集记录里观察到的可访问名称（无障碍树摘要，已去掉个人信息）。 */
function observedNamesOf(records = []) {
  return [...new Set(records.flatMap((record) => (record?.semantic?.items || []).map((item) => String(item.name || '').trim()))
    .filter((name) => name && !name.includes('[redacted]')))];
}

module.exports = { groundingFindings, observedNamesOf, CONTROL_RE, RESULT_RE };
