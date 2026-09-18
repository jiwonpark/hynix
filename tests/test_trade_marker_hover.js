const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const StrategyExecutionChartController = require('../strategy-execution-chart.js');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('      executionMarkerTimeAtX(mouseX)');
const end = html.indexOf('      updateMarkerState(hoveredTime = null)', start);
const method = html.slice(start, end);
const host = {clientWidth: 600};
const context = vm.createContext({$: () => host, Number, Math});
const chart = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({from: 0, to: 60}),
    timeToCoordinate: time => time / 10,
  }),
};
const markerController = new StrategyExecutionChartController();
markerController.setExecutions([{time: 1000, source: 'actual'}, {time: 2000, source: 'actual'}]);
const engine = vm.runInContext(`({
  shortTermChart: chart,
  executionChartController: markerController,
  rawExecutionMarkers: [{time: 1000}, {time: 2000}],
  ${method}
})`, vm.createContext({...context, chart, markerController}));

assert.equal(engine.executionMarkerTimeAtX(105), 1000,
  'the entire x-column should activate a marker');
assert.equal(engine.executionMarkerTimeAtX(105), engine.executionMarkerTimeAtX(105),
  'hover selection must not depend on mouse y');
assert.equal(engine.executionMarkerTimeAtX(150), null,
  'unrelated chart columns must not activate a marker');
assert.equal(engine.executionMarkerTimeAtX(196), 2000,
  'the closest visible marker should activate by x-coordinate');
markerController.setVisibility('actual', false);
assert.equal(engine.executionMarkerTimeAtX(105), null,
  'hidden actual trades must not remain hover targets');
markerController.setExecutions([...markerController.executions, {time: 1000, source: 'virtual', hypothetical: true}]);
assert.equal(engine.executionMarkerTimeAtX(105), 1000,
  'visible virtual trades must remain independently hoverable');

assert.ok(html.includes('this.updateMarkerState(this.activeHoveredExecutionMarkerTime);'),
  'live chart redraws must preserve the active trade price label');
assert.ok(!html.includes('let activeHoveredMarkerTime = null;'),
  'hover state must survive beyond the chart initialization closure');
const componentSource = fs.readFileSync(path.join(__dirname, '../strategy-execution-chart.js'), 'utf8');
assert.ok(componentSource.includes('shape: isShort ? "arrowDown" : "arrowUp"'),
  'hypothetical markers must use arrow shapes instead of colored circle dots');
assert.ok(componentSource.includes('m.hypothetical ? "0.35" : "0.70"'),
  'simulated trades should use dimmed arrows');
assert.ok(componentSource.includes('✓ ${virtual.label || "Virtual"}'));
assert.ok(html.includes('actual: "legendActualTrades"'));
assert.ok(html.includes('virtual: "legendVirtualTrades"'));
assert.ok(html.includes('toggleTradeMarkers(kind)'));
assert.ok(componentSource.includes('visibleExecutions()'));
assert.ok(!html.includes('positionImpliedMarker'),
  'current inventory must never be presented as a missed trade');

const pnlStart = html.indexOf('      tranchePnlSeries(marker)');
const lineStart = html.indexOf('      syncHoveredTrancheAnalytics(hoveredTime = null)', pnlStart);
const lineEnd = html.indexOf('      calcMovingAverage(bars, period)', lineStart);
const pnlMethod = html.slice(pnlStart, lineStart);
const lineMethod = html.slice(lineStart, lineEnd);
const created = [], removed = [], pnlData = [], pnlCreated = [], pnlRemoved = [], referenceRenders = [];
const lineSeries = {
  createPriceLine: options => { created.push(options); return options; },
  removePriceLine: line => removed.push(line),
};
const pnlSeries = {
  setData: data => pnlData.push(data),
  createPriceLine: options => { pnlCreated.push(options); return options; },
  removePriceLine: line => pnlRemoved.push(line),
};
const pnlLabel = {style: {}};
const lineEngine = vm.runInContext(`({
  shortTermSeries: lineSeries,
  shortTermPnlSeries: pnlSeries,
  shortTermHistory: {bars: [{time: 2, adr: 99, csop: 11}]},
  rawExecutionMarkers: [{time: 1000, is_entry: true, entry_spread: 139.34,
    pnl_model: {adr_exit_qty: .07, stock_exit_qty: 1.2, adr_entry_price: 100,
      stock_entry_price: 10, entry_fees_usd: 0, entry_time_ms: 1000,
      exit_fee_bps: 0, slippage_bps: 0, funding_reserve_bps_day: 0, threshold_usd: .02}}],
  isTradeMarkerVisible() { return true; },
  renderShortTermReferenceLines(entry, options) { referenceRenders.push({entry, options}); },
  renderCurrentPositionReferenceLines() { referenceRenders.push({current: true}); },
  ${pnlMethod}
  ${lineMethod}
})`, vm.createContext({lineSeries, pnlSeries, Number, LightweightCharts: {LineStyle: {Dashed: 2}},
  referenceRenders, $: id => id === 'valShortTermNetPnl' ? pnlLabel : null}));
lineEngine.syncHoveredTrancheAnalytics(1000);
assert.equal(referenceRenders[0].entry, 139.34, 'entry x-hover must use that execution instance spread');
assert.equal(referenceRenders[0].options.selected, true, 'hovered entry must replace position reference lines');
assert.equal(pnlData[0][0].value, 1.27, 'net PnL must use both paired legs');
assert.equal(pnlCreated[0].price, .02, 'the PnL pane must show the actual exit threshold');
assert.equal(pnlLabel.textContent, '+$1.270');
lineEngine.syncHoveredTrancheAnalytics(null);
assert.equal(referenceRenders[1].current, true, 'leaving the entry column must restore current position lines');
assert.equal(pnlData.at(-1).length, 0, 'leaving the entry column must clear selected PnL');

for (const redundantTitle of ['title: `ENTRY (${criteria.entry_baseline_spread.toFixed(2)}%)`',
                              'title: `SCALE-IN SHORT (${criteria.scale_in_trigger_spread.toFixed(2)}%)`',
                              'title: `TP COVER (${tpLinePrice.toFixed(2)}%)`']) {
  assert.ok(!html.includes(redundantTitle), 'horizontal line titles must not repeat axis percentages');
}

console.log('Trade marker x-hover regression checks passed');
