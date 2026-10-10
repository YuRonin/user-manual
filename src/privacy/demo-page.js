'use strict';

/*
 * 在页面内执行的 Demo 函数（由 Playwright page.evaluate 序列化执行，必须自包含，不能引用外部变量）。
 *
 * applyDemoInPage：把页面用 data-redact="<键>" 声明的敏感区域替换为演示值。幂等：
 *   已替换且未被页面改回的元素不再触碰；页面重渲染后再次调用会重新替换。
 *   被替换下来的原始值只保存在页面内存（window.__manualDemo），用于残留检查，不回传、不落盘。
 * auditDemoInPage：只读审计，截图之后调用。返回：
 *   reverted   已替换的区域被页面改回，或替换后才出现的未替换区域（需要重试）
 *   leaks      原始值仍出现在可见文本 / 表单值 / 空输入框占位符 / 加载失败图片的 alt 中（会进入截图）
 *   contacts   data-redact 之外可见文本里的手机号 / 邮箱（只回传给门禁计数，不写入记录）
 *   hidden     原始值出现在 title / aria-* / 页面标题等截图中不渲染的位置（只记数量）
 *   surfaces   无法审计的可见区域：跨域 iframe、canvas（只记数量）
 *   generation 审计时刻的 DOM 变更计数，用来确认审计与截图属于同一时刻
 */

