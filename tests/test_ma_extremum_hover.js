const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TerminalCommon = require('../terminal-common.js');

const points = [
  {time: 1, value: 1},
  {time: 2, value: 3},
  {time: 3, value: 2},
  {time: 4, value: 0},
  {time: 5, value: 2},
  {time: 6, value: 4},
];

assert.deepStrictEqual(
  TerminalCommon.previousLocalExtremumSegment(points, 6),
  [{time: 4, value: 0}, {time: 6, value: 4}],
  'uses the most recent prior local minimum',
);
assert.deepStrictEqual(
  TerminalCommon.previousLocalExtremumSegment(points, 4),
  [{time: 2, value: 3}, {time: 4, value: 0}],
  'uses the most recent prior local maximum',
);
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment(points, 2), [], 'requires a confirmed earlier turn');
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment([], 6), [], 'handles unavailable MA data');
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment([
  {time:1,value:1},{time:2,value:2},{time:3,value:2}],3),[], 'flat top is not a confirmed turn');
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment([
  {time:1,value:1},{time:2,value:2},{time:3,value:2},{time:4,value:1}],4),
  [{time:3,value:2},{time:4,value:1}], 'uses the end of a plateau once the turn is confirmed');
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment([
  ...points,{time:7,value:null}],7),[], 'a missing value is not a zero-price pivot');

const writes = [];
const overlays = {
  7: {setData: (data) => writes.push(['7', data]), applyOptions: () => {}},
  24: {setData: (data) => writes.push(['24', data]), applyOptions: () => {}},
};
TerminalCommon.renderMaExtremumHover(overlays, {7: points, 24: points}, 6, {7: true, 24: false});
assert.deepStrictEqual(writes[0][1], [{time: 4, value: 0}, {time: 6, value: 4}]);
assert.deepStrictEqual(writes[1][1], [], 'hidden MAs never leave a hover segment visible');

let primitive, redraws = 0;
const chart = {addLineSeries() { throw Error('Hover must not add or mutate chart data'); },
  timeScale: () => ({timeToCoordinate: time => time * 10})};
const priceSeries = {attachPrimitive(value) { primitive = value; value.attached({requestUpdate: () => redraws++}); },
  priceToCoordinate: value => value * 4};
const guides = TerminalCommon.createMaExtremumHoverSeries(chart, {7:'#f59e0b'}, 2, priceSeries);
TerminalCommon.renderMaExtremumHover(guides, {7:points}, 6);
const count = redraws;
TerminalCommon.renderMaExtremumHover(guides, {7:points}, 6);
assert.equal(redraws, count, 'moving within the same candle must not request another redraw');
const paths = [];
const ctx = {save(){},restore(){},setLineDash(){},beginPath(){},stroke(){},fill(){},
  moveTo:(x,y)=>paths.push(['move',x,y]),lineTo:(x,y)=>paths.push(['line',x,y]),arc(){}};
const view = primitive.paneViews()[0];
view.renderer().draw({useMediaCoordinateSpace: draw => draw({context:ctx})});
assert.deepStrictEqual(paths,[['move',40,0],['line',60,16]],'guides use the existing time and price coordinate transforms');
assert.equal(view.zOrder(),'top');
assert.equal(primitive.autoscaleInfo, undefined, 'guides do not change the price scale');
assert.equal(primitive.hitTest, undefined, 'guides do not intercept pointer gestures');
TerminalCommon.renderMaExtremumHover(guides,{7:points},null);
assert.deepStrictEqual(guides[7].data(),[], 'leaving the chart removes guides');
primitive.detached();

const root = path.join(__dirname, '..');
for (const [name, file] of [
  ['Tab 2', 'index.html'],
  ['Tab 3', 'lighter-tab.js'],
  ['Tab 4', 'crypto-tab.js'],
  ['Tab 5', 'lighter-crypto-tab.js'],
]) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /createMaExtremumHoverSeries\(/, `${name} creates the shared hover-only MA overlay`);
  assert.match(source, /renderMaExtremumHover\(/, `${name} updates the overlay from its chart crosshair`);
}

console.log('MA extremum hover tests passed');
