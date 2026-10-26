const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
(async () => {
for (const [file, prefix, name] of [['crypto-tab.js', 'crypto', 'cryptoEngine'], ['lighter-crypto-tab.js', 'lighterCrypto', 'lighterCryptoEngine']]) {
  const layer = {style: {}, innerHTML: ''}, legend = {};
  const elements = new Map([[`${prefix}TrendBandLayer`, layer], [`${prefix}EntryTrendLegend`, legend], [`${prefix}_shortTermSpreadChartHost`, {}]]);
  const context = {setTimeout, clearTimeout, TerminalCommon: {replaySignalLinks: () => new Map()}, window: {}, document: {getElementById: id => elements.get(id), readyState: 'loading', addEventListener() {}}, console, URLSearchParams};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const engine = context.window[name];
  engine.bars = [0, 300, 600, 900].map(time => ({time, value: 100}));
  engine.chart = {timeScale: () => ({timeToCoordinate: time => time / 10, width: () => 500})};
  const result = {enabled: true, source: 'LIGHTER', basis: 'completed 1h', points: [
    {time: 0, direction: 'UPTREND', source_time: 0}, {time: 300, direction: 'DOWNTREND', source_time: 0},
    {time: 600, direction: 'SIDEWAYS', source_time: 0},
  ]};
  engine.applyEntryTrend(result);
  assert.equal(engine.trendRanges.length, 3, 'forming/uncovered candles must not inherit a trend');
  assert.match(layer.innerHTML, /rgba\(22,163,74,.12\)/);
  assert.match(layer.innerHTML, /rgba\(220,38,38,.12\)/);
  assert.match(legend.textContent, /PAPER ENTRY FILTER ON.*completed 1h/);
  assert.match(layer.innerHTML, /source candle.*KST/);
  engine.applyEntryTrend({...result, enabled: false, points: [{time: 0, direction: 'OFF'}]});
  assert.doesNotMatch(layer.innerHTML, /rgba\(22,163,74|rgba\(220,38,38/);
  assert.match(legend.textContent, /OFF/);
  engine.clearEntryTrend();
  assert.equal(layer.innerHTML, '');
  assert.equal(engine.calculateTrendRanges(engine.bars).length, 0);
  assert.match(legend.textContent, /awaiting replay/);
  // Exercise the actual async response path, not just the rendering helper.
  const input = {value: '7', dataset: {}, checkValidity: () => true};
  elements.set(`${prefix}_macroMaPeriod`, input);
  assert.equal(engine.replaySettings().macro_ma_period, 7, 'hourly MA control must reach replay');
  engine.botState = {macro_ma_period: 60};
  engine.orderNotional = () => 50;
  assert.equal(engine.liveStrategyPayload('grid').macro_ma_period, 7, 'hourly MA control must reach authenticated deployment');
  engine.currentParadigm = 'grid';
  engine.paradigms = {grid: {name: 'Grid'}};
  let replayStatus = '';
  engine.executionChartFrame = {setStatus: text => { replayStatus = text; }};
  engine.replaySettings = () => ({strategy_mode: 'grid'});
  for (const method of ['renderMarkers', 'renderCurrentPositionReferenceLines', 'updateRulesMatchStatus', 'updateMaAndDiffs']) engine[method] = () => {};
  context.fetch = async () => ({ok: true, json: async () => ({success: true, entry_trend: result, trades: [], entry_signals: [], metrics: {}, summary: {trades: 0, win_rate: 0, net_pct: 0}})});
  await engine.runBacktest();
  assert.match(legend.textContent, /PAPER ENTRY FILTER ON/, `${file} must apply the replay response: ${replayStatus}`);
  assert.match(layer.innerHTML, /rgba\(220,38,38,.12\)/);
  context.fetch = async () => { throw new Error('test unavailable'); };
  await engine.runBacktest();
  assert.match(legend.textContent, /failed/, 'failed same-settings refresh must be labeled');
  assert.equal(layer.style.opacity, '.38', 'previous same-settings background must be visibly stale');
}
console.log('Both crypto tabs render authoritative entry-filter colors and clear stale shading');

})().catch(error => { console.error(error); process.exitCode = 1; });
