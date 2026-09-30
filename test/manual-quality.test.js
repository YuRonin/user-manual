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
test('完成声明停在最后一步之前时提示核对任务目标',()=>{
 const {taskQuality}=require('../src/generate/quality');
 const t=task();t.completion.claims=[{id:'opened',text:'已打开积分中心',checkpoint:'open',assertionRefs:['opened']}];
 assert.match(taskQuality(t).warnings.join('\n'),/completion-before-final-step/);
 t.completion.claims[0].checkpoint='filter';
 assert.doesNotMatch(taskQuality(t).warnings.join('\n'),/completion-before-final-step/);
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
