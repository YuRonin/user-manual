'use strict';

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildDiscoveryWorklist(pages, tasks = []) {
  return pages.map((page) => ({
    page: {
      id: page.id,
      route: page.route,
      title: page.title,
      purpose: page.purpose,
      browserVerified: !!page.browser?.verified,
      browserObservation: page.browser?.verified && page.browser?.latestCaptureId
        ? { scope: 'page-entry', captureId: page.browser.latestCaptureId }
        : null,
    },
    detectedActions: Array.isArray(page.detectedActions) ? page.detectedActions : [],
    stepHints: (page.guide || []).map(({ id, title, instruction, target }) => ({
      id, title, instruction, page: page.id, ...(target ? { target } : {}), source: 'page-guide', verified: false,
    })),
    assertionHints: Object.entries(page.states || {}).flatMap(([stateId, state]) =>
      (state.assertions || []).map((assertion, index) => ({
        stateId, assertion, assertionRef: assertion.id || `${page.id}:${stateId}#${index}`,
        source: 'page-state', verified: false,
      }))),
    preconditionHints: unique(tasks.filter(task => task.entryPage === page.id)
      .flatMap(task => Array.isArray(task.preconditions) ? task.preconditions : []))
      .map(text => ({ text, source: 'existing-task', verified: false })),
    existingTasks: tasks.filter(task => task.entryPage === page.id).map(({ id, title, status }) => ({ id, title, status })),
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
