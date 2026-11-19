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
  setTimeout,
  clearTimeout,
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

// 11. Test MACD calculation (fast=12, slow=26, signal=9)
const dummyCandles = [];
for (let i = 0; i < 50; i++) {
  dummyCandles.push({
    time: 1000 + i * 60,
    open: 100 + i * 0.5,
    high: 102 + i * 0.5,
    low: 99 + i * 0.5,
    close: 100 + i * 0.5 + (i % 2 === 0 ? 1 : -1),
    volume: 10,
  });
}

const macdOutput = MultiSpan.calculateMacd(dummyCandles, 12, 26, 9);
assert.ok(macdOutput.macd.length > 0, "MACD line must have points for 50 candles");
assert.equal(macdOutput.macd.length, 50 - 26 + 1, "MACD line length should match candles - slowPeriod + 1");
assert.equal(macdOutput.signal.length, macdOutput.macd.length - 9 + 1, "Signal line length should match macd - signalPeriod + 1");
assert.equal(macdOutput.histogram.length, macdOutput.signal.length, "Histogram length should match signal line length");

macdOutput.histogram.forEach((h) => {
  if (h.value >= 0) {
    assert.equal(h.color, "rgba(5, 150, 105, 0.75)", "Positive histogram bar must be green");
  } else {
    assert.equal(h.color, "rgba(220, 38, 38, 0.75)", "Negative histogram bar must be red");
  }
});

const shortCandles = dummyCandles.slice(0, 20);
const shortMacd = MultiSpan.calculateMacd(shortCandles, 12, 26, 9);
assert.equal(shortMacd.macd.length, 0, "calculateMacd should return empty arrays if candles < slowPeriod");

// 12. Test MACD Legend DOM Updating
const mockElements = {
  msMacdVal_1s: { textContent: "" },
  msSigVal_1s: { textContent: "" },
  msHistVal_1s: { textContent: "", style: {} },
};
sandbox.document.getElementById = (id) => mockElements[id] || null;

MultiSpan.updateMacdLegend("1s", 1.23456, 0.87654, 0.35802);
assert.equal(mockElements.msMacdVal_1s.textContent, "1.2346", "MACD value formatted to 4 decimals");
assert.equal(mockElements.msSigVal_1s.textContent, "0.8765", "Signal value formatted to 4 decimals");
assert.equal(mockElements.msHistVal_1s.textContent, "+0.3580", "Positive histogram formatted with + prefix");
assert.equal(mockElements.msHistVal_1s.style.color, "#059669", "Positive histogram styled green");

MultiSpan.updateMacdLegend("1s", -0.5, 0.1, -0.6);
assert.equal(mockElements.msHistVal_1s.textContent, "-0.6000", "Negative histogram formatted without double minus");
assert.equal(mockElements.msHistVal_1s.style.color, "#dc2626", "Negative histogram styled red");

// 13. Test MACD Sub-Chart Crosshair Synchronization
let macdCrosshairCalls = [];
MultiSpan.macdCharts["5m"] = {
  setCrosshairPosition: (v, t, s) => { macdCrosshairCalls.push({ v, t, s }); },
  clearCrosshairPosition: () => { macdCrosshairCalls.push({ clear: true }); },
};
MultiSpan.macdHist["5m"] = {};
MultiSpan.macdData["5m"] = {
  macd: [{ time: 1000, value: 1.5 }],
  signal: [{ time: 1000, value: 1.2 }],
  histogram: [{ time: 1000, value: 0.3 }],
  byTime: new Map([[1000, { macd: 1.5, signal: 1.2, hist: 0.3, histogram: 0.3 }]]),
};

macdCrosshairCalls = [];
MultiSpan.handleCrosshairMove("5m", { time: 1000 }, "main");
assert.equal(macdCrosshairCalls.length, 1, "Moving crosshair on main chart must update MACD crosshair on same card");
assert.equal(macdCrosshairCalls[0].t, 1000, "MACD crosshair time must match main chart hovered time");
assert.equal(macdCrosshairCalls[0].v, 0.3, "MACD crosshair value must match histogram at hovered time");

// 14. Test KST Timezone & Localization
const fileContent = fs.readFileSync(path.join(__dirname, "../multi-span-tab.js"), "utf8");
assert.ok(fileContent.includes('timeZone: KST_TIME_ZONE') || fileContent.includes('Asia/Seoul'), "Must use Asia/Seoul timezone");
assert.ok(fileContent.includes('locale: "ko-KR"'), "Chart localization must specify ko-KR locale");
assert.ok(fileContent.includes('tickMarkFormatter: (time, tickMarkType) => formatKstTick'), "Chart time scale must specify formatKstTick");
assert.ok(fileContent.includes('TIME (KST):'), "HUD time must explicitly display (KST) label");

