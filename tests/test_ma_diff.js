const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const TerminalCommon = require('../terminal-common.js');

// Test 1: TerminalCommon.movingAverageDiff
assert.equal(typeof TerminalCommon.movingAverageDiff, 'function');

const maFast = [
  { time: 100, value: 50100 },
  { time: 200, value: 50050 },
  { time: 300, value: 49900 },
  { time: 400, value: 50000 },
];
const maSlow = [
  { time: 100, value: 50000 },
  { time: 200, value: 50050 },
  { time: 300, value: 50000 },
  { time: 400, value: 49800 },
];

const diffs = TerminalCommon.movingAverageDiff(maFast, maSlow);
assert.equal(diffs.length, 4);

// Bar 1: Fast > Slow -> positive diff
assert.equal(diffs[0].time, 100);
assert.equal(diffs[0].value, 100);
assert.equal(diffs[0].color, 'rgba(22, 163, 74, 0.75)');

// Bar 2: Fast == Slow -> 0 diff (green)
assert.equal(diffs[1].time, 200);
assert.equal(diffs[1].value, 0);
assert.equal(diffs[1].color, 'rgba(22, 163, 74, 0.75)');

// Bar 3: Fast < Slow -> negative diff (red)
assert.equal(diffs[2].time, 300);
assert.equal(diffs[2].value, -100);
assert.equal(diffs[2].color, 'rgba(220, 38, 38, 0.75)');

// Bar 4: Fast > Slow -> positive diff (green)
assert.equal(diffs[3].time, 400);
assert.equal(diffs[3].value, 200);
assert.equal(diffs[3].color, 'rgba(22, 163, 74, 0.75)');

// Test 2: Moving average calculation
const sampleBars = [
  { time: 10, value: 10 },
  { time: 20, value: 20 },
  { time: 30, value: 30 },
  { time: 40, value: 40 },
  { time: 50, value: 50 },
];
const ma3 = TerminalCommon.movingAverage(sampleBars, 3);
assert.equal(ma3.length, 3);
assert.equal(ma3[0].time, 30);
assert.equal(ma3[0].value, 20); // (10+20+30)/3
assert.equal(ma3[2].time, 50);
assert.equal(ma3[2].value, 40); // (30+40+50)/3

// Test 3: Standard MACD uses EMA(12) - EMA(26), EMA(9) signal, and their histogram.
const trendBars = Array.from({length: 60}, (_, index) => ({time: index + 1, value: 100 + index}));
const macd = TerminalCommon.macd(trendBars);
assert.equal(macd.macd[0].time, 26);
assert.equal(macd.signal[0].time, 34);
assert.equal(macd.histogram[0].time, 34);
assert.equal(macd.macd.length, 35);
assert.equal(macd.signal.length, 27);
assert.equal(macd.histogram.length, 27);
assert.ok(macd.histogram.every((point) => Number.isFinite(point.value)));

const flatMacd = TerminalCommon.macd(Array.from({length: 40}, (_, index) => ({time: index + 1, value: 100})));
assert.ok(flatMacd.macd.every((point) => Math.abs(point.value) < 1e-12));
assert.ok(flatMacd.signal.every((point) => Math.abs(point.value) < 1e-12));
assert.ok(flatMacd.histogram.every((point) => Math.abs(point.value) < 1e-12));

for (const file of ['crypto-tab.js', 'lighter-crypto-tab.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.match(source, /TerminalCommon\.macd\(bars, 12, 26, 9\)/,
    `${file} must render standard MACD (12, 26, 9)`);
  assert.match(source, /title: "MACD"/);
  assert.match(source, /title: "Signal"/);
  assert.doesNotMatch(source, /title: "Price \(Ref\)"/,
    `${file} MACD pane must not duplicate the price chart`);
}

const indexSource = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
assert.match(indexSource, /id="shortTermStockHost"/,
  'Tab 2 must render ETF price in a separate pane');
assert.match(indexSource, /linkCrosshairs\(\[/,
  'multi-pane charts must synchronize their focus line');

console.log('All MA difference and MACD unit tests passed successfully');
