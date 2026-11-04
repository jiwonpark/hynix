// Run with linkedom on NODE_PATH. Exercise the real strategy switch lifecycle.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {parseHTML}=require('linkedom');
(async()=>{
for(const [file,name,prefix,rootId] of [
 ['crypto-tab.js','cryptoEngine','crypto_','tabContentCrypto'],
 ['lighter-crypto-tab.js','lighterCryptoEngine','lighterCrypto_','tabContentLighterCrypto'],
]){
 const {window,document}=parseHTML(`<html><body><main id="${rootId}"><div class="shortTermCriteriaGrid"></div><div id="${prefix}gridMatrixSection"></div><div id="${prefix}paradigmDetailSection"></div></main></body></html>`);
 Object.defineProperty(document,"readyState",{value:"loading"});
 document.addEventListener=()=>{};
 const context={window,document,console,URLSearchParams,setTimeout,clearTimeout,localStorage:{getItem:()=>null,setItem(){}}};
 vm.createContext(context);vm.runInContext(fs.readFileSync('terminal-common.js','utf8'),context);
 context.TerminalCommon=window.TerminalCommon;
 vm.runInContext(fs.readFileSync(file,'utf8'),context);
 const engine=window[name],common=window.TerminalCommon;
 const entry=['EntryMaStretch','EntryBase','EntryPeak','EntryMaStack5m','EntryMaStack1h','EntryCapacity','EntryLeverage','EntryMargin','EntryEngine','EntryGuard'];
 const exit=['ExitConvergence','ExitDwell','ExitBottoming','ExitNetPnl','ExitActive','ExitMaStack5m','ExitMaStack1h','ExitPosition'];
 const card=(title,rows)=>`<div><div><span id="${prefix}${title}"></span></div>${rows.map(suffix=>`<div id="${prefix}rowCond${suffix}"><input type="checkbox" id="${prefix}chkCond${suffix}"><span class="condLabel"></span><span id="${prefix}valCond${suffix}" class="condValue"></span><span id="${prefix}badgeCond${suffix}" class="condBadge"></span></div>`).join('')}</div>`;
 document.querySelector('.shortTermCriteriaGrid').innerHTML=card('lblCritScaleInTitle',entry)+card('lblCritTPTitle',exit);
 engine.interval='5m';engine.botState={strategy_mode:'macd_zero_cross',macd_fast_period:20,macd_slow_period:60,macd_signal_period:9,use_macd_signal_zone:true,strategy_params:{}};
 for(const method of ['renderMarkers','renderCurrentPositionReferenceLines','renderTradeMarkerTargets','clearEntryTrend','runBacktest','updateRulesMatchStatus','updateDeployButtonState','applyExecutionLock'])engine[method]=()=>{};
 let replayCalls=0;engine.runBacktest=()=>{replayCalls++;};
 const stackDwell=common.inheritedStrategyConditions('ma_stack','crypto_').find(rule=>rule.condition==='exit_max_dwell');
 assert.equal(common.inheritedConditionValue(stackDwell,{min_dwell_bars:3},'ma_stack'),'16 completed bars','MA Stack must not inherit a stale three-bar Grid caption');
 const crossDwell=common.inheritedStrategyConditions('golden_death_cross',prefix).find(rule=>rule.condition==='exit_dwell');
 assert.equal(common.inheritedConditionValue(crossDwell,{min_dwell_bars:7},'golden_death_cross'),'Minimum 7 completed bars');
 const livePanel=document.createElement('div');livePanel.id=prefix.replace(/_$/,'')+'LiveConditions';document.getElementById(rootId).append(livePanel);
 const expected={grid:8,custom:8,adaptive_tranche:8,ma_acceleration:5,ma_proximity:3,golden_death_cross:6,ma_stack:prefix==='crypto_'?6:0,macd_zero_cross:0,macd_hist_turn:0,ou_quant:0,macd_reversal:1,macd_strength_scaleout:1,multi_factor:1,trend_pullback:1};
 for(const mode of [...Object.keys(engine.paradigms),'macd_zero_cross','ma_acceleration','golden_death_cross','grid']){
  await engine.setParadigm(mode);
  const rules=common.inheritedStrategyConditions(mode,prefix);
  assert.equal(rules.length,expected[mode],mode+' complete supported switch inventory');
  const selected=[...document.querySelectorAll('[data-terminal-rule-selected="true"]')];
  assert.equal(selected.length,rules.length,mode+' actual selection matches inventory');
  for(const rule of rules){
   const row=document.getElementById(prefix+'rowCond'+rule.suffix);
   const group=document.getElementById(prefix+(rule.suffix.startsWith('Exit')?'exit':'entry')+'ConditionGroup');
   assert.ok(group.contains(row),mode+' '+rule.suffix+' grouped correctly');
   assert.equal(row.dataset.terminalRuleSelected,'true');
   assert.equal(row.querySelector('.condLabel').textContent,rule.label);
   const toggle=document.getElementById(prefix+'chkCond'+rule.suffix);
   toggle.checked=false;
   assert.equal(engine.replaySettings()[rule.toggle],false,mode+' OFF changes replay '+rule.toggle);
   assert.equal(engine.liveStrategyPayload(mode)[rule.toggle],false,mode+' OFF changes deploy payload '+rule.toggle);
   toggle.checked=true;
   assert.equal(engine.replaySettings()[rule.toggle],true,mode+' ON changes replay '+rule.toggle);
   assert.equal(engine.liveStrategyPayload(mode)[rule.toggle],true,mode+' ON changes deploy payload '+rule.toggle);
  }
  if(mode==='ma_proximity'){
   const period=document.getElementById(prefix+'inpMaAccelPeriod');
   const distance=document.getElementById(prefix+'inpMaMaxDistance');
   const nearRow=document.getElementById(prefix+'rowCondEntryPeak');
   assert.ok(nearRow.nextElementSibling?.contains(period), 'SMA period follows the proximity rule');
   assert.equal(period.type,'number');
   period.value='37';
   distance.value='0.27';
   document.getElementById(prefix+'inpMaDirectionPeriod').value='73';
   for(const settings of [engine.replaySettings(),engine.liveStrategyPayload(mode)]){
    assert.equal(settings.ma_accel_period,37);
    assert.equal(settings.ma_direction_period,73);
    assert.equal(settings.ma_max_distance_pct,0.27);
   }

   const slope=document.getElementById(prefix+'chkCondEntryMaStretch');
   const proximity=document.getElementById(prefix+'chkCondEntryPeak');
   common.syncInheritedConditionControls(prefix,mode,{strategy_params:{use_ma_stretch:true,use_ma_slope:false,use_ma_pullback:false}});
   assert.equal(slope.checked,false,'polling uses MA slope rather than legacy MA stretch');
   assert.equal(proximity.checked,false);
   proximity.checked=true;
   proximity.dataset.unsaved='true';
   common.syncInheritedConditionControls(prefix,mode,{strategy_params:{use_ma_pullback:false}});
   assert.equal(proximity.checked,true,'polling preserves the edited paper switch');
   delete proximity.dataset.unsaved;
   slope.checked=true;
  }
  if(mode==='macd_hist_turn'){
   assert.equal(document.getElementById(prefix+'macdFastPeriod').value,'20','new mode inherits current MACD periods');
   assert.equal(document.getElementById(prefix+'macdSlowPeriod').value,'60');
   assert.equal(document.getElementById(prefix+'macdSignalPeriod').value,'9');
   const turn=document.getElementById(prefix+'macdTurnUseTurn'),zone=document.getElementById(prefix+'macdTurnUseZone'),signal=document.getElementById(prefix+'macdZeroUseSignalZone');
   assert.ok(turn.hasAttribute('checked'));assert.ok(zone.hasAttribute('checked'));assert.ok(!signal.hasAttribute('checked'),'a different strategy does not import its saved signal-zone restriction');
   for(const [node,key] of [[turn,'use_macd_hist_turn'],[zone,'use_macd_hist_zone']]){
    assert.ok(document.getElementById(prefix+'entryConditionGroup').contains(node));
    node.checked=false;
    assert.equal(engine.replaySettings()[key],false);assert.equal(engine.liveStrategyPayload(mode)[key],false);
    node.checked=true;
    assert.equal(engine.replaySettings()[key],true);assert.equal(engine.liveStrategyPayload(mode)[key],true);
   }
   for(const [suffix,key] of [['macdZeroUseExitCross','use_macd_hist_exit'],['macdTurnUseExitZone','use_macd_hist_exit_zone']]){
    const node=document.getElementById(prefix+suffix);
    assert.ok(document.getElementById(prefix+'exitConditionGroup').contains(node));
    node.checked=false;assert.equal(engine.replaySettings()[key],false);assert.equal(engine.liveStrategyPayload(mode)[key],false);
    node.checked=true;assert.equal(engine.replaySettings()[key],true);assert.equal(engine.liveStrategyPayload(mode)[key],true);
    const before=replayCalls;node.dispatchEvent(new window.Event('change'));assert.equal(replayCalls,before+1);
   }
   const beforeChange=replayCalls;zone.dispatchEvent(new window.Event('change'));assert.equal(replayCalls,beforeChange+1,'one toggle schedules exactly one replay');
   const pass={entry_histogram_delta_turn:true,entry_histogram_zone:true,entry_signal_zone:false,exit_histogram_delta_turn:true,exit_histogram_zone:false};
   const enabled={entry_histogram_delta_turn:true,entry_histogram_zone:true,entry_signal_zone:false,exit_histogram_delta_turn:true,exit_histogram_zone:true};
   const evaluation={strategy:mode,time:Date.now()/1000,candidate_side:1,histogram:-.8,previous_histogram_delta:-.5,histogram_delta:.2,condition_pass:pass,condition_enabled:enabled};
   engine.renderReplayConditionStatus({latest_conditions:pass,latest_evaluation:evaluation,latest_condition_time:evaluation.time},engine.replaySettings());
   assert.equal(document.getElementById(prefix+'macdStatusDeltaTurn').textContent,'PASS');
   assert.equal(document.getElementById(prefix+'macdStatusHistogramZone').textContent,'PASS');
   assert.equal(document.getElementById(prefix+'macdStatusSignalZone').textContent,'OFF');
   assert.equal(document.getElementById(prefix+'macdStatusExitCross').textContent,'PASS');
   assert.equal(document.getElementById(prefix+'macdStatusExitZone').textContent,'WAITING');
   assert.match(document.getElementById(prefix+'macdStatusSource').textContent,/ΔH -0.500000 → 0.200000/);
   assert.match(document.getElementById(prefix+'macdStatusSource').textContent,/KST/);
   engine.renderLiveConditionStatus({enabled:true,strategy_mode:mode,strategy_interval:'5m',tranches:[{qty:1,side:1}],last_evaluation:evaluation});
   assert.match(document.getElementById(prefix+'liveRule_entry_histogram_delta_turn').textContent,/LIVE · PASS/);
   assert.match(document.getElementById(prefix+'liveRule_entry_histogram_zone').textContent,/LIVE · PASS/);
   assert.match(document.getElementById(prefix+'liveRule_exit_histogram_delta_turn').textContent,/LIVE · PASS/);
   assert.match(document.getElementById(prefix+'liveRule_exit_histogram_zone').textContent,/LIVE · WAITING/);
  }
  if(mode==='ma_stack' && prefix==='lighterCrypto_'){
   assert.ok(document.getElementById(prefix+'entryConditionGroup').contains(document.getElementById(prefix+'maUseStack5m')));
   assert.ok(document.getElementById(prefix+'exitConditionGroup').contains(document.getElementById(prefix+'maUseOppositeExit')));
  }
  for(const suffix of ['EntryCapacity','EntryLeverage','EntryMargin','EntryGuard','ExitNetPnl','ExitActive'])
   assert.equal(document.getElementById(prefix+'rowCond'+suffix).dataset.terminalRuleSelected,'false','execution safeguards never become fake optional strategy switches');
 }
 console.log(file+': complete switch inventory survives real strategy changes and controls replay/live payloads');
}
})().catch(error=>{console.error(error);process.exitCode=1;});