const hudTimeEl = { textContent: "" };
sandbox.document.getElementById = (id) => (id === "msHudTime" ? hudTimeEl : mockElements[id] || null);
MultiSpan.broadcastTimePoint(1763441544, "1s", false);
assert.ok(hudTimeEl.textContent.includes("KST"), "Broadcast time point must format in KST");
assert.ok(hudTimeEl.textContent.includes("13:52:24"), "Timestamp must correspond to KST wall-clock time");

// 15. Test KST midnight formatting (no 24:xx) and KST tick boundary formatting
const midnightKstSec = Date.UTC(2026, 10, 18, 15, 5, 9) / 1000; // 2026-11-19 00:05:09 KST
const kstMidnightHudEl = { textContent: "" };
const kstMidnightBadgeEl = { textContent: "" };
sandbox.document.getElementById = (id) => {
  if (id === "msHudTime") return kstMidnightHudEl;
  if (id === "msCardTime_5m") return kstMidnightBadgeEl;
  return mockElements[id] || null;
};
MultiSpan.candlesData["5m"] = [{ time: midnightKstSec, open: 10, high: 11, low: 9, close: 10 }];
MultiSpan.broadcastTimePoint(midnightKstSec, "5m", false);
assert.equal(kstMidnightHudEl.textContent, "2026-11-19 00:05:09 KST", "00:05 KST must format as 00:xx, not 24:xx");
assert.equal(kstMidnightBadgeEl.textContent, "11-19 00:05 KST", "Card time at 00:05 KST must format as 00:05, not 24:05");

const utcMidnightSec = Date.UTC(2026, 10, 19, 0, 0, 0) / 1000; // 09:00 KST
const kstZeroSec = Date.UTC(2026, 10, 18, 15, 0, 0) / 1000; // 00:00 KST
assert.equal(MultiSpan.formatKstTick(kstZeroSec, 2, "15m"), "11-19", "KST 00:00 boundary must label as date MM-DD");
assert.equal(MultiSpan.formatKstTick(utcMidnightSec, 2, "15m"), "11-19 09:00", "UTC midnight (09:00 KST) must include time instead of impersonating KST midnight");

// 16. Test MACD timestamp alignment (signal & histogram aligned to their own timestamps, not shifted by warmup offset)
const macdSetDataCalls = [];
const macdCandles = new Array(50).fill(0).map((_, i) => ({
  time: 10000 + i * 60,
  open: 100 + i,
  high: 102 + i,
  low: 99 + i,
  close: 100 + i * 1.1 + (i % 3),
}));
let logical5mState = { from: 10, to: 50 };
MultiSpan.series["5m"] = {
  setData: (d) => {
    // Simulate Lightweight Charts scrolling/resetting range inside setData when length grows
    logical5mState = { from: d.length - 20, to: d.length };
  },
  update: () => {},
};
MultiSpan.ma20["5m"] = { setData: () => {} };
MultiSpan.ma50["5m"] = { setData: () => {} };
MultiSpan.macdHist["5m"] = { setData: (d) => macdSetDataCalls.push({ kind: "hist", len: d.length }), update: () => {} };
MultiSpan.macdLine["5m"] = { setData: (d) => macdSetDataCalls.push({ kind: "macd", len: d.length }), update: () => {} };
MultiSpan.macdSignal["5m"] = { setData: (d) => macdSetDataCalls.push({ kind: "sig", len: d.length }), update: () => {} };
MultiSpan.macdZero["5m"] = { setData: (d) => macdSetDataCalls.push({ kind: "zero", len: d.length }), update: () => {} };
MultiSpan.charts["5m"] = {
  timeScale: () => ({
    getVisibleRange: () => ({ from: 10000, to: 13000 }),
    getVisibleLogicalRange: () => logical5mState,
    setVisibleLogicalRange: (r) => { logical5mState = r; },
    width: () => 500,
  }),
  setCrosshairPosition: () => {},
  clearCrosshairPosition: () => {},
};
MultiSpan.setSpanData("5m", macdCandles);
logical5mState = { from: 10, to: 50 };
const lastBarTime = macdCandles[macdCandles.length - 1].time;
const lastMacdEntry = MultiSpan.macdData["5m"].byTime.get(lastBarTime);
assert.ok(lastMacdEntry && lastMacdEntry.signal !== null && lastMacdEntry.hist !== null, "Latest candle must have non-null MACD signal and histogram");
assert.equal(lastMacdEntry.signal, MultiSpan.macdData["5m"].signal.slice(-1)[0].value, "Signal in byTime must match same timestamp");
assert.equal(lastMacdEntry.hist, MultiSpan.macdData["5m"].histogram.slice(-1)[0].value, "Histogram in byTime must match same timestamp");

