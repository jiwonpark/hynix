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

// Use fast compressed animation scale so unit tests run real RAF animation loops rapidly
MultiSpan.animationDurationScale = 0.05;
const flushAnimations = async (ms = 40) => {
  await new Promise((r) => setTimeout(r, ms));
};

// Test range change synchronization (Anchor & Range modes)
let targetSetRangeCalled = null;
let targetVisibleRange = { from: 50, to: 150 };
const mockTargetChart = {
  timeScale: () => ({
    getVisibleRange: () => targetVisibleRange,
    setVisibleRange: (r) => { targetVisibleRange = r; targetSetRangeCalled = r; },
    width: () => 500,
  }),
};
MultiSpan.charts["1s"] = {
  timeScale: () => ({
    getVisibleRange: () => ({ from: 1000, to: 1200 }),
    setVisibleRange: () => {},
    width: () => 500,
  }),
};
MultiSpan.charts["5m"] = mockTargetChart;
MultiSpan.syncEnabled = true;
MultiSpan.syncMode = "range";
MultiSpan.isSyncing = false;

// Trigger range change on 1s
MultiSpan.handleRangeChange("1s", { from: 1000, to: 1200 });
await flushAnimations();
assert.ok(targetSetRangeCalled, "Target chart setVisibleRange should be called in range mode after animation");
assert.equal(targetSetRangeCalled.from, 1000, "Target from should match source from in range mode");
assert.equal(targetSetRangeCalled.to, 1200, "Target to should match source to in range mode");

// Re-entrancy guard test: when isSyncing is true, nothing should happen
targetSetRangeCalled = null;
MultiSpan.isSyncing = true;
MultiSpan.handleRangeChange("1s", { from: 2000, to: 2200 });
await flushAnimations();
assert.equal(targetSetRangeCalled, null, "Must not sync while isSyncing guard is active");
MultiSpan.isSyncing = false;

// Test Hover & Click Behavior:
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

// 2. Hover on finest chart (1s) must ALSO be separate: NO crosshair broadcast to other charts
crosshairCalls = [];
MultiSpan.handleCrosshairMove("1s", { time: 200 });
assert.equal(crosshairCalls.length, 0, "Hover on finest chart (1s) must NOT broadcast crosshairs to other charts (hover is local and separate)");

// 2b. Click on 1s chart sets pinnedTime and broadcasts crosshairs to other charts
crosshairCalls = [];
MultiSpan.handleChartClick("1s", { time: 200 });
assert.equal(MultiSpan.pinnedTime, 200, "Clicking 1s chart must set pinnedTime");
assert.ok(crosshairCalls.some((c) => c.span === "5m" && c.t === 200), "Clicking 1s chart must broadcast crosshair to 5m");

// 2c. Subsequent hover on 5m chart does NOT clear or change 1s pinned crosshair
crosshairCalls = [];
MultiSpan.handleCrosshairMove("5m", { time: 100 });
assert.equal(crosshairCalls.length, 0, "Hovering on 5m must NOT alter 1s chart crosshair");
assert.equal(MultiSpan.pinnedTime, 200, "pinnedTime must stay locked across hovers");

// 3. Click on coarser chart (5m):
// - MUST NOT highlight range until zoom & pan animation finishes
// - MUST animate smoothly to centered zoom & pan and reveal highlight cleanly upon completion
crosshairCalls = [];
let narrowerChart1sSetRange = { from: 0, to: 1 };
let hlEl1s = { style: { display: "none" } };
let badgeEl1s = { style: {} };
const origGetById = sandbox.document.getElementById;
sandbox.document.getElementById = (id) => {
  if (id === "msRangeHighlight_1s") return hlEl1s;
  if (id === "msRangeBadge_1s") return badgeEl1s;
  return origGetById(id);
};

