import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(__dirname, "../multi-span-tab.js"), "utf8");

// Create test sandbox
const sandbox = {
  document: {
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
  },
  window: {},
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  module: { exports: {} },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const MultiSpan = sandbox.module.exports;

assert.ok(MultiSpan, "MultiSpan module must export properly");
assert.equal(typeof MultiSpan.mount, "function", "mount method must exist");
assert.equal(typeof MultiSpan.handleRangeChange, "function", "handleRangeChange must exist");
assert.equal(typeof MultiSpan.calculateSma, "function", "calculateSma must exist");
assert.equal(typeof MultiSpan.findCandleAtOrBefore, "function", "findCandleAtOrBefore must exist");

// Test SMA calculation
const testData = [];
for (let i = 1; i <= 30; i++) {
  testData.push({ time: 1000 + i * 60, close: i * 10 });
}
const sma20 = MultiSpan.calculateSma(testData, 20);
assert.equal(sma20.length, 11, "30 items with period 20 should produce 11 SMA points");
// First SMA point at index 19 (values 10..200, sum = 2100, avg = 105)
assert.equal(sma20[0].value, 105);

// Test findCandleAtOrBefore (binary search)
MultiSpan.candlesData["5m"] = [
  { time: 100, close: 10 },
  { time: 200, close: 20 },
  { time: 300, close: 30 },
  { time: 400, close: 40 },
];
assert.equal(MultiSpan.findCandleAtOrBefore("5m", 250).time, 200);
assert.equal(MultiSpan.findCandleAtOrBefore("5m", 300).time, 300);
assert.equal(MultiSpan.findCandleAtOrBefore("5m", 450).time, 400);
assert.equal(MultiSpan.findCandleAtOrBefore("5m", 50).time, 100);

// Test range change synchronization (Anchor & Range modes)
let targetSetRangeCalled = null;
const mockTargetChart = {
  timeScale: () => ({
    getVisibleRange: () => ({ from: 50, to: 150 }),
    setVisibleRange: (r) => { targetSetRangeCalled = r; },
  }),
};
MultiSpan.charts["1s"] = {
  timeScale: () => ({
    getVisibleRange: () => ({ from: 1000, to: 1200 }),
    setVisibleRange: () => {},
  }),
};
MultiSpan.charts["5m"] = mockTargetChart;
MultiSpan.syncEnabled = true;
MultiSpan.syncMode = "range";
MultiSpan.isSyncing = false;

// Trigger range change on 1s
MultiSpan.handleRangeChange("1s", { from: 1000, to: 1200 });
assert.ok(targetSetRangeCalled, "Target chart setVisibleRange should be called in range mode");
assert.equal(targetSetRangeCalled.from, 1000, "Target from should match source from in range mode");
assert.equal(targetSetRangeCalled.to, 1200, "Target to should match source to in range mode");

// Re-entrancy guard test: when isSyncing is true, nothing should happen
targetSetRangeCalled = null;
MultiSpan.isSyncing = true;
MultiSpan.handleRangeChange("1s", { from: 2000, to: 2200 });
// Test Hover Behavior:
// 1. Hover on 5m (coarser) must NOT position crosshair on other charts
let crosshairCalls = [];
MultiSpan.candlesData["1s"] = [{ time: 100, close: 10 }, { time: 200, close: 20 }, { time: 300, close: 30 }];
MultiSpan.series["1s"] = {};
MultiSpan.series["5m"] = {};
MultiSpan.charts["1s"].setCrosshairPosition = (p, t, s) => { crosshairCalls.push({ span: "1s", p, t }); };
MultiSpan.charts["5m"].setCrosshairPosition = (p, t, s) => { crosshairCalls.push({ span: "5m", p, t }); };

crosshairCalls = [];
MultiSpan.handleCrosshairMove("5m", { time: 200 });
assert.equal(crosshairCalls.length, 0, "Hover on coarser chart (5m) must NOT broadcast crosshairs to other charts");

// 2. Hover on 1s (finest) MUST broadcast crosshairs to other charts
crosshairCalls = [];
MultiSpan.handleCrosshairMove("1s", { time: 200 });
assert.equal(crosshairCalls.length, 1, "Hover on finest chart (1s) MUST broadcast crosshairs to other charts");
assert.equal(crosshairCalls[0].span, "5m");
assert.equal(crosshairCalls[0].t, 200);

// 3. Click on coarser chart (5m) MUST broadcast crosshairs AND re-center narrower charts (1s)
crosshairCalls = [];
let narrowerChart1sSetRange = null;
MultiSpan.candlesData["1s"] = [
  { time: 100, close: 10 },
  { time: 200, close: 20 },
  { time: 300, close: 30 },
  { time: 450, close: 45 },
  { time: 600, close: 60 },
];
MultiSpan.charts["1s"].timeScale = () => ({
  getVisibleRange: () => ({ from: 100, to: 600 }),
  setVisibleRange: (r) => { narrowerChart1sSetRange = r; },
  setVisibleLogicalRange: (r) => { narrowerChart1sSetRange = r; },
});
MultiSpan.handleChartClick("5m", { time: 300 });
assert.equal(crosshairCalls.length, 1, "Click on coarser chart must broadcast crosshair");
assert.equal(crosshairCalls[0].span, "1s");
assert.equal(crosshairCalls[0].t, 300);
assert.ok(narrowerChart1sSetRange, "Click on coarser chart must re-center narrower chart when range is covered");
assert.equal((narrowerChart1sSetRange.from + narrowerChart1sSetRange.to) / 2, 2, "Narrower chart must be centered on candle index 2 (time 300)");
// 4. Test findCandleIndexAtOrBefore
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 250), 1);
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 300), 2);
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 450), 3);
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 50), -1);

