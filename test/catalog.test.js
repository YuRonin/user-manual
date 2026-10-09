'use strict';
/*
 * docs.catalog：index.md 目录分组的配置校验、生成与 doctor 检查。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const releases=require('../src/publication/release-store');
const {newUuid}=require('../src/model/ids');
const {resolveCatalogConfig}=require('../src/config/catalog');
const {updateHandbook}=require('../src/generate/handbook');
const {checkCatalog}=require('../src/commands/doctor');

const HEX='0'.repeat(64);

/** 造一个带已发布手册的临时项目。 */
function project(manualIds){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-catalog-'));
  const state=path.join(root,'.manual');
  for(const manualId of manualIds){
    const kind=manualId.startsWith('task-')?'task':'page',id=manualId.slice(kind.length+1);
    const documentPath=kind==='task'?`docs/manual/tasks/${id}.md`:`docs/manual/${id}.md`;
    fs.mkdirSync(path.dirname(path.join(root,documentPath)),{recursive:true});
    fs.writeFileSync(path.join(root,documentPath),`# ${id}\n`);
    const release={schemaVersion:1,id:newUuid(),manualId,documentPath,documentHash:HEX,factsHash:HEX,captureIds:[],definitionRevisions:{},createdAt:new Date().toISOString(),
      facts:{factPack:{kind,title:`标题 ${id}`,blocks:{intro:{default:`说明 ${id}`}}}}};
    releases.writeRelease(state,release);releases.setCurrent(state,release);
  }
  return root;
}
const config=catalog=>({artifacts:{stateDir:'.manual'},docs:{outputDir:'docs/manual',catalog}});
const readIndex=root=>fs.readFileSync(path.join(root,'docs/manual/index.md'),'utf8');
const headings=md=>[...md.matchAll(/^## (.+)$/gm)].map(m=>m[1]);
function withProject(ids,fn){const root=project(ids);try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}

test('resolveCatalogConfig：未配置返回 null，合法配置补默认兜底标题',()=>{
  assert.deepEqual(resolveCatalogConfig(undefined),{ok:true,config:null});
  assert.deepEqual(resolveCatalogConfig({groups:[{title:' 快速开始 ',entries:['page-login']}]}),
    {ok:true,config:{groups:[{title:'快速开始',entries:['page-login']}],fallbackTitle:'更多'}});
});

test('resolveCatalogConfig：形状错误、坏 id、跨组重复、与兜底同名均报错',()=>{
  const bad=[
    [[],/需要是对象/],
    [{},/groups 需要是非空数组/],
    [{groups:[{title:'',entries:['page-a']}]},/title 需要是单行非空字符串/],
    [{groups:[{title:'A',entries:[]}]},/entries 需要是非空数组/],
    [{groups:[{title:'A',entries:['login']}]},/不是手册 id/],
    [{groups:[{title:'A',entries:['page-a']},{title:'B',entries:['page-a']}]},/只能属于一个分组/],
    [{groups:[{title:'更多',entries:['page-a']}]},/不能与 fallbackTitle/],
    [{fallbackTitle:'',groups:[{title:'A',entries:['page-a']}]},/fallbackTitle 需要是单行非空字符串/],
  ];
  for(const [raw,pattern] of bad){
    const r=resolveCatalogConfig(raw);
    assert.equal(r.ok,false,JSON.stringify(raw));
    assert.match(r.errors.join('\n'),pattern);
  }
});

test('updateHandbook：未配置分组时输出与原有两组格式逐字一致',()=>withProject(['page-chat','task-ask'],root=>{
  updateHandbook({projectRoot:root,config:config(undefined)});
  assert.equal(readIndex(root),[
    '<!-- manual:catalog -->','# 使用手册','',
    '## 操作指南','','- [标题 ask](tasks/ask.md)：说明 ask','',
    '## 功能介绍','','- [标题 chat](chat.md)：说明 chat',
    '<!-- /manual:catalog -->',''].join('\n'));
}));

test('updateHandbook：按配置分组与顺序输出，未引用的落入兜底分组',()=>withProject(['page-chat','page-login','task-ask','page-misc'],root=>{
  const r=updateHandbook({projectRoot:root,config:config({fallbackTitle:'其他',groups:[
    {title:'快速开始',entries:['page-login']},
    {title:'AI 对话',entries:['task-ask','page-chat']},
  ]})});
  assert.equal(r.updated,true);assert.equal(r.entries,4);assert.equal(r.warning,undefined);
  const md=readIndex(root);
  assert.deepEqual(headings(md),['快速开始','AI 对话','其他']);
  assert.ok(md.indexOf('(tasks/ask.md)')<md.indexOf('(chat.md)'),'组内顺序以配置为准');
  assert.match(md,/## 其他\n\n- \[标题 misc\]\(misc\.md\)/);
}));

test('updateHandbook：全部引用时不输出兜底分组；未发布条目跳过并告警、空组省略',()=>withProject(['page-chat'],root=>{
  const r=updateHandbook({projectRoot:root,config:config({fallbackTitle:'更多',groups:[
    {title:'AI 对话',entries:['page-chat']},
    {title:'课堂活动',entries:['page-activities']},
  ]})});
  assert.deepEqual(headings(readIndex(root)),['AI 对话']);
  assert.match(r.warning,/catalog-unknown-entries: .*page-activities/);
}));

test('doctor checkCatalog：未配置不出项，未发布条目给 warn',()=>withProject(['page-chat'],root=>{
  assert.equal(checkCatalog(root,config(null)),null);
  assert.equal(checkCatalog(root,config({groups:[{title:'A',entries:['page-chat']}],fallbackTitle:'更多'})).status,'ok');
  const c=checkCatalog(root,config({groups:[{title:'A',entries:['page-chat','task-missing']}],fallbackTitle:'更多'}));
  assert.equal(c.status,'warn');assert.deepEqual(c.missing,['task-missing']);
}));

test('loadConfig：docs.catalog 经校验进入 config，非法时整体报错',()=>{
  const {loadConfig}=require('../src/config/load');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-catalog-cfg-'));
  try{
    const r=require('child_process').spawnSync(process.execPath,[path.resolve(__dirname,'..','bin','manual.js'),'init','--base-url','http://localhost:3000'],{cwd:root,encoding:'utf8'});
    assert.equal(r.status,0,r.stderr);
    const file=path.join(root,'.manual','config.yaml');
    const base=fs.readFileSync(file,'utf8');
    assert.equal(loadConfig(root).config.docs.catalog,null);
    fs.writeFileSync(file,base.replace(/^docs:\n/m,'docs:\n  catalog:\n    groups:\n      - title: 快速开始\n        entries: [page-login]\n'));
    assert.deepEqual(loadConfig(root).config.docs.catalog,{groups:[{title:'快速开始',entries:['page-login']}],fallbackTitle:'更多'});
    fs.writeFileSync(file,base.replace(/^docs:\n/m,'docs:\n  catalog:\n    groups: []\n'));
    const bad=loadConfig(root);assert.equal(bad.ok,false);assert.match(bad.errors.join('\n'),/docs\.catalog\.groups/);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});
