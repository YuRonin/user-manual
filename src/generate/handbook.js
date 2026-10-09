'use strict';
const fs=require('fs'),path=require('path');
const {readCurrentRelease}=require('../publication/release-store');
const {writeFileAtomic}=require('../util/atomic-write');
const OPEN='<!-- manual:catalog -->',CLOSE='<!-- /manual:catalog -->';
const text=s=>String(s||'').replace(/[\r\n|\[\]]/g,' ');
/** 维护者用的证据覆盖摘要，不进入读者目录。 */
function taskCoverage(pack) {
  const steps=`${pack.steps.filter(s=>s.executed===true).length}/${pack.steps.length} 步`;
  const claims=`${pack.claims.filter(c=>c.status==='verified').length}/${pack.claims.length} 完成声明已验证`;
  return `${steps}；${claims}${pack.readerChecks?.length ? '；需读者核对实际结果' : ''}`;
}
/** 目录里每篇文档的一句话说明：任务目标或页面用途。 */
function describeEntry(pack) {
  return text(pack?.blocks?.intro?.default || '').replace(/\s+/g,' ').trim();
}
/** 收集所有已发布手册（目录行 + 供 meta.json 用的 href/title/factPack/createdAt），按 manualId 排序。 */
function collectEntries(projectRoot,config) {
  const state=path.join(projectRoot,config.artifacts.stateDir),dir=path.join(state,'releases');
  const entries=[];
  for(const id of fs.existsSync(dir)?fs.readdirSync(dir).sort():[]) {
    if(!/^(page|task)-[a-z0-9-]+$/.test(id))continue;
    const r=readCurrentRelease(state,id);if(!r||!fs.existsSync(path.join(projectRoot,r.documentPath)))continue;
    const pack=r.facts?.factPack;
    const href=path.relative(path.join(projectRoot,config.docs.outputDir),path.join(projectRoot,r.documentPath)).replace(/\\/g,'/');
    const summary=describeEntry(pack);
    entries.push({id,kind:pack?.kind==='task'||id.startsWith('task-')?'task':'page',href,title:pack?.title||id,pack:pack||{},createdAt:r.createdAt,line:`- [${text(pack?.title||id)}](${href})${summary?`：${summary}`:''}`});
  }
  return entries;
}
/*
 * 目录分组：
 * - 默认按读者用途分两组：先列"怎样完成某件事"的操作指南，再列页面功能介绍；
 * - 配置了 docs.catalog 时按配置的分组与顺序输出，未被引用的已发布手册落到兜底分组，
 *   配置里尚未发布的条目跳过并告警（不静默丢失）。空分组一律省略。
 * 每项一行标题加一句说明，不写证据范围等维护信息。
 */
function groupEntries(entries,catalog) {
  if(!catalog)return {sections:[['操作指南',entries.filter(e=>e.kind==='task')],['功能介绍',entries.filter(e=>e.kind==='page')]],unknown:[]};
  const byId=new Map(entries.map(e=>[e.id,e])),used=new Set(),unknown=[];
  const sections=catalog.groups.map(g=>[g.title,g.entries.flatMap(id=>{
    const e=byId.get(id);if(!e){unknown.push(id);return [];}
    used.add(id);return [e];
  })]);
  sections.push([catalog.fallbackTitle,entries.filter(e=>!used.has(e.id))]);
  return {sections,unknown};
}
function updateHandbook({projectRoot,config}) {
  const {sections,unknown}=groupEntries(collectEntries(projectRoot,config),config.docs.catalog||null);
  const section=(title,rows)=>rows.length?['',`## ${title}`,'',...rows.map(e=>e.line)]:[];
  const generated=[OPEN,'# 使用手册',...sections.flatMap(([title,rows])=>section(title,rows)),CLOSE].join('\n');
  const rows=sections.flatMap(([,r])=>r);
  const file=path.join(projectRoot,config.docs.outputDir,'index.md');
  const prior=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  if(prior && !(prior.includes(OPEN)&&prior.includes(CLOSE)))return {file,updated:false,warning:'catalog-human-owned: index.md 已存在且无生成标记，保留人工内容。'};
  const content=prior ? prior.slice(0,prior.indexOf(OPEN))+generated+prior.slice(prior.indexOf(CLOSE)+CLOSE.length) : generated+'\n';
  fs.mkdirSync(path.dirname(file),{recursive:true});writeFileAtomic(file,content);
  const result={file,updated:true,entries:rows.length};
  if(unknown.length)result.warning=`catalog-unknown-entries: docs.catalog 引用了尚未发布的手册 ${unknown.join('、')}，已跳过。`;
  return result;
}
module.exports={updateHandbook,taskCoverage,collectEntries,groupEntries};
