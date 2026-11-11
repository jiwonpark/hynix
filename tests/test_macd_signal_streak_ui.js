const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TerminalCommon = require('../terminal-common.js');

const nodes = new Map([
  ['crypto_macdUseSignalStreak', {checked:true}],
  ['crypto_macdStreakLookback', {value:'30'}],
  ['crypto_macdStreakMinSamples', {value:'7'}],
  ['crypto_macdStreakMinPercentile', {value:'80'}],
  ['crypto_macdStreakMinReversalProb', {value:'25'}],
  ['crypto_macdStreakRequireTurn', {checked:false}],
]);
global.document = {getElementById: id => nodes.get(id) || null};

assert.deepEqual(TerminalCommon.macdSignalStreakSettings('crypto_'), {
  use_macd_signal_streak:true,
  macd_streak_lookback:30,
  macd_streak_min_samples:7,
  macd_streak_min_percentile:80,
  macd_streak_min_reversal_prob_pct:25,
  macd_streak_require_turn:false,
});

for (const file of ['crypto-tab.js', 'lighter-crypto-tab.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const prefix = file === 'crypto-tab.js' ? 'crypto_' : 'lighterCrypto_';
  assert.ok(source.includes(`macdSignalStreakControls?.("${prefix}"`), `${file} renders the shared real condition`);
  assert.ok(source.includes(`macdSignalStreakSettings?.("${prefix}"`), `${file} sends every threshold to replay/live payloads`);
  assert.ok(source.includes(`renderMacdSignalStreakStatus?.("${prefix}"`), `${file} exposes completed-candle source/status`);
  assert.ok(source.includes('entry_signal_streak_exhaustion'), `${file} exposes the live engine condition`);
}

const sharedSource = fs.readFileSync(path.join(__dirname, '..', 'terminal-common.js'), 'utf8');
assert.ok(sharedSource.includes('macdSignalStreakControls(prefix, saved, streakRow, streakToggle, {showPeriods:true})'), 'MA Proximity visibly renders the shared streak condition');
assert.ok(sharedSource.includes('options.showPeriods'), 'MA Proximity exposes the applicable MACD periods');
assert.ok(sharedSource.includes('MACD regime entry'), 'UI gives the condition a concise name');
assert.ok(sharedSource.includes('red = short · green = long'), 'UI explains regime-aligned entry direction plainly');

const comparison = TerminalCommon.macdSignalRegimeComparison([
  {time:1,value:-1},{time:2,value:-2},
  {time:3,value:1},{time:4,value:2},
  {time:5,value:-1},{time:6,value:-2},{time:7,value:-3},
]);
assert.deepEqual(comparison.current, {sign:-1,length:3,startTime:5,endTime:7});
assert.deepEqual(comparison.previous, {sign:-1,length:2,startTime:1,endTime:2});
assert.equal(comparison.percentage, 150);
for (const file of ['crypto-tab.js', 'lighter-crypto-tab.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  assert.ok(source.includes('macdSignalRegimeSummary'), `${file} shows the current/previous regime comparison`);
  assert.ok(source.includes('renderMacdSignalRegimes'), `${file} renders shared MACD regime bands`);
}

function element() {
  return {
    style: {}, dataset: {}, children: [], clientWidth: 100,
    setAttribute() {},
    replaceChildren() { this.children = []; },
    appendChild(child) {
      this.children.push(child);
      if (child.id) nodes.set(child.id, child);
    },
  };
}
global.document.createElement = element;
const host = element();
const chart = { timeScale: () => ({ timeToCoordinate: time => time * 10 }) };
const history = [-1, 2, 0, 1, undefined, -2, 1, -3].map((value, index) => ({
  time: index + 1, value,
}));
TerminalCommon.renderMacdSignalRegimes('crypto_', host, chart, history);
const bands = host.children[0].children;
assert.deepEqual(bands.map(band => band.dataset.regimeSign),
  ['negative', 'positive', 'positive', 'negative', 'positive', 'negative']);
assert.deepEqual(bands.map(band => band.dataset.regimeRole),
  ['history', 'history', 'history', 'previous', 'history', 'current']);
assert.deepEqual(bands.map(band => Number(band.style.cssText.match(/left:(\d+)px/)[1])),
  [5, 15, 35, 55, 65, 75], 'zero and missing values have no band');
for (const band of bands) {
  const rgb = band.dataset.regimeSign === 'positive' ? '22,163,74' : '220,38,38';
  assert.ok(band.style.cssText.includes(`background:rgba(${rgb},`));
}

console.log('MACD signal streak UI tests passed');
