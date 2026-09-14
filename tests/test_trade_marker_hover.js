const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
const engine = vm.runInContext(`({
  shortTermChart: chart,
  rawExecutionMarkers: [{time: 1000}, {time: 2000}],
  ${method}
})`, vm.createContext({...context, chart}));

assert.equal(engine.executionMarkerTimeAtX(105), 1000,
  'the entire x-column should activate a marker');
assert.equal(engine.executionMarkerTimeAtX(105), engine.executionMarkerTimeAtX(105),
  'hover selection must not depend on mouse y');
assert.equal(engine.executionMarkerTimeAtX(150), null,
  'unrelated chart columns must not activate a marker');
assert.equal(engine.executionMarkerTimeAtX(196), 2000,
  'the closest visible marker should activate by x-coordinate');

assert.ok(html.includes('this.updateMarkerState(this.activeHoveredExecutionMarkerTime);'),
  'live chart redraws must preserve the active trade price label');
assert.ok(!html.includes('let activeHoveredMarkerTime = null;'),
  'hover state must survive beyond the chart initialization closure');

const inferredStart = html.indexOf('      positionImpliedMarker(bars, confirmedMarkers, visibleFrom = 0)');
const pnlStart = html.indexOf('      tranchePnlSeries(marker)', inferredStart);
const lineStart = html.indexOf('      syncHoveredTrancheAnalytics(hoveredTime = null)', pnlStart);
const lineEnd = html.indexOf('      calcMovingAverage(bars, period)', lineStart);
const inferredMethod = html.slice(inferredStart, pnlStart);
const pnlMethod = html.slice(pnlStart, lineStart);
const lineMethod = html.slice(lineStart, lineEnd);
const created = [], removed = [], pnlData = [], pnlCreated = [], pnlRemoved = [];
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
  rawExecutionMarkers: [{time: 1000, is_entry: true, convergence_target_spread: 139.26,
    pnl_model: {adr_exit_qty: .07, stock_exit_qty: 1.2, adr_entry_price: 100,
      stock_entry_price: 10, entry_fees_usd: 0, entry_time_ms: 1000,
      exit_fee_bps: 0, slippage_bps: 0, funding_reserve_bps_day: 0, threshold_usd: .02}}],
  ${pnlMethod}
  ${lineMethod}
})`, vm.createContext({lineSeries, pnlSeries, Number, LightweightCharts: {LineStyle: {Dashed: 2}},
  $: id => id === 'valShortTermNetPnl' ? pnlLabel : null}));
lineEngine.syncHoveredTrancheAnalytics(1000);
assert.equal(created[0].price, 139.26, 'entry x-hover must draw its convergence reference');
assert.equal(created[0].title, 'SELECTED REF', 'the spread line must not claim exact profitability');
assert.equal(pnlData[0][0].value, 1.27, 'net PnL must use both paired legs');
assert.equal(pnlCreated[0].price, .02, 'the PnL pane must show the actual exit threshold');
assert.equal(pnlLabel.textContent, '+$1.270');
lineEngine.syncHoveredTrancheAnalytics(null);
assert.equal(removed.length, 1, 'leaving the entry column must remove the convergence reference');
assert.equal(pnlData.at(-1).length, 0, 'leaving the entry column must clear selected PnL');

const inferredEngine = vm.runInContext(`({
  state: {hedgedStatus: {adr_position: {position_amt: -.99}}},
  ${inferredMethod}
})`, vm.createContext({Number, Math}));
const inferred = inferredEngine.positionImpliedMarker([{time: 100}], [
  {is_entry: true, qty: .8}, {is_entry: false, qty: .1}
]);
assert.equal(inferred.is_entry, true);
assert.equal(inferred.outlineGlyph, '⇩');
assert.ok(Math.abs(inferred.qty - .29) < 1e-8, 'outline marker must reconcile loaded trades to position size');
assert.equal(inferredEngine.positionImpliedMarker([{time: 100}], [{is_entry: true, qty: .99}]), null,
  'no inferred marker should remain after confirmed history reconciles the position');
const visibleCarry = inferredEngine.positionImpliedMarker(
  [{time: 100}, {time: 200}, {time: 300}],
  [{time: 100, is_entry: true, qty: .8}, {time: 200, is_entry: false, qty: .1}],
  1
);
assert.equal(visibleCarry.time, 200, 'outline marker must stay on the first visible bar');
assert.ok(Math.abs(visibleCarry.qty - 1.09) < 1e-8,
  'opening inventory must reconcile the current position using trades after the visible boundary');
assert.ok(html.includes('this.refreshPositionImpliedMarker(range);'),
  'panning the chart must re-anchor inferred inventory to the visible window');

for (const redundantTitle of ['title: `ENTRY (${criteria.entry_baseline_spread.toFixed(2)}%)`',
                              'title: `SCALE-IN SHORT (${criteria.scale_in_trigger_spread.toFixed(2)}%)`',
                              'title: `TP COVER (${tpLinePrice.toFixed(2)}%)`']) {
  assert.ok(!html.includes(redundantTitle), 'horizontal line titles must not repeat axis percentages');
}

console.log('Trade marker x-hover regression checks passed');
