'use strict';
/*
 * docs/manual/meta.json：更新时间 + 相关文章的计算与写盘。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const releases=require('../src/publication/release-store');
const {newUuid}=require('../src/model/ids');
const {buildDocMeta,updateDocMeta}=require('../src/generate/doc-meta');

const HEX='0'.repeat(64);

/** 造临时项目：docs = { manualId: 额外 factPack 字段 }；unpublished 里的只写发布记录、不写文档文件。 */
function project(docs,{unpublished=[]}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'manual-docmeta-'));
  const state=path.join(root,'.manual');
  let tick=0;
  for(const [manualId,extra] of Object.entries(docs)){
    const kind=manualId.startsWith('task-')?'task':'page',id=manualId.slice(kind.length+1);
    const documentPath=kind==='task'?`docs/manual/tasks/${id}.md`:`docs/manual/${id}.md`;
    if(!unpublished.includes(manualId)){
      fs.mkdirSync(path.dirname(path.join(root,documentPath)),{recursive:true});
      fs.writeFileSync(path.join(root,documentPath),`# ${id}\n`);
    }
    const createdAt=new Date(Date.UTC(2026,9,1,0,0,tick++)).toISOString();
    const release={schemaVersion:1,id:newUuid(),manualId,documentPath,documentHash:HEX,factsHash:HEX,captureIds:[],definitionRevisions:{},createdAt,
      facts:{factPack:{kind,title:`标题 ${id}`,blocks:{intro:{default:`说明 ${id}`}},...extra}}};
    releases.writeRelease(state,release);releases.setCurrent(state,release);
  }
  return root;
}
const config=catalog=>({artifacts:{stateDir:'.manual'},docs:{outputDir:'docs/manual',catalog}});
function withProject(docs,opts,fn){const root=project(docs,opts);try{fn(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}
// 某篇的相关文章压成 "target:reason" 列表，便于断言。
const rel=(meta,key)=>meta.docs[key].related.map(r=>`${r.target}:${r.reason}`);
// 用单独分组把每篇隔开，排除 same-group 的干扰。
const isolated=ids=>({fallbackTitle:'更多',groups:ids.map(id=>({title:`组 ${id}`,entries:[id]}))});

test('entry-page 与 shared-page 双向成立，updatedAt 取发布记录 createdAt，title 取 factPack.title',()=>withProject({
  'page-chat':{route:'/chat'},
  'page-credits':{route:'/credits/'},
  'task-ask':{entry:{route:'/chat?tab=1'},steps:[{pageId:'chat'},{pageId:'credits'}]},
},{},root=>{
  const meta=buildDocMeta({projectRoot:root,config:config(isolated(['page-chat','page-credits','task-ask']))});
  assert.equal(meta.version,1);
  assert.deepEqual(Object.keys(meta.docs),['chat.md','credits.md','tasks/ask.md']);
  assert.deepEqual(rel(meta,'tasks/ask.md'),['chat.md:entry-page','credits.md:shared-page'],'entry-page 胜过同一页面的 shared-page');
  assert.deepEqual(rel(meta,'chat.md'),['tasks/ask.md:entry-page']);
  assert.deepEqual(rel(meta,'credits.md'),['tasks/ask.md:shared-page']);
  assert.equal(meta.docs['tasks/ask.md'].related[0].title,'标题 chat');
  assert.equal(meta.docs['chat.md'].updatedAt,'2026-10-01T00:00:00.000Z');
  assert.equal(meta.docs['tasks/ask.md'].updatedAt,'2026-10-01T00:00:02.000Z');
}));

test('guide-link 双向；explicit 单向且强于其它理由；去重保留最强理由',()=>withProject({
  'page-skills':{route:'/skills',guide:[{taskId:'use'},{taskId:null}]},
  'task-use':{entry:{route:'/skills'},relatedTasks:['combo'],steps:[{pageId:'skills'}]},
  'task-combo':{related:[{id:'use',title:'x'}]},
},{},root=>{
  const meta=buildDocMeta({projectRoot:root,config:config(isolated(['page-skills','task-use','task-combo']))});
  assert.deepEqual(rel(meta,'skills.md'),['tasks/use.md:guide-link'],'guide-link 胜过 entry-page/shared-page');
  assert.deepEqual(rel(meta,'tasks/use.md'),['tasks/combo.md:explicit','skills.md:guide-link']);
  assert.deepEqual(rel(meta,'tasks/combo.md'),['tasks/use.md:explicit'],'related[].id 也算 explicit');
}));

test('same-group：按配置分组成组，同强度按目录顺序；自身不出现',()=>withProject({
  'page-a':{},'page-b':{},'page-c':{},'page-d':{},
},{},root=>{
  const meta=buildDocMeta({projectRoot:root,config:config({fallbackTitle:'更多',groups:[{title:'G',entries:['page-c','page-a','page-b']}]})});
  assert.deepEqual(rel(meta,'a.md'),['c.md:same-group','b.md:same-group']);
  assert.deepEqual(rel(meta,'c.md'),['a.md:same-group','b.md:same-group']);
  assert.deepEqual(rel(meta,'d.md'),[],'兜底分组只有自己时为空数组');
}));

test('same-group：未配置时沿用默认「操作指南 / 功能介绍」两组',()=>withProject({
  'page-a':{},'page-b':{},'task-x':{},
},{},root=>{
  const meta=buildDocMeta({projectRoot:root,config:config(null)});
  assert.deepEqual(rel(meta,'a.md'),['b.md:same-group']);
  assert.deepEqual(rel(meta,'tasks/x.md'),[]);
}));

test('每篇最多 5 条；强理由排在 same-group 前',()=>withProject({
  'page-a':{},'page-b':{},'page-c':{},'page-d':{},'page-e':{},'page-f':{},
  'task-t':{relatedTasks:[]},'page-hub':{route:'/hub',guide:[{taskId:'t'}]},
},{},root=>{
  const meta=buildDocMeta({projectRoot:root,config:config({fallbackTitle:'更多',groups:[{title:'G',entries:['page-hub','page-a','page-b','page-c','page-d','page-e','page-f']}]})});
  const hub=rel(meta,'hub.md');
  assert.equal(hub.length,5);
  assert.deepEqual(hub,['tasks/t.md:guide-link','a.md:same-group','b.md:same-group','c.md:same-group','d.md:same-group']);
}));

test('未发布（无文档文件）与不存在的目标静默丢弃，键也不出现',()=>withProject({
  'page-chat':{route:'/chat'},
  'task-ask':{entry:{route:'/chat'},relatedTasks:['ghost','gone'],steps:[{pageId:'nowhere'}]},
  'task-gone':{},
},{unpublished:['task-gone']},root=>{
  const meta=buildDocMeta({projectRoot:root,config:config(isolated(['page-chat','task-ask']))});
  assert.deepEqual(Object.keys(meta.docs),['chat.md','tasks/ask.md']);
  assert.deepEqual(rel(meta,'tasks/ask.md'),['chat.md:entry-page']);
}));

test('updateDocMeta：写入 outputDir/meta.json，同输入逐字节一致',()=>withProject({
  'page-chat':{route:'/chat'},'task-ask':{entry:{route:'/chat'}},'page-b':{},
},{},root=>{
  const cfg=config(null);
  const r=updateDocMeta({projectRoot:root,config:cfg});
  assert.equal(r.docs,3);
  const file=path.join(root,'docs/manual/meta.json');
  assert.equal(r.file,file);
  const first=fs.readFileSync(file,'utf8');
  assert.ok(first.endsWith('}\n'));
  assert.deepEqual(JSON.parse(first),buildDocMeta({projectRoot:root,config:cfg}));
  assert.equal(first,`${JSON.stringify(buildDocMeta({projectRoot:root,config:cfg}),null,2)}\n`);
  updateDocMeta({projectRoot:root,config:cfg});
  assert.equal(fs.readFileSync(file,'utf8'),first);
}));