MultiSpan.candlesData["1s"] = [
  { time: 100, close: 10 },
  { time: 200, close: 20 },
  { time: 300, close: 30 },
  { time: 450, close: 45 },
  { time: 600, close: 60 },
];
MultiSpan.charts["1s"].timeScale = () => ({
  getVisibleRange: () => ({ from: 100, to: 600 }),
  getVisibleLogicalRange: () => narrowerChart1sSetRange,
  setVisibleRange: (r) => { narrowerChart1sSetRange = r; },
  setVisibleLogicalRange: (r) => { narrowerChart1sSetRange = r; },
  logicalToCoordinate: (idx) => {
    const span = narrowerChart1sSetRange.to - narrowerChart1sSetRange.from;
    return span > 0 ? ((idx - narrowerChart1sSetRange.from) / span) * 500 : 0;
  },
  width: () => 500,
});
MultiSpan.handleChartClick("5m", { time: 300 });
assert.ok(crosshairCalls.some((c) => c.span === "1s" && c.t === 300), "Click on coarser chart must broadcast crosshair to 1s");
assert.equal(MultiSpan.pinnedTime, 300, "Click on coarser chart must set pinnedTime to stay");

// Immediately after click (mid-animation), highlight MUST still be hidden & readySpans["1s"] falsy!
assert.equal(hlEl1s.style.display, "none", "Highlight must NOT be shown until pan & zoom animation finishes");
assert.ok(!MultiSpan.activeRangeHighlight.readySpans["1s"], "readySpans['1s'] must remain false during animation");
assert.equal(MultiSpan.animatingSpans["1s"], true, "1s chart must animate continuously to target pan/zoom");

await flushAnimations(60);
assert.equal(MultiSpan.animatingSpans["1s"], false, "1s chart animation should complete cleanly");
assert.equal(MultiSpan.activeRangeHighlight.readySpans["1s"], true, "readySpans['1s'] must turn true after pan & zoom finish");
assert.equal(hlEl1s.style.display, "block", "Highlight must be revealed only after zoom & pan settle");
assert.equal((narrowerChart1sSetRange.from + narrowerChart1sSetRange.to) / 2, 2.5, "Narrower chart must center cleanly on visual candle range [1.5, 3.5]");

// 3b. Click drill-down zooms out 1s chart enough to frame full 5m candle (300 bars -> ~375 bars) without changing syncedCandleCount
const baseT = Math.floor(Date.now() / 1000) - 2000;
MultiSpan.candlesData["1s"] = new Array(1200).fill(0).map((_, i) => ({ time: baseT + i, close: 100 }));
MultiSpan.candlesData["5m"] = [
  { time: baseT, close: 100 },
  { time: baseT + 300, close: 105 },
  { time: baseT + 600, close: 110 },
];
narrowerChart1sSetRange = { from: 1094, to: 1200 };
MultiSpan.handleChartClick("5m", { time: baseT + 300 });
assert.equal(hlEl1s.style.display, "none", "Highlight resets and hides on new click until zoom & pan complete");
await flushAnimations(60);
const zoomedCount1s = narrowerChart1sSetRange.to - narrowerChart1sSetRange.from;
assert.ok(zoomedCount1s >= 375, `1s chart must zoom out to frame full 5m range (>= 375 bars, got ${zoomedCount1s})`);
assert.equal(hlEl1s.style.display, "block", "Highlight shows once drill-down zoom & pan settle");
sandbox.document.getElementById = origGetById;

// 4. Test findCandleIndexAtOrBefore
MultiSpan.candlesData["5m"] = [
  { time: 100, close: 10 },
  { time: 200, close: 20 },
  { time: 300, close: 30 },
  { time: 400, close: 40 },
];
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 250), 1);
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 300), 2);
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 450), 3);
assert.equal(MultiSpan.findCandleIndexAtOrBefore("5m", 50), -1);

// 5. Verify Independent Zoom (Zoom sync removed: zooming one chart does NOT alter other charts)
let targetSetLogicalRangeCalled = null;
let mock5mLogicalRange = { from: 400, to: 500 };
MultiSpan.candlesData["1s"] = new Array(1000).fill(0).map((_, i) => ({ time: 1000 + i, close: 100 + i }));
MultiSpan.candlesData["5m"] = new Array(500).fill(0).map((_, i) => ({ time: 1000 + i * 300, close: 100 + i }));

MultiSpan.charts["1s"] = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 940, to: 1000 }),
    setVisibleLogicalRange: () => {},
    width: () => 500,
  }),
};
MultiSpan.charts["5m"] = {
  timeScale: () => ({
    getVisibleLogicalRange: () => mock5mLogicalRange,
    setVisibleLogicalRange: (r) => { mock5mLogicalRange = r; targetSetLogicalRangeCalled = r; },
    width: () => 500,
  }),
};
MultiSpan.cancelSpanAnimation("1s");
MultiSpan.cancelSpanAnimation("5m");
MultiSpan.isLogicalSyncing = false;
MultiSpan.isSyncing = false;
MultiSpan.programmaticSpans = {};

