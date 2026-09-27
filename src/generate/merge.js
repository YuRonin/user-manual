'use strict';

/*
 * 人工编辑保护：旧生成 / 当前手改 / 新生成三方合并（P3-06，契约 C11）。
 *
 * 文档由生成块（<!-- manual:block id=… --> … <!-- /manual:block -->）与块之间的人工内容组成：
 *   - 块之间（及文档首尾）的文字属于人工（ownership=human），按其前一个块锚定，永远保留；
 *   - 生成块属于生成器；块头写 owner=human 的块由人接管，生成器不覆盖也不报冲突；
 *   - 同一生成块：只有生成器改了 → 用新版；只有人改了 → 保留人改；两边都改且不同 → 冲突；
 *   - 人删掉生成块 → 冲突（删的可能是事实块，不能静默恢复也不能静默丢掉）；
 *   - 新生成新增的块按新顺序插入；新生成删掉的块若人没改过就删掉，人改过 → 冲突。
 * 没有块标记的文档（旧模板 / 润色稿）整篇视为一个块：两边都改就是冲突。
 *
 * 标记用 markdown-it 定位（只认顶层 html_block），代码块里的同形文字不会被当成标记。
 */

const MarkdownIt = require('markdown-it');

const parser = new MarkdownIt({ html: true });
const OPEN_RE = /^<!--\s*manual:block\s+id=([A-Za-z0-9._:-]+)(?:\s+owner=(generated|human))?\s*-->$/;
const CLOSE_RE = /^<!--\s*\/manual:block\s*-->$/;
const WHOLE = '(document)';

class MergeParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeParseError';
    this.code = 'manual-structure-invalid';
  }
}

function normalize(text) {
  return String(text).replace(/\r\n/g, '\n');
}

/**
 * 解析文档结构。
 * @returns {{ marked, blocks: Map<id,{id, owner, content}>, order: string[], human: Array<{anchor, text}> }}
 */
function parseManual(markdown) {
  const text = normalize(markdown);
  const lines = text.split('\n');
  const markers = [];
  for (const token of parser.parse(text, {})) {
    if (token.type !== 'html_block' || token.level !== 0 || !token.map) continue;
    const line = token.content.trim();
    const open = OPEN_RE.exec(line);
    if (open) markers.push({ line: token.map[0], type: 'open', id: open[1], owner: open[2] || 'generated' });
    else if (CLOSE_RE.test(line)) markers.push({ line: token.map[0], type: 'close' });
  }
  if (markers.length === 0) {
    return { marked: false, blocks: new Map([[WHOLE, { id: WHOLE, owner: 'generated', content: text }]]), order: [WHOLE], human: [] };
  }
  const blocks = new Map();
  const order = [];
  const human = [];
  let cursor = 0;
  let anchor = null;
  let current = null;
  const pushHuman = (from, to) => {
    const chunk = lines.slice(from, to).join('\n').trim();
    if (chunk) human.push({ anchor, text: chunk });
  };
  for (const marker of markers) {
    if (marker.type === 'open') {
      if (current) throw new MergeParseError(`块 ${current.id} 没有结束标记就开始了块 ${marker.id}。`);
      if (blocks.has(marker.id)) throw new MergeParseError(`块 ID 重复: ${marker.id}`);
      pushHuman(cursor, marker.line);
      current = { id: marker.id, owner: marker.owner, start: marker.line + 1 };
    } else {
      if (!current) throw new MergeParseError(`第 ${marker.line + 1} 行有多余的块结束标记。`);
      blocks.set(current.id, { id: current.id, owner: current.owner, content: lines.slice(current.start, marker.line).join('\n') });
      order.push(current.id);
      anchor = current.id;
      cursor = marker.line + 1;
      current = null;
    }
  }
  if (current) throw new MergeParseError(`块 ${current.id} 缺少结束标记。`);
  pushHuman(cursor, lines.length);
  return { marked: true, blocks, order, human };
}

/** 按块顺序与人工锚点拼回文档。 */
function serialize({ marked, blocks, order, human }) {
  if (!marked) return blocks.get(WHOLE).content;
  const parts = [];
  const humanAfter = (anchor) => human.filter((h) => h.anchor === anchor).map((h) => h.text);
  parts.push(...humanAfter(null));
  for (const id of order) {
    const block = blocks.get(id);
    const open = block.owner === 'human' ? `<!-- manual:block id=${id} owner=human -->` : `<!-- manual:block id=${id} -->`;
    parts.push([open, block.content, '<!-- /manual:block -->'].join('\n'));
    parts.push(...humanAfter(id));
  }
  return parts.join('\n\n') + '\n';
}

/**
 * 三方合并。
 * @param {{ base: string|null, current: string, next: string }} p
 * @returns {{ ok, markdown, proposed, conflicts, acceptedEdits, mode }}
 *   mode: unchanged（当前即新版）/ regenerated（无人工修改）/ kept（生成内容未变，保留当前原文）/ merged / conflict
 */