function applyDemoInPage({ text = {}, images = {}, known = [] }) {
  const state = window.__manualDemo || (window.__manualDemo = { originals: [] });
  const remember = (value) => {
    const v = String(value || '').trim();
    if (v && !state.originals.includes(v)) state.originals.push(v);
  };
  const valueFor = (values, index) => {
    const list = Array.isArray(values) ? values : [values];
    return String(list[index % list.length]).replace(/\{n\}/g, String(index + 1));
  };
  const rendered = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const initial = (key) => {
    const values = text[key];
    const first = Array.isArray(values) ? values[0] : values;
    return String(first || '演').trim().charAt(0) || '演';
  };
  const avatar = (key, style) => {
    const body = style === 'blank'
      ? '<rect width="64" height="64" fill="#E5E9F0"/>'
      : `<rect width="64" height="64" fill="#DCE3EE"/><text x="32" y="33" font-family="sans-serif" font-size="28" fill="#4A5568" text-anchor="middle" dominant-baseline="central">${initial(key).replace(/[<>&"']/g, '')}</text>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">${body}</svg>`)}`;
  };
  const out = { replaced: {}, images: {}, unconfigured: [], imageUnconfigured: [], unreplaceable: [] };
  const counters = {};
  const unreplaceable = new Set(['canvas', 'video', 'iframe', 'object', 'embed', 'svg', 'picture']);
  // 只处理最外层的 data-redact：嵌套的内层随外层一起替换
  const elements = [...document.querySelectorAll('[data-redact]')].filter((el) => !el.parentElement?.closest('[data-redact]'));
  for (const el of elements) {
    if (!rendered(el)) continue;
    // 没写键名的 data-redact 用 * 配置演示值
    const key = el.getAttribute('data-redact') || '*';
    const tag = el.localName;
    const background = getComputedStyle(el).backgroundImage;
    const hasBackground = background && background !== 'none' && /url\(/.test(background);
    if (tag === 'img' || (hasBackground && !String(el.textContent || '').trim())) {
      if (!(key in images)) { out.imageUnconfigured.push(key); continue; }
      if (el.getAttribute('data-manual-demo') !== 'image') {
        const uri = avatar(key, images[key]);
        if (tag === 'img') { el.removeAttribute('srcset'); el.src = uri; } else el.style.backgroundImage = `url("${uri}")`;
        el.setAttribute('data-manual-demo', 'image');
      }
      out.images[key] = (out.images[key] || 0) + 1;
      continue;
    }
    if (unreplaceable.has(tag) || el.querySelector('canvas,video,iframe,object,embed')) { out.unreplaceable.push(key); continue; }
    const field = tag === 'input' || tag === 'textarea';
    const current = field ? el.value : el.textContent;
    if (!String(current || '').trim()) continue;
    // 与 Fixture 响应中的字符串完全相同：内容本身就是虚构数据，保留原样（不再替换）
    if (known.includes(String(current).trim())) {
      el.setAttribute('data-manual-demo', current);
      out.replaced[key] = (out.replaced[key] || 0) + 1;
      continue;
    }
    if (!(key in text)) { out.unconfigured.push(key); continue; }
    counters[key] = (counters[key] ?? -1) + 1;
    const value = valueFor(text[key], counters[key]);
    if (current !== value) {
      // 之前替换过的演示值不是原始值；只有页面自己渲染出的内容才记为原始值
      if (current !== el.getAttribute('data-manual-demo')) remember(current);
      if (field) el.value = value; else el.textContent = value;
    }
    el.setAttribute('data-manual-demo', value);
    out.replaced[key] = (out.replaced[key] || 0) + 1;
  }
  return out;
}

function auditDemoInPage({ text = {}, images = {}, known = [] } = {}) {
  const state = window.__manualDemo || { originals: [] };
  const checkable = (value) => {
    const t = String(value || '').trim();
    if (t.length < 2) return false;
    if (/^[\d\s.,:+\-%¥$]+$/.test(t)) return t.replace(/\D/g, '').length >= 4;
    return true;
  };
  const originals = state.originals.filter(checkable);
  const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const inRedact = (el) => !!el?.closest('[data-redact]');
  const contains = (value) => originals.some((original) => String(value || '').includes(original));
  const out = { replaced: {}, images: {}, unconfigured: [], imageUnconfigured: [], unreplaceable: [], reverted: 0, leaks: [], contacts: [], hidden: 0, surfaces: { iframe: 0, canvas: 0 } };
  const unreplaceable = new Set(['canvas', 'video', 'iframe', 'object', 'embed', 'svg', 'picture']);

  // 以截图时刻为准重新核对每个 data-redact 区域：替换后才出现、或被页面改回的区域都不能算已替换
  for (const el of document.querySelectorAll('[data-redact]')) {
    if (el.parentElement?.closest('[data-redact]') || !visible(el)) continue;
    // 没写键名的 data-redact 用 * 配置演示值
    const key = el.getAttribute('data-redact') || '*';
    const marker = el.getAttribute('data-manual-demo');
    const tag = el.localName;
    const background = getComputedStyle(el).backgroundImage;
    const imageLike = tag === 'img' || (background && background !== 'none' && /url\(/.test(background) && !String(el.textContent || '').trim());
    if (imageLike) {
      if (marker === 'image') out.images[key] = (out.images[key] || 0) + 1;
      else if (key in images) out.reverted++;
      else out.imageUnconfigured.push(key);
      continue;
    }
    if (unreplaceable.has(tag) || el.querySelector('canvas,video,iframe,object,embed')) { out.unreplaceable.push(key); continue; }
    const field = tag === 'input' || tag === 'textarea';
    const current = field ? el.value : el.textContent;
    if (!String(current || '').trim()) continue;
    if (marker !== null && current === marker) out.replaced[key] = (out.replaced[key] || 0) + 1;
    else if (marker === null && known.includes(String(current).trim())) out.replaced[key] = (out.replaced[key] || 0) + 1;
    else if (marker !== null || key in text) out.reverted++;
    else out.unconfigured.push(key);
  }

  const phone = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const value = node.nodeValue || '';
    if (!value.trim() || !parent || inRedact(parent) || !visible(parent)) continue;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName)) continue;
    if (contains(value)) out.leaks.push({ surface: 'text' });
    out.contacts.push(...(value.match(phone) || []), ...(value.match(email) || []));
  }
  for (const el of document.querySelectorAll('input,textarea,select')) {
    if (inRedact(el) || !visible(el) || el.type === 'password' || el.type === 'hidden') continue;
    const value = el.localName === 'select' ? (el.selectedOptions?.[0]?.textContent || '') : el.value;
    if (contains(value)) out.leaks.push({ surface: 'form-value' });
    if (!value && contains(el.getAttribute('placeholder'))) out.leaks.push({ surface: 'placeholder' });
  }
  for (const img of document.querySelectorAll('img[alt]')) {
    if (inRedact(img) || !visible(img)) continue;
    if (img.complete && img.naturalWidth === 0 && contains(img.getAttribute('alt'))) out.leaks.push({ surface: 'image-alt' });
  }
  for (const el of document.querySelectorAll('[title],[aria-label],[aria-description]')) {
    if (['title', 'aria-label', 'aria-description'].some((name) => contains(el.getAttribute(name)))) out.hidden++;
  }
  if (contains(document.title)) out.hidden++;
  for (const frame of document.querySelectorAll('iframe')) {
    if (!visible(frame)) continue;
    let readable = false;
    try { readable = !!frame.contentDocument; } catch (_) { readable = false; }
    if (!readable) out.surfaces.iframe++;
  }
  for (const canvas of document.querySelectorAll('canvas')) if (visible(canvas) && !inRedact(canvas)) out.surfaces.canvas++;
  out.generation = window.__manualMutation ? window.__manualMutation.generation : null;
  return out;
}

module.exports = { applyDemoInPage, auditDemoInPage };
