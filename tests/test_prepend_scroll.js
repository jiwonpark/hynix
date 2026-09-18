const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Test 1: Ensure fixLeftEdge is false on both spreadChart and positionChart
assert.ok(!html.includes('fixLeftEdge: true'), 'fixLeftEdge must not be true to enable smooth left-scrolling into past history');

// Test 2: Ensure spreadChart threshold for prepending older bars is from < 25
assert.ok(html.includes('if (from < 25) {'), 'spreadChart must trigger prepend when within 25 bars of the left edge');

// Test 3: Ensure tradingEngine threshold for prepending is from < 25 and checks hasMore/loadingOlder
assert.ok(html.includes('range.from < 25 && !this.shortTermRendering && !this.shortTermHistory?.loadingOlder && this.shortTermHistory?.hasMore'),
  'tradingEngine must trigger fetchShortTermParity(true) when from < 25');

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
