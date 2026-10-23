const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
assert.match(
  html,
  /try \{ this\.renderPositionsAndLogs\(\); \} catch \(e\) \{ console\.warn\("Positions and execution history render error:", e\); \}/,
  'A different Tab 2 panel render failure must not discard a successful status response',
);
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
    verified_exit_summary: {
      verified_exit_pairs: 19,
      total_recorded_exit_pairs: 19,
      realized_after_exit_fees_usd: -42.89830268,
      exit_fees_usd: 0.1266299,
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
assert.match($('executionHistoryBody').innerHTML, /VERIFIED EXIT LEG/);
assert.match($('executionHistoryBody').innerHTML, /After exit fee/);

console.log('✅ Tab 2 verified-exit summary and authoritative leg labels passed');
