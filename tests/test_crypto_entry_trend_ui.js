const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
(async () => {
for (const [file, prefix, name] of [['crypto-tab.js', 'crypto', 'cryptoEngine'], ['lighter-crypto-tab.js', 'lighterCrypto', 'lighterCryptoEngine']]) {
  const layer = {style: {}, innerHTML: ''}, legend = {}, summary = {style: {}};
  const elements = new Map([
    [`${prefix}TrendBandLayer`, layer], [`${prefix}EntryTrendLegend`, legend],
    [`${prefix}_shortTermSpreadChartHost`, {}], [`${prefix}_shortTermAssetHost`, {}],
    [`${prefix}_macdSignalRegimeSummary`, summary],
  ]);
  let priceRegimeSignal = null;
  let assetRegimeSignal = null;
  let replayResponse = null;
  let replayFailure = null;
  const context = {setTimeout, clearTimeout, TerminalCommon: {
    replaySignalLinks: () => new Map(),
    fetchReplay: async () => {
      if (replayFailure) throw replayFailure;
      return replayResponse;
    },
    renderMacdSignalRegimes: (_prefix, _host, _chart, signal, options) => {
      if (options?.layer) {
        priceRegimeSignal = signal;
        options.layer.innerHTML = 'authoritative MACD regime';
      } else {
        assetRegimeSignal = signal;
      }
    },
  }, window: {}, document: {getElementById: id => elements.get(id), readyState: 'loading', addEventListener() {}}, console, URLSearchParams};
  context.window.TerminalCommon = context.TerminalCommon;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  const engine = context.window[name];
  engine.bars = [0, 300, 600, 900].map(time => ({time, value: 100}));
  engine.chart = {timeScale: () => ({timeToCoordinate: time => time / 10, width: () => 500})};
  engine.assetChart = {timeScale: () => ({timeToCoordinate: time => time / 10, width: () => 500})};
  const result = {enabled: true, source: 'LIGHTER', basis: 'completed 1h MACD-H(20, 60, 9) regime', points: [
    {time: 0, direction: 'UPTREND', long_ok: true, short_ok: false, source_time: 0},
    {time: 300, direction: 'DOWNTREND', long_ok: false, short_ok: true, source_time: 0},
    {time: 600, direction: 'SIDEWAYS', long_ok: false, short_ok: false, source_time: 0},
  ]};
  engine._currentMacd = {signal: [{time: 0, value: -1}, {time: 300, value: 1}]};
  engine.applyEntryTrend(result);
  assert.equal(engine.trendRanges.length, 3, 'forming/uncovered candles must not inherit a trend');
  assert.equal(layer.innerHTML, 'authoritative MACD regime');
  assert.deepEqual(Array.from(priceRegimeSignal, point => Number.isNaN(point.value) ? [point.time, 'NaN'] : [point.time, point.value]), [[0, 1], [300, -1], [600, 'NaN']]);
  assert.deepEqual(Array.from(assetRegimeSignal, point => Number.isNaN(point.value) ? [point.time, 'NaN'] : [point.time, point.value]), [[0, 1], [300, -1], [600, 'NaN']], 'price and MACD panes must use the governing hourly entry regime');
  assert.equal(legend.textContent, 'HOURLY MACD-H REGIME · ENTRY ON · red short · green long');
  assert.equal(summary.textContent, 'Hourly MACD-H − · SHORT only');
  const regimeToggle = {checked: true};
  elements.set(`${prefix}_macdUseSignalStreak`, regimeToggle);
  engine.applyEntryTrend(result);
  assert.equal(layer.innerHTML, 'authoritative MACD regime');
  assert.equal(legend.textContent, 'HOURLY MACD-H REGIME · ENTRY ON · red short · green long');
  regimeToggle.checked = false;
  engine.applyEntryTrend({...result, enabled: false, points: [{time: 0, direction: 'OFF'}]});
  assert.equal(layer.innerHTML, 'authoritative MACD regime');
  assert.equal(legend.textContent, 'MACD REGIME · DISPLAY ONLY · entry rule off');
  assert.equal(priceRegimeSignal, engine._currentMacd.signal, 'disabled hourly gate must fall back to chart-interval signal shading');
  assert.equal(assetRegimeSignal, engine._currentMacd.signal, 'both panes must use the same fallback regime');
  engine.clearEntryTrend();
  assert.equal(layer.innerHTML, 'authoritative MACD regime');
  assert.equal(engine.calculateTrendRanges(engine.bars).length, 0);
  assert.equal(legend.textContent, 'MACD REGIME · DISPLAY ONLY · entry rule off');
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
  replayResponse = {success: true, entry_trend: result, trades: [], entry_signals: [], metrics: {}, summary: {trades: 0, win_rate: 0, net_pct: 0}, latest_conditions: {}, latest_condition_time: 900};
  await engine.runBacktest();
  assert.match(legend.textContent, /HOURLY MACD-H REGIME · ENTRY ON/, `${file} must show the governing replay direction regime: ${replayStatus}`);
  assert.equal(layer.innerHTML, 'authoritative MACD regime');
  replayFailure = new Error('test unavailable');
  await engine.runBacktest();
  assert.match(legend.textContent, /HOURLY MACD-H REGIME · ENTRY ON/, 'replay failure must preserve the last completed governing regime');
  assert.equal(layer.style.opacity, '1', 'replay failure must not dim the independently computed MACD regime');
}
console.log('Both crypto tabs synchronize price and MACD panes to the active entry-direction regime');

})().catch(error => { console.error(error); process.exitCode = 1; });
