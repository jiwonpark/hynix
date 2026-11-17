const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const code = fs.readFileSync(path.join(__dirname, "../multi-span-tab.js"), "utf8");

// Create test sandbox
const sandbox = {
  document: {
    getElementById: () => null,
    querySelectorAll: () => [],
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
MultiSpan.syncMode = "anchor";
MultiSpan.isSyncing = false;

// Trigger range change on 1s
MultiSpan.handleRangeChange("1s", { from: 1000, to: 1200 });
// Center is 1100. Target duration was 100 (150-50). So target should center around 1100 => [1050, 1150]
assert.ok(targetSetRangeCalled, "Target chart setVisibleRange should be called");
assert.equal((targetSetRangeCalled.from + targetSetRangeCalled.to) / 2, 1100, "Target center should match source center 1100");

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
MultiSpan.charts["1s"].timeScale = () => ({
  getVisibleRange: () => ({ from: 100, to: 200 }),
  setVisibleRange: (r) => { narrowerChart1sSetRange = r; },
});
MultiSpan.handleChartClick("5m", { time: 300 });
assert.equal(crosshairCalls.length, 1, "Click on coarser chart must broadcast crosshair");
assert.equal(crosshairCalls[0].span, "1s");
assert.equal(crosshairCalls[0].t, 300);
assert.ok(narrowerChart1sSetRange, "Click on coarser chart must re-center narrower chart");
assert.equal((narrowerChart1sSetRange.from + narrowerChart1sSetRange.to) / 2, 300, "Narrower chart must be centered on clicked timestamp 300");

console.log("All Multi-Span synchronization unit tests passed!");
