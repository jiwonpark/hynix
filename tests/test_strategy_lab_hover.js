const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Controller = require('../strategy-execution-chart.js');

const host = { clientWidth: 600, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } };
const context = { window: {}, document: { getElementById: () => host } };
vm.runInNewContext(fs.readFileSync(require.resolve('../strategy-lab.js'), 'utf8'), context);
const lab = context.window.strategyLab;
const buy = { time: 100, entry_price: 1000, exit_price: 1100, net_return_pct: 9.89,
  hypothetical: true, backtest: true, is_entry: true, shape: 'arrowUp', hoverText: 'BUY' };
const sell = { ...buy, time: 200, is_entry: false, shape: 'arrowDown', hoverText: 'SELL' };
lab.data = { markers: [buy, sell], fee_bps: 5, open_position: { price: 1200 } };
lab.chart = { timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 60 }),
  timeToCoordinate: time => time }) };
let cursor = { time: 100, point: { x: 100, y: 10 } };
let updates = 0;
let rendered;
const lines = new Set();
lab.candles = {
  setMarkers(markers) {
    rendered = markers;
    updates++;
    // Reproduce Lightweight Charts' synchronous crosshair notification.
    if (updates > 20) throw new Error('recursive crosshair updates');
    lab.onCrosshair(cursor);
  },
  createPriceLine(options) { lines.add(options); lab.onCrosshair(cursor); return options; },
  removePriceLine(line) { lines.delete(line); lab.onCrosshair(cursor); },
};
lab.controller = new Controller({ series: lab.candles });
lab.controller.setExecutions(lab.data.markers);

lab.onCrosshair(cursor);
assert.equal(updates, 1, 'one mouse event must not recurse through setMarkers');
assert.equal(lines.size, 8, 'buy hover must draw entry, six profit levels and exit');
assert.equal([...lines][0].price, buy.entry_price);
assert.equal(rendered[0].text, 'BUY');
lab.onCrosshair({ time: 100, point: { x: 100, y: 350 } });
assert.equal(updates, 1, 'moving vertically within the same trade column must not redraw');

cursor = { time: 201, point: { x: 202, y: 350 } };
lab.onCrosshair(cursor);
assert.equal(updates, 2, 'sell hover must resolve by x even away from the arrow');
assert.equal(rendered[1].text, 'SELL');
assert.equal([...lines][0].price, buy.entry_price, 'sell levels must use its matching buy');
assert.ok([...lines].at(-1).title.includes('+9.89% net'));

lab.onClick(cursor);
cursor = {};
lab.onCrosshair(cursor);
assert.equal([...lines][0].price, buy.entry_price, 'clicked trade remains pinned on mouse leave');
lab.onClick({ point: { x: 450, y: 20 } });
assert.equal([...lines][0].price, 1200, 'empty click restores open-position reference');

lab.toggleVirtual();
cursor = { time: 100, point: { x: 100, y: 20 } };
lab.onCrosshair(cursor);
assert.equal(lines.size, 0, 'hidden trades must not restore their lines on hover');
lab.toggleVirtual();
lab.onCrosshair(cursor);
assert.equal(lines.size, 8, 'hover recovers after showing virtual trades again');
assert.equal(lab.syncingMarkerState, false);

// 1h interval marker rendering and interaction tests
lab.data.hourly = [{ time: 0, open: 1000, high: 1100, low: 900, close: 1050, ma7: 1020, ma24: 1010, ma60: 1000 }];
lab.data.bars = [
  { time: 100, open: 1000, high: 1050, low: 950, close: 1000, ma7: 1000, ma24: 1000, ma60: 1000 },
  { time: 200, open: 1100, high: 1150, low: 1050, close: 1100, ma7: 1050, ma24: 1020, ma60: 1000 },
];
lab.candles.setData = () => {};
lab.maSeries = [];
lab.chart = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 0, to: 60 }),
    timeToCoordinate: (time) => time,
    fitContent: () => {},
  }),
};

lab.setChartInterval('1h');
assert.equal(lab.chartInterval, '1h');
assert.equal(rendered.length, 2, 'markers must render on 1h interval');
assert.equal(rendered[0].time, 0, 'marker timestamp must be mapped to 1h candle timestamp');
assert.equal(rendered[1].time, 0, 'marker timestamp must be mapped to 1h candle timestamp');

cursor = { time: 0, point: { x: 0, y: 10 } };
lab.onCrosshair(cursor);
assert.equal(lines.size, 8, 'hovering 1h candle must draw reference lines');
assert.equal([...lines][0].price, buy.entry_price);

lab.onTrancheClick(100);
assert.equal(lab.selectedMarkerTime, 0, 'clicking tranche on 1h must select the 1h mapped time');
assert.equal([...lines][0].price, buy.entry_price, 'tranche click on 1h must draw entry and profit lines');

lab.setChartInterval('5m');
assert.equal(lab.chartInterval, '5m');
assert.equal(rendered[0].time, 100, '5m marker time restored on 5m interval');
assert.equal(rendered[1].time, 200, '5m marker time restored on 5m interval');

