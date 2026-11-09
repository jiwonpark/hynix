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

const curved = [1, 0, 3, 3.2, 6.8, 7, 10].map((value,time)=>({time,value}));
const chord = [{x:1,y:0},{x:6,y:10}];
const crossings = TerminalCommon.segmentCurveIntersections(chord, curved.slice(1).map(p=>({x:p.time,y:p.value})));
assert.equal(crossings.length,3,'marks every internal crossing, including between candles');
assert.deepStrictEqual(crossings.map(p=>p.direction),['down','up','down']);
assert.equal(TerminalCommon.segmentCurveIntersections(chord.slice().reverse(),curved.slice(1).map(p=>({x:p.time,y:p.value})))[0].direction,'up','direction follows the guide from its first endpoint');
for (const [i, expected] of [23/9,3.5,40/9].entries()) assert(Math.abs(crossings[i].x-expected)<1e-9);
assert.deepStrictEqual(TerminalCommon.segmentCurveIntersections([{x:0,y:0},{x:2,y:2}],
  [{x:0,y:0},{x:.5,y:2},{x:1,y:1},{x:1.5,y:2},{x:2,y:2}]),[], 'a touch without crossing has no up/down direction');
assert.deepStrictEqual(TerminalCommon.segmentCurveIntersections([{x:0,y:0},{x:2,y:2}],
  [{x:0,y:0},{x:.5,y:1},{x:1,y:1},{x:1.5,y:1},{x:2,y:2}]),[{x:1,y:1,direction:'down'}], 'an exact vertex crossing is marked once');
assert.deepStrictEqual(TerminalCommon.segmentCurveIntersections(chord,chord),[], 'shared endpoints are not extra intersections');
assert.deepStrictEqual(TerminalCommon.segmentCurveIntersections([{x:0,y:0},{x:2,y:2}],
  [{x:0,y:0},{x:1,y:1},{x:2,y:2}]),[], 'coincident lines do not create arbitrary rings');
assert.deepStrictEqual(TerminalCommon.segmentCurveIntersections([{x:0,y:0},{x:3,y:0}],
  [{x:0,y:0},{x:1,y:1},null,{x:2,y:-1},{x:3,y:0}]),[], 'missing curve data is not bridged');

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
const circles = [];
const strokes = [];
let currentPath = [];
const ctx = {save(){},restore(){},setLineDash(){},beginPath(){currentPath=[];},
  stroke(){strokes.push({color:this.strokeStyle,path:currentPath.slice()});},fill(){},
  moveTo:(x,y)=>{paths.push(['move',x,y]);currentPath.push(['move',x,y]);},
  lineTo:(x,y)=>{paths.push(['line',x,y]);currentPath.push(['line',x,y]);},arc:(x,y,r)=>circles.push({x,y,r})};
const view = primitive.paneViews()[0];
view.renderer().draw({useMediaCoordinateSpace: draw => draw({context:ctx})});
assert.deepStrictEqual(paths,[['move',40,0],['line',60,16]],'guides use the existing time and price coordinate transforms');
assert.equal(view.zOrder(),'top');
assert.equal(primitive.autoscaleInfo, undefined, 'guides do not change the price scale');
assert.equal(primitive.hitTest, undefined, 'guides do not intercept pointer gestures');
TerminalCommon.renderMaExtremumHover(guides,{7:curved},6);
circles.length=0;strokes.length=0;
view.renderer().draw({useMediaCoordinateSpace: draw=>draw({context:ctx})});
assert.equal(guides[7].intersections().length,3);
const arrows=strokes.filter(p=>p.color==='#f59e0b' && p.path.length===5);
assert.equal(arrows.length,3,'native renderer paints one directional arrow at each crossing');
guides[7].intersections().forEach((crossing,i)=>{
  const shaft=arrows[i].path;
  assert.equal(shaft[1][1],crossing.x);assert.equal(shaft[1][2],crossing.y,'arrow tip anchors at the intersection');
  assert.equal(shaft[0][2]>shaft[1][2],crossing.direction==='up','arrow orientation agrees with the crossing direction');
});
assert.equal(circles.length,1,'only the original pivot dot remains; intersections are no longer circles');
const originalX=guides[7].intersections()[0].x;
chart.timeScale=()=>({timeToCoordinate:t=>t*20});
priceSeries.priceToCoordinate=value=>value*8;
view.renderer().draw({useMediaCoordinateSpace:draw=>draw({context:ctx})});
assert(Math.abs(guides[7].intersections()[0].x-originalX*2)<1e-9,'arrows reproject when the chart is scaled');
const straight=curved.map(p=>({...p,value:p.time>=1?(p.time-1)*2:p.value}));
TerminalCommon.renderMaExtremumHover(guides,{7:straight},6);
view.renderer().draw({useMediaCoordinateSpace:draw=>draw({context:ctx})});
assert.deepStrictEqual(guides[7].intersections(),[], 'interior curve changes refresh arrows even when chord endpoints are unchanged');
TerminalCommon.renderMaExtremumHover(guides,{7:curved},6,{7:false});
assert.deepStrictEqual(guides[7].intersections(),[],'hidden MAs clear intersection markers');
TerminalCommon.renderMaExtremumHover(guides,{7:points},null);
assert.deepStrictEqual(guides[7].data(),[], 'leaving the chart removes guides');
assert.deepStrictEqual(guides[7].intersections(),[], 'leaving the chart removes intersections');
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