// 17. Test loadMoreHistorical also updates MACD data & series AND preserves pre-setData logical range
macdSetDataCalls.length = 0;
const olderMacdCandles = new Array(20).fill(0).map((_, i) => ({
  time: 10000 - (20 - i) * 60,
  open: 90 + i * 0.2,
  high: 91 + i * 0.2,
  low: 89 + i * 0.2,
  close: 90 + i * 0.2,
}));
MultiSpan.fetchKlinesForSpan = async () => olderMacdCandles;
await MultiSpan.loadMoreHistorical("5m");
assert.equal(MultiSpan.candlesData["5m"].length, 70, "loadMoreHistorical should prepend 20 bars to 50 -> 70");
assert.equal(logical5mState.from, 30, "loadMoreHistorical must capture pre-setData logical range (10 + 20 = 30)");
assert.equal(logical5mState.to, 70, "loadMoreHistorical must shift pre-setData logical range to (50 + 20 = 70)");
assert.equal(MultiSpan.macdData["5m"].macd.length, 70 - 26 + 1, "loadMoreHistorical must recalculate MACD length for merged candles");
assert.ok(macdSetDataCalls.some((c) => c.kind === "hist" && c.len === 70 - 34 + 1), "loadMoreHistorical must update macdHist series");
assert.ok(macdSetDataCalls.some((c) => c.kind === "zero" && c.len === 70), "loadMoreHistorical must update macdZero baseline series");

// 18. Test historical 1d click -> focused 30m slice on 1s (not 5000-bar clamp / 5500-bar zoom)
const pastDayStart = nowSec - 5 * 86400;
const fetchRangeRequests = [];
const histBadge1s = { style: {}, textContent: "" };
const hlEl1sDrill = { style: { display: "none" } };
const badgeEl1sDrill = { style: {}, textContent: "" };
let logicalRange1sDrill = { from: 900, to: 1000 };
MultiSpan.candlesData["1d"] = [
  { time: pastDayStart - 86400, open: 100, high: 105, low: 95, close: 102 },
  { time: pastDayStart, open: 102, high: 110, low: 100, close: 108 },
  { time: pastDayStart + 86400, open: 108, high: 112, low: 104, close: 109 },
];
MultiSpan.candlesData["1s"] = new Array(1000).fill(0).map((_, i) => ({ time: nowSec - 1000 + i, open: 100, high: 101, low: 99, close: 100 }));
MultiSpan.isHistorical = {};
MultiSpan.reloadingSpans = {};
MultiSpan.series["1s"] = { setData: () => {}, update: () => {} };
MultiSpan.ma20["1s"] = { setData: () => {} };
MultiSpan.ma50["1s"] = { setData: () => {} };
MultiSpan.charts["1s"] = {
  timeScale: () => ({
    getVisibleRange: () => ({ from: nowSec - 100, to: nowSec }),
    getVisibleLogicalRange: () => logicalRange1sDrill,
    setVisibleLogicalRange: (r) => { logicalRange1sDrill = r; },
    logicalToCoordinate: (idx) => {
      const span = logicalRange1sDrill.to - logicalRange1sDrill.from;
      return span > 0 ? ((idx - logicalRange1sDrill.from) / span) * 500 : 0;
    },
    width: () => 500,
  }),
  setCrosshairPosition: () => {},
  clearCrosshairPosition: () => {},
};
MultiSpan.fetchKlinesRange = async (sym, span, sTime, eTime, batches) => {
  fetchRangeRequests.push({ span, sTime, eTime, batches, widthSec: eTime - sTime });
  const len = span === "1s" ? 1800 : 300;
  const step = span === "1s" ? 1 : (span === "5m" ? 300 : span === "15m" ? 900 : 3600);
  return new Array(len).fill(0).map((_, i) => ({
    time: sTime + i * step,
    open: 100,
    high: 102,
    low: 99,
    close: 101,
  }));
};
sandbox.document.getElementById = (id) => {
  if (id === "msRangeHighlight_1s") return hlEl1sDrill;
  if (id === "msRangeBadge_1s") return badgeEl1sDrill;
  if (id === "msCardModeBadge_1s") return histBadge1s;
  return null;
};
MultiSpan.handleChartClick("1d", { time: pastDayStart });
await flushAnimations(80);
const req1sDrill = fetchRangeRequests.find((r) => r.span === "1s");
assert.ok(req1sDrill, "Clicking past 1d bar must request 1s slice");
assert.equal(req1sDrill.batches, 2, "1d -> 1s slice should batch at most 2 requests instead of 6");
assert.equal(req1sDrill.widthSec, 1800, "1d -> 1s slice should fetch focused 1800s (30m) window around day start");
const visBars1sDrill = logicalRange1sDrill.to - logicalRange1sDrill.from;
assert.ok(visBars1sDrill >= 200 && visBars1sDrill <= 300, `1d -> 1s must zoom to readable slice (~240 bars, got ${visBars1sDrill})`);
assert.equal(histBadge1s.textContent, "⏮️ HISTORICAL · 30M SLICE", "Partial slice badge must clearly label 30M SLICE");
assert.equal(badgeEl1sDrill.textContent, "1-DAY RANGE (30M SLICE)", "Range highlight badge must indicate 30M SLICE");

