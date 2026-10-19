const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const scheduled = [];
const context = {window: {}, document: {readyState:'loading', addEventListener(){}, getElementById(){return null;}},
  AbortSignal, URLSearchParams, console, clearTimeout(){}, setTimeout(fn, ms){scheduled.push({fn, ms});return scheduled.length;}};
vm.createContext(context);
vm.runInContext(fs.readFileSync('lighter-crypto-tab.js','utf8'),context);
const engine = context.window.lighterCryptoEngine;
(async () => {
  let release, calls=0;
  engine.loadChart = () => {calls++;return new Promise(resolve=>release=resolve);};
  const first=engine.refreshChart();
  const second=engine.refreshChart();
  assert.equal(calls,1,'overlapping activations must share candle request');
  release(); await Promise.all([first,second]);
  assert.equal(engine.chartLoad,null);

  // Exercise the real loader failure path with a working chart shell.
  vm.runInContext(fs.readFileSync('lighter-crypto-tab.js','utf8'),context);
  const failing=context.window.lighterCryptoEngine;
  failing.ensureChart=()=>{}; failing.resize=()=>{};
  failing.chart={}; failing.series={};
  const statuses=[];
  failing.executionChartFrame={setSync: value=>statuses.push(value)};
  context.fetch=async () => {throw Error('upstream unavailable');};
  await failing.refreshChart();
  assert.equal(statuses.length,2);
  assert.match(statuses[1],/Chart unavailable.*Retrying/);
  assert.equal(scheduled.at(-1).ms,5000,'failed initial load must retry');
  assert.equal(failing.chartLoad,null,'failed request must not block subsequent attempts');
  // GET reads work without the newer AbortSignal.timeout browser API.
  let synced=false;
  failing.updateBotStatus=()=>{synced=true;};
  context.fetch=async()=>({ok:true,json:async()=>({bot:{enabled:false}})});
  await failing.syncBotStatus();
  assert(synced, 'older browsers must still fetch chart/account APIs');

  // Account timeouts must recover, never fabricate a current Last Sync time.
  failing.refreshChart=async()=>{};
  failing.renderVirtualState=()=>{};
  failing.updateGridLadderData=()=>{};
  failing.scheduleTrendRetry=()=>{};
  failing.virtualPnlText=()=>'';
  const labels=new Map(); failing.setText=(id,text)=>labels.set(id,text);
  context.fetch=async url=>({ok:true,json:async()=>url.includes('/status?')
    ? {success:false,error:'Temporary account outage'} : {}});
  await failing.refresh();
  assert.match(labels.get('lblDaemonSyncTime'), /Temporary account outage.*retrying/);
  assert.equal(scheduled.at(-1).ms,5000);
  assert.equal(failing.liveVenue.success,false);
  console.log('Tab 5 chart loading, browser compatibility and account retry passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
