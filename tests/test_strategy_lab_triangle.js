const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Controller = require('../strategy-execution-chart.js');

function createMockDom() {
  const elements = new Map();

  class MockElement {
    constructor(tagName, id = '') {
      this.tagName = tagName;
      this.id = id;
      this.children = [];
      this.attributes = new Map();
      this.style = {};
      this._innerHTML = '';
      this.clientWidth = 800;
      this.clientHeight = 420;
      this.classList = {
        add: () => {},
        remove: () => {},
        toggle: () => {},
        contains: () => false,
      };
      this.parentElement = this;
      this.firstChild = { textContent: '' };
    }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(val) {
      this._innerHTML = val;
      if (val === '') this.children = [];
    }
    insertAdjacentHTML() {}
    setAttribute(name, val) { this.attributes.set(name, String(val)); }
    getAttribute(name) { return this.attributes.get(name); }
    appendChild(child) {
      if (child.nodeType === 11) { // DocumentFragment
        this.children.push(...child.children);
      } else {
        this.children.push(child);
        if (child.id) elements.set(child.id, child);
      }
      return child;
    }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
    removeEventListener() {}
  }

  class MockFragment {
    constructor() {
      this.nodeType = 11;
      this.children = [];
    }
    appendChild(child) { this.children.push(child); return child; }
  }

  const knownIds = [
    'lab_shortTermExecutionSection', 'lab_shortTermExecutionChartFrame',
    'lab_shortTermSpreadChartHost', 'lab_valShortTermCurrentParity',
    'lab_entryConditionsChecklist', 'lab_exitConditionsChecklist',
    'lab_btnRerunDynamicBacktest', 'lab_dynamicBacktestStatus',
    'lab_macroPolicyStatus', 'lab_shortTermChartLegend',
    'lab_lblShortTermChartSync', 'lab_legendActualTrades',
    'lab_legendVirtualTrades', 'lab_btnShortInterval5m',
    'lab_btnShortInterval1h', 'lab_btnShortInterval1m',
    'lab_btnShortInterval15m', 'lab_btnShortInterval4h',
    'lab_btnShortInterval1d', 'tabContentStrategyLab',
    'strategyLabDays'
  ];
  for (const id of knownIds) {
    elements.set(id, new MockElement('div', id));
  }

  const document = {
    createElement(tag) {
      const el = new MockElement(tag);
      return el;
    },
    createElementNS(ns, tag) {
      const el = new MockElement(tag);
      el.namespaceURI = ns;
      return el;
    },
    createDocumentFragment() {
      return new MockFragment();
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
  };

  return { document, elements };
}

const { document, elements } = createMockDom();
global.document = document;
const savedSettings = new Map();
const mockLightweightCharts = {
  CrosshairMode: { Normal: 0 },
  LineStyle: { Solid: 0, Dashed: 2 },
  createChart(host) {
    return {
      applyOptions() {},
      timeScale() {
        return {
          fitContent() {},
          width: () => 750,
          timeToCoordinate: t => (t - 1000) * 2,
          subscribeVisibleLogicalRangeChange() {},
        };
      },
      priceScale: () => ({ width: () => 50 }),
      addCandlestickSeries() {
        return {
          setData() {},
          setMarkers() {},
          priceToCoordinate: p => 400 - (p - 100) * 10,
          createPriceLine: opt => opt,
          removePriceLine() {},
        };
      },
      addLineSeries() {
        return { setData() {}, applyOptions() {} };
      },
      subscribeCrosshairMove() {},
      subscribeClick() {},
    };
  },
};

const context = {
  StrategyExecutionChartFrame: Controller.Frame,
  StrategyExecutionChartController: Controller,
  LightweightCharts: mockLightweightCharts,
  window: {
    StrategyExecutionChartFrame: Controller.Frame,
    StrategyExecutionChartController: Controller,
    LightweightCharts: mockLightweightCharts,
    localStorage: {
      getItem: key => savedSettings.get(key) || null,
      setItem: (key, value) => savedSettings.set(key, value),
    },
  },
  document,
  ResizeObserver: class { observe() {} disconnect() {} },
  requestAnimationFrame: fn => fn(),
  setInterval: () => 1,
  clearInterval: () => {},
  console,
  Date,
  Intl,
  Math,
  Number,
  String,
};

vm.runInNewContext(fs.readFileSync(require.resolve('../strategy-lab.js'), 'utf8'), context);
const lab = context.window.strategyLab;
assert.ok(lab, 'strategyLab must be exposed on window');

// Test 1: initChart creates tradeTrianglesLayer SVG
lab.initChart();
const host = elements.get('lab_shortTermSpreadChartHost');
const svg = elements.get('lab_tradeTrianglesLayer');
assert.ok(svg, 'tradeTrianglesLayer must be mounted inside chart host');
assert.equal(svg.getAttribute('aria-label'), 'Trade entry-exit triangles');

// Test 2: Inactive state renders nothing (only on hover / selection)
lab.data = {
  bars: [
    { time: 1000, open: 100, high: 105, low: 95, close: 102 },
    { time: 1300, open: 102, high: 115, low: 101, close: 110 },
  ],
  trades: [
    { id: 'T1', entry_time: 1000, exit_time: 1300, entry_price: 100, exit_price: 110, net_return_pct: 9.8, direction: 'long' }
  ],
  markers: [
    { time: 1000, is_entry: true, entry_price: 100, exit_price: 110, net_return_pct: 9.8, shape: 'arrowUp', direction: 'long' },
    { time: 1300, is_entry: false, entry_price: 100, exit_price: 110, net_return_pct: 9.8, shape: 'arrowDown', direction: 'long' }
  ]
};
lab.controller = new Controller({ series: lab.candles });
lab.controller.setExecutions(lab.data.markers);
lab.selectedMarkerTime = null;
lab.hoveredMarkerTime = null;
lab.renderTradeTriangles();
assert.equal(svg.children.length, 2, 'completed trades must show triangles by default');
assert.equal(svg.children[0].getAttribute('stroke-width'), '1', 'default state uses normal stroke');

// Test 3: Hover on entry marker time highlights green lower triangle for profitable long
lab.hoveredMarkerTime = 1000;
lab.renderTradeTriangles();
assert.equal(svg.children.length, 2, 'hover must render 1 polygon and 1 diagonal line');
const polygon = svg.children[0];
const diag = svg.children[1];
assert.equal(polygon.tagName, 'polygon');
assert.equal(diag.tagName, 'line');
assert.equal(polygon.getAttribute('fill'), 'rgba(34, 197, 94, 0.22)', 'highlighted profitable trade must have green fill');
assert.equal(diag.getAttribute('stroke'), '#16a34a', 'profitable trade must have green diagonal');
assert.equal(polygon.getAttribute('stroke-width'), '2', 'highlighted trade uses stroke width 2');

// Verify lower triangle geometry for long trade:
// Entry: t=1000 -> x1=0, p1=100 -> y1=400
// Exit: t=1300 -> x2=600, p2=110 -> y2=300
// y1 (400) > y2 (300) -> leftY > rightY
// For long: corner is (rightX, leftY) = (600, 400)
// Points: x1,y1 cornerX,cornerY x2,y2 -> "0.0,400.0 600.0,400.0 600.0,300.0"
const pts = polygon.getAttribute('points');
assert.equal(pts, '0.0,400.0 600.0,400.0 600.0,300.0', 'long trade must construct lower triangle of bounding box');

// Test 4: Hover on loss long trade draws red triangle
lab.data.trades = [
  { id: 'T2', entry_time: 1000, exit_time: 1300, entry_price: 110, exit_price: 100, net_return_pct: -9.2, direction: 'long' }
];
svg.children = [];
lab.renderTradeTriangles();
assert.equal(svg.children.length, 2);
assert.equal(svg.children[0].getAttribute('fill'), 'rgba(239, 68, 68, 0.22)', 'highlighted loss trade must have red fill');
assert.equal(svg.children[1].getAttribute('stroke'), '#dc2626', 'loss trade must have red diagonal');

// Test 5: Profitable short trade draws green upper triangle
lab.data.trades = [
  { id: 'T3', entry_time: 1000, exit_time: 1300, entry_price: 110, exit_price: 100, net_return_pct: 8.9, direction: 'short' }
];
svg.children = [];
lab.renderTradeTriangles();
assert.equal(svg.children.length, 2);
assert.equal(svg.children[0].getAttribute('fill'), 'rgba(34, 197, 94, 0.22)', 'profitable short trade must have green fill');
// Entry: p1=110 -> y1=300. Exit: p2=100 -> y2=400.
// leftY (300) <= rightY (400)
// For short: corner is (rightX, leftY) = (600, 300)
// Points: 0.0,300.0 600.0,300.0 600.0,400.0 (upper triangle)
assert.equal(svg.children[0].getAttribute('points'), '0.0,300.0 600.0,300.0 600.0,400.0', 'short trade must construct upper triangle');

// Test 6: Selection via onTrancheClick highlights triangle
lab.hoveredMarkerTime = null;
lab.onTrancheClick(1000);
assert.equal(lab.selectedMarkerTime, 1000, 'onTrancheClick must select marker time');
assert.equal(svg.children[0].getAttribute('stroke-width'), '2', 'selected trade must be highlighted with stroke 2');

// Test 7: Clicking again deselects, returning to default normal stroke
lab.onTrancheClick(1000);
assert.equal(lab.selectedMarkerTime, null);
assert.equal(svg.children[0].getAttribute('stroke-width'), '1', 'deselected trade returns to normal stroke');

console.log('Strategy Lab PnL triangle unit tests passed');
