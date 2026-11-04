// Run with linkedom available on NODE_PATH (temporary test dependency).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {parseHTML} = require('linkedom');
for (const [file, name, prefix] of [
  ['crypto-tab.js', 'cryptoEngine', 'crypto_'],
  ['lighter-crypto-tab.js', 'lighterCryptoEngine', 'lighterCrypto_'],
]) {
  const {window, document} = parseHTML('<html><body><main><div class="shortTermCriteriaGrid"></div><div id="detail"></div></main></body></html>');
  const storage = new Map();
  const context = {window, document, console, URLSearchParams, setTimeout, clearTimeout,
    localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)}};
  // Scripts normally register DOMContentLoaded; avoid mounting a real terminal.
  document.addEventListener = () => {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('terminal-common.js','utf8'),context);
  vm.runInContext(fs.readFileSync(file,'utf8'),context);
  const common=window.TerminalCommon, engine=window[name];
  assert.ok(engine, name);
  engine.botState={strategy_mode:'macd_zero_cross'};
  engine.interval='5m';
  let changes=0;
  engine.runBacktest=()=>{changes++;};
  engine.updateRulesMatchStatus=()=>{};
  const anchor=document.getElementById('detail');
  const frame=document.querySelector('.shortTermCriteriaGrid');
  frame.innerHTML=`<div><div><span id="${prefix}lblCritScaleInTitle">Entry summary</span></div></div><div><div><span id="${prefix}lblCritTPTitle">Exit summary</span></div></div>`;
  const legacyEntry=document.getElementById(prefix+'lblCritScaleInTitle').parentNode.parentNode;
  legacyEntry.insertAdjacentHTML('beforeend', `<div id="${prefix}rowCondEntryMaStack1h"><input type="checkbox" id="${prefix}testTrendSwitch"></div><div id="${prefix}rowCondEntryMaStretch"><input type="checkbox" id="${prefix}testZSwitch"></div>`);
  const trendRow=document.getElementById(prefix+'rowCondEntryMaStack1h');
  const zRow=document.getElementById(prefix+'rowCondEntryMaStretch');
  common.mountHourlyHistogram(prefix,anchor,engine);
  common.mountTakeProfitControls(prefix,anchor,engine);
  common.mountTakeProfitControls(prefix,anchor,engine,"stop_loss");
  const sl=document.getElementById(prefix+"stopLossControls");
  const hourly=document.getElementById(prefix+'hourlyHistControls');
  const tp=document.getElementById(prefix+'takeProfitControls');
  const fast=document.getElementById(prefix+'hourlyHistFast');
  fast.value='17';
  const countBefore=document.querySelectorAll('input').length;
  const livePanel=document.createElement('div');livePanel.id=prefix.replace(/_$/,'')+'LiveConditions';
  anchor.parentNode.append(livePanel);
  for (const mode of [...Object.keys(engine.paradigms), 'macd_zero_cross']) {
    common.prepareConditionGroups(prefix,anchor);
    anchor.innerHTML=mode==='grid'?'':engine.renderParadigmDetail(mode);
    const usesTrend = !['ou_quant','macd_zero_cross','macd_hist_turn','ma_proximity', ...(prefix==='lighterCrypto_'?['ma_stack']:[])].includes(mode);
    trendRow.style.display=usesTrend?'':'none';
    trendRow.dataset.terminalRuleSelected=String(usesTrend);
    zRow.dataset.terminalRuleSelected=String(['grid','custom','adaptive_tranche'].includes(mode));
    zRow.style.display=''; // Late polling can change display, but never select an irrelevant rule.
    common.groupConditionControls(prefix,anchor,mode);
    const entry=document.getElementById(prefix+'entryConditionGroup');
    const exit=document.getElementById(prefix+'exitConditionGroup');
    assert.equal(hourly.parentNode,entry,mode+' hourly in entry');
    assert.equal(document.getElementById(prefix+'lblCritScaleInTitle').parentNode.parentNode.style.display,
      ['grid','custom','adaptive_tranche'].includes(mode)?'flex':'none','legacy card matches selected strategy');
    if (!['grid','custom','adaptive_tranche'].includes(mode)) {
      assert.equal(trendRow.parentNode,usesTrend?entry:legacyEntry,'real shared trend switch remains visible');
      assert.equal(zRow.parentNode,legacyEntry,'unrelated Grid switch stays in hidden legacy card');
      zRow.style.display=''; // Simulate a late legacy refresh; parent still hides it.
      assert.equal(legacyEntry.style.display,'none');
    }
    assert.equal(tp.parentNode,exit,mode+' TP in exit');
    assert.equal(sl.parentNode,exit,mode+' SL in exit');
    assert.equal(fast.value,'17','unsaved period survives layout rebuild');
    assert.equal(document.querySelectorAll('#'+prefix+'conditionGroups').length,1);
    for(const node of document.querySelectorAll('[data-terminal-rule-group]'))
      assert.equal(node.parentNode,node.dataset.terminalRuleGroup==='entry'?entry:exit);
    if(mode==='macd_zero_cross') {
      assert.equal(document.getElementById(prefix+'macdZeroUseExitCross').closest('section'),exit);
      const badge=document.createElement('span');badge.textContent='PASS';
      assert.equal(common.groupedLiveCondition(prefix,'exit_histogram_zero_cross',badge,mode,mode),true);
      const host=document.getElementById(prefix+'liveRule_exit_histogram_zero_cross');
      assert.equal(host.parentNode,document.getElementById(prefix+'macdZeroUseExitCross').parentNode);
      common.resetGroupedLiveConditions(prefix,'source',false);
      assert.match(host.textContent,/DIFFERENT STRATEGY/);
    }
    const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);
    assert.equal(new Set(ids).size,ids.length,'no duplicate controls');
  }
  const placeholder=document.createElement('span');placeholder.className='condValue';
  placeholder.innerHTML=common.terminalLoadingMarkup;
  document.getElementById(prefix+'entryConditionGroup').append(placeholder);
  const livePlaceholder=document.createElement('span');livePlaceholder.setAttribute('data-live-condition','test');
  livePlaceholder.innerHTML='<span class="condBadge">'+common.terminalLoadingMarkup+'</span>';
  document.getElementById(prefix+'entryConditionGroup').append(livePlaceholder);
  common.settleReplayPlaceholders(prefix);
  assert.ok(livePlaceholder.querySelector('.terminalLoadingDots'),'settling PAPER must not alter live statuses');
  livePlaceholder.remove();
  assert.equal(placeholder.textContent,'Not reported','settled replay cannot leave a value spinning indefinitely');
  engine.currentParadigm='macd_zero_cross';
  const bot={enabled:true,strategy_mode:'macd_zero_cross',strategy_interval:'5m',tranches:[{}],
    last_evaluation:{strategy:'macd_zero_cross',time:Date.now()/1000,
      condition_pass:{entry_histogram_zero_cross:true,entry_signal_zone:false,exit_histogram_zero_cross:true}}};
  engine.renderLiveConditionStatus(bot);
  assert.match(document.getElementById(prefix+'liveRule_exit_histogram_zero_cross').textContent,/LIVE · PASS/);
  engine.renderLiveConditionStatus({...bot,strategy_mode:'ou_quant'});
  assert.match(document.getElementById(prefix+'liveRule_exit_histogram_zero_cross').textContent,/DIFFERENT STRATEGY/);
  fast.dispatchEvent(new window.Event('change'));
  assert.equal(changes,1,'original change handler remains attached exactly once');
  assert.ok(document.querySelectorAll('input').length>countBefore);
  console.log(file+': grouped controls survive strategy switches with draft values and listeners intact');
}
