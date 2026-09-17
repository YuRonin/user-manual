'use strict';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildDiscoveryWorklist(pages) {
  return pages.map((page) => ({
    page: {
      id: page.id,
      route: page.route,
      title: page.title,
      purpose: page.purpose,
      browserVerified: !!page.browser?.verified,
    },
    detectedActions: Array.isArray(page.detectedActions) ? page.detectedActions : [],
    read: unique([
      ...(Array.isArray(page.source) ? page.source : []),
      page.entry,
      ...(Array.isArray(page.dependencies?.files) ? page.dependencies.files : []),
    ]),
    needs: [
      'title', 'goal', 'preconditions', 'risk', 'steps', 'completion',
      'sourceEvidence', 'keepMergeOrDiscardRecommendation',
    ],
  }));
}

module.exports = { buildDiscoveryWorklist };
