'use strict';

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SEMANTIC_LABEL = /姓名|学校|会话标题|昵称/;
const ACCOUNT_LABEL = /账号|用户\s*ID|UID/i;
const CREDENTIAL_LABEL = /password|passcode|token|access[_ -]?token|secret|api[_ -]?key|密码|密钥/i;

function normalizePolicy(policy = {}) {
  if (policy.redact || policy.preserve) {
    return { audience: 'public', rules: { redact: policy.redact || [], preserve: policy.preserve || [] } };
  }
  return {
    audience: policy.audience === 'internal' ? 'internal' : 'public',
    rules: {
      redact: Array.isArray(policy.rules?.redact) ? policy.rules.redact : [],
      preserve: Array.isArray(policy.rules?.preserve) ? policy.rules.preserve : [],
    },
  };
}

function ruleMatches(rule, candidate) {
  if (typeof rule === 'string') return rule === candidate.label;
  if (!rule || typeof rule !== 'object') return false;
  if (rule.page && rule.page !== candidate.pagePath) return false;
  if (rule.label && rule.label !== candidate.label) return false;
  if (rule.selector && rule.selector !== candidate.selectorHint) return false;
  return !!(rule.page || rule.label || rule.selector);
}

function isAlreadyObscured(value) {
  const text = String(value || '').trim();
  return /[*•·]{2,}|\.{3,}|…/.test(text) || /^\d{2,4}[- ]?\*{3,}[- ]?\d{2,4}$/.test(text);
}

function classifyCandidate(candidate, policy) {
  const text = String(candidate.text || '');
  const label = String(candidate.label || '');
  if (isAlreadyObscured(text)) return null;
  if (candidate.inputType === 'password' || CREDENTIAL_LABEL.test(label)) {
    return { kind: 'credential', confidence: 'high', forced: true };
  }
  if (PHONE.test(text)) return { kind: 'phone', confidence: 'high', forced: true };
  if (EMAIL.test(text)) return { kind: 'email', confidence: 'high', forced: true };
  if (ACCOUNT_LABEL.test(label)) return { kind: 'account', confidence: 'high', forced: true };
  if (candidate.source === 'explicit') return { kind: 'explicit', confidence: 'high', forced: true };

  const explicitRedact = policy.rules.redact.some((rule) => ruleMatches(rule, candidate));
  const explicitPreserve = policy.rules.preserve.some((rule) => ruleMatches(rule, candidate));
  if (explicitRedact) return { kind: 'semantic', confidence: 'configured', forced: false };
  if (explicitPreserve) return null;
  if (policy.audience === 'public' && SEMANTIC_LABEL.test(label)) {
    return { kind: 'semantic', confidence: 'medium', forced: false };
  }
  return null;
}

function detectRedactions(candidates, rawPolicy = {}) {
  const policy = normalizePolicy(rawPolicy);
  const errors = [];
  for (const redact of policy.rules.redact) {
    if (policy.rules.preserve.some((preserve) => JSON.stringify(preserve) === JSON.stringify(redact))) {
      errors.push(`redact 与 preserve 冲突: ${typeof redact === 'string' ? redact : JSON.stringify(redact)}`);
    }
  }
  if (errors.length) return { ok: false, errors, redactions: [] };

  const redactions = [];
  for (const candidate of candidates || []) {
    const classified = classifyCandidate(candidate, policy);
    if (!classified) continue;
    redactions.push({
      kind: classified.kind,
      rect: candidate.rect,
      source: candidate.source || 'unknown',
      confidence: classified.confidence,
      result: 'neutral-mosaic',
    });
  }
  return { ok: true, redactions };
}

module.exports = { detectRedactions, classifyCandidate, isAlreadyObscured, normalizePolicy };
