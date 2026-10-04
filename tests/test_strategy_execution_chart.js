const assert = require('node:assert/strict');
const Controller = require('../strategy-execution-chart.js');

const created = [];
const removed = [];
const series = {
  createPriceLine: options => { created.push(options); return options; },
  removePriceLine: line => removed.push(line),
};
const controller = new Controller({series, lineStyle: {Solid: 0, Dashed: 2}});
controller.setExecutions([
  {time: 1000, source: 'actual', is_entry: true, position: 'aboveBar', shape: 'arrowDown', hoverText: 'actual'},
  {time: 2000, source: 'virtual', hypothetical: true, backtest: true, is_entry: true, position: 'aboveBar', shape: 'arrowDown', hoverText: 'virtual'},
]);

assert.equal(controller.markersForRender().length, 2);
controller.setVisibility('actual', false);
assert.equal(controller.markersForRender().length, 1);
assert.equal(controller.markersForRender()[0].text, '');
assert.equal(controller.markersForRender(2000)[0].text, 'virtual');

controller.setVisibility('actual', true);
controller.setExecutions([
  {time: 3000, source: 'virtual', hypothetical: true, backtest: true, is_entry: true, direction: 'long', position: 'belowBar', shape: 'arrowUp'},
]);
assert.equal(controller.markersForRender()[0].shape, 'arrowUp', 'generic component must preserve long-entry direction');
controller.setExecutions([
  {time: 1000, source: 'actual', is_entry: true, position: 'aboveBar', shape: 'arrowDown', hoverText: 'actual'},
  {time: 2000, source: 'virtual', hypothetical: true, backtest: true, is_entry: true, position: 'aboveBar', shape: 'arrowDown', hoverText: 'virtual'},
]);
controller.setVisibility('actual', false);

const timeScale = {
  getVisibleLogicalRange: () => ({from: 0, to: 60}),
  timeToCoordinate: time => time / 10,
};
assert.equal(controller.executionTimeAtX(105, {timeScale, hostWidth: 600}), null);
assert.equal(controller.executionTimeAtX(196, {timeScale, hostWidth: 600}), 2000);

controller.renderReferenceLines({
  entry: 140,
  selected: true,
  levels: [{price: 139.8, netProfitPct: 0, title: 'B/E'}, {price: 139, netProfitPct: 0.5, title: 'NET +0.5%'}],
});
assert.equal(created.length, 3);
assert.equal(created[0].title, 'ENTRY · SELECTED');
assert.equal(created[1].title, 'B/E');
controller.renderReferenceLines({entry: 141, levels: [], exit: 139.5, exitTitle: 'EXIT'});
assert.equal(created.at(-1).title, 'EXIT', 'must render optional exit price line');
assert.equal(created.at(-1).price, 139.5);

const exactSeries = {priceToCoordinate: price => price * 2};
const exact = new Controller({series: exactSeries, exactActual: true});
exact.setExecutions([
  {time: 1000, is_entry: true, fill_signals: [
    {order_id: 'a', signal: 138.2, adr_price: 190, stock_price: 5.2},
    {order_id: 'b', signal: 138.4, adr_price: 191, stock_price: 5.3}]},
  {time: 2000, is_entry: false, fill_signals: [], unpaired_order_count: 1},
  {time: 3000, hypothetical: true, backtest: true, is_entry: true, position: 'aboveBar'},
]);
assert.equal(exact.markersForRender().length, 2, 'paired actual fills use exact-price glyphs, not candle markers');
assert.equal(exact.markersForRender()[0].shape, 'circle', 'unpaired fills must not imply a precise execution ratio');
assert.equal(exact.markersForRender()[1].shape, 'arrowDown', 'virtual arrows remain on the chart');
const exactChart = {timeScale: () => ({timeToCoordinate: time => time / 10})};
const projected = exact.projectActualFills(exactChart, 600, 400);
assert.deepEqual(projected.map(point => point.y), [276.4, 276.8]);
assert.deepEqual(projected.map(point => point.order_id), ['a', 'b']);
exact.setVisibility('actual', false);
assert.equal(exact.projectActualFills(exactChart, 600, 400).length, 0);

console.log('Reusable strategy execution chart checks passed');
