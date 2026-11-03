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
 engine.interval='5m';engine.botState={strategy_mode:'macd_zero_cross',strategy_params:{}};
 for(const method of ['renderMarkers','renderCurrentPositionReferenceLines','renderTradeMarkerTargets','clearEntryTrend','runBacktest','updateRulesMatchStatus','updateDeployButtonState','applyExecutionLock'])engine[method]=()=>{};
 const stackDwell=common.inheritedStrategyConditions('ma_stack','crypto_').find(rule=>rule.condition==='exit_max_dwell');
 assert.equal(common.inheritedConditionValue(stackDwell,{min_dwell_bars:3},'ma_stack'),'16 completed bars','MA Stack must not inherit a stale three-bar Grid caption');
 const crossDwell=common.inheritedStrategyConditions('golden_death_cross',prefix).find(rule=>rule.condition==='exit_dwell');
 assert.equal(common.inheritedConditionValue(crossDwell,{min_dwell_bars:7},'golden_death_cross'),'Minimum 7 completed bars');
 const expected={grid:8,custom:8,adaptive_tranche:8,ma_acceleration:5,golden_death_cross:6,ma_stack:prefix==='crypto_'?6:0,macd_zero_cross:0,ou_quant:0,macd_reversal:1,macd_strength_scaleout:1,multi_factor:1,trend_pullback:1};
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
