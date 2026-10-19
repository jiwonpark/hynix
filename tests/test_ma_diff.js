const assert = require('node:assert/strict');
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

console.log('All MA difference unit tests passed successfully');
