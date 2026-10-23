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
assert.ok(lighter.includes('notionalInput.dataset.unsaved = "true"'), 'edited order notional must remain pending until live start saves it');
assert.ok(lighter.includes('notionalInput.dataset?.unsaved !== "true"'), 'status refresh must not overwrite a pending order notional');
assert.ok(lighter.includes('liveTradeRate.dataset.unsaved = "true"'), 'edited trade rate must remain pending until explicitly saved or live start saves it');
assert.ok(lighter.includes('tradeRateInput.dataset?.unsaved !== "true"'), 'status refresh must not overwrite a pending trade rate');
assert.ok(lighter.includes('completed ${stratInterval} candles cap entries'), 'trade-rate display must disclose the completed-candle execution ceiling');
assert.ok(lighter.includes('effective ≤${effectiveTradeRateText}/min on ${stratInterval} candles'), 'top speed summary must show the completed-candle effective rate');

const context = {
  window: {},
  document: {
    readyState: 'loading',
    addEventListener() {},
    getElementById() { return null; },
    createElement() { return { querySelector() { return null; }, style: {} }; },
  },
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
assert.equal(tab5.currentParadigm, 'adaptive_tranche');
assert.equal(tab5.paradigms.adaptive_tranche.name, 'Adaptive Tranche');
assert.match(tab5.paradigms.adaptive_tranche.badge, /TAB 2 MODEL/);
assert.match(tab5.paradigms.adaptive_tranche.entryLabels.rowCondEntryMaStack5m, /MA60/);
assert.equal(tab5.paradigms.grid.name, 'Legacy Dynamic Grid');
assert.equal(tab5.paradigms.macd_reversal.name, 'MACD Reversal');
const macdMarkup = tab5.renderParadigmDetail('macd_reversal');
assert.match(macdMarkup, /Signal line &lt; 0/);
assert.match(macdMarkup, /Histogram &lt; 0/);
assert.match(macdMarkup, /reverses upward from local trough/);
assert.match(macdMarkup, /Signal line &gt; 0/);
assert.match(macdMarkup, /Histogram &gt; 0/);
assert.match(macdMarkup, /reverses downward from local peak/);
[
  ['lighterCrypto_macdFastPeriod', { value: '12' }],
  ['lighterCrypto_macdSlowPeriod', { value: '26' }],
  ['lighterCrypto_macdSignalPeriod', { value: '9' }],
  ['lighterCrypto_macdUseEntrySignalNegative', { checked: true }],
  ['lighterCrypto_macdUseEntryHistogramNegative', { checked: true }],
  ['lighterCrypto_macdUseEntryReversal', { checked: true }],
  ['lighterCrypto_macdUseExitSignalPositive', { checked: true }],
  ['lighterCrypto_macdUseExitHistogramPositive', { checked: true }],
  ['lighterCrypto_macdUseExitReversal', { checked: true }],
].forEach(([id, node]) => nodes.set(id, node));
tab5.currentParadigm = 'macd_reversal';
const macdReplay = tab5.replaySettings();
assert.equal(macdReplay.strategy_mode, 'macd_reversal');
assert.equal(macdReplay.macd_fast_period, 12);
assert.equal(macdReplay.use_macd_hist_reversal_exit, true);
const macdPayload = tab5.liveStrategyPayload('macd_reversal');
assert.equal(macdPayload.macd_slow_period, 26);
assert.equal(macdPayload.use_macd_signal_negative, true);
assert.equal(tab5.paradigms.macd_strength_scaleout.name, 'MACD Strength Scale-Out');
const strengthMarkup = tab5.renderParadigmDetail('macd_strength_scaleout');
assert.match(strengthMarkup, /Rebound ≥/);
assert.match(strengthMarkup, /first peak closes/);
nodes.set('lighterCrypto_macdUseStrength', { checked: true });
nodes.set('lighterCrypto_macdStrengthPct', { value: '30' });
nodes.set('lighterCrypto_macdUseTwoStageExit', { checked: true });
nodes.set('lighterCrypto_macdFirstExitPct', { value: '50' });
tab5.currentParadigm = 'macd_strength_scaleout';
const strengthReplay = tab5.replaySettings();
assert.equal(strengthReplay.strategy_mode, 'macd_strength_scaleout');
assert.equal(strengthReplay.macd_strength_min_pct, 30);
assert.equal(strengthReplay.macd_first_exit_pct, 50);
const strengthPayload = tab5.liveStrategyPayload('macd_strength_scaleout');
assert.equal(strengthPayload.use_macd_strength, true);
assert.equal(strengthPayload.use_macd_two_stage_exit, true);
const maMarkup = tab5.renderParadigmDetail('ma_stack');
assert.match(maMarkup, /2\. 5m Full MA Stack \(Price &lt; MA7 &lt; MA24 &lt; MA60\)/);
assert.match(maMarkup, /Opposite 5m Full MA Stack \(Price &gt; MA7 &gt; MA24 &gt; MA60\)/);
assert.doesNotMatch(maMarkup, /Stretch Discount|Maximum Dwell|Trailing Stop Ratchet|Golden Cross Reversal|1h Macro Trend/);
nodes.set('lighterCrypto_maUseStack5m', { checked: true });
nodes.set('lighterCrypto_maUseOppositeExit', { checked: true });
tab5.currentParadigm = 'ma_stack';
const maReplay = tab5.replaySettings();
assert.equal(maReplay.ma_stack_opposite_only, true);
assert.equal(maReplay.use_ma_stack, true);
assert.equal(maReplay.use_opposite_stack_exit, true);
assert.equal(maReplay.use_ma_stretch, false);
assert.equal(maReplay.use_ma_stack_1h, false);
assert.equal(maReplay.use_convergence, false);
assert.equal(maReplay.use_dwell, false);
assert.equal(maReplay.use_bottoming, false);
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

// Test updateBotStatus runs without error and detects mismatch
nodes.set('lighterCrypto_chkAutoPeriodic48h', { checked: false, disabled: false });
nodes.set('lighterCrypto_autoTradeMasterBanner', { classList: { add() {}, remove() {} }, querySelector() { return null; }, appendChild() {} });
nodes.set('lighterCrypto_autoTradePulseIndicator', { className: '' });
nodes.set('lighterCrypto_lblAutoTradeStateTitle', { textContent: '' });
nodes.set('lighterCrypto_badgeAutoPeriodicStatus', { style: {}, textContent: '', className: '', classList: { remove() {}, add() {} } });
nodes.set('lighterCrypto_lblAutoTradeStatusHeading', { textContent: '' });
nodes.set('lighterCrypto_lblAutoTradeStatusDetail', { textContent: '' });
nodes.set('lighterCrypto_btnReconcileBot', { style: {} });
nodes.set('lighterCrypto_activePositionsBody', { innerHTML: '' });
nodes.set('lighterCrypto_activePositionsSummary', { innerHTML: '' });
nodes.set('lighterCrypto_executionHistoryBody', { innerHTML: '' });
nodes.set('lighterCrypto_executionHistorySummary', { innerHTML: '' });

tab5.updateBotStatus({ enabled: false, tranches: [] }, { positions: [{ market_id: 1, position_amt: 0.00026 }] });
assert.equal(nodes.get('lighterCrypto_btnReconcileBot').style.display, 'inline-flex');
assert.match(nodes.get('lighterCrypto_lblAutoTradeStatusDetail').textContent, /differs from bot/);

tab5.renderVirtualState();
assert.ok(nodes.get('lighterCrypto_activePositionsBody').innerHTML.length > 0);

console.log('Independent Binance Tab 4 and Lighter Tab 5 UI checks passed');

// Null is the persisted Unlimited setting, not a missing value or a default five.
nodes.set('lighterCrypto_inputLiveMaxTranches', {value: '5', dataset: {}});
tab5.updateBotStatus({enabled: false, tranches: [], max_tranches: null}, {positions: []});
assert.equal(nodes.get('lighterCrypto_inputLiveMaxTranches').value, 'unlimited');
assert.equal(tab5.liveStrategyPayload().max_tranches, null);
