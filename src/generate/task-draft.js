'use strict';
const fs = require('fs');
const path = require('path');

function uiTexts(text) { return [...String(text||'').matchAll(/「([^」]+)」/g)].map(m=>m[1]); }
function buildTaskDraft(task, evidence) {
  const errors=[]; const byId=new Map((evidence?.steps||[]).map(s=>[s.id,s])); const images=[];
  for(const record of evidence?.steps||[]) for(const shot of record.screenshots||[]){if(!shot.annotated||!String(shot.annotated).replace(/\\/g,'/').includes('/images/annotated/'))errors.push(`步骤 ${record.id} 的正式图片必须来自 annotated 目录。`);else images.push(shot.annotated.replace(/\\/g,'/'))}
  if(images.length===0) errors.push('任务指南至少需要一张 annotated 关键状态截图。');
  if(errors.length)return {ok:false,errors};
  const L=[`# ${task.title}`,'',task.goal,'','## 开始前',''];
  for(const item of task.preconditions||[])L.push(`- ${item}`);
  L.push('','## 操作步骤','');
  let imageIndex=0;
  task.steps.forEach((step,index)=>{const record=byId.get(step.id);L.push(`<!-- step:${step.id} -->`,`${index+1}. ${step.instruction}`);for(const shot of record?.screenshots||[]){L.push('',`   ![步骤 ${index+1}](${shot.annotated.replace(/\\/g,'/')})`);imageIndex++}if(record?.status==='not-executed')L.push('','   > 此操作未执行，指南停在提交前。');L.push('')});
  L.push('## 完成标志','',task.completion.verification==='verified'?'已验证结果：':'预期结果：',task.completion.description,'');
  if((task.branches||[]).length){L.push('## 条件分支','');for(const b of task.branches)L.push(`- **${b.condition}**：${b.effect}`);L.push('')}
  if((task.relatedTasks||[]).length){L.push('## 相关任务','');for(const id of task.relatedTasks)L.push(`- ${id}`);L.push('')}
  const markdown=L.join('\n');
  return {ok:true,markdown,facts:{title:task.title,stepIds:task.steps.map(s=>s.id),images,uiTexts:task.steps.flatMap(s=>uiTexts(s.instruction)),completionVerification:task.completion.verification}};
}
function publishAtomic(file,content){fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';fs.writeFileSync(temp,content,'utf8');fs.renameSync(temp,file);return file}
module.exports={buildTaskDraft,publishAtomic};