// 19. Test clicking today's live 1d candle (>4000s elapsed) keeps 1s live on live tail without rewinding or freezing
fetchRangeRequests.length = 0;
MultiSpan.isHistorical["1s"] = false;
MultiSpan.candlesData["1s"] = new Array(1000).fill(0).map((_, i) => ({ time: nowSec - 1000 + i, open: 100, high: 101, low: 99, close: 100 }));
const todayLiveDayStart = nowSec - 12000;
MultiSpan.candlesData["1d"].push({ time: todayLiveDayStart, open: 109, high: 112, low: 107, close: 111 });
MultiSpan.handleChartClick("1d", { time: todayLiveDayStart });
await flushAnimations(80);
assert.equal(fetchRangeRequests.filter((r) => r.span === "1s").length, 0, "Clicking today's live 1d candle when 1s is live must NOT rewind/reload 1s backward");
assert.equal(MultiSpan.isHistorical["1s"], false, "1s must stay non-historical (live WebSocket enabled) when clicking today's 1d candle");

// 20. Test mouse-leave crosshair restoration on macdChart uses pinnedCandle.time (not raw pinnedTime)
let restoredMacdCrosshair = null;
MultiSpan.candlesData["5m"] = [{ time: 5000, close: 100 }, { time: 5300, close: 102 }];
MultiSpan.macdData["5m"] = {
  macd: [{ time: 5000, value: 1.0 }],
  signal: [{ time: 5000, value: 0.8 }],
  histogram: [{ time: 5000, value: 0.2 }],
  byTime: new Map([[5000, { macd: 1.0, signal: 0.8, hist: 0.2, histogram: 0.2 }]]),
};
MultiSpan.macdCharts["5m"] = {
  setCrosshairPosition: (v, t) => { restoredMacdCrosshair = { v, t }; },
  clearCrosshairPosition: () => { restoredMacdCrosshair = { cleared: true }; },
};
MultiSpan.pinnedTime = 5150; // between 5000 and 5300 5m candles
MultiSpan.handleCrosshairMove("5m", null, "main");
assert.equal(restoredMacdCrosshair?.t, 5000, "Mouse-leave must restore macdChart crosshair at matched candle time (5000), not raw 5150");

// 21. Test setSymbol resets pinned state, activeRangeHighlight, and historical flags cleanly
MultiSpan.pinnedTime = 5150;
MultiSpan.pinnedSpan = "5m";
MultiSpan.isHistorical["1s"] = true;
MultiSpan.activeRangeHighlight = { navId: 9, sourceSpan: "1d", finerSpans: ["1s"], readySpans: { "1s": true } };
let initFetchedFor = null;
MultiSpan.fetchInitialData = async () => { initFetchedFor = MultiSpan.symbol; };
MultiSpan.setSymbol("ETHUSDT");
assert.equal(MultiSpan.pinnedTime, null, "setSymbol must clear pinnedTime");
assert.equal(MultiSpan.pinnedSpan, null, "setSymbol must clear pinnedSpan");
assert.equal(MultiSpan.activeRangeHighlight, null, "setSymbol must clear activeRangeHighlight");
assert.equal(Object.keys(MultiSpan.isHistorical).length, 0, "setSymbol must clear isHistorical flags");
assert.equal(initFetchedFor, "ETHUSDT", "setSymbol must reload initial data for new symbol");

