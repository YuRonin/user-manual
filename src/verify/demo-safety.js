'use strict';

/*
 * verify 的 Demo 结果：与标注覆盖率分开报告。
 *
 *   demo_privacy  手册引用的截图是否都通过了 Demo 门禁（privacy.demo.status = passed）；
 *                 没有 privacy.demo 的旧证据记为 legacy（采集于 Demo 之前，遮罩规则沿用旧版），不算通过也不伪造失败
 *   write_safety  这些截图采集期间的网络计数：被中止的写请求必须为 0；放行 / 授权 / Mock 的数量如实列出
 * 只读 Capture 记录，不读取任何图片或页面文本。
 */

function summarizeDemoSafety(records = []) {
  const shots = records.filter(Boolean);
  const passed = shots.filter((r) => r.privacy?.demo?.status === 'passed');
  const legacy = shots.filter((r) => !r.privacy?.demo);
  const failed = shots.length - passed.length - legacy.length;
  const sum = (field) => passed.reduce((total, r) => total + Number(r.privacy.demo.network?.[field] || 0), 0);
  const sources = (field) => passed.reduce((total, r) => total + Number(r.privacy.demo.sources?.[field] || 0), 0);
  const blocked = sum('blocked');
  return {
    demo_privacy: {
      status: failed > 0 ? 'failed' : legacy.length > 0 ? 'legacy' : 'passed',
      total: shots.length,
      passed: passed.length,
      legacy: legacy.length,
      failed,
      sources: { api_mock: sources('api_mock'), dom_replace: sources('dom_replace') },
      unverifiedSurfaces: passed.reduce((total, r) => total + Number(r.privacy.demo.surfaces?.iframe || 0) + Number(r.privacy.demo.surfaces?.canvas || 0), 0),
    },
    write_safety: {
      status: blocked > 0 ? 'failed' : legacy.length === shots.length && shots.length > 0 ? 'unknown' : 'passed',
      blockedWrites: blocked,
      mocked: sum('mocked'),
      allowed: sum('allowed'),
      authorized: sum('authorized'),
      suppressed: sum('suppressed'),
    },
  };
}

module.exports = { summarizeDemoSafety };
