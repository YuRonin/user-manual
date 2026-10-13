'use strict';

const { sha256Hex } = require('../util/hash');
const { inspectWithRetry, locateReason } = require('../evidence/capture-safe');

function candidatesOf(semantic) {
  return (semantic?.items || []).filter((i) => i.locator && i.resolution === 'unique' && i.name && !i.name.includes('[redacted]'))
    .map((i) => ({ id: `control-${sha256Hex(JSON.stringify(i.locator)).slice(0, 16)}`, role: i.role, name: i.name, target: { ...i.locator, exact: true } }));
}

async function bindOperation(provider, item, semantic, choice = null) {
  const candidates = candidatesOf(semantic).filter(c => !item.bindingIntent?.role || c.role === item.bindingIntent.role);
  let target = item.target;
  if (!choice && target?.role && item.bindingIntent?.role && target.role !== item.bindingIntent.role) return { status: 'unresolved', reason: 'binding-role-mismatch', candidates };
  let selected = null;
  let source = 'explicit-hint';
  if (choice) {
    const candidate = candidates.find((c) => c.id === choice.candidateId);
    if (!candidate) return { status: 'unresolved', reason: 'binding-candidate-stale', candidates };
    target = candidate.target;
    selected = candidate;
    source = 'model-candidate';
  }
  if (!target && item.bindingIntent?.name) {
    const matches = candidates.filter((c) => c.name === item.bindingIntent.name && (!item.bindingIntent.role || c.role === item.bindingIntent.role));
    if (matches.length === 1) { target = matches[0].target; selected = matches[0]; source = 'unique-name'; }
    else if (matches.length > 1) return { status: 'ambiguous', reason: 'target-ambiguous', candidates: matches };
  }
  if (!target) return { status: 'unresolved', reason: 'binding-input-required', candidates };
  try {
    const found = await inspectWithRetry(provider, target);
    if (!found.rect || found.obscuredBy) return { status: 'unresolved', reason: found.obscuredBy ? 'target-occluded' : 'target-not-located', candidates };
    if (source === 'explicit-hint') {
      const identity = item.bindingIntent || (target.role ? { role: target.role, name: target.name } : null);
      const matching = candidates.filter(c => (!identity?.name || c.name === identity.name) && (!identity?.role || c.role === identity.role));
      selected = provider.matchBindingCandidate ? await provider.matchBindingCandidate(target, matching) : null;
      // 限定了所在区域的提示（within）用于每张卡片 / 每行都有一个的重复控件：这类控件在整页上必然不唯一，
      // 不会出现在全局候选里。只要限定后能唯一定位到可见元素，就按显式提示通过，不再要求全局候选同名。
      const scoped = !!target.within && !!found.rect;
      if (!selected && identity && !scoped) return { status: 'unresolved', reason: 'binding-identity-mismatch', candidates };
      // Freeze the verified semantic strategy instead of a potentially broad hint or fallback.
      // Unnamed source-backed regions keep their explicit hint and verified geometry.
      if (selected) target = selected.target;
    }
    return { status: 'verified', target, found, source, name: selected?.name || target.name || null, role: selected?.role || target.role || null, operationId: item.operation_id, figureId: item.figure_id };
  } catch (error) { return { status: error.code === 'target-ambiguous' ? 'ambiguous' : 'unresolved', reason: locateReason(error), candidates }; }
}

module.exports = { candidatesOf, bindOperation };
