const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
function method(name) {
  const start = html.search(new RegExp(`^      (?:async )?${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = html.indexOf('\n      },', start) + '\n      },'.length;
  return html.slice(start, end);
}
const elements = {
  activePositionsBody: {}, btnReduceTranche: {style: {}}, lblReduceTrancheText: {},
  btnStepTranche: {}, lblHedgedSyncBadge: {}, lblStepTrancheSize: {}, valCritCycleCore: {}, macroPolicyStatus: {},
};
const context = vm.createContext({window: {location: {origin: 'https://test', pathname: '/skhynix/'}},
  $: id => elements[id], AbortSignal, console, formatKstTime: () => 'now'});
const engine = vm.runInContext(`({state: {positions: [], orderLog: [], conditionToggles: {}},
  ${['isConditionEnabled', 'renderPositionsAndLogs', 'fetchHedgedStatus', 'fetchHedgedStatusOnce', 'renderHedgedController'].map(method).join('\n')}
})`, context);
engine.renderAutoTrancheCriteria = () => {};
engine.fetchShortTermParity = () => {};
engine.scheduleDynamicBacktest = () => {};
engine.state.backendPositions = ['SKHYUSDT', 'CSOPSKHYNIX2LUSDT'].map(symbol => ({
  symbol, unrealized_pnl: 0, notional: 10, entry_price: 190, mark_price: 191, roe_percent: 0,
}));
engine.renderPositionsAndLogs();
assert.match(elements.activePositionsBody.innerHTML, /— \/ — UNITS/);
assert.doesNotMatch(elements.activePositionsBody.innerHTML, /-100\.00%/);

(async () => {
  const data = {authenticated: true, tranches_active: 12, eligible_for_take_profit: true,
    auto_tranche_criteria: {tranches_max: 189, can_scale_in: true, can_take_profit: true,
      is_exit_ma_aligned: false, effective_exit_ma_aligned: true,
      target_tranche_profit: {net_pnl_usd: .1, available: true},
      condition_toggles: {exit_ma_stack_5m: false}}};
  context.fetch = async () => ({ok: true, json: async () => data});
  await engine.fetchHedgedStatus();
  assert.match(elements.activePositionsBody.innerHTML, /12 \/ 189 UNITS/,
    'hedged status polling must refresh table capacity');
  assert.equal(elements.btnReduceTranche.disabled, false,
    'disabled MA gate must not override the backend exit decision');
  data.auto_tranche_criteria.asymmetric_sizing = {scale_in_skhy:.12, scale_in_csop:2.1,
    residual_retained_skhy:.05,residual_retained_csop:.9,scale_in_notional_usd:34};
  data.auto_tranche_criteria.macro_policy = {regime:'TOPPING',score:100,entry_multiplier:1.5};
  data.auto_tranche_criteria.exit_policy = {convergence_pts:.16,minimum_net_profit_usd:.04,require_confirmed_rebound:true};
  await engine.fetchHedgedStatus();
  assert.match(elements.lblStepTrancheSize.textContent, /0.12 ADR \/ 2.10 ETF/);
  assert.match(elements.valCritCycleCore.textContent, /0.05 ADR \/ 0.90 ETF/);
  assert.match(elements.macroPolicyStatus.textContent, /net > \$0.04, two rising 5m closes/);
  data.auto_tranche_criteria.can_take_profit = false;
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnReduceTranche.disabled, true);

  context.fetch = async () => ({ok: true, json: async () => ({authenticated:false,status:'unavailable'})});
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnStepTranche.disabled, true);
  assert.equal(elements.btnReduceTranche.disabled, true);
  assert.match(elements.lblHedgedSyncBadge.textContent, /DATA UNAVAILABLE/);
  context.fetch = async () => ({ok:true,json:async()=>data});
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnStepTranche.disabled, false);
  assert.match(elements.lblHedgedSyncBadge.textContent, /Sync/);

  engine.state.conditionToggles = {exit_net_profit: false, exit_ma_stack: false,
    exit_ma_stack_5m: true, exit_speculative_tranche: false};
  assert.equal(engine.isConditionEnabled('exit_ma_stack_5m'), true);
  assert.equal(engine.isConditionEnabled('exit_ma_stack_1h'), false);
  assert.equal(engine.isConditionEnabled('exit_speculative_tranche'), true);
  assert.equal(engine.isConditionEnabled('exit_net_profit'), false, 'profit switch remains usable by backtest');

  const badges = {};
  context.criteria = {mandatory_live_conditions: ['exit_net_profit']};
  context.isKo = false;
  context.setBadge = (id, text, type) => {badges[id] = {text, type};};
  elements.check = {};
  elements.row = {classList: {toggle: (_, disabled) => {elements.row.disabled = disabled;}}};
  const start = html.indexOf('        const syncCondRow =');
  const end = html.indexOf('\n        };', start) + '\n        };'.length;
  const sync = vm.runInContext(`(function() {${html.slice(start, end)} return syncCondRow;})`, context).call(engine);
  sync('exit_net_profit', 'row', 'check', 'badge', false, 'PASS', 'LOCKED');
  assert.equal(elements.check.checked, false);
  assert.equal(elements.row.disabled, false);
  assert.equal(badges.badge.text, 'LOCKED', 'backtest switch cannot hide a live guard');
  sync('exit_ma_stack_1h', 'row', 'check', 'badge', false, 'PASS', 'WAIT');
  assert.equal(elements.row.disabled, true);
  assert.equal(badges.badge.text, 'OFF');
  console.log('Live condition and positions UI checks passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
