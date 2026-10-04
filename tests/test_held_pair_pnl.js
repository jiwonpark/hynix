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
assert.ok(points[1].value < 0, 'falling nominal signal must not imply profitable held pair');
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

const chart = Object.create(pnl.Readout.prototype);
chart.series = {setData: () => {throw new Error("P&L readout must never overwrite premium chart data");}};
chart.maSeries = [0,1,2].map(()=>({setData:()=>{}}));
chart.liveLabel = {style:{}};
chart.basisLabel = {};
chart.hoverLabel = {};
const history = [{time:300,adr:100,csop:5},{time:600,adr:100,csop:5}];
chart.update(history,status,'5m',650);
assert.equal(chart.points.get(300).value,0);
assert.ok(Math.abs(chart.points.get(600).value-position.live)<1e-10, 'forming candle must use live paired mark P&L');
chart.update(history,status,'5m',950);
assert.equal(chart.points.get(600).value,0,'closed candles must retain their historical prices');
chart.update(history,{authenticated:false},'5m',650);
assert.equal(chart.points.size,0,'unavailable holdings must not fall back to premium');

const model={adr_exit_qty:.07,stock_exit_qty:1.2,adr_entry_price:195,stock_entry_price:5.4,
 entry_fees_usd:.02,entry_time_ms:1000,exit_fee_bps:5,slippage_bps:3,funding_reserve_bps_day:3,threshold_usd:.02};
const bar={csop:5.5,signal_scale:60};
const valuation=86401000;
const levels=pnl.profitLevels(model,bar,valuation);
assert.equal(levels.length,9);
for(const level of levels){
 const adr=level.price/100*bar.signal_scale*Math.sqrt(bar.csop);
 const net=.07*(195-adr)+1.2*(5.5-5.4)-.02-(.07*adr+1.2*5.5)*.0008-(.07*195+1.2*5.4)*.0003;
 assert.ok(Math.abs(net-level.net)<1e-10,'premium level must solve the paired P&L equation including costs');
}
assert.ok(levels[1].price<levels[0].price);
assert.match(levels[1].title,/Min profit \(net/);
assert.deepEqual(pnl.profitLevels({...model,entry_fees_usd:null},bar,valuation),[]);
assert.deepEqual(pnl.profitLevels(model,{domestic:138},valuation),[]);
const higherEtf = pnl.profitLevels(model,{...bar,csop:5.6},valuation)[1];
const adrTarget = level => level.price/100*bar.signal_scale*Math.sqrt(bar.csop);
const higherEtfAdrTarget = higherEtf.price/100*bar.signal_scale*Math.sqrt(5.6);
assert.ok(higherEtfAdrTarget>adrTarget(levels[1]),
 'ETF gains must raise the ADR price at which the paired profit threshold is met');
