const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const elements = new Map();
for (const id of ['valAccountEquity', 'badgeEquitySource', 'valAvailMargin',
  'activePositionsSummary', 'activePositionsBody', 'lblUnrealizedPnl',
  'executionHistoryBody', 'executionHistorySummary', 'countOrderLog']) {
  elements.set(`crypto_${id}`, { textContent: '', innerHTML: '', style: {} });
}
const context = {
  window: {},
  document: { getElementById: (id) => elements.get(id), readyState: 'loading', addEventListener() {} },
  URLSearchParams, console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../crypto-tab.js'), 'utf8'), context);
const engine = context.window.cryptoEngine;
const renderExecutionHistory = engine.renderExecutionHistory;
engine.updateLeverageMetrics = () => {};
engine.renderExecutionHistory = () => {};
engine.entries = [];
engine.liveVenue = { authenticated: true, collateral: 933.05, available_margin: 483.5 };
engine.livePositions = [];
engine.botState = { enabled: false, tranches: [], execution_history: [] };
engine.mode = 'paper';
engine.renderVirtualState();
assert.equal(elements.get('crypto_valAccountEquity').textContent, '$933.05');
assert.equal(elements.get('crypto_badgeEquitySource').textContent, 'REAL FUTURES');
assert.match(elements.get('crypto_activePositionsSummary').innerHTML, /Paper bankroll.*10,000/);

engine.mode = 'live';
engine.livePositions = [{symbol: 'BTCUSDT', position_amt: 0.002, size: 0.002,
  notional: 165.33, entry_price: 82660, mark_price: 82665,
  unrealized_pnl: 0.01, initial_margin: 165.33}];
engine.renderVirtualState();
assert.equal(elements.get('crypto_valAccountEquity').textContent, '$933.05');
assert.equal(elements.get('crypto_badgeEquitySource').textContent, 'REAL FUTURES');
assert.match(elements.get('crypto_activePositionsSummary').innerHTML, /Available margin.*483\.50/);
assert.doesNotMatch(elements.get('crypto_activePositionsSummary').innerHTML, /Lighter|pair size/);

engine.liveVenue = {authenticated: false, collateral: null, available_margin: null};
engine.livePositions = [];
engine.mode = 'paper';
engine.renderVirtualState();
assert.equal(elements.get('crypto_valAccountEquity').textContent, '—');
assert.equal(elements.get('crypto_badgeEquitySource').textContent, 'UNAVAILABLE');

engine.botState = { execution_history: [
  {event: 'ENTRY', symbol: 'BTCUSDT', order_id: '10', qty: 2, price: 100, side: 1, time: 1},
  {event: 'EXIT', symbol: 'BTCUSDT', order_id: '11', qty: 2, price: 101,
   entry_price: 100, original_side: 1, time: 2, pnl_authoritative: true,
   pnl_source: 'BINANCE_USER_TRADES', gross_pnl_usd: 2, net_pnl_usd: 1.8,
   pnl_pct: 0.9, round_trip_fee_usd: 0.2},
] };
engine.renderExecutionHistory = renderExecutionHistory;
engine.renderExecutionHistory();
assert.match(elements.get('crypto_executionHistorySummary').innerHTML, /\+\$1\.8000/);
assert.match(elements.get('crypto_executionHistoryBody').innerHTML, /\+\$1\.8000 net/);
assert.match(elements.get('crypto_executionHistoryBody').innerHTML, /\$0\.2000 total/);
assert.match(elements.get('crypto_executionHistorySummary').innerHTML, /funding excluded/);

console.log('Crypto live balance display checks passed');
