const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, name) {
  const elements = new Map();
  const document = {readyState:'loading', addEventListener(){}, getElementById:id=>elements.get(id),
    createElement(){return {children:[],append(...items){this.children.push(...items)}};}};
  const context = {window:{}, document, URLSearchParams, console};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return {engine:context.window[name], elements};
}

const ouChecks = {entry_z:true, entry_halflife:false, entry_min_deviation:true,
  entry_macro_trend:false, entry_stop_zone:true, exit_z:false, exit_emergency_stop:false};
const evaluation = {time:1791500000, z:-1.8, half_life_bars:40,
  abs_deviation_pp:.32, macro_ema_slope:-.01, condition_pass:ouChecks};
const settings = {entry_z:1.5, exit_z:.2, ou_halflife_max:8, ou_stop_z:3.5,
  ou_min_abs_deviation_pp:.25, ou_use_entry_z:true, ou_use_halflife:true,
  ou_use_min_abs_deviation:true, ou_use_macro_trend:false,
  ou_use_stop_zone:true, ou_use_exit_z:true};
for (const [file, name, prefix] of [
  ['lighter-tab.js','lighterEngine','lighter_'],
  ['lighter-crypto-tab.js','lighterCryptoEngine','lighterCrypto_'],
]) {
  const {engine, elements} = load(file,name);
  engine.currentParadigm = 'ou_quant';
  for (const suffix of ['EntryZ','Halflife','MinDeviation','MacroTrend','StopZone','ExitZ','EmergencyStop'])
    elements.set(`${prefix}ouStatus${suffix}`, {});
  if (file === 'lighter-tab.js') {
    for (const suffix of ['EntryZ','Halflife','MinDeviation','MacroTrend','StopZone','ExitZ','EmergencyStop'])
      elements.set(`lighter_ouLiveStatus${suffix}`, {});
    engine.botState={enabled:true,strategy_mode:'ou_quant',strategy_interval:'5m',
      strategy_params:{},tranches:[{}],last_evaluation:{...evaluation,time:Math.floor(Date.now()/1000)-300,strategy:'ou_quant'}};
  }
  elements.set(`${prefix}ouStatusSource`, {});
  const render = file === 'lighter-tab.js'
    ? (value, config)=>engine.renderOuConditionStatus(value, config)
    : (value, config)=>engine.renderReplayConditionStatus({latest_evaluation:value}, config);
  render(evaluation,settings);
  assert.equal(elements.get(`${prefix}ouStatusEntryZ`).textContent,'PASS');
  assert.equal(elements.get(`${prefix}ouStatusHalflife`).textContent,'WAITING');
  assert.equal(elements.get(`${prefix}ouStatusMacroTrend`).textContent,'OFF');
  assert.equal(elements.get(`${prefix}ouStatusExitZ`).textContent,'WAITING');
  assert.match(elements.get(`${prefix}ouStatusSource`).textContent,/PAPER.*Completed candle/);
  if (file === 'lighter-tab.js') {
    assert.equal(elements.get('lighter_ouLiveStatusEntryZ').textContent,'LIVE PASS');
    assert.equal(elements.get('lighter_ouLiveStatusHalflife').textContent,'LIVE WAITING');
    engine.botState.enabled=false;
    engine.renderLiveOuConditionStatus();
    assert.equal(elements.get('lighter_ouLiveStatusEntryZ').textContent,'LIVE UNAVAILABLE');
  }
  render(null,settings);
  assert.equal(elements.get(`${prefix}ouStatusEntryZ`).textContent,'UNAVAILABLE');
}

const {engine, elements} = load('lighter-crypto-tab.js','lighterCryptoEngine');
const livePanel={children:[],replaceChildren(...items){this.children=items},append(...items){this.children.push(...items)}};
elements.set('lighterCryptoLiveConditions',livePanel);
engine.renderLiveConditionStatus({enabled:true,strategy_mode:'ou_quant',strategy_interval:'5m',
  ou_use_macro_trend:false,tranches:[{}],
  last_evaluation:{...evaluation,time:Math.floor(Date.now()/1000)-300,strategy:'ou_quant'}});
assert.equal(livePanel.children[1].children[1].textContent,'PASS');
assert.equal(livePanel.children[2].children[1].textContent,'WAITING');
assert.equal(livePanel.children[4].children[1].textContent,'OFF');
engine.renderLiveConditionStatus({enabled:false,strategy_mode:'ou_quant',strategy_interval:'5m',
  last_evaluation:{...evaluation,time:Math.floor(Date.now()/1000)-300,strategy:'ou_quant'}});
assert.equal(livePanel.children[1].children[1].textContent,'UNAVAILABLE');
engine.currentParadigm='grid';
engine.interval='5m';
elements.set('lighterCryptoMatchPill',{style:{},dataset:{},addEventListener(){},setAttribute(){}});
elements.set('lighterCrypto_btnMatchLiveReplay',{});
for (const [suffix,checked] of Object.entries({EntryMaStretch:true,EntryBase:true,EntryPeak:true,
  EntryMaStack5m:true,ExitConvergence:true,ExitDwell:true,ExitBottoming:true})) {
  elements.set(`lighterCrypto_chkCond${suffix}`,{checked,dataset:{}});
  elements.set(`lighterCrypto_badgeCond${suffix}`,{});
}
const gridSettings=engine.replaySettings();
engine.latestReplayConditionResult={latest_condition_time:1791500000,
  latest_conditions:{entry_z:true,entry_spacing:false,entry_rollover:true,
    entry_ma_stack:false,exit_convergence:true,exit_dwell:false,exit_bottoming:null}};
engine.replayConditionSignature=new URLSearchParams(gridSettings).toString();
engine.updateRulesMatchStatus();
assert.equal(elements.get('lighterCrypto_badgeCondEntryMaStretch').textContent,'PASS');
assert.equal(elements.get('lighterCrypto_badgeCondEntryBase').textContent,'WAITING');
assert.equal(elements.get('lighterCrypto_badgeCondExitBottoming').textContent,'N/A');
elements.get('lighterCrypto_chkCondEntryBase').checked=false;
engine.updateRulesMatchStatus();
assert.equal(elements.get('lighterCrypto_badgeCondEntryBase').textContent,'OFF');
assert.equal(elements.get('lighterCrypto_badgeCondEntryMaStretch').textContent,'N/A',
  'changing settings clears all verdicts from the prior replay');
console.log('Lighter per-condition PASS, WAITING, OFF, and stale-result checks passed');
