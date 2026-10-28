const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const TerminalCommon = require('../terminal-common.js');

const lighterShort = TerminalCommon.singleLegPositionReference([
  {symbol: 'BTC', market_id: 1, position_amt: -0.00186, size: 0.00186, entry_price: 80398.6},
], {symbol: 'BTC', marketId: 1});
assert.equal(lighterShort.direction, 'short');
assert.equal(lighterShort.isLong, false);
assert.equal(lighterShort.entry, 80398.6);

const signedSizeShort = TerminalCommon.singleLegPositionReference([
  {symbol: 'BTC', market_id: 1, sign: -1, size: 0.002, avg_entry_price: 80100},
], {symbol: 'BTC', marketId: 1});
assert.equal(signedSizeShort.direction, 'short', 'venue sign must qualify an unsigned size');

const binanceLong = TerminalCommon.singleLegPositionReference([
  {symbol: 'BTCUSDT', position_amt: 0.003, entry_price: 80500},
], {symbol: 'BTCUSDT'});
assert.equal(binanceLong.direction, 'long');
assert.equal(TerminalCommon.singleLegPositionReference([], {symbol: 'BTC'}), null);

function currentReferenceMethod(file) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('    renderCurrentPositionReferenceLines()');
  const end = source.indexOf('    syncHoveredMarkerDetails(', start);
  assert.ok(start >= 0 && end > start, `${file} current-position reference method exists`);
  return vm.runInNewContext(`({${source.slice(start, end)}})`, {window: {TerminalCommon}});
}

for (const [file, symbol] of [['crypto-tab.js', 'BTCUSDT'], ['lighter-crypto-tab.js', 'BTC']]) {
  const engine = currentReferenceMethod(file);
  let rendered = null;
  engine.executionChartController = {visibility: {actual: true, virtual: true}};
  engine.selectedSymbol = symbol;
  engine.currentMarketId = 1;
  engine.livePositions = [{symbol, market_id: 1, position_amt: -0.00186, entry_price: 80398.6}];
  engine.entries = [{ratio: 81000, side: 1}];
  engine.rawExecutionMarkers = [{entry_price: 81200, direction: 'long'}];
  engine.renderShortTermReferenceLines = (entry, options) => { rendered = {entry, options}; };
  engine.isTradeMarkerVisible = () => true;
  engine.clearReferenceLines = () => {};
  engine.renderCurrentPositionReferenceLines();
  assert.equal(rendered.entry, 80398.6, `${file} must prefer the open exchange cost basis`);
  assert.equal(rendered.options.isLong, false, `${file} must render an open short as SHORT`);
}

console.log('Live single-leg position reference direction checks passed');
