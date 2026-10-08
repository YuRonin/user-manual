'use strict';
const fs=require('fs'),path=require('path');
const {readCurrentRelease}=require('../publication/release-store');
const {writeFileAtomic}=require('../util/atomic-write');
const OPEN='<!-- manual:catalog -->',CLOSE='<!-- /manual:catalog -->';
const text=s=>String(s||'').replace(/[\r\n|\[\]]/g,' ');
function taskCoverage(pack) {
  const steps=`${pack.steps.filter(s=>s.executed===true).length}/${pack.steps.length} 步`;
  const claims=`${pack.claims.filter(c=>c.status==='verified').length}/${pack.claims.length} 完成声明已验证`;
  return `${steps}；${claims}${pack.readerChecks?.length ? '；需读者核对实际结果' : ''}`;
}
function updateHandbook({projectRoot,config}) {
  const state=path.join(projectRoot,config.artifacts.stateDir),dir=path.join(state,'releases');
  const rows=[];
  for(const id of fs.existsSync(dir)?fs.readdirSync(dir).sort():[]) {
    if(!/^(page|task)-[a-z0-9-]+$/.test(id))continue;
    const r=readCurrentRelease(state,id);if(!r||!fs.existsSync(path.join(projectRoot,r.documentPath)))continue;
    const pack=r.facts?.factPack;
    const href=path.relative(path.join(projectRoot,config.docs.outputDir),path.join(projectRoot,r.documentPath)).replace(/\\/g,'/');
    const coverage=pack?.kind==='task' ? taskCoverage(pack) : (pack?.guide?.length?'页面总览与操作说明':'页面总览');
    rows.push(`| [${text(pack?.title||id)}](${href}) | ${text(coverage)} |`);
  }
  const generated=[OPEN,'# 使用手册','','按要完成的任务选择指南。验证范围反映生成时的证据，不能替代当前在线验证。','','| 指南 | 证据范围 |','|---|---|',...rows,CLOSE].join('\n');
  const file=path.join(projectRoot,config.docs.outputDir,'index.md');
  const prior=fs.existsSync(file)?fs.readFileSync(file,'utf8'):'';
  if(prior && !(prior.includes(OPEN)&&prior.includes(CLOSE)))return {file,updated:false,warning:'catalog-human-owned: index.md 已存在且无生成标记，保留人工内容。'};
  const content=prior ? prior.slice(0,prior.indexOf(OPEN))+generated+prior.slice(prior.indexOf(CLOSE)+CLOSE.length) : generated+'\n';
  fs.mkdirSync(path.dirname(file),{recursive:true});writeFileAtomic(file,content);
  return {file,updated:true,entries:rows.length};
}
module.exports={updateHandbook,taskCoverage};