// 22. Test fetchKlinesForSpan hedged direct/proxy selection without 6s timeout cascade
const fetchCalls = [];
sandbox.AbortController = AbortController;
sandbox.window.location = { origin: "https://control.jiwonova.com", pathname: "/skhynix/" };
const protoFetchKlines = Object.getPrototypeOf(MultiSpan).fetchKlinesForSpan;
const freshClient = Object.assign(Object.create(Object.getPrototypeOf(MultiSpan)), {
  proxySlowUntil: 0,
  directFailUntil: 0,
});

// Case A: Direct Binance succeeds rapidly -> proxy should NOT even be called (<900ms)
sandbox.fetch = async (url) => {
  fetchCalls.push(url);
  return {
    ok: true,
    json: async () => [[1700000000000, "100", "105", "99", "102", "5"]],
  };
};
const directRes = await protoFetchKlines.call(freshClient, "BTCUSDT", "1s", 10, 1700000010000);
assert.equal(directRes.length, 1);
assert.equal(directRes[0].time, 1700000000);
assert.equal(fetchCalls.length, 1, "Fast direct response must avoid redundant proxy request");
assert.ok(fetchCalls[0].startsWith("https://api.binance.com/api/v3/klines"), "Must try direct Binance first");

// Case B: Direct Binance fails immediately -> falls back to proxy and caches directFailUntil cooldown
fetchCalls.length = 0;
sandbox.fetch = async (url) => {
  fetchCalls.push(url);
  if (url.startsWith("https://api.binance.com")) {
    throw new Error("CORS or network blocked");
  }
  return {
    ok: true,
    json: async () => [[1700000060000, "102", "106", "101", "104", "8"]],
  };
};
const fallbackRes = await protoFetchKlines.call(freshClient, "BTCUSDT", "1s", 10, 1700000070000);
assert.equal(fallbackRes.length, 1);
assert.equal(fallbackRes[0].time, 1700000060);
assert.ok(freshClient.directFailUntil > Date.now(), "Must activate directFailUntil cooldown after proxy wins on direct error");
assert.ok(fetchCalls.some((u) => u.includes("/skhynix/api/klines")), "Must fall back immediately to /skhynix/api/klines");

// Test 23: Empty latest payload does not mask working source, and total failure sets cooldowns for next retry
const emptyMaskCalls = [];
sandbox.fetch = async (url) => {
  emptyMaskCalls.push(url);
  if (url.includes("/skhynix/api/klines")) {
    return { ok: true, json: async () => [] };
  }
  return {
    ok: true,
    json: async () => [[1700000120000, "105", "109", "104", "108", "12"]],
  };
};
const clientEmptyLatest = Object.assign(Object.create(Object.getPrototypeOf(MultiSpan)), {
  directFailUntil: Date.now() + 60000,
  proxySlowUntil: 0,
  fallbackFailUntil: 0,
});
const nonEmptyWinner = await protoFetchKlines.call(clientEmptyLatest, "BTCUSDT", "5m", 10, null);
assert.equal(nonEmptyWinner.length, 1, "Empty latest 200 [] must not beat valid kline payload");
assert.equal(nonEmptyWinner[0].time, 1700000120);
assert.ok(emptyMaskCalls.some((u) => u.includes("/skhynix/api/klines")), "Must try proxy first when directFailUntil is active");
assert.ok(emptyMaskCalls.some((u) => u.startsWith("https://fapi.binance.com")), "Must fail over to direct Binance when proxy returns 200 []");

const allFailCalls = [];
let allFailPhase = 1;
sandbox.fetch = async (url) => {
  allFailCalls.push({ phase: allFailPhase, url });
  if (allFailPhase === 2 && url.includes("/skhynix/api/klines")) {
    return {
      ok: true,
      json: async () => [[1700000180000, "110", "112", "109", "111", "4"]],
    };
  }
  throw new Error("network down");
};
const cooldownClient = Object.assign(Object.create(Object.getPrototypeOf(MultiSpan)), {
  directFailUntil: 0,
  proxySlowUntil: 0,
  fallbackFailUntil: 0,
});
const phase1Res = await protoFetchKlines.call(cooldownClient, "BTCUSDT", "5m", 10, null);
assert.equal(phase1Res.length, 0);
assert.ok(cooldownClient.directFailUntil > Date.now(), "Total failure must still mark directFailUntil cooldown");
assert.ok(cooldownClient.fallbackFailUntil > Date.now(), "Total failure must mark fallbackFailUntil cooldown");
allFailPhase = 2;
const phase2Res = await protoFetchKlines.call(cooldownClient, "BTCUSDT", "5m", 10, null);
assert.equal(phase2Res.length, 1);
assert.equal(
  allFailCalls.filter((c) => c.phase === 2 && c.url.includes("fapi.binance.com") && !c.url.includes("allorigins")).length,
  0,
  "Retry during directFailUntil must go straight to proxy without retrying dead directUrl first",
);

