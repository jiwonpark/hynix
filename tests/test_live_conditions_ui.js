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
};
const context = vm.createContext({window: {location: {origin: 'https://test'}},
  $: id => elements[id], AbortSignal, console});
const engine = vm.runInContext(`({state: {positions: [], orderLog: [], conditionToggles: {}},
  ${['isConditionEnabled', 'renderPositionsAndLogs', 'fetchHedgedStatus', 'renderHedgedController'].map(method).join('\n')}
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
    auto_tranche_criteria: {tranches_max: 189, can_take_profit: true,
      is_exit_ma_aligned: false, effective_exit_ma_aligned: true,
      target_tranche_profit: {net_pnl_usd: .1, available: true},
      condition_toggles: {exit_ma_stack_5m: false}}};
  context.fetch = async () => ({ok: true, json: async () => data});
  await engine.fetchHedgedStatus();
  assert.match(elements.activePositionsBody.innerHTML, /12 \/ 189 UNITS/,
    'hedged status polling must refresh table capacity');
  assert.equal(elements.btnReduceTranche.disabled, false,
    'disabled MA gate must not override the backend exit decision');
  data.auto_tranche_criteria.can_take_profit = false;
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnReduceTranche.disabled, true);

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