// When 1s chart logical range changes (user zooms 1s), 5m chart must NOT be forced to match
MultiSpan.handleLogicalRangeChange("1s", { from: 940, to: 1000 });
await flushAnimations(50);
assert.equal(targetSetLogicalRangeCalled, null, "Target chart setVisibleLogicalRange must NOT be called on zoom (independent zoom)");
assert.equal(mock5mLogicalRange.from, 400, "5m chart logical range 'from' must remain unchanged");
assert.equal(mock5mLogicalRange.to, 500, "5m chart logical range 'to' must remain unchanged");

// 6. Test reloading finer chart when clicked range is not fully loaded
let reloadSpanCalled = null;
const origReload = MultiSpan.reloadSpanToRange;
MultiSpan.reloadSpanToRange = (span, start, end, navId) => { reloadSpanCalled = { span, start, end, navId }; };
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

// Forming/live candle whose endTime is slightly in the future must NOT trigger spurious reload if data goes up to now
const nowSec = Math.floor(Date.now() / 1000);
MultiSpan.candlesData["1s"] = new Array(600).fill(0).map((_, i) => ({ time: nowSec - 600 + i, close: 100 }));
MultiSpan.candlesData["5m"].push({ time: nowSec - 120, close: 100 });
reloadSpanCalled = null;
MultiSpan.handleChartClick("5m", { time: nowSec - 120 });
assert.equal(reloadSpanCalled, null, "Clicking forming live candle must NOT spuriously trigger reloadSpanToRange");
MultiSpan.reloadSpanToRange = origReload;

// 7. Test activeRangeHighlight when clicking a coarser chart
MultiSpan.candlesData["1h"] = [{ time: 10000, close: 100 }, { time: 13600, close: 105 }];
MultiSpan.reloadSpanToRange = () => {};
MultiSpan.handleChartClick("1h", { time: 10000 });
assert.ok(MultiSpan.activeRangeHighlight, "activeRangeHighlight must be populated when clicking 1h");
assert.equal(MultiSpan.activeRangeHighlight.sourceSpan, "1h");
assert.equal(MultiSpan.activeRangeHighlight.startTime, 10000);
assert.equal(MultiSpan.activeRangeHighlight.endTime, 10000 + 3600);
assert.equal(JSON.stringify(MultiSpan.activeRangeHighlight.finerSpans), JSON.stringify(["1s", "5m", "15m"]));
MultiSpan.reloadSpanToRange = origReload;

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

// 10. Test Adjustable Charts Per Row (1..5 and auto)
const mockWrapper = { style: {} };
sandbox.document.getElementById = (id) => (id === "msChartsWrapper" ? mockWrapper : null);

MultiSpan.setChartsPerRow(1);
assert.equal(MultiSpan.chartsPerRow, "1");
assert.equal(MultiSpan.activeLayout, "grid");
assert.equal(mockWrapper.style.gridTemplateColumns, "repeat(1, minmax(0, 1fr))");

MultiSpan.setChartsPerRow(2);
assert.equal(MultiSpan.chartsPerRow, "2");
assert.equal(mockWrapper.style.gridTemplateColumns, "repeat(2, minmax(0, 1fr))");

MultiSpan.setChartsPerRow(3);
assert.equal(MultiSpan.chartsPerRow, "3");
assert.equal(mockWrapper.style.gridTemplateColumns, "repeat(3, minmax(0, 1fr))");

MultiSpan.setChartsPerRow(4);
assert.equal(MultiSpan.chartsPerRow, "4");
assert.equal(mockWrapper.style.gridTemplateColumns, "repeat(4, minmax(0, 1fr))");

MultiSpan.setChartsPerRow(5);
assert.equal(MultiSpan.chartsPerRow, "5");
assert.equal(mockWrapper.style.gridTemplateColumns, "repeat(5, minmax(0, 1fr))");

MultiSpan.setChartsPerRow("auto");
assert.equal(MultiSpan.chartsPerRow, "auto");
assert.equal(mockWrapper.style.gridTemplateColumns, "repeat(auto-fit, minmax(420px, 1fr))");

console.log("All Multi-Span synchronization unit tests passed!");
