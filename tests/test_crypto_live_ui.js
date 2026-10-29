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

// A favorable fill-price move can be a realized net loss after commissions.
const svg = {children: [], set innerHTML(value) { if (value === '') this.children = []; },
  appendChild(fragment) { this.children.push(...fragment.children); }};
elements.set('crypto_tradeTrianglesLayer', svg);
context.document.createDocumentFragment = () => ({children: [], appendChild(child) { this.children.push(child); }});
context.document.createElementNS = (_, tag) => ({tag, attributes: {}, style: {},
  setAttribute(name, value) { this.attributes[name] = value; }});
const entry = {source: 'actual', is_entry: true, direction: 'short', ratio: 100,
  time: 100, markerKey: 'entry', pairKey: 'pair'};
const exit = {source: 'actual', is_entry: false, direction: 'short', ratio: 99.98,
  time: 200, markerKey: 'exit', pairKey: 'pair', pnl: -0.14, pnl_authoritative: true};
engine.rawExecutionMarkers = [entry, exit];
engine.selectedExecutionMarkerKey = 'entry';
engine.isTradeMarkerVisible = () => true;
engine.alignChartOverlay = () => {};
engine.chart = {timeScale: () => ({timeToCoordinate: (time) => time})};
engine.series = {priceToCoordinate: (price) => price};
engine.renderTradeTriangles();
assert.equal(svg.children[1].attributes.stroke, '#dc2626', 'verified net loss is red despite favorable prices');
exit.pnl = 0.01;
engine.renderTradeTriangles();
assert.equal(svg.children[1].attributes.stroke, '#16a34a', 'verified net gain is green');
exit.pnl_authoritative = false;
engine.renderTradeTriangles();
assert.equal(svg.children[1].attributes.stroke, '#64748b', 'unverified realized P&L is neutral');
assert.equal(engine.paradigms.macd_reversal.name, 'MACD Reversal');
assert.equal(engine.paradigms.macd_strength_scaleout.name, 'MACD Strength Scale-Out');
const macdMarkup = engine.renderParadigmDetail('macd_reversal');
assert.match(macdMarkup, /Long entry \/ short exit: Signal &lt; 0/);
assert.match(macdMarkup, /Long entry \/ short exit: Histogram &lt; 0/);
assert.match(macdMarkup, /trough turns up/);
assert.match(macdMarkup, /Short entry \/ long exit: Signal &gt; 0/);
assert.match(macdMarkup, /Short entry \/ long exit: Histogram &gt; 0/);
assert.match(macdMarkup, /peak turns down/);
assert.match(macdMarkup, /Chart MACD-H zone \+ slope/);
assert.match(macdMarkup, /Completed 5m/);
assert.match(macdMarkup, /crypto_macroMaPeriodSlider/);
assert.match(macdMarkup, /Hourly macro MA period/);
assert.doesNotMatch(macdMarkup, /Z window|Enter \|Z\||Release \|Z\||slope Z/);
assert.match(macdMarkup, /Hybrid \(both agree\)/);
assert.match(macdMarkup, /NEW/);

const strengthMarkup = engine.renderParadigmDetail('macd_strength_scaleout');
assert.match(strengthMarkup, /Rebound ≥/);
assert.match(strengthMarkup, /first peak closes/);

[
  ['crypto_macdFastPeriod', { value: '12' }],
  ['crypto_macdSlowPeriod', { value: '26' }],
  ['crypto_macdSignalPeriod', { value: '9' }],
  ['crypto_macdUseEntrySignalNegative', { checked: true }],
  ['crypto_macdUseEntryHistogramNegative', { checked: true }],
  ['crypto_macdUseEntryReversal', { checked: true }],
  ['crypto_macdUseExitSignalPositive', { checked: true }],
  ['crypto_macdUseExitHistogramPositive', { checked: true }],
  ['crypto_macdUseExitReversal', { checked: true }],
  ['crypto_macroRegimeMode', { value: 'macd_hist_accel' }],
  ['crypto_macroMaPeriodSlider', { value: '8' }],
  ['crypto_macroMaPeriodVal', { value: '8' }],
  ['crypto_macroMacdFastPeriod', { value: '8' }],
  ['crypto_macroMacdSlowPeriod', { value: '21' }],
  ['crypto_macroMacdSignalPeriod', { value: '5' }],
  ['crypto_macroMacdConfirmBars', { value: '2' }],
  ['crypto_valCondEntryMaStack1h', { textContent: '' }],
  ['crypto_macdMacroConditionLabel', { textContent: '' }],
  ['crypto_macroRegimeReadout', { textContent: '' }],
].forEach(([id, node]) => elements.set(id, node));

engine.currentParadigm = 'macd_reversal';
const macdReplay = engine.replaySettings();
assert.equal(macdReplay.strategy_mode, 'macd_reversal');
assert.equal(macdReplay.macd_fast_period, 12);
assert.equal(macdReplay.use_macd_hist_reversal_exit, true);
assert.equal(macdReplay.macro_regime_mode, 'macd_hist_accel');
assert.equal(macdReplay.macro_ma_period, 8);
assert.equal(macdReplay.macro_macd_confirm_bars, 2);
assert.equal('macro_macd_enter_z' in macdReplay, false);

const macdPayload = engine.liveStrategyPayload('macd_reversal');
assert.equal(macdPayload.macd_slow_period, 26);
assert.equal(macdPayload.use_macd_signal_negative, true);
assert.equal(macdPayload.macro_regime_mode, 'macd_hist_accel');
assert.equal(macdPayload.macro_ma_period, 8);

[
  'crypto_macroRegimeMode', 'crypto_macroMaPeriodSlider',
  'crypto_macroMaPeriodVal', 'crypto_macroMacdFastPeriod',
  'crypto_macroMacdSlowPeriod', 'crypto_macroMacdSignalPeriod',
  'crypto_macroMacdConfirmBars',
].forEach((id) => { elements.get(id).dataset = {}; });
engine.initialized = false;
assert.equal(engine.syncMacroRegimeControlsFromBot({
  strategy_mode: 'macd_reversal',
  strategy_params: {
    macro_regime_mode: 'macd_hist_accel', macro_ma_period: 24,
    macro_macd_fast_period: 24,
    macro_macd_slow_period: 30, macro_macd_signal_period: 7,
    macro_macd_confirm_bars: 3,
  },
}), true);
assert.equal(elements.get('crypto_macroRegimeMode').value, 'macd_hist_accel');
assert.equal(elements.get('crypto_macroMaPeriodSlider').value, '24');
assert.equal(elements.get('crypto_macroMaPeriodVal').value, '24');
assert.match(elements.get('crypto_valCondEntryMaStack1h').textContent, /completed 5m MACD-H/);
assert.match(elements.get('crypto_macdMacroConditionLabel').textContent, /completed 5m MACD-H/);

elements.get('crypto_macroRegimeMode').dataset.unsaved = 'true';
assert.equal(engine.syncMacroRegimeControlsFromBot({
  strategy_mode: 'macd_reversal', strategy_params: { macro_regime_mode: 'ma_slope' },
}), false);
assert.equal(elements.get('crypto_macroRegimeMode').value, 'macd_hist_accel');
delete elements.get('crypto_macroRegimeMode').dataset.unsaved;

console.log('Crypto live balance display & Tab 4 MACD parity checks passed');
