'use strict';
// 回归：不跟踪的角色（menu）也要结束同级容器，菜单项不能被挂到前一个同级 region 下
const assert = require('assert');
const { parseAriaSnapshot } = require('../src/verify/semantic-diff');

const items = parseAriaSnapshot([
  '- region "Notifications alt+T"',
  '- menu "更多活动操作":',
  '  - menuitem "详情"',
  '  - menuitem "重置链接"',
  '- region "活动关键指标":',
  '  - button "刷新"',
].join('\n'));
const reset = items.find(i => i.name === '重置链接');
assert(reset && !reset.within, `菜单项不应带 within：${JSON.stringify(reset)}`);
assert.deepEqual(items.find(i => i.name === '刷新').within, { role: 'region', name: '活动关键指标', exact: true }, '真实的父级 region 仍要保留');
console.log('semantic-scope: sibling containers end at untracked roles');
