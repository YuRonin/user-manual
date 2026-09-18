'use strict';

const { detectRedactions } = require('../privacy/detector');

function planRedactions(elements, policy = {}) {
  return detectRedactions(elements, policy);
}

module.exports = { planRedactions };
