const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TerminalCommon = require('../terminal-common.js');
const nodes = new Map();
function input(id, value) {
  const listeners={};
  const node={id,value:String(value),addEventListener(type,callback){listeners[type]=callback;},fire(type){listeners[type]?.();}};
  nodes.set(id,node); return node;
}
const fast=input('lighterCrypto_macdFastPeriod',8);
const slow=input('lighterCrypto_macdSlowPeriod',21);
const signal=input('lighterCrypto_macdSignalPeriod',5);
const periods=[fast,slow,signal];
nodes.set('lighterCrypto_paradigmDetailSection',{querySelectorAll(){return periods;}});
const legend={textContent:''};nodes.set('lighterCrypto_macdLegendPeriods',legend);
const context={window:{TerminalCommon},TerminalCommon,URLSearchParams,console,
  document:{readyState:'loading',addEventListener(){},getElementById:id=>nodes.get(id)||null}};
vm.createContext(context);vm.runInContext(fs.readFileSync('lighter-crypto-tab.js','utf8'),context);
const engine=context.window.lighterCryptoEngine;
engine.currentParadigm='macd_reversal';
engine.bars=Array.from({length:120},(_,i)=>({time: i*300,value:100+Math.sin(i/7)*5+i*.03}));
const plotted={};engine.assetSeries=Object.fromEntries(['macd','signal','histogram'].map(name=>[name,{setData(data){plotted[name]=data;}}]));
engine.updateRulesMatchStatus=()=>{};
engine.updateMaAndDiffs(engine.bars);
function assertPlot(f,s,g) {
  assert.equal(legend.textContent,`MACD (${f}, ${s}, ${g}):`);
  const expected=TerminalCommon.macd(engine.bars,f,s,g);
  for(const key of ['macd','signal','histogram']) assert.deepEqual(JSON.parse(JSON.stringify(plotted[key])),expected[key]);
  const replay=engine.replaySettings(), live=engine.liveStrategyPayload();
  for(const settings of [replay,live]) assert.deepEqual(
    [settings.macd_fast_period,settings.macd_slow_period,settings.macd_signal_period],[f,s,g]);
}
assertPlot(8,21,5);
let replayCount=0;engine.runBacktest=()=>{replayCount++;};
engine.bindParadigmDetailEvents('macd_reversal');
fast.value='10';fast.fire('input');assertPlot(10,21,5);
signal.value='4';signal.fire('input');assertPlot(10,21,4);
signal.fire('change');assert.equal(replayCount,1);
// Saved settings must drive the chart before inputs mount and in other regimes.
for(const node of periods) nodes.delete(node.id);
engine.botState={macd_fast_period:6,macd_slow_period:18,macd_signal_period:3};
engine.currentParadigm='grid';engine.updateMaAndDiffs(engine.bars);
assert.equal(legend.textContent,'MACD (6, 18, 3):');
assert.deepEqual(JSON.parse(JSON.stringify(plotted.histogram)),TerminalCommon.macd(engine.bars,6,18,3).histogram);
console.log('MACD chart, immediate input updates, replay/live settings and saved-period fallback match');
