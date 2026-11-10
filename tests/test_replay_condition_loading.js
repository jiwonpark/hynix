const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

(async()=>{
  for(const [file,name] of [['crypto-tab.js','cryptoEngine'],['lighter-crypto-tab.js','lighterCryptoEngine']]){
    const pending=[], controllers=[], fetchSignals=[];
    const context={window:{},document:{readyState:'loading',addEventListener(){},getElementById(){return null;}},
      console,URLSearchParams,AbortController:class extends AbortController { constructor(){super();controllers.push(this);} },setTimeout,clearTimeout,
      fetch:(_,options)=>{fetchSignals.push(options.signal);return new Promise(resolve=>pending.push(resolve));}};
    vm.createContext(context);
    vm.runInContext(fs.readFileSync('terminal-common.js','utf8'),context);
    context.TerminalCommon=context.window.TerminalCommon;
    vm.runInContext(fs.readFileSync(file,'utf8'),context);
    const engine=context.window[name], common=context.window.TerminalCommon;
    let threshold=1;
    engine.currentParadigm='grid';engine.interval='5m';engine.bars=[];
    engine.replaySettings=()=>({strategy_mode:'grid',interval:'5m',entry_z:threshold});
    for(const method of ['renderMarkers','renderCurrentPositionReferenceLines','setEntryTrendLoading','updateMaAndDiffs','updateRulesMatchStatus','renderTradeMarkerTargets','renderTradeTriangles'])engine[method]=()=>{};
    engine.applyEntryTrend=trend=>{engine.entryTrendResult=trend;};
    const data={success:true,entry_trend:{ranges:[]},trades:[],open_positions:[],entry_signals:[],
      latest_conditions:{entry_z:false},latest_condition_time:100,
      summary:{trades:0,win_rate:0,net_pct:0},metrics:{}};
    const response=()=>({ok:true,headers:{get:()=> 'application/json'},json:async()=>data});
    // An old background must never make an unresolved current replay ready.
    engine.entryTrendResult={ranges:[]};
    assert.equal(common.replayProgressPart(engine).ready,false);
    const first=engine.runBacktest();
    assert.equal(engine.replayLoading,true);
    assert.equal(fetchSignals[0],controllers[0].signal,"replay deadline controls the actual network request");
    assert.equal(common.replayProgressPart(engine).ready,false);
    threshold=2; // Simulate settings synchronized while the first request runs.
    pending.shift()(response());
    await first;
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(pending.length,1,'a discarded response starts a replacement request');
    assert.equal(common.replayProgressPart(engine).ready,false);
    pending.shift()(response());
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(engine.replayLoading,false);
    assert.ok(engine.latestReplayConditionResult, engine.replayError);
    assert.equal(common.replayProgressPart(engine).ready,true);
    // Losing an evaluation must not be masked by the previous completed key.
    engine.latestReplayConditionResult=null;
    const retry=engine.runBacktestIfChanged();
    assert.equal(pending.length,1,'missing conditions can rerun the same completed key');
    pending.shift()(response());await retry;
    assert.equal(common.replayProgressPart(engine).ready,true);
    // A failed current request settles as an error, rather than perpetual loading.
    const fail=engine.runBacktest();
    pending.shift()({ok:false,headers:{get:()=> 'application/json'},json:async()=>({error:'unavailable'})});
    await fail;
    assert.equal(engine.replayLoading,false);
    assert.equal(common.replayProgressPart(engine).ready,false);
    assert.equal(common.replayProgressPart(engine).error,true);
    assert.match(engine.replayError,/unavailable/);
    let signal;
    await assert.rejects(common.fetchReplay((_,options)=>{signal=options.signal;return new Promise(()=>{});},'/test',5),/timed out/);
    assert.equal(signal.aborted,true,'timeout aborts the underlying request');
    console.log(file+': readiness, stale-response recovery, same-key retry, errors and timeout passed');
  }
  const index=fs.readFileSync('index.html','utf8');
  const commonSource=fs.readFileSync('terminal-common.js','utf8');
  assert.match(commonSource,/fetchReplay\(api, path, timeoutMs = 90000\)/,
    'shared replay requests allow serialized calculations to finish before timing out');
  assert.match(index,/replayProgressPart\(window.cryptoEngine\)/);
  assert.match(index,/replayProgressPart\(window.lighterCryptoEngine\)/);
  assert.doesNotMatch(index,/progressPart\("Signals \+ background", window\.(?:cryptoEngine|lighterCryptoEngine)\?\.entryTrendResult\)/);
})().catch(error=>{console.error(error);process.exitCode=1;});
