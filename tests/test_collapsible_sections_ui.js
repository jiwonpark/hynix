const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// 1. Verify CSS rules for collapsible sections
assert.ok(indexHtml.includes('.collapsible-section'), 'CSS must define .collapsible-section');
assert.ok(indexHtml.includes('.collapsible-section.is-collapsed'), 'CSS must define .collapsible-section.is-collapsed');
assert.ok(indexHtml.includes('.section-collapse-btn'), 'CSS must define .section-collapse-btn');
assert.ok(indexHtml.includes('.collapsible-section.is-collapsed > *:not(.collapsible-header)'), 'CSS must hide non-header children when collapsed');

// 2. Verify all major sections in index.html are marked collapsible
const expectedSections = [
  'secMarketEnvironment',
  'secStrategyOptimizer',
  'secParityChart',
  'secNewsCatalystFeed',
  'secHistogramPanel',
  'secSpectrumPanel',
  'secQuantArchitecturePanel',
  'secModelEvaluation',
  'secFaqPanel',
  'secAccountStrip',
  'secExecutionTerminal',
  'secHedgedController',
  'shortTermExecutionSection',
  'secPositionsTable',
  'secPairsControls',
  'secPairsMatrix',
  'secCustomPairScan',
  'secPairDeepDive',
  'secCompoundControls',
  'secCompYieldCurve',
  'secCompQueue',
  'secCompInvariants',
  'secUpbitRadarControls',
  'secUpbitRankMatrix'
];

for (const secId of expectedSections) {
  assert.ok(indexHtml.includes(secId), `Section ${secId} should exist in index.html`);
  const regex = new RegExp(`id="${secId}"[^>]*class="[^"]*collapsible-section|class="[^"]*collapsible-section[^"]*"[^>]*id="${secId}"`);
  assert.ok(regex.test(indexHtml), `Section ${secId} must have class "collapsible-section"`);
}

// 3. Verify collapsibleSectionsManager logic
assert.ok(indexHtml.includes('collapsibleSectionsManager'), 'collapsibleSectionsManager must be present in index.html');
assert.ok(indexHtml.includes('hynix_collapse_'), 'localStorage key prefix hynix_collapse_ must be present');

console.log('Collapsible sections UI & markup verification passed!');
