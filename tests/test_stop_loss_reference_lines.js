const assert = require('node:assert/strict');

global.document = {getElementById: () => null};
global.localStorage = {getItem: () => null, setItem() {}};
const common = require('../terminal-common.js');

const longExact = common.singleLegNetTargetPrice({
  entry: 100,
  isLong: true,
  targetPct: -2,
  exitFeeRate: 0.001,
  evaluation: {quantity: 10, entry_notional_usd: 1000, entry_fee_usd: 1, exit_fee_rate: 0.001, side: 1},
});
assert.ok(Math.abs(longExact - ((1000 * 0.98 + 1) / (10 * 0.999))) < 1e-10,
  'long stop must solve the same fee-aware net-PnL equation as the engine');

const shortExact = common.singleLegNetTargetPrice({
  entry: 100,
  isLong: false,
  targetPct: -2,
  exitFeeRate: 0.001,
  evaluation: {quantity: 10, entry_notional_usd: 1000, entry_fee_usd: 1, exit_fee_rate: 0.001, side: -1},
});
assert.ok(Math.abs(shortExact - ((1000 * 1.02 - 1) / (10 * 1.001))) < 1e-10,
  'short stop must solve the same fee-aware net-PnL equation as the engine');

assert.equal(common.singleLegStopLossLevel('crypto_', {use_stop_loss: false}, null, 100, true, 0.001), null,
  'disabled stop loss must not create a decorative chart line');

const paper = common.singleLegStopLossLevel('crypto_', {
  use_stop_loss: true, stop_loss_pct: 0.35,
}, null, 100, true, 0.001, 'paper');
assert.equal(paper.axisTitle, 'STOP -0.35%');
assert.ok(paper.price < 100 && paper.stopLoss);

const liveTrail = common.singleLegStopLossLevel('lighterCrypto_', {
  use_stop_loss: true,
  stop_loss_pct: 0.2,
  stop_loss_mode: 'trailing',
  stop_loss_evaluation: {
    target_pct: 0.6, trail_active: true, quantity: 10,
    entry_notional_usd: 1000, entry_fee_usd: 0,
    exit_fee_rate: 0, side: 1,
  },
}, null, 100, true, 0, 'live');
assert.equal(liveTrail.axisTitle, 'TRAIL +0.6%');
assert.equal(liveTrail.price, 100.6);

for (const file of ['../crypto-tab.js', '../lighter-crypto-tab.js']) {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, file), 'utf8');
  assert.match(source, /singleLegStopLossLevel/, `${file} must pass the real stop level to the shared chart ladder`);
  assert.match(source, /stopSource:\s*"live"/, `${file} live positions must use saved live stop configuration`);
}

const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {parseHTML} = require('linkedom');
for (const [file, engineName, prefix] of [
  ['crypto-tab.js', 'cryptoEngine', 'crypto_'],
  ['lighter-crypto-tab.js', 'lighterCryptoEngine', 'lighterCrypto_'],
]) {
  const {window, document} = parseHTML('<html><body></body></html>');
  Object.defineProperty(document, 'readyState', {value: 'loading'});
  document.addEventListener = () => {};
  const storage = {getItem: () => null, setItem() {}};
  const context = {window, document, console, URLSearchParams, setTimeout, clearTimeout, localStorage: storage};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../terminal-common.js'), 'utf8'), context);
  context.TerminalCommon = window.TerminalCommon;
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const engine = window[engineName];
  let rendered = null;
  engine.executionChartController = {renderReferenceLines: config => {rendered = config; return [];}};
  engine.botState = {use_stop_loss: true, stop_loss_pct: 0.4, execution_history: [], strategy_params: {}};
  engine.latestReplayConditionResult = null;
  engine.renderShortTermReferenceLines(100, {isLong: true});
  const line = rendered.levels.find(level => level.stopLoss);
  assert.ok(line, `${file} must render an enabled stop alongside its P&L ladder`);
  assert.equal(line.axisTitle, 'STOP -0.4%');
}

console.log('Stop-loss P&L reference line checks passed');
