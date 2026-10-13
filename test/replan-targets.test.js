'use strict';
// 回归：页面变体展开出的 scenario 依赖不能记成用户目标，否则 resume --replan 报 invalid-plan
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { userTargets } = require('../src/runtime/app');

assert.deepEqual(userTargets({ command: 'generate', targets: ['scenario:page-chat-menu', 'page:chat', 'task:send'] }), ['page:chat', 'task:send'], 'generate 重新规划只用页面与任务目标');
assert.deepEqual(userTargets({ command: 'capture', targets: ['scenario:page-chat-menu'] }), ['scenario:page-chat-menu'], 'capture 允许独立的 scenario 目标');
const planner = fs.readFileSync(path.join(__dirname, '../src/runtime/planner.js'), 'utf8');
assert(/targets: snapshot\.targets\.filter\(\(t\) => !t\.dependencyFor\)\.map\(\(t\) => t\.ref\)/.test(planner), '常规计划体必须过滤变体依赖');
console.log('replan-targets: variant scenarios stay out of replanned targets');
