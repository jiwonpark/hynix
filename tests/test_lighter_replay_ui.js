const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const elements = new Map();
const conditions = {EntryMaStretch:true, EntryBase:false, EntryPeak:false, EntryMaStack5m:false,
  ExitConvergence:true, ExitDwell:false, ExitBottoming:false};
for (const [suffix, checked] of Object.entries(conditions)) elements.set(`lighter_chkCond${suffix}`, {checked});
const pillEvents = {};
elements.set('lighterMatchPill', {
  style:{}, dataset:{}, setAttribute(){},
  addEventListener(type, handler){pillEvents[type]=handler;},
});
elements.set('lighter_dynamicBacktestStatus', {});
elements.set('lighter_btnRerunDynamicBacktest', {});
elements.set('lighter_inpOuEntryZ', {value:'1.8'});
elements.set('lighter_inpOuExitZ', {value:'0.2'});
let response, requestUrl;
const ctx = {window:{}, document:{getElementById:id=>elements.get(id),readyState:'loading',addEventListener(){}},
  URLSearchParams, console, fetch:async url=>{requestUrl=url; return {ok:true,json:async()=>response};}};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../lighter-tab.js'),'utf8'),ctx);
const engine = ctx.window.lighterEngine;
engine.currentParadigm='ou_quant'; engine.interval='5m';
const ouHtml=engine.renderParadigmDetail('ou_quant');
for (const id of ['lighter_ouUseEntryZ','lighter_ouHalflifeMax','lighter_ouMinDeviation',
  'lighter_ouMacroSpan','lighter_ouMacroSlopeBars','lighter_ouStopZ','lighter_ouUseExitZ']) {
  assert.match(ouHtml,new RegExp(`id="${id}"`));
}
assert.doesNotMatch(ouHtml,/ADF Stationarity|Cointegration Drift Persistence/);
const pill = elements.get('lighterMatchPill');
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/Live settings unavailable/);
assert.equal(typeof pillEvents.click,'function');
engine.botState={enabled:true,strategy_mode:'ou_quant',strategy_interval:'5m',
  strategy_params:{entry_z:3.5,exit_z:0.8,ou_halflife_max:8,ou_stop_z:3.5,
    ou_min_abs_deviation_pp:.25,ou_macro_ema_span:60,ou_macro_slope_bars:12,
    ou_use_entry_z:true,ou_use_halflife:true,ou_use_min_abs_deviation:true,
    ou_use_macro_trend:true,ou_use_stop_zone:true,ou_use_exit_z:true}};
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/PAPER DIVERGENT/);
assert.match(pill.textContent,/entry_z: 1.8 ≠ 3.5/);
let alignCalls=0;
const alignReplayToLive=engine.alignReplayToLive;
engine.alignReplayToLive=()=>{alignCalls++;};
pillEvents.click();
assert.equal(alignCalls,1,'the first divergent click must align the replay');
engine.alignReplayToLive=alignReplayToLive;
engine.botState.strategy_params.entry_z=1.8; engine.botState.strategy_params.exit_z=.2;
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);
const liveOuParams = {...engine.botState.strategy_params, entry_z:2.1, exit_z:.35};
// OU ignores these checkboxes; turning one on cannot change match status.
elements.get('lighter_chkCondEntryPeak').checked=true;
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);
assert.equal(elements.get('lighter_chkCondEntryPeak').disabled,true);
elements.set('lighter_ouUseMinDeviation', {checked:false});
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/ou_use_min_abs_deviation: false ≠ true/);
assert.equal(engine.liveStrategyPayload('ou_quant').ou_use_min_abs_deviation,false);
elements.get('lighter_ouUseMinDeviation').checked=true;
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);
engine.currentParadigm='grid'; engine.botState.strategy_mode='grid';
engine.botState.strategy_params={entry_z:1.5,exit_z:.25};
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/Peak rollover ON \(live OFF\)/);
elements.get('lighter_chkCondEntryPeak').checked=false;
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);
assert.equal(elements.get('lighter_chkCondEntryPeak').disabled,false);
engine.currentParadigm='ma_stack'; engine.botState.strategy_mode='ma_stack';
engine.botState.strategy_params={ma_stretch_min:.3,ma_trailing_stop:.15};
engine.updateRulesMatchStatus();
assert.match(pill.textContent,/Replay signal\/exit rules differ from live/);
assert.match(pill.textContent,/Live match unavailable/);
assert.equal(pill.dataset.matchState,'unavailable');

