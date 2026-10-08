'use strict';
const { canonical } = require('../util/hash');
function imageQuality(captured, redactions, annotations) {
  const canvas=captured.geometry.fullPage ? captured.geometry.documentSize : captured.geometry.viewport;
  const area=(canvas?.width || 1)*(canvas?.height || 1);
  const maskedArea=redactions.reduce((sum,r)=>sum+Math.max(0,r.rect?.width||0)*Math.max(0,r.rect?.height||0),0);
  const ratio=Math.min(1,maskedArea/area);
  return {annotationCount:annotations.length, redactionCount:redactions.length, maskedAreaUpperBound:ratio,
    warnings:[...(annotations.length ? [] : ['image-unannotated']),...(ratio>0.15 ? ['image-heavily-redacted: 使用演示数据或局部图，并目视检查最终图片；保留隐私遮挡。'] : [])]};
}
function taskQuality(task,evidence = {}, { entryPage } = {}) {
  const warnings=[];
  const firstStep=task.steps?.[0];
  const checks = {
    entry: Boolean(entryPage?.route),
    firstActionLocation: Boolean(firstStep) && (firstStep.action?.type==='inspect' || Boolean(firstStep.capture) ||
      /(?:页面|侧栏|输入框|菜单|工具栏|顶部|底部|左侧|右侧|上方|下方|\bsidebar\b|\btoolbar\b)/i.test(firstStep.instruction || '')),
    preconditions: Boolean(task.preconditions?.length),
    steps: Boolean(task.steps?.length),
    completion: Boolean(task.completion?.claims?.length) && task.completion.claims.every(claim => claim.assertionRefs?.length),
    exceptions: Boolean(task.branches?.length || task.steps?.some(step => /(?:若|如果|遇到|未找到|没有结果|\bif\b|\bwhen\b)/i.test(step.instruction || ''))),
    screenshots: false,
  };
  if (!checks.entry) warnings.push('entry-missing: 缺少可供读者定位的任务入口地址。');
  if (!checks.firstActionLocation) warnings.push('first-action-location-unreviewed: 第一步未说明控件位置，也没有对应截图；请核对读者能否找到入口。');
  if (!checks.preconditions) warnings.push('preconditions-missing: 缺少开始前的数据或权限前提。');
  if (!checks.steps) warnings.push('steps-missing: 缺少操作步骤。');
  if (!checks.exceptions) warnings.push('exceptions-unreviewed: 任务模型中尚未记录常见异常的处理方式；需根据已观察界面或可靠来源审阅，不能猜测。');
  if (!checks.completion) warnings.push('completion-unbound: 完成结果没有可验证的断言。');
  const lastStepId=task.steps?.at(-1)?.id;
  const claims=task.completion?.claims||[];
  if (lastStepId && claims.length && claims.every(claim => claim.checkpoint && claim.checkpoint!==lastStepId)) {
    warnings.push(`completion-before-final-step: 所有完成声明都停在最后一步 ${lastStepId} 之前；核对任务目标是否已被证明。`);
  }
  for (const step of task.steps || []) {
    const name=step.action?.target?.name;
    const quoted=[...String(step.instruction).matchAll(/「([^」]+)」/g)].map(m=>m[1]);
    if (name && quoted.length && !quoted.includes(name)) warnings.push(`ui-name-mismatch:${step.id}: ${name}`);
    const capture = step.capture;
    if (capture?.readerVisible !== false && capture?.timing === 'before') {
      const actionTarget = step.action?.target;
      for (const annotation of capture.annotations || []) {
        if (annotation.target === 'action.target' || !actionTarget || !annotation.target) continue;
        if (canonical(annotation.target) !== canonical(actionTarget)) warnings.push(`before-image-target-mismatch:${step.id}: 操作前截图标注的目标与本步动作目标不同，请目视核对。`);
      }
    }
  }
  const executed=(evidence.steps||[]).filter(s=>s.status && s.status!=='not-executed');
  checks.screenshots = executed.some(s=>s.screenshots?.length);
  if (!checks.screenshots) warnings.push('screenshots-missing: 缺少已执行步骤的截图。');
  const capturedById=new Map(executed.map(step=>[step.id,step]));
  for (const step of task.steps || []) {
    if (!step.capture || !capturedById.has(step.id)) continue;
    if (!capturedById.get(step.id).screenshots?.length) warnings.push(`step-image-missing:${step.id}`);
    else if (step.capture.readerVisible !== false && !step.capture.readerCaption) warnings.push(`step-image-caption-unreviewed:${step.id}: 截图需说明操作前后状态与读者应看的位置。`);
  }
  for (const step of evidence.steps||[]) for (const shot of step.screenshots||[]) {
    warnings.push(...(shot.quality?.warnings||[]));
    const defined = task.steps?.find(item => item.id === step.id)?.capture;
    if (defined?.readerVisible !== false && defined?.timing && shot.timing && defined.timing !== shot.timing) {
      warnings.push(`image-timing-mismatch:${step.id}: 截图记录为 ${shot.timing}，任务模型声明为 ${defined.timing}。`);
    }
  }
  const evaluatedClaims=require('../evidence/claims').computeClaims(task,evidence);
  const claimsById = new Map(evaluatedClaims.map(claim => [claim.id, claim]));
  const goalCoverage = (task.completion?.goalChecks || []).map(item => {
    const claimResults = (item.claimIds || []).map(id => ({ id, status: claimsById.get(id)?.status || 'missing' }));
    return { id: item.id, text: item.text, claims: claimResults, readerChecks: item.readerChecks || [],
      status: claimResults.some(claim => claim.status !== 'verified') ? 'not-verified'
        : (item.readerChecks || []).length ? 'reader-check-required'
          : claimResults.length ? 'observed-interface' : 'not-verified' };
  });
  if (!goalCoverage.length) warnings.push('goal-coverage-unreviewed: 任务目标尚未逐项对应到已验证界面结果或读者核对项。');
  return {checks,warnings:[...new Set(warnings)],stepsExecuted:executed.length,stepsTotal:task.steps?.length || 0,
    completionClaimsVerified:evaluatedClaims.length>0 && evaluatedClaims.every(c=>c.status==='verified'),goalCoverage};
}
module.exports={imageQuality,taskQuality};
