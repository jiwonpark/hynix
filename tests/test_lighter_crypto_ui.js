const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const common = fs.readFileSync(path.join(root, 'terminal-common.js'), 'utf8');
const lighter = fs.readFileSync(path.join(root, 'lighter-crypto-tab.js'), 'utf8');

assert.match(html, /id="navTabLighterCrypto"/);
assert.match(html, /id="tabContentLighterCrypto"/);
assert.match(html, /lighter-crypto-tab\.js/);
assert.match(common, /venue: "lighterCrypto", prefix: "lighterCrypto_"/);
assert.match(lighter, /\/api\/lighter-crypto\/status/);
assert.match(lighter, /\/api\/lighter-crypto\/bot\/toggle/);
assert.match(lighter, /market_source=lighter/);
assert.doesNotMatch(lighter, /\/api\/crypto\//);

const context = {
  window: {},
  document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
  URLSearchParams, console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'crypto-tab.js'), 'utf8'), context);
vm.runInContext(lighter, context);
assert.notEqual(context.window.cryptoEngine, context.window.lighterCryptoEngine);
assert.equal(context.window.cryptoEngine.selectedSymbol, 'BTCUSDT');
assert.equal(context.window.lighterCryptoEngine.selectedSymbol, 'BTC');
assert.equal(context.window.lighterCryptoEngine.replaySettings().symbol, 'BTC');

const nodes = new Map([
  ['lighterCrypto_inputOrderNotional', { value: '150' }],
  ['lighterCrypto_LiveRiskBudget', { textContent: '' }],
  ['lighterCrypto_valCondEntryMargin', { textContent: '' }],
  ['lighterCrypto_valCondEntryLeverage', { textContent: '' }],
]);
context.document.getElementById = (id) => nodes.get(id) || null;
const tab5 = context.window.lighterCryptoEngine;
tab5.mode = 'live';
tab5.liveVenue = { collateral: 170, available_margin: 170, account_gross_notional: 0 };
tab5.livePositions = [];
tab5.botState = { enabled: true, tranches: [], risk_capacity: {
  gross_leverage_cap: 1, margin_leverage_assumption: 10,
  margin_buffer_multiplier: 1.25, min_margin_buffer_usd: 2.5,
  stress_move_pct: 10, stress_loss_budget_pct_equity: 10,
} };
tab5.updateLeverageMetrics();
assert.match(nodes.get('lighterCrypto_valCondEntryMargin').textContent, /\$170\.00 ≥ \$18\.75/);
assert.match(nodes.get('lighterCrypto_LiveRiskBudget').textContent, /−\$15\.00 \(8\.8% of equity, limit 10%\)/);
assert.match(nodes.get('lighterCrypto_valCondEntryLeverage').textContent, /0\.88x projected ≤ 1\.0x/);
console.log('Independent Binance Tab 4 and Lighter Tab 5 UI checks passed');
