const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const elements = new Map();
for (const id of ['valAccountEquity', 'badgeEquitySource', 'valAvailMargin',
  'activePositionsSummary', 'activePositionsBody', 'lblUnrealizedPnl']) {
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

console.log('Crypto live balance display checks passed');