// 5-Framework Strategy Sub-Tabs & Bollinger Band Tests
let bbRenderedData = {};
lab.bbSeries = [
  { key: 'bb_upper', series: { setData: (d) => { bbRenderedData.bb_upper = d; } } },
  { key: 'bb_middle', series: { setData: (d) => { bbRenderedData.bb_middle = d; } } },
  { key: 'bb_lower', series: { setData: (d) => { bbRenderedData.bb_lower = d; } } },
];
lab.data.bars = [
  { time: 100, open: 1000, high: 1050, low: 950, close: 1000, bb_upper: 1080, bb_middle: 1000, bb_lower: 920, z_score: -2.1, rsi: 25, stoch_k: 15, ou_z: -1.8, p_reversion: 0.65 },
  { time: 200, open: 1100, high: 1150, low: 1050, close: 1100, bb_upper: 1120, bb_middle: 1050, bb_lower: 980, z_score: 1.2, rsi: 70, stoch_k: 85, ou_z: 0.5, p_reversion: 0.45 },
];

let runTriggered = 0;
lab.run = () => { runTriggered++; };

lab.setStrategyMode('bollinger_zscore');
assert.equal(lab.strategyMode, 'bollinger_zscore');
assert.equal(runTriggered, 1);
lab.renderChartData();
assert.equal(bbRenderedData.bb_upper?.length, 2, 'Bollinger upper band must be plotted in bollinger_zscore mode');
assert.equal(bbRenderedData.bb_lower?.length, 2, 'Bollinger lower band must be plotted in bollinger_zscore mode');

lab.setStrategyMode('rsi_momentum');
assert.equal(lab.strategyMode, 'rsi_momentum');
assert.equal(runTriggered, 2);
lab.renderChartData();
assert.equal(bbRenderedData.bb_upper?.length, 0, 'Bollinger bands must be cleared in non-Bollinger modes');

lab.setStrategyMode('multi_factor');
assert.equal(lab.strategyMode, 'multi_factor');
assert.equal(runTriggered, 3);

lab.setStrategyMode('ou_quant');
assert.equal(lab.strategyMode, 'ou_quant');
assert.equal(runTriggered, 4);

// Verify that getConditionDefinitions produces unique full sets of entry and exit conditions for each strategy
const cap = { remaining_tranches: 5, max_tranches: 5, free_cash_krw: 10000000, open_quantity_btc: 0 };
const latest = lab.data.bars[0];
const hourly = { rsi: 40, ma24: 1000, bullish: false, bearish: true };

const defMa = lab.getConditionDefinitions('ma_stack', latest, hourly, cap, [], null);
assert.equal(defMa.entryRows[0].key, 'entry_5m');
assert.equal(defMa.exitRows[2].key, 'exit_5m');

const defBB = lab.getConditionDefinitions('bollinger_zscore', latest, hourly, cap, [], null);
assert.equal(defBB.entryRows[0].key, 'entry_zscore');
assert.equal(defBB.entryRows[1].key, 'entry_bb_pierce');
assert.equal(defBB.exitRows[2].key, 'exit_bb_middle');

const defRsi = lab.getConditionDefinitions('rsi_momentum', latest, hourly, cap, [], null);
assert.equal(defRsi.entryRows[0].key, 'entry_rsi_dual');
assert.equal(defRsi.entryRows[1].key, 'entry_stoch_hook');
assert.equal(defRsi.exitRows[2].key, 'exit_rsi_5m');

const defMF = lab.getConditionDefinitions('multi_factor', latest, hourly, cap, [], null);
assert.equal(defMF.entryRows[0].key, 'entry_macro_1h');
assert.equal(defMF.entryRows[1].key, 'entry_micro_stretch');
assert.equal(defMF.entryRows[4].key, 'entry_consensus');
assert.equal(defMF.exitRows[2].key, 'exit_rsi_65');

const defOU = lab.getConditionDefinitions('ou_quant', latest, hourly, cap, [], null);
assert.equal(defOU.entryRows[0].key, 'entry_ou_spread');
assert.equal(defOU.entryRows[1].key, 'entry_p_reversion');
assert.equal(defOU.exitRows[2].key, 'exit_ou_mean');

// Actual Trade Marker Ingestion and Toggle Tests
lab.botState = {
  mode: 'live',
  recent_trades: [
    { id: 'T1', entry_time: 150, exit_time: 250, entry_price: 1000, exit_price: 1050, net_return_pct: 4.85, mode: 'live' }
  ],
  active_tranches: [
    { id: 'T2', entry_time: 350, entry_price: 1020, coin_qty: 0.01, mode: 'live' }
  ]
};

const actualMarkers = lab.getActualTradeMarkers();
assert.equal(actualMarkers.length, 3, 'Must generate 2 markers for closed trade (buy+sell) and 1 for open tranche');
assert.equal(actualMarkers[0].source, 'actual');
assert.equal(actualMarkers[0].hypothetical, false);
assert.equal(actualMarkers[0].is_entry, true);
assert.equal(actualMarkers[0].time, 150);
assert.equal(actualMarkers[1].source, 'actual');
assert.equal(actualMarkers[1].is_entry, false);
assert.equal(actualMarkers[1].time, 250);
assert.equal(actualMarkers[2].source, 'actual');
assert.equal(actualMarkers[2].is_entry, true);
assert.equal(actualMarkers[2].time, 350);

lab.toggleActual();
assert.equal(lab.controller.visibility.actual, false, 'toggleActual must toggle actual visibility to false');
lab.toggleActual();
assert.equal(lab.controller.visibility.actual, true, 'toggleActual must restore actual visibility to true');

console.log('Strategy Lab real crosshair callback regression checks passed');


