'use strict';
function imageQuality(captured, redactions, annotations) {
  const canvas=captured.geometry.fullPage ? captured.geometry.documentSize : captured.geometry.viewport;
  const area=(canvas?.width || 1)*(canvas?.height || 1);
  const maskedArea=redactions.reduce((sum,r)=>sum+Math.max(0,r.rect?.width||0)*Math.max(0,r.rect?.height||0),0);
  const ratio=Math.min(1,maskedArea/area);
  return {annotationCount:annotations.length, redactionCount:redactions.length, maskedAreaUpperBound:ratio,
    warnings:[...(annotations.length ? [] : ['image-unannotated']),...(ratio>0.15 ? ['image-heavily-redacted: 使用演示数据或局部图，并目视检查最终图片；保留隐私遮挡。'] : [])]};
}
function taskQuality(task,evidence = {}) {
  const warnings=[];
  if (!task.completion?.claims?.length) warnings.push('completion-unbound: 完成结果没有可验证的断言。');
  const lastStepId=task.steps?.at(-1)?.id;
  const claims=task.completion?.claims||[];
  if (lastStepId && claims.length && claims.every(claim => claim.checkpoint && claim.checkpoint!==lastStepId)) {
    warnings.push(`completion-before-final-step: 所有完成声明都停在最后一步 ${lastStepId} 之前；核对任务目标是否已被证明。`);
  }
  for (const step of task.steps) {
    const name=step.action?.target?.name;
    const quoted=[...String(step.instruction).matchAll(/「([^」]+)」/g)].map(m=>m[1]);
    if (name && quoted.length && !quoted.includes(name)) warnings.push(`ui-name-mismatch:${step.id}: ${name}`);
  }
  const executed=(evidence.steps||[]).filter(s=>s.status!=='not-executed');
  for (const step of executed) if (!step.screenshots?.length) warnings.push(`step-image-missing:${step.id}`);
  for (const step of evidence.steps||[]) for (const shot of step.screenshots||[]) warnings.push(...(shot.quality?.warnings||[]));
  return {warnings:[...new Set(warnings)],stepsExecuted:executed.length,stepsTotal:task.steps.length,businessVerified:require('../evidence/claims').computeClaims(task,evidence).every(c=>c.status==='verified')};
}
module.exports={imageQuality,taskQuality};
