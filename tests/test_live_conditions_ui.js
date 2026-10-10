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
  btnStepTranche: {}, lblHedgedSyncBadge: {}, lblStepTrancheSize: {}, valCritCycleCore: {}, macroPolicyStatus: {}, valCritExitSize: {},
};
const context = vm.createContext({window: {location: {origin: 'https://test', pathname: '/skhynix/'}, terminalLockManager: {isLocked: false}},
  terminalLockManager: {isLocked: false}, $: id => elements[id], AbortSignal, console, formatKstTime: () => 'now'});
const engine = vm.runInContext(`({state: {positions: [], orderLog: [], conditionToggles: {}},
  ${['isConditionEnabled', 'renderPositionsAndLogs', 'fetchHedgedStatus', 'fetchHedgedStatusOnce', 'renderHedgedController', 'renderHeldPairPnl'].map(method).join('\n')}
})`, context);
engine.renderAutoTrancheCriteria = () => {};
engine.fetchShortTermParity = () => {};
engine.scheduleDynamicBacktest = () => {};
let displayedStatus;
engine.heldPairPnlPane = {update: (_, status) => {displayedStatus = status;}};
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
  assert.equal(displayedStatus, data);
  assert.match(elements.activePositionsBody.innerHTML, /12 \/ 189 UNITS/,
    'hedged status polling must refresh table capacity');
  assert.equal(elements.btnReduceTranche.disabled, false,
    'disabled MA gate must not override the backend exit decision');
  data.auto_tranche_criteria.asymmetric_sizing = {scale_in_skhy:.09, scale_in_csop:1.62, scale_out_skhy:.06, scale_out_csop:1.08,
    residual_retained_skhy:.03,residual_retained_csop:.54,scale_in_notional_usd:34};
  data.auto_tranche_criteria.macro_policy = {regime:'TOPPING',score:100,entry_multiplier:1.5,adr_exit_qty:.06,stock_exit_qty:1.08};
  data.auto_tranche_criteria.exit_policy = {adr_exit_qty:.06,stock_exit_qty:1.08,convergence_pts:.16,minimum_net_profit_usd:.04,require_confirmed_rebound:true};
  await engine.fetchHedgedStatus();
  assert.match(elements.lblStepTrancheSize.textContent, /0.09 ADR \/ 1.62 ETF/);
  assert.match(elements.valCritCycleCore.textContent, /0.03 ADR \/ 0.54 ETF/);
  assert.match(elements.macroPolicyStatus.textContent, /net > \$0.04, two rising 5m closes/);
  assert.match(elements.valCritExitSize.textContent, /0.06 ADR \/ 1.08 ETF/);
  assert.match(elements.lblReduceTrancheText.textContent, /0.06 ADR \/ 1.08 ETF/);
  data.auto_tranche_criteria.can_take_profit = false;
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnReduceTranche.disabled, true);

  context.fetch = async () => ({ok: true, json: async () => ({authenticated:false,status:'unavailable'})});
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnStepTranche.disabled, true);
  assert.equal(elements.btnReduceTranche.disabled, true);
  assert.match(elements.lblHedgedSyncBadge.textContent, /DATA UNAVAILABLE/);
  assert.equal(displayedStatus.authenticated, false, 'unavailable status clears held-pair P&L');
  context.fetch = async () => ({ok:true,json:async()=>data});
  await engine.fetchHedgedStatus();
  assert.equal(elements.btnStepTranche.disabled, false);
  assert.match(elements.lblHedgedSyncBadge.textContent, /Sync/);

  engine.state.conditionToggles = {exit_net_profit: false, exit_ma_stack: false,
    exit_ma_stack_5m: true, exit_speculative_tranche: false};
  assert.equal(engine.isConditionEnabled('exit_ma_stack_5m'), true);
  assert.equal(engine.isConditionEnabled('exit_ma_stack_1h'), false);
  assert.equal(engine.isConditionEnabled('exit_speculative_tranche'), true);
  assert.equal(engine.isConditionEnabled('exit_net_profit'), false, 'profit switch is toggleable');

  const badges = {};
  context.criteria = {mandatory_live_conditions: ['exit_speculative_tranche']};
  context.isKo = false;
  context.setBadge = (id, text, type) => {badges[id] = {text, type};};
  elements.check = {dataset: {}};
  elements.row = {classList: {toggle: (_, disabled) => {elements.row.disabled = disabled;}}};
  const start = html.indexOf('        const syncCondRow =');
  const end = html.indexOf('\n        };', start) + '\n        };'.length;
  const sync = vm.runInContext(`(function() {${html.slice(start, end)} return syncCondRow;})`, context).call(engine);

  // Mandatory condition (e.g. exit_speculative_tranche) remains locked ON with checkbox disabled
  sync('exit_speculative_tranche', 'row', 'check', 'badge', false, 'PASS', 'WAIT');
  assert.equal(elements.check.disabled, true, 'mandatory condition checkbox must be disabled');
  assert.equal(elements.row.disabled, false);
  assert.equal(badges.badge.text, 'WAIT', 'mandatory condition cannot be toggled OFF');

  // exit_net_profit is toggleable: checkbox is enabled and can be toggled OFF
  sync('exit_net_profit', 'row', 'check', 'badge', false, 'PASS', 'LOCKED');
  assert.equal(elements.check.disabled, false, 'exit_net_profit checkbox must be enabled');
  assert.equal(elements.check.checked, false);
  assert.equal(elements.row.disabled, true);
  assert.equal(badges.badge.text, 'OFF', 'exit_net_profit shows OFF when disabled');

  sync('exit_ma_stack_1h', 'row', 'check', 'badge', false, 'PASS', 'WAIT');
  assert.equal(elements.row.disabled, true);
  assert.equal(badges.badge.text, 'OFF');

  // Condition 10 (entry_adaptive_guard) must be toggleable and disable sub-guards
  engine.state.conditionToggles.entry_adaptive_guard = false;
  assert.equal(engine.isConditionEnabled('entry_adaptive_guard'), false);
  assert.equal(engine.isConditionEnabled('entry_campaign_cap'), false);
  assert.equal(engine.isConditionEnabled('entry_rate_limit'), false);
  assert.equal(engine.isConditionEnabled('entry_closed_bar'), false);
  sync('entry_adaptive_guard', 'row', 'check', 'badge', false, 'PASS', 'WAIT');
  assert.equal(elements.row.disabled, true);
  assert.equal(badges.badge.text, 'OFF');

  // Check HTML markup for Condition 10 toggle
  assert.match(html, /id="chkCondEntryGuard"[^>]*onchange="tradingEngine\.toggleConditionWithWarning\('entry_adaptive_guard', this\)"/);
  assert.doesNotMatch(html, /id="chkCondEntryGuard"[^>]*disabled/);
  assert.match(html, /id="conditionWarningModal"/);

  console.log('Live condition and positions UI checks passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
