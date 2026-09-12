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

const lineStart = html.indexOf('      syncHoveredMinimumProfitLine(hoveredTime = null)');
const lineEnd = html.indexOf('      calcMovingAverage(bars, period)', lineStart);
const lineMethod = html.slice(lineStart, lineEnd);
const created = [], removed = [];
const lineSeries = {
  createPriceLine: options => { created.push(options); return options; },
  removePriceLine: line => removed.push(line),
};
const lineEngine = vm.runInContext(`({
  shortTermSeries: lineSeries,
  rawExecutionMarkers: [{time: 1000, is_entry: true, minimum_profit_spread: 139.26}],
  ${lineMethod}
})`, vm.createContext({lineSeries, Number, LightweightCharts: {LineStyle: {Dashed: 2}}}));
lineEngine.syncHoveredMinimumProfitLine(1000);
assert.equal(created[0].price, 139.26, 'entry x-hover must draw its minimum-profit spread');
assert.equal(created[0].title, '', 'minimum profit must be a line, not a text label');
lineEngine.syncHoveredMinimumProfitLine(null);
assert.equal(removed.length, 1, 'leaving the entry column must remove the horizontal line');

console.log('Trade marker x-hover regression checks passed');
