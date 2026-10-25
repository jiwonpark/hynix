const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const elements = new Map([
  ['strategyLabFee', {value: '5'}],
  ['strategyLabTranches', {value: '5'}],
  ['lab_lblShortTermChartSync', {textContent: ''}],
]);
let requestedUrl = '';
const page = {
  page_mode: true,
  has_more: true,
  bars: [{time: 100, close: 90}, {time: 200, close: 95}],
  hourly: [{time: 0, close: 90}],
  entry_signals: [{time: 100, price: 90}],
  trades: [{id: 'old', pairKey: 'old-pair', entry_time: 100, exit_time: 200}],
  markers: [
    {time: 100, pairKey: 'old-pair', is_entry: true},
    {time: 200, pairKey: 'old-pair', is_entry: false},
  ],
  equity_curve: [{time: 100, value: 10000000}],
};
const context = {
  document: {getElementById: id => elements.get(id) || null},
  window: {localStorage: {getItem: () => null, setItem() {}}},
  URLSearchParams,
  fetch: async (url) => { requestedUrl = url; return {ok: true, status: 200, json: async () => page}; },
  console,
};
vm.runInNewContext(fs.readFileSync(require.resolve('../strategy-lab.js'), 'utf8'), context);
const lab = context.window.strategyLab;
lab.strategyMode = 'ma_stack';
lab.conditions = () => ({entry_1h: true});
lab.data = {
  bars: [{time: 300, close: 100}, {time: 400, close: 110}],
  hourly: [{time: 300, close: 100}],
  entry_signals: [{time: 300, price: 100}],
  trades: [{id: 'new', pairKey: 'new-pair', entry_time: 300, exit_time: 400}],
  markers: [
    {time: 300, pairKey: 'new-pair', is_entry: true},
    {time: 400, pairKey: 'new-pair', is_entry: false},
  ],
  equity_curve: [{time: 300, value: 10000000}],
};
let chartRenders = 0;
lab.renderChartData = () => { chartRenders += 1; };
lab.renderTradeTriangles = () => {};

(async () => {
  const added = await lab.loadOlderPaperBars(600);
  assert.equal(added, 2);
  assert.match(requestedUrl, /before=300/);
  assert.match(requestedUrl, /limit=600/);
  assert.deepEqual(Array.from(lab.data.bars, b => b.time), [100, 200, 300, 400]);
  assert.deepEqual(Array.from(lab.data.trades, t => t.pairKey), ['old-pair', 'new-pair']);
  assert.equal(chartRenders, 1);
  assert.match(elements.get('lab_lblShortTermChartSync').textContent, /2 appended paper trades/);
  console.log('Strategy Lab chart and paper-trade history append together');
})().catch((error) => { console.error(error); process.exitCode = 1; });
