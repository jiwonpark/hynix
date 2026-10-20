const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Test 1: Ensure fixLeftEdge is false on both spreadChart and positionChart
assert.ok(!html.includes('fixLeftEdge: true'), 'fixLeftEdge must not be true to enable smooth left-scrolling into past history');

// Test 2: The research chart must use the shared zoom-aware loader.
assert.ok(html.includes('window.backtestPrefetchDetach = StrategyExecutionChartController.attachZoomAwarePrefetch(window.spreadChart'),
  'research chart must attach the shared zoom-aware history loader');

// Test 3: Tab 2 must use the same loader and pass its requested zoom span to the API.
assert.ok(html.includes('this.shortTermPrefetchDetach = StrategyExecutionChartController.attachZoomAwarePrefetch(this.shortTermChart'),
  'tradingEngine must attach the shared zoom-aware history loader');
assert.ok(html.includes('onPrefetchNeeded: (needed) => this.fetchShortTermParity(true, needed)'),
  'tradingEngine must request enough bars for the current zoom span');

// Test 4: Verify renderShortTermChart defines activeTime and runs without throwing ReferenceError
const renderStart = html.indexOf('      renderShortTermChart(data) {');
const renderEnd = html.indexOf('      renderAutoTrancheCriteria(criteria, hedgedData) {', renderStart);
const renderMethod = html.slice(renderStart, renderEnd);

const elMap = {
  shortTermSpreadChartHost: { clientWidth: 800 },
  valShortTermCurrentParity: { textContent: '' },
  lblShortTermChartSync: { textContent: '' },
  legendScaleInLine: { style: {} }
};

const fakeSeries = {
  setData: () => {},
  setMarkers: () => {},
  applyOptions: () => {}
};

const fakeChart = {
  addLineSeries: () => fakeSeries,
  addAreaSeries: () => fakeSeries,
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 0, to: 100 }),
    setVisibleLogicalRange: () => {}
  }),
  subscribeCrosshairMove: () => {},
  subscribeClick: () => {}
};

const context = vm.createContext({
  window: {
    location: { origin: 'http://localhost:8000', pathname: '/skhynix/' },
    currentLang: 'en'
  },
  fakeSeries,
  $: (id) => elMap[id] || { textContent: '', style: {}, addEventListener: () => {} },
  formatKstTime: () => '12:00:00',
  LightweightCharts: {
    createChart: () => fakeChart,
    LineStyle: { Solid: 0, Dotted: 1, Dashed: 2 }
  },
  StrategyExecutionChartController: function() {
    this.setExecutions = () => {};
    this.markersForRender = () => [];
  },
  AbortSignal,
  console,
  Date
});

const engineCode = `({
  state: { shortTermInterval: '5m', hedgedStatus: { auto_tranche_criteria: {} } },
  shortTermSeries: fakeSeries,
  shortTermHistory: { interval: '5m', bars: [{ time: 100, value: 139.2 }], markers: [] },
  isConditionEnabled: () => true,
  syncHoveredTrancheAnalytics: () => {},
  renderCurrentPositionReferenceLines: () => {},
  updateMarkerState: () => {},
  calcMovingAverage: () => [],
  initShortTermChart: () => {},
  renderHeldPairPnl: () => {},
  ${renderMethod}
})`;

const testEngine = vm.runInContext(engineCode, context);
assert.doesNotThrow(() => {
  testEngine.renderShortTermChart({
    bars: [{ time: 100, value: 139.2 }],
    markers: []
  });
}, 'renderShortTermChart must execute without ReferenceError');

console.log('Prepend scroll regression checks passed');

let adrData, stockData;
testEngine.shortTermAssetSeries = {
  adr: {setData: data => {adrData = data;}}
};
testEngine.shortTermStockSeries = {setData: data => {stockData = data;}};
testEngine.renderShortTermChart({bars:[
  {time:100, value:139.2, adr:190, csop:5.5},
  {time:200, value:139.3},
  {time:300, value:139.4, adr:191, csop:5.6},
], markers:[]});
assert.equal(JSON.stringify(adrData), JSON.stringify([{time:100,value:190},{time:200},{time:300,value:191}]));
assert.equal(JSON.stringify(stockData), JSON.stringify([{time:100,value:5.5},{time:200},{time:300,value:5.6}]));
