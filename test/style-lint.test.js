'use strict';
/*
 * 手册文字风格检查：style-lint 本身，以及它在文案提交、describe、任务质量里的接入。
 */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {lintProse}=require('../src/generate/style-lint');
const {validateCopy}=require('../src/generate/markdown-validate');
const {validateEntry}=require('../src/commands/describe');
const {taskQuality}=require('../src/generate/quality');

const codes=text=>lintProse(text).map(f=>f.code);

test('lintProse：套话、“您”、连串「」、同段重复「」都能命中',()=>{
  assert.deepEqual(codes('值得注意的是，上传前先压缩。'),['stock-phrase']);
  assert.deepEqual(codes('您可以在这里查看积分。'),['formal-you']);
  assert.deepEqual(codes('在「活动标题」「开始时间」「结束时间」中修改。'),['ui-quote-chain']);
  assert.deepEqual(codes('在「标题」、「开始时间」和「结束时间」中修改。'),['ui-quote-chain']);
  assert.deepEqual(codes('输入「教案生成」，再点击「教案生成」。'),['ui-quote-repeat']);
});

test('lintProse：正常写法不误报',()=>{
  for (const text of [
    '在答案公布方式里选择「提交后可查看答案」或「活动结束后自动公布」。',
    '在我的活动列表里找到草稿，点击「继续编辑」进入详情，修改后点击「保存草稿」。',
    '写好问题后，点击「发送」，回复会出现在当前对话里。',
    '',
  ]) assert.deepEqual(lintProse(text),[],text);
});

test('validateCopy：风格问题按 style-* 拒绝，不影响其它块',()=>{
  const pack={allowedUiTerms:['发送','新对话'],blocks:{intro:{default:'与 AI 对话。'},'step.send':{default:'提交后等待回复。'}}};
  const result=validateCopy(pack,{intro:'在这里与 AI 对话，高效地完成备课。','step.send':'发送后，回复出现在当前对话里。'});
  assert.equal(result.ok,false);
  assert.deepEqual(result.blocked.map(f=>[f.blockId,f.code]),[['intro','style-stock-phrase']]);
});

test('describe：purpose 与 guide 命中风格问题时拒绝写入',()=>{
  const errors=[];
  const patch=validateEntry({id:'activities',purpose:'一站式管理活动。',guide:[{id:'info',title:'修改活动信息',instruction:'在「活动标题」「开始时间」「结束时间」中修改。'}]},0,new Set(['activities']),errors);
  assert.ok(errors.some(e=>e.includes('style-stock-phrase')&&e.includes('purpose')),errors.join('\n'));
  assert.ok(errors.some(e=>e.includes('style-ui-quote-chain')&&e.includes('guide[0].instruction')),errors.join('\n'));
  assert.equal(patch?.guide,undefined);
});

test('taskQuality：读者字段的风格问题只给警告，标题里的「」单独提示',()=>{
  const task={title:'从「我要出题」生成练习题',goal:'生成练习题',preconditions:['已登录'],readerPreconditions:['您需要先登录'],
    steps:[{id:'send',instruction:'点击「发送」',action:{type:'click',target:{role:'button',name:'发送'}}}],
    branches:[{id:'none',condition:'没有回复',effect:'需要注意的是，回复可能还在生成。'}]};
  const {warnings}=taskQuality(task,{});
  assert.ok(warnings.some(w=>w.startsWith('style-formal-you（readerPreconditions[0]）')),warnings.join('\n'));
  assert.ok(warnings.some(w=>w.startsWith('style-stock-phrase（branches.none.effect）')),warnings.join('\n'));
  assert.ok(warnings.some(w=>w.startsWith('style-quote-in-title')),warnings.join('\n'));
});
