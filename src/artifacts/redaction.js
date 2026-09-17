'use strict';

const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const UNCERTAIN_LABEL = /姓名|学校|会话标题|昵称/;

function planRedactions(elements, rules = {}) {
  const redact = new Set(rules.redact || []);
  const preserve = new Set(rules.preserve || []);
  const errors = [];
  for (const item of redact) if (preserve.has(item)) errors.push(`redact 与 preserve 冲突: ${item}`);
  const redactions = [];
  for (const element of elements || []) {
    const label = String(element.label || '');
    let kind = null;
    if (PHONE.test(String(element.text || ''))) kind = 'phone';
    else if (EMAIL.test(String(element.text || ''))) kind = 'email';
    else if (/账号|用户ID/i.test(label)) kind = 'account';
    else if (redact.has(label)) kind = 'semantic';
    else if (UNCERTAIN_LABEL.test(label) && !preserve.has(label)) {
      errors.push(`${label || '未知字段'} 的敏感性无法可靠判断，需要人工确认 redact 或 preserve。`);
      continue;
    }
    if (kind && !preserve.has(label)) redactions.push({ kind, rect: element.rect, result: 'opaque-mask' });
  }
  return errors.length ? { ok: false, errors, redactions: [] } : { ok: true, redactions };
}

module.exports = { planRedactions };