// Test 24: fetchInitialData renders incrementally, retries slow missing span in background into candlesData, and setSymbol clears stale data
const protoObj = Object.getPrototypeOf(MultiSpan);
let scheduledCb = null;
const savedSetTimeout = sandbox.setTimeout;
sandbox.setTimeout = (cb, ms) => {
  if (ms === 1200) {
    scheduledCb = cb;
    return 9999;
  }
  return savedSetTimeout(cb, ms);
};
let oneSecCallCount = 0;
const fakeInitClient = Object.assign(Object.create(protoObj), {
  symbol: "BTCUSDT",
  loaded: false,
  fetchSeq: { "1s": 1, "5m": 1, "15m": 1, "1h": 1, "1d": 1 },
  candlesData: {},
  macdData: {},
  charts: {},
  macdCharts: {},
  animations: {},
  reloadingSpans: {},
  isHistorical: {},
  startRealtimeFeeds() {},
  stopRealtimeFeeds() {},
  cancelSpanAnimation() {},
  updateAllRangeHighlights() {},
  setSpanData(spanId, rawCandles) {
    this.candlesData[spanId] = rawCandles;
    this.macdData[spanId] = { macd: [{ time: rawCandles[0].time, value: 0 }] };
  },
  async fetchKlinesForSpan(sym, span) {
    if (span === "1s") {
      oneSecCallCount += 1;
      if (oneSecCallCount <= 2) return [];
      return [{ time: 1700000000, open: 100, high: 101, low: 99, close: 100, volume: 1 }];
    }
    return [{ time: 1700000000, open: 100, high: 101, low: 99, close: 100, volume: 1 }];
  },
});
await protoObj.fetchInitialData.call(fakeInitClient);
assert.equal(fakeInitClient.loaded, true, "fetchInitialData must mark loaded even if 1s went to background retry");
assert.equal(fakeInitClient.candlesData["5m"].length, 1, "Healthy spans must render incrementally on Attempt 1");
assert.equal(fakeInitClient.candlesData["1s"], undefined, "Missing span must remain empty until background retry runs");
assert.ok(typeof scheduledCb === "function", "Missing span must schedule background retry callback");
await scheduledCb();
assert.equal(fakeInitClient.candlesData["1s"].length, 1, "Background retry must populate candlesData['1s'] without TypeError");
fakeInitClient.fetchInitialData = () => {};
protoObj.setSymbol.call(fakeInitClient, "ETHUSDT");
assert.equal(Object.keys(fakeInitClient.candlesData).length, 0, "setSymbol must clear stale candlesData");
assert.equal(Object.keys(fakeInitClient.macdData).length, 0, "setSymbol must clear stale macdData");
sandbox.setTimeout = savedSetTimeout;

// Test 25: Right-side pagination from historical 1s slice (loadMoreNewer) appends newer bars, updates MACD, and keeps viewport pinned
const nowEpochSec = Math.floor(Date.now() / 1000);
const pastBaseSec = nowEpochSec - 50000;
const pastSlice = new Array(60).fill(0).map((_, i) => ({
  time: pastBaseSec + i,
  open: 60000 + i,
  high: 60005 + i,
  low: 59995 + i,
  close: 60002 + i,
  volume: 10,
}));
const newerBtnEl = { style: { display: "inline-block" }, textContent: "NEWER >" };
const badge1sEl = { style: { display: "inline-block" }, textContent: "⏮️ HISTORICAL · 30M SLICE" };
const prevDocGetById = sandbox.document.getElementById;
const prevDocQuerySelector = sandbox.document.querySelector;
sandbox.document.getElementById = (id) => (id === "msCardModeBadge_1s" ? badge1sEl : prevDocGetById(id));
sandbox.document.querySelector = (sel) => (sel === '.msCardLoadNewerBtn[data-span="1s"]' ? newerBtnEl : prevDocQuerySelector(sel));

