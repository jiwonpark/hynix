const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function ladder(file, botState) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const start = source.indexOf('    shortSpreadProfitLadder(entrySpread');
  const end = source.indexOf('    clearReferenceLines()', start);
  assert.ok(start >= 0 && end > start, `${file} ladder exists`);
  const engine = vm.runInNewContext(`({${source.slice(start, end)}})`, {Number, Array, Map});
  engine.botState = botState;
  return engine;
}

const tab3 = ladder('lighter-tab.js', {});
assert.equal(tab3.shortSpreadProfitLadder(100, 1)[0].price, 99.8);
assert.match(tab3.shortSpreadProfitLadder(100, 1)[0].title, /PRICE MOVE/);
assert.equal(tab3.shortSpreadProfitLadder(100, 1, false).at(-1).price, 99);
assert.ok(tab3.shortSpreadProfitLadder(100, 1, true).every(level => level.price > 100));
assert.ok(tab3.shortSpreadProfitLadder(100, 1, false).every(level => level.price < 100));

const binance = ladder('crypto-tab.js', {execution_history: [{event: 'EXIT',
  pnl_authoritative: true, round_trip_fee_usd: 0.1, qty: 1, entry_price: 100}]});
for (const isLong of [true, false]) {
  const levels = binance.shortSpreadProfitLadder(100, 1, isLong);
  const price = levels[0].price;
  const net = (isLong ? price - 100 : 100 - price) - 0.05 - price * 0.0005;
  assert.ok(Math.abs(net) < 1e-9, 'Binance B/E solves fee-only single-leg P&L');
  assert.match(levels[0].title, /10\.00bps observed avg/);
  assert.ok(levels.slice(1).every(level => isLong ? level.price > 100 : level.price < 100),
    'Binance net-profit levels must follow the selected trade direction');
}

const lighter = ladder('lighter-crypto-tab.js', {execution_history: [
  {event: 'ENTRY', order_id: 'a', fee_usd: 0, qty: 1, price: 100},
  {event: 'EXIT', entry_order_id: 'a', fee_usd: 0, qty: 1, entry_price: 100},
]});
assert.equal(lighter.shortSpreadProfitLadder(100, 1, true)[0].price, 100);
assert.match(lighter.shortSpreadProfitLadder(100, 1, true)[0].title, /0\.00bps recorded avg/);
assert.ok(lighter.shortSpreadProfitLadder(100, 1, true).slice(1).every(level => level.price > 100));
assert.ok(lighter.shortSpreadProfitLadder(100, 1, false).slice(1).every(level => level.price < 100));

console.log('Fee-only chart line checks passed');
