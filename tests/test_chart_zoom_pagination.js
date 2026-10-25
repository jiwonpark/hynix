const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Controller = require('../strategy-execution-chart.js');
const TerminalCommon = require('../terminal-common.js');

async function main() {

// 1. Test configureStandardTimeScale
let appliedOptions = null;
const mockChart = {
  applyOptions: (opts) => { appliedOptions = opts; },
  timeScale: () => mockTimeScale,
};
const mockTimeScale = {
  _range: { from: 50, to: 150 },
  applyOptions: (opts) => { appliedOptions = opts; },
  getVisibleLogicalRange: function() { return this._range; },
  setVisibleLogicalRange: function(r) { this._range = r; },
  subscribeVisibleLogicalRangeChange: function(fn) { this._sub = fn; },
  unsubscribeVisibleLogicalRangeChange: function(fn) { this._sub = null; },
};

Controller.configureStandardTimeScale(mockChart, { rightOffset: 0 });
assert.ok(appliedOptions.timeScale, 'must configure timeScale options');
assert.equal(appliedOptions.timeScale.minBarSpacing, 0.5);
assert.equal(appliedOptions.timeScale.shiftVisibleRangeOnNewBar, false);
assert.equal(appliedOptions.timeScale.rightOffset, 0);

// 2. Test applyPrependedRange preserves exact span while shifting range
mockTimeScale._range = { from: 10, to: 80 };
const shifted = Controller.applyPrependedRange(mockChart, 50);
assert.deepEqual(shifted, { from: 60, to: 130 });
assert.equal(shifted.to - shifted.from, 70, 'span must remain invariant after prepending older bars');
assert.deepEqual(mockTimeScale.getVisibleLogicalRange(), { from: 60, to: 130 });

// Test applyPrependedRange with baseRange argument
const shiftedWithBase = Controller.applyPrependedRange(mockChart, 20, { from: 5, to: 45 });
assert.deepEqual(shiftedWithBase, { from: 25, to: 65 });

// 3. Test attachZoomAwarePrefetch triggering prefetch on zoom
let prefetchTriggeredCount = 0;
let neededRequested = 0;
let isHistoryExhausted = false;

const detach = Controller.attachZoomAwarePrefetch(mockChart, {
  getTotalBars: () => 200,
  onPrefetchNeeded: async (needed) => {
    prefetchTriggeredCount++;
    neededRequested = needed;
    return 100;
  },
  isExhausted: () => isHistoryExhausted,
});

assert.ok(typeof detach === 'function', 'must return detach function');

// Trigger callback with wide zoom span (span 100 on 200 bars = 50% > 40%)
mockTimeScale._sub({ from: 20, to: 120 });
// Trigger again while loading - should NOT duplicate
mockTimeScale._sub({ from: 10, to: 110 });
await Promise.resolve();
assert.equal(prefetchTriggeredCount, 1, 'must trigger prefetch when zoom span > 40% of total bars');
assert.equal(prefetchTriggeredCount, 1, 'must not trigger concurrent prefetch while prior fetch is in flight');

// 4. Test boundary clamping
// Left boundary clamp when exhausted:
isHistoryExhausted = true;
mockTimeScale._range = { from: -40, to: 60 };
mockTimeScale._sub({ from: -40, to: 60 });
assert.equal(mockTimeScale.getVisibleLogicalRange().from, 0, 'must clamp left edge to 0 when history exhausted');
assert.equal(mockTimeScale.getVisibleLogicalRange().to, 100, 'span must be preserved during left clamp');

// Right boundary clamp: drifting into future void
mockTimeScale._range = { from: 210, to: 310 }; // totalBars = 200, from > 205
mockTimeScale._sub({ from: 210, to: 310 });
assert.equal(mockTimeScale.getVisibleLogicalRange().to, 208, 'must clamp right edge to totalBars + 8');

// 5. Test TerminalCommon candle caching
const storageMap = new Map();
global.localStorage = {
  getItem: (k) => storageMap.get(k) || null,
  setItem: (k, v) => storageMap.set(k, String(v)),
  removeItem: (k) => storageMap.delete(k),
};

const sampleBars = [
  { time: 1000, value: 50 },
  { time: 2000, value: 55 },
];
TerminalCommon.setCachedCandles('test_key', sampleBars);
const retrieved = TerminalCommon.getCachedCandles('test_key');
assert.equal(retrieved.length, 2);
assert.equal(retrieved[1].value, 55);
detach();

// 6. A single zoom-out must keep fetching until the enlarged viewport is backed
// by enough candles, even though range-change events fire during the first fetch.
let chainedBars = 200;
let chainedFetches = 0;
mockTimeScale._range = { from: 20, to: 120 };
const detachChained = Controller.attachZoomAwarePrefetch(mockChart, {
  getTotalBars: () => chainedBars,
  onPrefetchNeeded: async () => {
    chainedFetches += 1;
    chainedBars += 100;
    mockTimeScale._range = {
      from: mockTimeScale._range.from + 100,
      to: mockTimeScale._range.to + 100,
    };
    // Mirrors the callback emitted by applyPrependedRange while a request is active.
    mockTimeScale._sub(mockTimeScale._range);
    return 100;
  },
  hasMore: () => chainedFetches < 3,
});
mockTimeScale._sub(mockTimeScale._range);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(chainedFetches, 2, 'one zoom-out must chain older-page loads until the viewport is covered');
detachChained();

// 7. A larger zoom demand received during an in-flight request must be queued,
// not discarded or replaced by the smaller request which started first.
let queuedBars = 200;
let queuedCalls = [];
let finishFirst;
const firstPage = new Promise((resolve) => { finishFirst = resolve; });
const detachQueued = Controller.attachZoomAwarePrefetch(mockChart, {
  getTotalBars: () => queuedBars,
  onPrefetchNeeded: async (needed) => {
    queuedCalls.push(needed);
    if (queuedCalls.length === 1) await firstPage;
    queuedBars += 100;
    return 100;
  },
  hasMore: () => queuedCalls.length < 2,
});
mockTimeScale._sub({ from: 20, to: 120 });
await Promise.resolve();
mockTimeScale._sub({ from: -500, to: 200 });
finishFirst();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(queuedCalls.length, 2, 'rapid zoom-out must queue one follow-up page');
assert.ok(queuedCalls[1] >= 1050, 'follow-up page must retain the largest requested zoom span');
detachQueued();

// 8. Every trading chart surface must inherit the shared zoom-aware loader.
const root = path.join(__dirname, '..');
for (const file of ['strategy-lab.js', 'lighter-tab.js', 'crypto-tab.js', 'lighter-crypto-tab.js']) {
  assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /attachZoomAwarePrefetch\(/,
    `${file} must attach the shared zoom-aware history loader`);
}
const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assert.ok((indexSource.match(/attachZoomAwarePrefetch\(/g) || []).length >= 2,
  'index charts (research and live/paper) must both attach the shared zoom-aware history loader');
console.log('All chart zoom pagination, edge clamping, and candle caching tests passed!');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
