const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map();
const ids = ['lab_tabModeMaStack', 'lab_tabModeBollinger', 'lab_tabModeRsi', 'lab_tabModeMultiFactor', 'lab_tabModeOuQuant',
  'lab_btnBindStrategy', 'lab_btnModePaper', 'lab_btnModeLive', 'lab_btnToggleBotPower', 'lab_btnEmergencyFlatten', 'lab_inpBotTrancheSize'];
for (const id of ids) {
  const classes = new Set(id === 'lab_tabModeMaStack' ? ['active'] : []);
  elements.set(id, {classList: {toggle: (name, on) => on ? classes.add(name) : classes.delete(name), contains: name => classes.has(name)}});
}
elements.set('tabContentStrategyLab', {style:{display:'block'}});
let tick, calls = [], resolveFetch;
const alerts = [];
const context = {
  document: {getElementById: id => elements.get(id)},
  window: {localStorage: {getItem: () => 'ou_quant'}, alert: message => alerts.push(message),
    terminalLockManager: {isLocked: true, openPasswordModal(){ this.prompted = true; }, setLocked(v){this.isLocked = v;}}},
  setInterval: fn => {tick = fn; return 1;}, clearInterval: () => {},
  fetch: async (...args) => {calls.push(args); return {ok:true, json: async () => ({success:true, status:{mode:'paper'}})}},
};
const source = fs.readFileSync(require.resolve('../strategy-lab.js'), 'utf8');
assert.match(source, /The .* bot is still running/);
assert.match(source, /Apply \$\{selectedName\} to Bot/);
assert.match(source, /Research view and bot strategy match/);
vm.runInNewContext(source, context);
const lab = context.window.strategyLab;
lab.renderStrategyTabs();
assert.equal(elements.get('lab_tabModeOuQuant').classList.contains('active'), true);
assert.equal(elements.get('lab_tabModeMaStack').classList.contains('active'), false);
lab.renderBotUI = () => {};
lab.botState = {min_profit_pct: 0.35, active_tranches:[{unrealized_return_pct:0.30}]};
for (const mode of ['ma_stack','bollinger_zscore','rsi_momentum','multi_factor','ou_quant']) {
  const row = lab.getConditionDefinitions(mode, null, null, {}, [], null).exitRows.find(r => r.key === 'exit_net_pnl');
  assert.equal(row.liveOnly, true, 'minimum profit is a bot execution gate');
  assert.equal(row.backtestOnly, undefined);
  assert.ok(row.label.includes('0.35%'));
  assert.equal(row.pass, false, 'use bot threshold and bot LIFO entry, not replay inventory');
}
lab.botState = null;
const flush = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  lab.startBotPolling(); await flush();
  tick(); await flush(); tick(); await flush();
  assert.equal(calls.length, 3, 'visible Strategy Lab polls repeatedly using real tab ID');
  elements.get('tabContentStrategyLab').style.display = 'none';
  tick(); await flush();
  assert.equal(calls.length, 3, 'hidden tab does not poll');
  context.fetch = (...args) => {calls.push(args); return new Promise(resolve => resolveFetch = resolve);};
  const pending = lab.fetchBotStatus();
  await lab.fetchBotStatus();
  assert.equal(calls.length, 4, 'poll requests never overlap');
  resolveFetch({ok:true,json:async () => ({success:true,status:{}})}); await pending;
  lab.applyExecutionLock();
  assert.equal(elements.get('lab_btnModeLive').disabled, true);
  await lab.setBotMode('live');
  assert.equal(calls.length, 4, 'locked execution must not send a mutation');
  assert.equal(context.window.terminalLockManager.prompted, true);
  context.window.terminalLockManager.isLocked = false;
  context.window.terminalLockManager.token = 'test-session';
  lab.conditions = () => ({entry_1h:true});
  context.fetch = async (...args) => {calls.push(args); return {ok:true,json:async () => ({success:true,status:{}})};};
  await lab.setBotMode('paper');
  assert.equal(calls.length, 5, 'mode, strategy and enable sent atomically');
  const [url, request] = calls.at(-1);
  assert.equal(url, 'api/strategy-lab/set-mode');
  assert.equal(request.headers.Authorization, 'Bearer test-session');
  assert.deepEqual(JSON.parse(request.body), {mode:'paper',enable:true,strategy:'ou_quant',options:{entry_1h:true}});
  context.fetch = async () => ({ok:false,status:401,json:async () => ({error:'Unlock required'})});
  await lab.toggleBotPower();
  assert.equal(context.window.terminalLockManager.isLocked, true);
  assert.equal(alerts.length, 1, 'authorization and execution errors are visible');
  console.log('Strategy Lab controls regression tests passed');
})().catch(err => {console.error(err);process.exitCode=1;});
