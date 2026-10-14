'use strict';

/*
 * 路由发现适配器注册表（docs/MULTI_FRAMEWORK_PLAN.md §5.1）。
 *
 * 适配器只回答两件事：能不能分析当前项目（detect），以及产出标准化的路由记录（discover）。
 * 截图、AI 描述、写文件、增量更新都与它无关。注册顺序即优先级：同一项目命中多个时取第一个。
 */

const ADAPTERS = [
  require('./nextjs'),
  require('./react-router'),
  require('./vue-router'),
];

function adapterById(id) {
  return ADAPTERS.find((adapter) => adapter.id === id) || null;
}

module.exports = { ADAPTERS, adapterById };