function mergeManual({ base, current, next }) {
  const cur = normalize(current);
  const nxt = normalize(next);
  if (cur === nxt) return { ok: true, markdown: next, proposed: next, conflicts: [], acceptedEdits: [], mode: 'unchanged' };
  if (base !== null && base !== undefined) {
    const b = normalize(base);
    if (cur === b) return { ok: true, markdown: next, proposed: next, conflicts: [], acceptedEdits: [], mode: 'regenerated' };
    // 生成内容没有变化：保留当前文档原样（不重排空行，不重写人工内容）
    if (nxt === b) return { ok: true, markdown: current, proposed: current, conflicts: [], acceptedEdits: [{ kind: 'document', id: WHOLE }], mode: 'kept' };
  }
  const B = base === null || base === undefined ? null : parseManual(base);
  const C = parseManual(cur);
  const N = parseManual(nxt);
  if (!B) {
    return conflictResult([{ blockId: WHOLE, kind: 'base-missing', current: cur, next: nxt }], nxt);
  }
  if (!C.marked || !N.marked || !B.marked) {
    return conflictResult([{ blockId: WHOLE, kind: 'document-edited', base: normalize(base), current: cur, next: nxt }], nxt);
  }

  const conflicts = [];
  const acceptedEdits = [];
  const result = new Map();
  for (const id of N.order) {
    const nb = N.blocks.get(id);
    const cb = C.blocks.get(id);
    const bb = B.blocks.get(id);
    if (cb && cb.owner === 'human') { result.set(id, cb); acceptedEdits.push({ kind: 'human-owned-block', id }); continue; }
    if (!bb) {
      // 新生成新增的块；当前文档里若已有同 ID 且内容不同（人工预先写入），按冲突处理
      if (cb && cb.content !== nb.content) conflicts.push({ blockId: id, kind: 'both-added', current: cb.content, next: nb.content });
      result.set(id, nb);
      continue;
    }
    if (!cb) {
      conflicts.push({ blockId: id, kind: 'deleted-by-user', base: bb.content, current: null, next: nb.content });
      result.set(id, nb);
      continue;
    }
    if (cb.content === bb.content || cb.content === nb.content) { result.set(id, nb); continue; }
    if (nb.content === bb.content) { result.set(id, cb); acceptedEdits.push({ kind: 'edited-block', id }); continue; }
    conflicts.push({ blockId: id, kind: 'both-modified', base: bb.content, current: cb.content, next: nb.content });
    result.set(id, nb);
  }
  // 新生成删掉的块：人没改过 → 删；人改过或接管过 → 冲突 / 保留
  for (const id of B.order) {
    if (N.blocks.has(id)) continue;
    const cb = C.blocks.get(id);
    if (!cb) continue;
    if (cb.owner === 'human') { acceptedEdits.push({ kind: 'human-owned-block', id }); continue; }
    if (cb.content !== B.blocks.get(id).content) conflicts.push({ blockId: id, kind: 'removed-but-edited', base: B.blocks.get(id).content, current: cb.content, next: null });
  }

  // 顺序：以新生成为准；人接管且新生成已删除的块接在原前驱之后
  const order = [...N.order];
  for (const id of C.order) {
    const cb = C.blocks.get(id);
    if (N.blocks.has(id) || cb.owner !== 'human') continue;
    const before = C.order.slice(0, C.order.indexOf(id)).reverse().find((prev) => order.includes(prev));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
    result.set(id, cb);
  }
  // 块之间的内容（按前一个块锚定）同样三方比较：生成器也可能在块外写内容（润色稿、草稿头），
  // 只有人加的 → 保留；只有生成器改的 → 用新版；两边都改且不同 → 冲突。
  const reanchor = (h) => {
    if (h.anchor === null || order.includes(h.anchor)) return h.anchor;
    return C.order.slice(0, C.order.indexOf(h.anchor)).reverse().find((prev) => order.includes(prev)) || null;
  };
  const gaps = (doc, fix = (h) => h.anchor) => {
    const map = new Map();
    for (const h of doc.human) {
      const anchor = fix(h);
      map.set(anchor, map.has(anchor) ? `${map.get(anchor)}\n\n${h.text}` : h.text);
    }
    return map;
  };
  const gB = gaps(B);
  const gC = gaps(C, reanchor);
  const gN = gaps(N);
  const human = [];
  for (const anchor of new Set([...gB.keys(), ...gC.keys(), ...gN.keys()])) {
    const b = gB.get(anchor) ?? '';
    const c = gC.get(anchor) ?? '';
    const n = gN.get(anchor) ?? '';
    let text;
    if (c === b || c === n) text = n;
    else if (n === b) { text = c; acceptedEdits.push({ kind: 'human-text', anchor }); }
    else { conflicts.push({ blockId: `(after ${anchor ?? 'start'})`, kind: 'both-modified-text', base: b, current: c, next: n }); text = n; }
    if (text) human.push({ anchor, text });
  }
  const markdown = serialize({ marked: true, blocks: result, order, human });
  if (conflicts.length) return { ok: false, markdown: null, proposed: markdown, conflicts, acceptedEdits, mode: 'conflict' };
  return { ok: true, markdown, proposed: markdown, conflicts: [], acceptedEdits, mode: 'merged' };
}

function conflictResult(conflicts, proposed) {
  return { ok: false, markdown: null, proposed, conflicts, acceptedEdits: [], mode: 'conflict' };
}

/** 冲突说明（纯文本，逐块给出旧生成 / 当前 / 新生成）。 */
function describeConflicts(conflicts) {
  const show = (label, text) => (text === null || text === undefined ? [`--- ${label}: （无）`] : [`--- ${label}:`, ...String(text).split('\n').map((l) => `    ${l}`)]);
  const out = [];
  for (const c of conflicts) {
    out.push(`## 块 ${c.blockId}（${c.kind}）`);
    if ('base' in c) out.push(...show('上次生成', c.base));
    out.push(...show('当前文档（人工修改）', c.current));
    out.push(...show('新生成', c.next));
    out.push('');
  }
  return out.join('\n');
}

module.exports = { WHOLE, MergeParseError, parseManual, serialize, mergeManual, describeConflicts };