// 5. Test Zoom Level (Visible Candle Count) Synchronization
let targetSetLogicalRangeCalled = null;
MultiSpan.candlesData["1s"] = new Array(1000).fill(0).map((_, i) => ({ time: 1000 + i, close: 100 + i }));
MultiSpan.candlesData["5m"] = new Array(500).fill(0).map((_, i) => ({ time: 1000 + i * 300, close: 100 + i }));

MultiSpan.charts["1s"] = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 940, to: 1000 }),
    setVisibleLogicalRange: () => {},
  }),
};
MultiSpan.charts["5m"] = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 400, to: 500 }),
    setVisibleLogicalRange: (r) => { targetSetLogicalRangeCalled = r; },
  }),
};
MultiSpan.isLogicalSyncing = false;
MultiSpan.isSyncing = false;
MultiSpan.syncedCandleCount = 100;

// User zooms 1s chart from 100 bars to 60 bars (from: 940, to: 1000)
MultiSpan.handleLogicalRangeChange("1s", { from: 940, to: 1000 });
assert.ok(targetSetLogicalRangeCalled, "Target chart setVisibleLogicalRange should be called on zoom");
assert.equal(targetSetLogicalRangeCalled.to - targetSetLogicalRangeCalled.from, 60, "Target chart must have exactly 60 visible candles");
assert.equal(MultiSpan.syncedCandleCount, 60, "syncedCandleCount must be updated to 60");

// Test setSyncedCandleCount preset
targetSetLogicalRangeCalled = null;
MultiSpan.setSyncedCandleCount(30);
assert.ok(targetSetLogicalRangeCalled, "Target chart setVisibleLogicalRange must be called by preset");
assert.equal(targetSetLogicalRangeCalled.to - targetSetLogicalRangeCalled.from, 30, "Target chart must have exactly 30 visible candles");
assert.equal(MultiSpan.syncedCandleCount, 30, "syncedCandleCount must be 30");

// 6. Test reloading finer chart when clicked range is not fully loaded
let reloadSpanCalled = null;
MultiSpan.reloadSpanToRange = (span, start, end) => { reloadSpanCalled = { span, start, end }; };
// Add 5m candle at time 500. 1s currently only has times 1000..1999 (outside 1s loaded range):
MultiSpan.candlesData["5m"].unshift({ time: 500, close: 50 });
MultiSpan.handleChartClick("5m", { time: 500 });
assert.ok(reloadSpanCalled, "reloadSpanToRange must be called when clicked time is outside finer chart loaded range");
assert.equal(reloadSpanCalled.span, "1s");
assert.equal(reloadSpanCalled.start, 500);
assert.equal(reloadSpanCalled.end, 800);