let vis1sRightState = { from: 20, to: 55 };
const newerFetchArgs = [];
const histRightClient = Object.assign(new MultiSpan.constructor(), {
  symbol: "BTCUSDT",
  isHistorical: { "1s": true },
  fetchSeq: { "1s": 3 },
  pinnedTime: null,
  series: {
    "1s": {
      setData: (d) => {
        // Simulate LightweightCharts auto-scrolling right on setData unless restored
        vis1sRightState = { from: d.length - 10, to: d.length };
      },
      update: () => {},
    },
  },
  ma20: { "1s": { setData: () => {} } },
  ma50: { "1s": { setData: () => {} } },
  macdCharts: {},
  macdHist: { "1s": { setData: () => {}, update: () => {} } },
  macdLine: { "1s": { setData: () => {}, update: () => {} } },
  macdSignal: { "1s": { setData: () => {}, update: () => {} } },
  macdZero: { "1s": { setData: () => {}, update: () => {} } },
  charts: {
    "1s": {
      timeScale: () => ({
        getVisibleRange: () => ({ from: pastBaseSec + 20, to: pastBaseSec + 55 }),
        getVisibleLogicalRange: () => vis1sRightState,
        setVisibleLogicalRange: (r) => { vis1sRightState = r; },
        width: () => 500,
      }),
      setCrosshairPosition: () => {},
      clearCrosshairPosition: () => {},
    },
  },
  cancelSpanAnimation() {},
  updateRangeHighlight() {},
  applySpanCrosshairState() {},
  async fetchKlinesForSpan(sym, span, limit, endTime) {
    newerFetchArgs.push({ sym, span, limit, endTime });
    const prevLast = pastSlice[pastSlice.length - 1].time;
    // Include 5 overlapping bars <= prevLast and 40 newer bars > prevLast
    return new Array(45).fill(0).map((_, i) => ({
      time: prevLast - 4 + i,
      open: 60100 + i,
      high: 60105 + i,
      low: 60095 + i,
      close: 60102 + i,
      volume: 12,
    }));
  },
});
histRightClient.setSpanData("1s", pastSlice);
vis1sRightState = { from: 20, to: 55 };
await protoObj.loadMoreNewer.call(histRightClient, "1s");
assert.equal(newerFetchArgs.length, 1);
assert.equal(newerFetchArgs[0].endTime, (pastSlice[pastSlice.length - 1].time + 950) * 1000, "Historical right-load must query latestTime + 950 * spanSec");
assert.equal(histRightClient.candlesData["1s"].length, 100, "Must append 40 unique newer candles without duplicates");
assert.equal(histRightClient.candlesData["1s"][99].time, pastSlice[59].time + 40);
assert.ok(Math.abs(vis1sRightState.from - 20) < 0.001 && Math.abs(vis1sRightState.to - 55) < 0.001, "Right-append must keep pre-setData visible logical range unchanged");
assert.ok(histRightClient.macdData["1s"].byTime.get(pastSlice[59].time + 40), "MACD byTime must be computed for newly appended right-side candles");
assert.equal(histRightClient.isHistorical["1s"], true, "Still >5s/5bars behind now -> remain in historical mode");
assert.equal(newerBtnEl.style.display, "inline-block", "NEWER > button must remain visible while historical");
assert.equal(newerBtnEl.textContent, "NEWER >", "Button label must restore after loading");

// Test 26: Right-side load reaching nowSec transitions span cleanly out of historical mode into live updates
const nearNowStart = nowEpochSec - 120;
const nearNowSlice = new Array(60).fill(0).map((_, i) => ({
  time: nearNowStart + i,
  open: 63000 + i,
  high: 63005 + i,
  low: 62995 + i,
  close: 63001 + i,
  volume: 5,
}));
histRightClient.setSpanData("1s", nearNowSlice);
histRightClient.isHistorical["1s"] = true;
histRightClient.syncCardHistoricalUI("1s", { isHistorical: true });
assert.equal(newerBtnEl.style.display, "inline-block");
newerFetchArgs.length = 0;
histRightClient.fetchKlinesForSpan = async (sym, span, limit, endTime) => {
  newerFetchArgs.push({ sym, span, limit, endTime });
  const prevLast = nearNowSlice[nearNowSlice.length - 1].time;
  return new Array(nowEpochSec - prevLast + 1).fill(0).map((_, i) => ({
    time: prevLast + i,
    open: 63100 + i,
    high: 63105 + i,
    low: 63095 + i,
    close: 63101 + i,
    volume: 6,
  }));
};
await protoObj.loadMoreNewer.call(histRightClient, "1s");
assert.equal(newerFetchArgs[0].endTime, null, "Near-live right load must omit endTime to fetch up to latest live bar");
assert.equal(histRightClient.isHistorical["1s"], false, "Reaching live tail must exit historical mode");
assert.equal(badge1sEl.style.display, "none", "Reaching live tail must hide HISTORICAL badge");
assert.equal(newerBtnEl.style.display, "none", "Reaching live tail must hide NEWER > button");
let liveTickApplied = false;
histRightClient.series["1s"].update = () => { liveTickApplied = true; };
histRightClient.updateCandle("1s", { time: nowEpochSec + 1, open: 63200, high: 63205, low: 63195, close: 63202, volume: 3 });
assert.equal(liveTickApplied, true, "After right-loading reaches live tail, WebSocket/live ticks must update the chart");

