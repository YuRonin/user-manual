'use strict';

const path = require('path');
const { pageInventory } = require('./coverage');
const { writeText } = require('../util/fsx');

function inventorySnapshot(pages, tasks = []) {
  const features = [];
  for (const page of pages) {
    // 与采集、发布门禁同一个入口（默认 Scenario 的页面清单）；任务步骤的隐式标注是提示性的，不列入
    features.push({ page_id: page.id, route: page.route, features: pageInventory({ page }) });
  }
  return { version: 1, pages: features, pending: features.flatMap((page) => page.features.filter((item) => item.priority === 'undecided').map((item) => ({ page_id: page.page_id, feature_id: item.feature_id, label: item.label }))) };
}

function writeInventory(stateDirAbs, pages, tasks = []) {
  const snapshot = inventorySnapshot(pages, tasks);
  const file = path.join(stateDirAbs, 'feature-inventory.json');
  writeText(file, JSON.stringify(snapshot, null, 2) + '\n');
  return { file, snapshot };
}

module.exports = { inventorySnapshot, writeInventory };
