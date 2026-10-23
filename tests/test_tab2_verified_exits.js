const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
assert(html.includes('/api/trade/verified_exits'), 'Tab 2 must use the lightweight verified-exit fallback');
assert(html.includes('this.lastVerifiedExitSnapshot = data'), 'Tab 2 must retain the last successful verified history');
assert(html.includes('if (this.verifiedExitSnapshotInFlight) return this.verifiedExitSnapshotInFlight;'), 'Tab 2 must coalesce slow verified-history requests');
assert(html.includes('AbortSignal.timeout(30000)'), 'Verified history must allow the production endpoint time to return');
assert(html.includes('priority: "high"'), 'Verified history must be prioritized over background dashboard requests');
assert(html.includes('await this.refreshVerifiedExitHistory();'), 'Opening Execution History must explicitly refresh its data');
assert(html.includes('`${apiPrefix}/verified-exits.json`'), 'Tab 2 must have a fast static verified-history bootstrap');
assert(html.includes('const bootstrap = {...data, stale: true};'), 'The static bootstrap must be labeled as a last successful read');
assert(html.includes('const exitSnapshotPromise = this.fetchVerifiedExitSnapshot();'), 'Tab 2 must fetch verified history independently of account status');
assert(html.includes('this.applyVerifiedExitSnapshot(this.state.hedgedStatus, exitSnapshot);'), 'A delayed verified-history response must restore the current view');
assert.match(
  html,
  /try \{ this\.renderPositionsAndLogs\(\); \} catch \(e\) \{ console\.warn\("Positions and execution history render error:", e\); \}/,
  'A different Tab 2 panel render failure must not discard a successful status response',
);
assert(!html.includes('$("valCritCombinedPnl").style.color = col;'), 'Tab 2 P&L color must not reference an undefined variable');
assert(html.includes('`${pnlSign}$${pnl.toFixed(3)} net'), 'Tab 2 P&L sign must use the scoped P&L sign variable');
const lines = html.split('\n');
const start = lines.findIndex((line) => line.includes('renderPositionsAndLogs() {'));
const end = lines.findIndex((line, index) => index > start && line.includes('async syncWithBackend() {'));
assert(start >= 0 && end > start, 'renderPositionsAndLogs must be extractable');

const elements = new Map();
for (const id of [
  'countPositions',
  'countOrderLog',
  'activePositionsBody',
  'pairExecutionHistorySummary',
  'executionHistoryBody',
]) {
  elements.set(id, { textContent: '', innerHTML: '', style: {} });
}
const $ = (id) => elements.get(id) || null;
const window = { currentLang: 'en' };
const formatKstDateTime = () => '2026-10-23 10:00:00 KST';
const state = {
  backendPositions: [],
  positions: [],
  orderLog: [],
  hedgedStatus: {
    verified_exits_stale: true,
    verified_exit_summary: {
      verified_exit_pairs: 19,
      total_recorded_exit_pairs: 19,
      realized_after_exit_fees_usd: -42.89830268,
      exit_fees_usd: 0.1266299,
      virtual_lifo_pairs: 19,
      virtual_lifo_after_commissions_usd: 2.7182,
      engine_estimate_pairs: 2,
      engine_estimated_net_pnl_usd: 0.2763,
      pnl_authoritative: true,
    },
    recent_executions: [{
      symbol: 'SKHYUSDT',
      side: 'BUY',
      qty: 0.07,
      price: 194.5,
      time: 1,
      commission: 0.0068,
      commission_asset: 'USDT',
      realized_pnl: -1.25,
      verified_exit_leg: true,
      verified_exit_pair_anchor: true,
      verified_exit_pair_realized_after_exit_fees_usd: -2.41,
      virtual_lifo_after_commissions_usd: 0.148,
      engine_take_profit_estimate_usd: 0.136,
    }],
  },
};
const tradingEngine = { state };
const code = lines.slice(start + 1, end - 2).join('\n');
tradingEngine.renderPositionsAndLogs = new Function(
  '$', 'window', 'formatKstDateTime', code,
).bind(tradingEngine, $, window, formatKstDateTime);

tradingEngine.renderPositionsAndLogs();

assert.match($('pairExecutionHistorySummary').innerHTML, /Verified exit pairs/);
assert.match($('pairExecutionHistorySummary').innerHTML, /19\/19/);
assert.match($('pairExecutionHistorySummary').innerHTML, /-\$42\.8983/);
assert.match($('pairExecutionHistorySummary').innerHTML, /entry commissions and funding excluded/);
assert.match($('pairExecutionHistorySummary').innerHTML, /Corresponding-entry Virtual LIFO P&L/);
assert.match($('pairExecutionHistorySummary').innerHTML, /\+\$2\.7182/);
assert.match($('pairExecutionHistorySummary').innerHTML, /Stored pre-exit engine estimate/);
assert.match($('pairExecutionHistorySummary').innerHTML, /last successful read \(retrying\)/);
assert.match($('executionHistoryBody').innerHTML, /VERIFIED EXIT LEG/);
assert.match($('executionHistoryBody').innerHTML, /After exit fee/);
assert.match($('executionHistoryBody').innerHTML, /Pair Binance average/);
assert.match($('executionHistoryBody').innerHTML, /Corresponding-entry Virtual LIFO/);
assert.match($('executionHistoryBody').innerHTML, /Pre-exit engine estimate/);

console.log('✅ Tab 2 verified-exit summary and authoritative leg labels passed');
