'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {approve}=require('../src/model/approval');
const {buildCapturePlan}=require('../src/tasks/capture-plan');
const pages=[{id:'chat',route:'/chat'},{id:'credits',route:'/credits'}];
function task(){return {id:'credits-tour',title:'积分',goal:'查看积分',entryPage:'chat',preconditions:[],risk:'read',steps:[{id:'open',page:'chat',instruction:'点击积分中心',action:{type:'click',target:{role:'button',name:'积分中心'}}},{id:'filter',page:'credits',instruction:'查看消耗',action:{type:'click',target:{role:'button',name:'消耗'}}}],completion:{description:'显示消耗'}};}
test('导航动作后校验目的页，下一步骤仍校验所在页',()=>{const t=task();t.approval=approve(t,pages);const p=buildCapturePlan(t,pages);assert.equal(p.ok,true);assert.equal(p.plan.steps[0].expectedState.assertions[0].value,'/credits');assert.equal(p.plan.steps[1].beforeState.assertions[0].value,'/credits');});
test('显式 pageAfter 参与审批，不能凭旧授权换目的页',()=>{const t=task();t.approval=approve(t,pages);t.steps[0].pageAfter='credits';assert.equal(buildCapturePlan(t,pages).code,'scope-changed');});
test('页面指南提供具体步骤与可对应的编号，不只输出动作名称',()=>{const {buildPageFactPack}=require('../src/generate/fact-pack');const {renderPage}=require('../src/generate/render');const p=buildPageFactPack({page:{id:'credits',title:'积分中心',route:'/credits',purpose:'查看积分',guide:[{id:'spend',title:'筛选消耗',instruction:'在积分明细中点击「消耗」。',target:{role:'button',name:'消耗'}}]},language:'zh-CN'});assert.match(renderPage(p),/在积分明细中点击「消耗」/);assert.match(renderPage(p),/1.*筛选消耗/);});
test('写授权限定环境、步骤、期限；预演始终停止且禁止自动重放',()=>{
 const t=task();t.environment='test';t.steps[0].risk='write';t.writeAuthorization={origin:'https://demo.test',steps:['open'],expiresAt:'2099-01-01',decisionRef:'user-request'};t.approval=approve(t,pages);
 const config={project:{baseUrl:'https://demo.test'},fixtures:{environments:{test:{origins:['https://demo.test']}}}};
 const p=buildCapturePlan(t,pages,{config});assert.equal(p.plan.steps[0].willExecute,true);assert.equal(p.plan.steps[0].replay,'requires-input');
 assert.equal(buildCapturePlan(t,pages,{config,preflight:true}).plan.steps[0].willExecute,false);
 const {permitsWrite}=require('../src/tasks/write-policy');assert.equal(permitsWrite(t,t.steps[1],config),false);assert.equal(permitsWrite(t,t.steps[0],config,Date.parse('2100-01-01')),false);
 config.fixtures.environments.test.production=true;assert.equal(permitsWrite(t,t.steps[0],config),false);
});
test('requires 与 guide 改动进入模型版本；无效授权被拒绝',()=>{
 const {definitionRevision}=require('../src/model/revision');const t=task();const old=definitionRevision('userTask',t);t.steps[0].requires=[{type:'visible',target:{text:'可用技能'}}];assert.notEqual(definitionRevision('userTask',t),old);
 const {validateUserTask}=require('../src/model/schema');t.writeAuthorization={steps:['missing']};assert.equal(validateUserTask(t,{pages}).ok,false);
});
test('图片遮挡比例产生可读性提示；目录保留人工内容',()=>{
 const {imageQuality}=require('../src/generate/quality');const q=imageQuality({geometry:{viewport:{width:100,height:100}}},[{rect:{width:80,height:80}}],[]);assert.equal(q.warnings.length,2);
 const fs=require('fs'),os=require('os'),path=require('path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-quality-'));
 try { const {updateHandbook}=require('../src/generate/handbook');const config={artifacts:{stateDir:'.manual'},docs:{outputDir:'docs'}};fs.mkdirSync(path.join(root,'docs'));const file=path.join(root,'docs/index.md');fs.writeFileSync(file,'人工内容');assert.equal(updateHandbook({projectRoot:root,config}).updated,false);assert.equal(fs.readFileSync(file,'utf8'),'人工内容');fs.writeFileSync(file,'前言\n<!-- manual:catalog -->old<!-- /manual:catalog -->\n附录');updateHandbook({projectRoot:root,config});assert.match(fs.readFileSync(file,'utf8'),/^前言[\s\S]*附录$/);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('目录在界面声明已验证时仍提示读者核对实际结果',()=>{
 const {taskCoverage}=require('../src/generate/handbook');
 const pack={steps:[{executed:true}],claims:[{status:'verified'}],readerChecks:['核对实际记录']};
 assert.equal(taskCoverage(pack),'1/1 步；1/1 完成声明已验证；需读者核对实际结果');
 assert.equal(taskCoverage({...pack,readerChecks:[]}), '1/1 步；1/1 完成声明已验证');
});
test('完成声明停在最后一步之前时提示核对任务目标',()=>{
 const {taskQuality}=require('../src/generate/quality');
 const t=task();t.completion.claims=[{id:'opened',text:'已打开积分中心',checkpoint:'open',assertionRefs:['opened']}];
 assert.match(taskQuality(t).warnings.join('\n'),/completion-before-final-step/);
 t.completion.claims[0].checkpoint='filter';
 assert.doesNotMatch(taskQuality(t).warnings.join('\n'),/completion-before-final-step/);
});
test('任务质量清单区分入口、前提、异常和截图，未绑定结果不能算已验证',()=>{
 const {taskQuality}=require('../src/generate/quality');
 const t=task();
 const missing=taskQuality(t,{steps:[]});
 assert.deepEqual(missing.checks,{entry:false,firstActionLocation:false,preconditions:false,steps:true,completion:false,exceptions:false,screenshots:false});
 assert.equal(missing.completionClaimsVerified,false);
 const complete=taskQuality({...t,steps:[{...t.steps[0],instruction:'在左侧栏底部点击积分中心。'},t.steps[1]],preconditions:['已登录'],branches:[{condition:'无结果',effect:'停止操作'}],completion:{claims:[{id:'done',text:'已筛选',assertionRefs:['done']}]}},
   {steps:[{id:'filter',status:'verified',screenshots:[{annotated:'x.png'}]}]},
   {entryPage:{route:'/chat',title:'聊天'}});
 assert.equal(Object.values(complete.checks).every(Boolean),true);
});
test('未给第一步控件位置或截图时提示读者可能找不到入口',()=>{
 const {taskQuality}=require('../src/generate/quality');
 const t=task();
 assert.match(taskQuality(t).warnings.join('\n'),/first-action-location-unreviewed/);
 t.steps[0].instruction='在左侧栏底部点击当前积分。';
 assert.doesNotMatch(taskQuality(t).warnings.join('\n'),/first-action-location-unreviewed/);
});
test('质量检查能报告缺少步骤与未绑定的完成声明',()=>{
 const {taskQuality}=require('../src/generate/quality');
 const t={...task(),steps:[],completion:{claims:[{id:'submitted',text:'已提交',assertionRefs:[]}]}};
 const q=taskQuality(t);
 assert.equal(q.checks.steps,false);
 assert.equal(q.checks.firstActionLocation,false);
 assert.equal(q.checks.completion,false);
 assert.equal(q.completionClaimsVerified,false);
 assert.match(q.warnings.join('\n'),/completion-unbound/);
 t.completion.claims.push({id:'reply',text:'回复出现',assertionRefs:['reply']});
 assert.equal(taskQuality(t).checks.completion,false, '任一完成声明未绑定断言都需要提示');
});
test('任务入口由页面模型渲染，不把内部 page id 当操作位置',()=>{
 const {renderTask}=require('../src/generate/render');
 const pack={language:'zh-CN',title:'查看积分',entry:{title:'聊天',route:'/chat'},preconditions:['已登录'],steps:[],claims:[],artifacts:[],scope:{firstSkipped:-1},branches:[],relatedTasks:[],blocks:{intro:{default:'查看积分'}}};
 assert.match(renderTask(pack),/## 从哪里开始\n\n打开 \[聊天\]\(\/chat\) 页面。/);
});
test('读者前提可用简明文案呈现，浏览器执行前提仍受原审批范围约束',()=>{
 const {buildTaskFactPack}=require('../src/generate/fact-pack');const {scopeHash}=require('../src/model/approval');
 const t=task();t.preconditions=['已登录且认证有效'];t.readerPreconditions=['已登录 NeoAgent'];
 const old=scopeHash(t,pages);const pack=buildTaskFactPack({task:t,evidence:{steps:[]},images:[],claims:[],language:'zh-CN'});
 assert.deepEqual(pack.preconditions,['已登录 NeoAgent']);
 t.readerPreconditions=['先登录 NeoAgent'];assert.equal(scopeHash(t,pages),old);
});
test('短位置说明放在第一步动作前且不重复',()=>{
 const {renderTask}=require('../src/generate/render');
 const pack={language:'zh-CN',title:'选择技能',entry:{title:'对话',route:'/chat'},preconditions:[],steps:[{id:'open',sentence:'点击「技能与组合技」',sentenceSource:'action',artifactRefs:[],executed:true}],claims:[],artifacts:[],scope:{firstSkipped:-1},branches:[],relatedTasks:[],blocks:{intro:{default:''},'step.open':{default:'入口图标位于消息输入框左下角。'}}};
 assert.match(renderTask(pack),/1\. 在消息输入框左下角，点击「技能与组合技」/);
 assert.equal(renderTask(pack).match(/入口图标位于/g),null);
});
test('操作前后截图有不同说明，步骤判断先于选择动作',()=>{
 const {renderTask}=require('../src/generate/render');
 const pack={language:'zh-CN',title:'选择技能',entry:{title:'对话',route:'/chat'},preconditions:['已登录'],steps:[
  {id:'choose',sentence:'点击「我要出题」',sentenceSource:'action',artifactRefs:['before'],executed:true},
  {id:'select',sentence:'点击「教案生成」',sentenceSource:'action',artifactRefs:[],executed:true},
  {id:'send',sentence:'点击「发送」',sentenceSource:'action',artifactRefs:['after'],executed:true},
 ],claims:[],artifacts:[{id:'before',timing:'before',markdownHref:'../images/annotated/before.png'},{id:'after',timing:'after',markdownHref:'../images/annotated/after.png'}],scope:{firstSkipped:-1},branches:[],relatedTasks:[],blocks:{intro:{default:''},'step.choose':{default:'在「试试这些」区域点击「我要出题」。'},'step.select':{default:'选择前，确认搜索结果是「教案生成」。'},'step.send':{default:'发送按钮位于消息输入框右下角。提交后等待回复。'}}};
 const md=renderTask(pack);
 assert.match(md,/在「试试这些」区域点击「我要出题」/);
 assert.equal((md.match(/点击「我要出题」/g)||[]).length,1);
 assert.match(md,/确认搜索结果是「教案生成」，再点击「教案生成」/);
 assert.match(md,/在消息输入框右下角，点击「发送」/);
 assert.match(md,/!\[第 1 步操作前的界面\]/);
 assert.match(md,/!\[第 3 步操作后的界面\]/);
 assert.match(md,/\[放大查看\]\(\.\.\/images\/annotated\/before\.png\)/);
});
test('读者核对项在完成部分单列，不提升为已验证结果',()=>{
 const {renderTask}=require('../src/generate/render');
 const pack={language:'zh-CN',title:'出题',preconditions:[],steps:[],claims:[{id:'reply',status:'verified',text:'助手回复已出现。'}],readerChecks:['打开题目预览并核对数量。'],artifacts:[],scope:{firstSkipped:-1},branches:[],relatedTasks:[],blocks:{intro:{default:''}}};
 const markdown=renderTask(pack);
 assert.match(markdown,/采集时已看到：助手回复已出现。/);
 assert.match(markdown,/### 请核对任务结果\n\n- 打开题目预览并核对数量。/);
 assert.equal((markdown.match(/采集时已看到：/g)||[]).length,1);
 const onlyReaderCheck=renderTask({...pack,claims:[]});
 assert.match(onlyReaderCheck,/请核对任务结果[\s\S]*打开题目预览并核对数量。/);
 assert.doesNotMatch(onlyReaderCheck,/采集时已看到：/);
});
test('截图缺失只针对声明需要截图且已执行的步骤',()=>{
 const {taskQuality}=require('../src/generate/quality');
 const t=task();t.steps[1].capture={timing:'after'};
 const q=taskQuality(t,{steps:[{id:'open',status:'observed',screenshots:[]},{id:'filter',status:'verified',screenshots:[]}]});
 assert.match(q.warnings.join('\n'),/step-image-missing:filter/);
 assert.doesNotMatch(q.warnings.join('\n'),/step-image-missing:open/);
});
test('已有步骤截图却没有读者图注时提示复核',()=>{
 const {taskQuality}=require('../src/generate/quality');const t=task();t.steps[1].capture={timing:'after'};
 const e={steps:[{id:'filter',status:'verified',screenshots:[{annotated:'x.png'}]}]};
 assert.match(taskQuality(t,e).warnings.join('\n'),/step-image-caption-unreviewed:filter/);
 t.steps[1].capture.readerCaption='筛选后显示扣减记录。';
 assert.doesNotMatch(taskQuality(t,e).warnings.join('\n'),/step-image-caption-unreviewed/);
});
test('预演不截图、不发布；缺少数据前提时动作不执行',async()=>{
 const {executeCapturePlan}=require('../src/tasks/executor');const fs=require('fs'),os=require('os'),path=require('path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-preflight-'));let actions=0;
 const provider={open:async url=>({status:200,finalUrl:url}),waitUntilReady:async()=>({warnings:[]}),assertCondition:async a=>{if(a.type==='visible')throw Error('empty');return {ok:true}},performAction:async()=>{actions++;return{}},screenshot:async()=>{throw Error('must not screenshot')},close:async()=>{}};
 const t=task();t.approval=approve(t,pages);const plan=buildCapturePlan(t,pages).plan;
 try {let result=await executeCapturePlan(plan,provider,{baseUrl:'https://demo.test',stateDir:root,preflight:true});assert.equal(result.onlineChecked,true);assert.equal(result.publicationReady,false);assert.deepEqual(fs.readdirSync(root),[]);assert.equal(actions,2);plan.steps[0].requires=[{type:'visible',target:{text:'可用技能'}}];await assert.rejects(executeCapturePlan(plan,provider,{baseUrl:'https://demo.test',stateDir:root,preflight:true}),e=>e.code==='precondition-failed');assert.equal(actions,2);}finally{fs.rmSync(root,{recursive:true,force:true})}
});
test('已有会话核对拒绝其他站点和没有会话标识的 URL，且不触发动作',async()=>{
 const {reconcileCapturePlan}=require('../src/tasks/executor');
 let actions=0;
 const provider={open:async()=>{actions++},performAction:async()=>{actions++}};
 const plan={taskId:'sample',entry:{route:'/chat'},steps:[]};
 for(const sessionUrl of ['https://other.test/chat?session=x','https://demo.test/chat']){
  await assert.rejects(reconcileCapturePlan(plan,provider,{baseUrl:'https://demo.test',sessionUrl}),error=>error.code==='invalid-reconcile-url');
 }
 assert.equal(actions,0);
});
test('只读续采仅接受已验证提交后的单一步骤，并拒绝改动旧动作或 Capture 链',()=>{
 const {validateReadOnlyContinuation}=require('../src/tasks/executor');
 const action={type:'fill',target:{selector:'textarea'},value:'测试需求'};
 const write={type:'click',target:{role:'button',name:'发送'}};
 const view={type:'click',target:{role:'button',name:'查看'}};
 const plan={taskId:'practice',steps:[
  {id:'prompt',page:'chat',action,risk:'local'},
  {id:'send',page:'chat',action:write,risk:'write'},
  {id:'view',page:'chat',action:view,risk:'read',willExecute:true,capture:{timing:'after'},expectedState:{assertions:[{type:'visible',target:{text:'预览'}}]}},
 ]};
 const prior={taskId:'practice',provenance:'live',canonicalCaptureRefs:['capture-1'],steps:[
  {id:'prompt',page:'chat',action,screenshots:[{captureId:'capture-1'}]},
  {id:'send',page:'chat',action:write,status:'verified',validations:[{scope:'scenario-state',check:'visible',outcome:'passed'}],screenshots:[]},
 ]};
 assert.equal(validateReadOnlyContinuation(plan,prior,['capture-1']).last.id,'view');
 assert.throws(()=>validateReadOnlyContinuation({...plan,steps:[{...plan.steps[0],action:{...action,value:'另一个需求'}},...plan.steps.slice(1)]},prior,['capture-1']),e=>e.code==='continuation-prefix-changed');
 assert.throws(()=>validateReadOnlyContinuation(plan,prior,['wrong']),e=>e.code==='invalid-prior-capture');
 assert.throws(()=>validateReadOnlyContinuation({...plan,steps:[...plan.steps.slice(0,-1),{...plan.steps.at(-1),risk:'write'}]},prior,['capture-1']),e=>e.code==='invalid-continuation-plan');
 assert.throws(()=>validateReadOnlyContinuation(plan,{...prior,steps:[prior.steps[0],{...prior.steps[1],validations:[]}]},['capture-1']),e=>e.code==='invalid-continuation-plan');
 const capturedRead={id:'view',page:'chat',action:view,status:'verified',validations:[{scope:'scenario-state',check:'visible',outcome:'passed'}],screenshots:[{captureId:'capture-2'}]};
 const refreshedPrior={...prior,steps:[...prior.steps,capturedRead],canonicalCaptureRefs:['capture-1','capture-2']};
 assert.equal(validateReadOnlyContinuation(plan,refreshedPrior,['capture-1','capture-2'],{allowRefresh:true}).refresh,true);
 assert.throws(()=>validateReadOnlyContinuation(plan,refreshedPrior,['capture-1','capture-2']),e=>e.code==='invalid-continuation-plan');
 assert.throws(()=>validateReadOnlyContinuation(plan,{...refreshedPrior,steps:[...prior.steps,{...capturedRead,action:{type:'click',target:{text:'其他卡片'}}}]},['capture-1','capture-2'],{allowRefresh:true}),e=>e.code==='continuation-prefix-changed');
});
test('新增未引用页面状态不让其他任务证据过期，引用状态或源码变化仍须重新采集',()=>{
 const {pageObservationRevision,compatiblePageRevisionsFor,evidenceFreshness,scopeHash}=require('../src/model/approval');
 const page={
  id:'chat',route:'/chat',analysis:{sourceRevision:'old-source'},
  states:{
   default:{assertions:[{type:'url',value:'/chat'}]},
   reply:{assertions:[{id:'reply',type:'visible',target:{text:'回复'}}]},
  },
 };
 const t={id:'reply-task',entryPage:'chat',steps:[{id:'send',page:'chat',stateAfter:'reply',risk:'write',action:{type:'click',target:{role:'button',name:'发送'}}}]};
 t.lastCapture={scopeHash:scopeHash(t,[page]),pageRevisions:{chat:pageObservationRevision(page)}};
 const added={...page,states:{...page.states,preview:{assertions:[{id:'preview',type:'visible',target:{text:'题目预览'}}]}}};
 assert.equal(compatiblePageRevisionsFor(t,[added],t.lastCapture.pageRevisions).chat,t.lastCapture.pageRevisions.chat);
 assert.equal(evidenceFreshness(t,[added]).status,'fresh');
 const changedReferenced={...added,states:{...added.states,reply:{assertions:[{id:'reply',type:'visible',target:{text:'另一种回复'}}]}}};
 assert.equal(evidenceFreshness(t,[changedReferenced]).status,'stale');
 assert.equal(evidenceFreshness(t,[{...added,analysis:{sourceRevision:'new-source'}}]).status,'stale');
});
