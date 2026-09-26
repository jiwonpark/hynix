const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../lighter-tab.js'), 'utf8');

assert.ok(code.includes('lighter_selTrancheDirection'), 'must inject lighter_selTrancheDirection');
assert.ok(code.includes('PAPER SIMULATION ONLY'), 'must display paper simulation badge');
assert.ok(code.includes('Close All Paper Tranches'), 'must label exit button clearly');
assert.ok(code.includes('➕ Add Paper Tranche'), 'must label add button clearly');

assert.ok(code.includes('window.showToast'), 'must call window.showToast for feedback');
assert.ok(code.includes('Paper Tranche #'), 'must notify when paper tranche is added');
assert.ok(code.includes('Closed'), 'must notify when paper tranches are closed');

assert.ok(code.includes('dirSelect.value === "short"'), 'must support manual short parity selection');
assert.ok(code.includes('dirSelect.value === "long"'), 'must support manual long parity selection');
assert.ok(code.includes('side = -1'), 'must assign negative side for short parity');
assert.ok(code.includes('side = 1'), 'must assign positive side for long parity');

// Tab 2 UX parity assertions
assert.ok(code.includes('lid("modePaper")'), 'must support modePaper');
assert.ok(code.includes('lid("modeSemiAuto")'), 'must support modeSemiAuto');
assert.ok(code.includes('lid("modeLive")'), 'must support modeLive');
assert.ok(code.includes('stepTrancheLive'), 'must support live step tranche');
assert.ok(code.includes('reduceTrancheLive'), 'must support live reduce tranche');
assert.ok(code.includes('emergencyFlatten'), 'must support emergency flatten');
assert.ok(code.includes('btnKillSwitch'), 'must support kill switch');
assert.ok(code.includes('btnResetPaperBalance'), 'must support reset paper balance');
assert.ok(code.includes('/api/lighter/step_tranche'), 'must call step tranche endpoint');
assert.ok(code.includes('/api/lighter/reduce_tranche'), 'must call reduce tranche endpoint');
assert.ok(code.includes('/api/lighter/flatten'), 'must call flatten endpoint');
assert.ok(code.includes('updateLeverageMetrics'), 'must implement updateLeverageMetrics');
assert.ok(code.includes('this.setText("valHedgedLeverage"'), 'must update valHedgedLeverage dynamically');
assert.ok(code.includes('this.setText("valCondEntryLeverage"'), 'must update valCondEntryLeverage dynamically');
assert.ok(code.includes('this.setText("valCritGrossLev"'), 'must update valCritGrossLev dynamically');
assert.ok(!code.includes('"1.00x fixed"'), 'must not hardcode 1.00x fixed');
assert.ok(code.includes('await this.toggleLiveBot(false)'), 'leaving live mode must pause the backend bot');
assert.ok(code.includes('Math.min(500'), 'manual live notional must be capped at $500 in the UI');
assert.ok(code.includes('execution_history'), 'must render normalized persisted live execution history');
assert.ok(code.includes('Entry → Exit Ratio'), 'must label linked entry and exit ratios');
assert.ok(code.includes('Net P&L / Return'), 'must label net PnL and percentage return');
assert.ok(code.includes('fee_bps'), 'must render execution fees in basis points');
assert.ok(code.includes('countOrderLog'), 'must update the execution-history event count');
assert.ok(code.includes('Filled Qty / USDT Size'), 'history must label USDT execution size');
assert.ok(code.includes('Est. 1x Margin'), 'active positions must label estimated 1x margin');
assert.ok(code.includes('gross_notional_usd'), 'history must consume persisted gross USDT exposure');
assert.ok(code.includes('position_value'), 'active positions must use the exchange position value');
assert.ok(code.includes('const levCap = 1.0'), 'Lighter margin utilization must use the configured 1x cap');
assert.ok(code.includes('tabEl.disabled = false'), 'bottom section tabs must be re-enabled after fail-closed initialization');
assert.ok(code.includes('irrelevantUpbitTab.style.display = "none"'), 'irrelevant Upbit tab must be hidden on Lighter');
assert.ok(code.includes('lighter_inputLiveTradeRate'), 'must expose an N-per-minute slider in the visible live-rules card');
assert.ok(code.includes('lighter_btnSaveLiveCooldown'), 'must expose a save button beside the live cooldown');
assert.ok(code.includes('type="range" min="0.2" max="10" step="0.2"'), 'trade-rate slider must cover 0.2 through 10 paired trades per minute');
assert.ok(code.includes('<div class="terminal-action-control"'), 'trade-rate slider must participate in terminal read-only locking');
assert.ok(code.includes('window.terminalLockManager?.applyState?.()'), 'dynamic trade-rate controls must receive the current lock state');
assert.ok(code.includes('async saveLiveBotRate() {\n      if (window.terminalLockManager?.isLocked)'), 'rate saving must fail closed when the terminal is locked');
assert.ok(code.includes('cooldownSecondsForTradeRate'), 'must convert the selected rate into a server-side cooldown');
assert.ok(code.includes('min_seconds_between_orders: cooldownSeconds'), 'must persist the selected rate as a cooldown');
assert.ok(code.includes('lighterLiveCooldown'), 'must show the configured cooldown in the live rules panel');
assert.ok(code.includes('const KST_TIME_ZONE = "Asia/Seoul"'), 'must render Lighter times explicitly in KST');
assert.ok(code.includes('Last Sync: ${formatKstDateTime'), 'last sync must use the explicit KST formatter');
assert.ok(code.includes('localization: {'), 'chart must use explicit time localization');
assert.ok(code.includes('tickMarkFormatter: (time) => formatKstChartTime(time)'), 'chart axis ticks must use KST');

console.log('Lighter Tab 2 UX & paper/live checks passed');
