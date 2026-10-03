const assert = require('node:assert/strict');
const pnl = require('../held-pair-pnl.js');
const status = {authenticated:true,
  adr_position:{symbol:'SKHYUSDT',position_amt:-1,entry_price:100,mark_price:105},
  stock_position:{symbol:'CSOPSKHYNIX2LUSDT',position_amt:10,entry_price:5,mark_price:5.28}};
const position = pnl.snapshot(status);
assert.ok(Math.abs(position.live + 2.2) < 1e-10);
const points = pnl.revalue([
  {time:1,adr:100,csop:5,value:140},
  {time:2,adr:105,csop:5.28,value:139},
  {time:3,adr:105,csop:null,domestic:80,value:138},
],position);
assert.equal(points[0].value,0);
assert.ok(points[1].value < 0, 'falling domestic premium must not imply profitable held pair');
assert.equal(points[1].adrPnl,-5);
assert.ok(Math.abs(points[1].hedgePnl-2.8)<1e-10);
assert.deepEqual(points[2],{time:3},'missing ETF data must leave a gap, never substitute domestic prices');
const reversed = pnl.snapshot({...status,adr_position:{...status.adr_position,position_amt:1},stock_position:{...status.stock_position,position_amt:-10}});
assert.ok(Math.abs(reversed.live-2.2)<1e-10);
const domestic = pnl.snapshot({...status,stock_position:{symbol:'SKHYNIXUSDT',position_amt:.1,entry_price:1000,mark_price:1060}});
assert.equal(pnl.revalue([{time:1,adr:105,domestic:106}],domestic)[0].value,1);
assert.equal(pnl.snapshot({...status,authenticated:false}),null);
assert.equal(pnl.snapshot({...status,adr_position:null}),null);
assert.equal(pnl.snapshot({...status,adr_position:{...status.adr_position,position_amt:0}}),null);
assert.equal(pnl.snapshot({...status,stock_position:{...status.stock_position,mark_price:Infinity}}),null);
assert.deepEqual(pnl.revalue([{time:1,adr:100}],null),[]);
console.log('Held-pair P&L valuation and missing-data regression checks passed');

assert.deepEqual(pnl.movingAverage([{time:1,value:-2},{time:2,value:-4},{time:3},{time:4,value:8}],2),
  [{time:1},{time:2,value:-3},{time:3},{time:4}], 'MA must use dollar P&L and reset at missing prices');
let mainData;
const chart = Object.create(pnl.MainChart.prototype);
chart.series = {setData: data => {mainData=data;}};
chart.maSeries = [0,1,2].map(()=>({setData:()=>{}}));
chart.liveLabel = {style:{}};
chart.basisLabel = {};
chart.hoverLabel = {};
global.document = {getElementById:()=>null};
const history = [{time:300,adr:100,csop:5},{time:600,adr:100,csop:5}];
chart.update(history,status,'5m',650);
assert.equal(mainData[0].value,0);
assert.ok(Math.abs(mainData[1].value-position.live)<1e-10, 'forming candle must use live paired mark P&L');
chart.update(history,status,'5m',950);
assert.equal(mainData[1].value,0,'closed candles must retain their historical prices');
chart.update(history,{authenticated:false},'5m',650);
assert.equal(mainData.length,0,'unavailable holdings must not fall back to premium');
delete global.document;
