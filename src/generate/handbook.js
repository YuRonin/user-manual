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
/*
 * 目录按读者用途分组：先列"怎样完成某件事"的操作指南，再列页面功能介绍；
 * 每项一行标题加一句说明，不写证据范围等维护信息。
 */
function updateHandbook({projectRoot,config}) {
  const state=path.join(projectRoot,config.artifacts.stateDir),dir=path.join(state,'releases');
  const groups={task:[],page:[]};
  for(const id of fs.existsSync(dir)?fs.readdirSync(dir).sort():[]) {
    if(!/^(page|task)-[a-z0-9-]+$/.test(id))continue;
    const r=readCurrentRelease(state,id);if(!r||!fs.existsSync(path.join(projectRoot,r.documentPath)))continue;
    const pack=r.facts?.factPack;
    const href=path.relative(path.join(projectRoot,config.docs.outputDir),path.join(projectRoot,r.documentPath)).replace(/\\/g,'/');
    const summary=describeEntry(pack);
    (pack?.kind==='task'||id.startsWith('task-')?groups.task:groups.page).push(`- [${text(pack?.title||id)}](${href})${summary?`：${summary}`:''}`);
  }
  const section=(title,rows)=>rows.length?['',`## ${title}`,'',...rows]:[];
  const generated=[OPEN,'# 使用手册',...section('操作指南',groups.task),...section('功能介绍',groups.page),CLOSE].join('\n');
  const rows=[...groups.task,...groups.page];
  const file=path.join(projectRoot,config.docs.outputDir,'index.md');
  const prior=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  if(prior && !(prior.includes(OPEN)&&prior.includes(CLOSE)))return {file,updated:false,warning:'catalog-human-owned: index.md 已存在且无生成标记，保留人工内容。'};
  const content=prior ? prior.slice(0,prior.indexOf(OPEN))+generated+prior.slice(prior.indexOf(CLOSE)+CLOSE.length) : generated+'\n';
  fs.mkdirSync(path.dirname(file),{recursive:true});writeFileAtomic(file,content);
  return {file,updated:true,entries:rows.length};
}
module.exports={updateHandbook,taskCoverage};
