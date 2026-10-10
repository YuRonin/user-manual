'use strict';

const path = require('path');
const { buildInventory } = require('./coverage');
const { writeText } = require('../util/fsx');

function inventorySnapshot(pages, tasks = []) {
  const features = [];
  for (const page of pages) {
    const byId = new Map(buildInventory({ page }).map((item) => [item.feature_id, item]));
    for (const task of tasks) {
      for (const item of buildInventory({ page, task })) byId.set(item.feature_id, item);
    }
    features.push({ page_id: page.id, route: page.route, features: [...byId.values()] });
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