// A single click after choosing another replay strategy restores the live OU
// strategy and thresholds without deploying anything to the bot.
engine.botState.strategy_mode='ou_quant';
engine.botState.strategy_params=liveOuParams;
engine.setParadigm=(mode)=>{engine.currentParadigm=mode;};
engine.refreshChart=()=>{};
const runBacktest=engine.runBacktest;
let replayCalls=0;
engine.runBacktest=()=>{replayCalls++;};
engine.updateRulesMatchStatus();
pillEvents.click();
assert.equal(engine.currentParadigm,'ou_quant');
assert.equal(elements.get('lighter_inpOuEntryZ').value,'2.10');
assert.equal(elements.get('lighter_inpOuExitZ').value,'0.35');
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);
assert.equal(replayCalls,1,'matching live must rerun the paper replay with restored thresholds');

engine.currentParadigm='ma_stack';
engine.botState.strategy_mode='grid';
engine.botState.strategy_params={entry_z:2,exit_z:.4};
elements.get('lighter_chkCondEntryPeak').checked=true;
engine.updateRulesMatchStatus();
pillEvents.click();
assert.equal(engine.currentParadigm,'grid');
assert.equal(engine.replaySettings().entry_z,2);
assert.equal(engine.replaySettings().exit_z,.4);
assert.equal(elements.get('lighter_chkCondEntryPeak').checked,false);
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);

elements.set('lighter_inpCustomEntryZ',{value:'1.5'});
elements.set('lighter_inpCustomExitZ',{value:'0.25'});
engine.currentParadigm='ma_stack';
engine.botState.strategy_mode='custom';
engine.botState.strategy_params={entry_z:2.2,exit_z:.3};
engine.updateRulesMatchStatus();
pillEvents.click();
assert.equal(engine.currentParadigm,'custom');
assert.equal(elements.get('lighter_inpCustomEntryZ').value,'2.2');
assert.equal(elements.get('lighter_inpCustomExitZ').value,'0.3');
assert.match(pill.textContent,/LIVE-MATCHED SIGNALS/);
assert.equal(replayCalls,3);
engine.runBacktest=runBacktest;

async function main() {
  engine.currentParadigm='ou_quant';
  engine.renderMarkers=()=>{}; engine.renderCurrentPositionReferenceLines=()=>{};
  elements.get('lighter_inpOuExitZ').value='0';
  response={trades:[{entry_time:100,entry:140,exit_time:200,exit:141,side:1,pnl_pct:.7143}],
    open_positions:[{entry_time:300,entry:142,side:-1,unrealized_pnl_pct:.2}],
    summary:{trades:1,win_rate:100,net_pct:.7143,unrealized_pct:.2},metrics:{signal_engine:'shared_live_ou'}};
  await engine.runBacktest();
  assert.equal(new URL(requestUrl,'https://example.test').searchParams.get('exit_z'),'0');
  assert.equal(engine.backtestMarkers.length,3);
  const open = engine.backtestMarkers.find(m=>m.is_open);
  assert.equal(open.time,300); assert.equal(open.is_entry,true); assert.equal(open.direction,'short');
  assert.equal(open.exit_price,undefined); assert.equal(open.pnl_pct,undefined);
  assert.equal(open.unrealized_pnl_pct,.2); assert.match(open.hoverText,/OPEN · unrealized/);
  assert.match(elements.get('lighter_dynamicBacktestStatus').innerHTML,/1<\/strong> open/);
  assert.match(elements.get('lighter_dynamicBacktestStatus').innerHTML,/unrealized return sum/);
  assert.equal(elements.get('lighter_btnRerunDynamicBacktest').disabled,false);
  console.log('Lighter replay settings, matching and open-entry UI checks passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
