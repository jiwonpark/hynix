const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname,'../index.html'),'utf8');
const methods = html.slice(html.indexOf('      scheduleDynamicBacktest(force = false)'), html.indexOf('      renderShortTermChart(data)'));
const elements = {inputDynamicBacktestEquity: {value: '500'}, dynamicBacktestStatus: {textContent: ''}};
const context = vm.createContext({AbortController, JSON, Number, Math, Object, Set,
  Date: {now: () => 1704070800000}, window: {location:{origin:'https://test'}},
  $: id => elements[id], setTimeout: () => 1, clearTimeout: () => {}});
const engine = vm.runInContext(`({state: {conditionToggles: {}}, ${methods}})`, context);
engine.redrawDynamicBacktest = () => {};
engine.shortTermHistory = {interval: '5m', bars: [{time:1704067200},{time:1704070500}], markers: []};
engine.scheduleDynamicBacktest();
const firstKey = engine.dynamicBacktestKey;
engine.state.conditionToggles.entry_ma_stretch = false;
engine.scheduleDynamicBacktest();
assert.notEqual(engine.dynamicBacktestKey, firstKey);
assert.equal(JSON.parse(engine.dynamicBacktestKey).toggles.entry_ma_stretch, false);
const newKey=engine.dynamicBacktestKey;
engine.dynamicBacktestMarkers = [{time: 1}];
engine.scheduleDynamicBacktest();
assert.equal(engine.dynamicBacktestMarkers.length, 1, 'unchanged polling must retain result');
engine.shortTermHistory.bars.unshift({time:1704066900});
engine.scheduleDynamicBacktest();
assert.notEqual(engine.dynamicBacktestKey,newKey, 'older history reruns the entire simulation');
assert.equal(engine.dynamicBacktestMarkers.length,0,'old results clear while new replay runs');

(async () => {
  let resolveOld;
  context.fetch = async () => new Promise(resolve => {resolveOld = resolve;});
  const history=engine.shortTermHistory;
  const key=engine.dynamicBacktestKey;
  const pending=engine.runDynamicBacktest(JSON.parse(key),key,history);
  engine.scheduleDynamicBacktest(true); // Same settings, new run: old result must be rejected.
  resolveOld({ok:true, json: async () => ({success:true,markers:[{time:1704067200}],summary:{}})});
  await pending;
  assert.equal(engine.dynamicBacktestMarkers.length,0);
  context.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).initial_equity,500);
    return {ok:true,json:async()=>({success:true,markers:[{time:1704067200,backtest:true}],summary:{
      entries:2,exits:1,open_tranches:1,net_pnl_usd:.2,return_pct:.04,max_drawdown_pct:.01,
      evaluated_bars:13,expected_bars:13}})};
  };
  await engine.runDynamicBacktest(JSON.parse(key),key,history);
  assert.equal(engine.dynamicBacktestMarkers.length,1);
  assert.match(elements.dynamicBacktestStatus.textContent,/2 entries · 1 exits/);
  console.log('Dynamic backtest UI checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
