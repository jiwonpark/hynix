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

const seriesOptions = [];
const compactChart = {
  addLineSeries: options => seriesOptions.push(options),
  addAreaSeries: options => seriesOptions.push(options),
  addBaselineSeries: options => seriesOptions.push(options),
};
Controller.compactCrosshairMarkers(compactChart);
compactChart.addLineSeries({color: '#000'});
compactChart.addAreaSeries({crosshairMarkerRadius: 8});
compactChart.addBaselineSeries();
assert.deepEqual(seriesOptions.map(options => options.crosshairMarkerRadius), [2, 2, 2],
  'all line-like series use the shared compact crosshair dot');
assert.deepEqual(seriesOptions.map(options => options.crosshairMarkerBorderWidth), [1, 1, 1],
  'compact crosshair dots use a thin border');

const frames = [];
let scaleOffset = 0;
let overlayRedraws = 0;
const chartHost = {clientWidth: 600, clientHeight: 420, getClientRects: () => [{}]};
const stopWatching = Controller.watchPriceScale({
  series: {priceToCoordinate: price => 300 - price + scaleOffset},
  host: chartHost,
  samplePrice: () => 100,
  onChange: () => { overlayRedraws += 1; },
  requestFrame: callback => frames.push(callback),
});
const nextFrame = () => frames.shift()();
nextFrame();
nextFrame();
assert.equal(overlayRedraws, 0, 'unchanged price scale must not redraw markers');
scaleOffset = 20;
nextFrame();
assert.equal(overlayRedraws, 1, 'vertical price-scale movement must redraw markers');
chartHost.getClientRects = () => [];
nextFrame();
assert.equal(overlayRedraws, 1, 'hidden charts must not redraw overlays');
chartHost.getClientRects = () => [{}];
nextFrame();
assert.equal(overlayRedraws, 1, 'returning to a visible chart establishes a new baseline');
scaleOffset = 30;
nextFrame();
assert.equal(overlayRedraws, 2, 'subsequent visible scaling must redraw again');
stopWatching();
nextFrame();
assert.equal(frames.length, 0, 'stopped observer must not schedule more frames');
assert.equal(Controller.isPriceVisible(120, 420), true);
assert.equal(Controller.isPriceVisible(-1, 420), false);
assert.equal(Controller.isPriceVisible(421, 420), false);
assert.equal(Controller.isPriceVisible(null, 420), false);

console.log('Reusable strategy execution chart checks passed');
