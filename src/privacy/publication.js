'use strict';

function normalize(file) {
  return String(file || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function validatePublishedImages(images, config) {
  if (config.privacy?.audience !== 'public') return { ok: true, errors: [] };
  const allowed = normalize(config.artifacts.annotatedDir).replace(/\/$/, '') + '/';
  const errors = [];
  for (const image of images || []) {
    const value = normalize(image);
    if (value.includes('../') || !value.startsWith(allowed)) {
      errors.push(`公开手册只能引用 annotated 图片: ${value}`);
    }
    if (/\.manual\/artifacts\/(raw|sanitized|diagnostics)\//i.test(value) || /auth-cache/i.test(value)) {
      errors.push(`公开手册引用了本地敏感产物: ${value}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

function screenshots(evidence) {
  return (evidence?.steps || []).flatMap((step) => step.screenshots || []);
}

function summarizeEvidence(evidence, config) {
  const shots = screenshots(evidence);
  const maskStyles = [...new Set(shots.flatMap((shot) => (shot.redactions || []).map((item) => item.result)).filter(Boolean))].sort();
  return {
    audience: config.privacy?.audience || 'public',
    maskStyles,
    unresolvedHighRisk: shots.reduce((sum, shot) => sum + Number(shot.unresolvedHighRisk || 0), 0),
  };
}

function validatePublicationFacts(summary, config) {
  if (config.privacy?.audience !== 'public') return { ok: true, errors: [] };
  const errors = [];
  if (Number(summary?.unresolvedHighRisk || 0) > 0) errors.push('存在无法可靠定位的高风险隐私内容。');
  const unsafe = (summary?.maskStyles || []).filter((style) => !['neutral-mosaic', 'soft-solid'].includes(style));
  if (unsafe.length) errors.push(`公开手册使用了不安全的遮罩样式: ${unsafe.join(', ')}`);
  return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
}

function validateEvidence(evidence, config) {
  const shots = screenshots(evidence);
  const imageCheck = validatePublishedImages(shots.map((shot) => shot.annotated).filter(Boolean), config);
  const facts = summarizeEvidence(evidence, config);
  const factCheck = validatePublicationFacts(facts, config);
  const errors = [...imageCheck.errors, ...factCheck.errors];
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], summary: facts };
}

module.exports = { validatePublishedImages, validateEvidence, summarizeEvidence, validatePublicationFacts };