// Test 27: VisibleLogicalRange listener detects right-edge panning only when historical/stale and enforces cooldown on empty fetch
const rangeCbs = [];
const prevLightweightCharts = sandbox.LightweightCharts;
sandbox.LightweightCharts = {
  CrosshairMode: { Normal: 0 },
  createChart: () => ({
    addCandlestickSeries: () => ({ setData: () => {}, update: () => {}, priceToCoordinate: () => 50 }),
    addLineSeries: () => ({ setData: () => {}, update: () => {} }),
    addHistogramSeries: () => ({ setData: () => {}, update: () => {} }),
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({
      subscribeVisibleTimeRangeChange: () => {},
      subscribeVisibleLogicalRangeChange: (cb) => rangeCbs.push(cb),
      getVisibleRange: () => ({ from: 1000, to: 1100 }),
      getVisibleLogicalRange: () => ({ from: 0, to: 100 }),
      setVisibleLogicalRange: () => {},
      width: () => 500,
    }),
    subscribeCrosshairMove: () => {},
    subscribeClick: () => {},
    applyOptions: () => {},
    resize: () => {},
  }),
};
const scrollClient = Object.assign(new MultiSpan.constructor(), {
  symbol: "BTCUSDT",
  candlesData: { "1s": pastSlice.slice() },
  isHistorical: { "1s": true },
  debounceCalls: [],
  debouncedLoadMore(span, dir) {
    this.debounceCalls.push({ span, dir });
  },
  updateRangeHighlight() {},
});
sandbox.document.getElementById = () => ({ addEventListener: () => {}, clientWidth: 500, clientHeight: 200 });
protoObj.initCharts.call(scrollClient);
assert.ok(rangeCbs.length >= 3, "initCharts must register logical range listeners including main chart");
// For 1s: main-macd-sync (0), macd-main-sync (1), 1s main load-more cb (2)
const oneSecLoadMoreCb = rangeCbs[2];
scrollClient.debounceCalls.length = 0;
// Panning near right edge while historical -> triggers newer
oneSecLoadMoreCb({ from: 25, to: 50 });
assert.deepEqual(scrollClient.debounceCalls, [{ span: "1s", dir: "newer" }], "Right-edge pan while historical must queue 'newer' load");
// Zoomed out past both edges with greater right overshoot -> prioritizes newer
scrollClient.debounceCalls.length = 0;
oneSecLoadMoreCb({ from: 15, to: 85 }); // leftOvershoot=10, rightOvershoot=85-(60-25)=50
assert.deepEqual(scrollClient.debounceCalls, [{ span: "1s", dir: "newer" }], "Greater right overshoot must choose 'newer'");
// Live mode right-edge pan -> must NOT queue newer load when tail is fresh
scrollClient.isHistorical["1s"] = false;
scrollClient.candlesData["1s"] = [{ time: Math.floor(Date.now() / 1000) - 2, close: 100 }];
scrollClient.debounceCalls.length = 0;
oneSecLoadMoreCb({ from: 0, to: 10 });
assert.equal(scrollClient.debounceCalls.some((c) => c.dir === "newer"), false, "Live tail near right edge must not trigger newer load");

// Empty response on historical newer load sets cooldown
histRightClient.isHistorical["1s"] = true;
histRightClient.candlesData["1s"] = pastSlice.slice();
histRightClient.fetchKlinesForSpan = async () => [];
await protoObj.loadMoreNewer.call(histRightClient, "1s");
assert.ok(histRightClient.noNewerBefore["1s"] > Date.now(), "Empty newer fetch must activate noNewerBefore cooldown");

// Restore sandbox hooks cleanly
if (prevLightweightCharts === undefined) delete sandbox.LightweightCharts;
else sandbox.LightweightCharts = prevLightweightCharts;
sandbox.document.getElementById = prevDocGetById;
sandbox.document.querySelector = prevDocQuerySelector;

console.log("All Multi-Span synchronization unit tests passed!");
