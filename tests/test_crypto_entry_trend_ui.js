const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
for (const [file, prefix, name] of [['crypto-tab.js', 'crypto', 'cryptoEngine'], ['lighter-crypto-tab.js', 'lighterCrypto', 'lighterCryptoEngine']]) {
  const layer = {style: {}, innerHTML: ''}, legend = {};
  const elements = new Map([[`${prefix}TrendBandLayer`, layer], [`${prefix}EntryTrendLegend`, legend], [`${prefix}_shortTermSpreadChartHost`, {}]]);
  const context = {window: {}, document: {getElementById: id => elements.get(id), readyState: 'loading', addEventListener() {}}, console, URLSearchParams};
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
}
console.log('Both crypto tabs render authoritative entry-filter colors and clear stale shading');