// If clicked range is INSIDE loaded range (e.g. 5m candle at 1500 spans 1500..1800, inside 1000..1999), reload must NOT be called
reloadSpanCalled = null;
MultiSpan.handleChartClick("5m", { time: 1500 });
assert.equal(reloadSpanCalled, null, "reloadSpanToRange must NOT be called when range is already inside loaded range");

// 7. Test activeRangeHighlight when clicking a coarser chart
MultiSpan.candlesData["1h"] = [{ time: 10000, close: 100 }, { time: 13600, close: 105 }];
MultiSpan.handleChartClick("1h", { time: 10000 });
assert.ok(MultiSpan.activeRangeHighlight, "activeRangeHighlight must be populated when clicking 1h");
assert.equal(MultiSpan.activeRangeHighlight.sourceSpan, "1h");
assert.equal(MultiSpan.activeRangeHighlight.startTime, 10000);
assert.equal(MultiSpan.activeRangeHighlight.endTime, 10000 + 3600);
assert.equal(JSON.stringify(MultiSpan.activeRangeHighlight.finerSpans), JSON.stringify(["1s", "5m", "15m"]));

// Clicking on finest chart (1s) clears activeRangeHighlight
MultiSpan.handleChartClick("1s", { time: 10000 });
assert.equal(MultiSpan.activeRangeHighlight, null, "Clicking on finest chart must clear activeRangeHighlight");

// 8. Test loadMoreHistorical prepending older candles & shifting logical range
let shiftedLogicalRange = null;
MultiSpan.candlesData["1s"] = [
  { time: 1000, open: 1, high: 2, low: 1, close: 2 },
  { time: 1001, open: 2, high: 3, low: 2, close: 3 },
];
MultiSpan.series["1s"] = { setData: () => {} };
MultiSpan.charts["1s"] = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 0, to: 2 }),
    setVisibleLogicalRange: (r) => { shiftedLogicalRange = r; },
  }),
};
MultiSpan.fetchKlinesForSpan = async (sym, span, limit, endMs) => {
  return [
    { time: 998, open: 1, high: 2, low: 1, close: 1 },
    { time: 999, open: 1, high: 2, low: 1, close: 2 },
  ];
};
await MultiSpan.loadMoreHistorical("1s");
assert.equal(MultiSpan.candlesData["1s"].length, 4, "Prepended 2 candles so total length must be 4");
assert.equal(MultiSpan.candlesData["1s"][0].time, 998, "Earliest candle must now be time 998");
assert.ok(shiftedLogicalRange, "Visible logical range must be shifted when older candles are prepended");
assert.equal(shiftedLogicalRange.from, 2, "from index must shift by +2 added candles");
assert.equal(shiftedLogicalRange.to, 4, "to index must shift by +2 added candles");

// 9. Test fetchKlinesRange multi-batch pagination
const batchCalls = [];
MultiSpan.fetchKlinesForSpan = async (sym, span, limit, endMs) => {
  batchCalls.push(endMs);
  if (batchCalls.length === 1) {
    return [
      { time: 3000, open: 1, high: 2, low: 1, close: 1 },
      { time: 4000, open: 1, high: 2, low: 1, close: 1 },
    ];
  } else if (batchCalls.length === 2) {
    return [
      { time: 1000, open: 1, high: 2, low: 1, close: 1 },
      { time: 2000, open: 1, high: 2, low: 1, close: 1 },
    ];
  }
  return [];
};
const rangeCandles = await MultiSpan.fetchKlinesRange("BTCUSDT", "1s", 1500, 4000, 5);
assert.equal(batchCalls.length, 2, "Should fetch 2 batches backwards until earliest candle <= startTime (1500)");
assert.equal(rangeCandles.length, 4, "Should aggregate all unique candles from batches");
assert.equal(rangeCandles[0].time, 1000);
assert.equal(rangeCandles[3].time, 4000);

console.log("All Multi-Span synchronization unit tests passed!");
