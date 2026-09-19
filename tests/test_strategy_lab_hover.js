const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Controller = require('../strategy-execution-chart.js');

const host = { clientWidth: 600, setAttribute() {}, classList: { toggle() {}, add() {}, remove() {} } };
const context = { window: {}, document: { getElementById: () => host } };
vm.runInNewContext(fs.readFileSync(require.resolve('../strategy-lab.js'), 'utf8'), context);
const lab = context.window.strategyLab;
const buy = { time: 100, entry_price: 1000, exit_price: 1100, net_return_pct: 9.89,
  hypothetical: true, backtest: true, is_entry: true, shape: 'arrowUp', hoverText: 'BUY' };
const sell = { ...buy, time: 200, is_entry: false, shape: 'arrowDown', hoverText: 'SELL' };
lab.data = { markers: [buy, sell], fee_bps: 5, open_position: { price: 1200 } };
lab.chart = { timeScale: () => ({ getVisibleLogicalRange: () => ({ from: 0, to: 60 }),
  timeToCoordinate: time => time }) };
let cursor = { time: 100, point: { x: 100, y: 10 } };
let updates = 0;
let rendered;
const lines = new Set();
lab.candles = {
  setMarkers(markers) {
    rendered = markers;
    updates++;
    // Reproduce Lightweight Charts' synchronous crosshair notification.
    if (updates > 20) throw new Error('recursive crosshair updates');
    lab.onCrosshair(cursor);
  },
  createPriceLine(options) { lines.add(options); lab.onCrosshair(cursor); return options; },
  removePriceLine(line) { lines.delete(line); lab.onCrosshair(cursor); },
};
lab.controller = new Controller({ series: lab.candles });
lab.controller.setExecutions(lab.data.markers);

lab.onCrosshair(cursor);
assert.equal(updates, 1, 'one mouse event must not recurse through setMarkers');
assert.equal(lines.size, 8, 'buy hover must draw entry, six profit levels and exit');
assert.equal([...lines][0].price, buy.entry_price);
assert.equal(rendered[0].text, 'BUY');
lab.onCrosshair({ time: 100, point: { x: 100, y: 350 } });
assert.equal(updates, 1, 'moving vertically within the same trade column must not redraw');

cursor = { time: 201, point: { x: 202, y: 350 } };
lab.onCrosshair(cursor);
assert.equal(updates, 2, 'sell hover must resolve by x even away from the arrow');
assert.equal(rendered[1].text, 'SELL');
assert.equal([...lines][0].price, buy.entry_price, 'sell levels must use its matching buy');
assert.ok([...lines].at(-1).title.includes('+9.89% net'));

lab.onClick(cursor);
cursor = {};
lab.onCrosshair(cursor);
assert.equal([...lines][0].price, buy.entry_price, 'clicked trade remains pinned on mouse leave');
lab.onClick({ point: { x: 450, y: 20 } });
assert.equal([...lines][0].price, 1200, 'empty click restores open-position reference');

lab.toggleVirtual();
cursor = { time: 100, point: { x: 100, y: 20 } };
lab.onCrosshair(cursor);
assert.equal(lines.size, 0, 'hidden trades must not restore their lines on hover');
lab.toggleVirtual();
lab.onCrosshair(cursor);
assert.equal(lines.size, 8, 'hover recovers after showing virtual trades again');
assert.equal(lab.syncingMarkerState, false);

// 1h interval marker rendering and interaction tests
lab.data.hourly = [{ time: 0, open: 1000, high: 1100, low: 900, close: 1050, ma7: 1020, ma24: 1010, ma60: 1000 }];
lab.data.bars = [
  { time: 100, open: 1000, high: 1050, low: 950, close: 1000, ma7: 1000, ma24: 1000, ma60: 1000 },
  { time: 200, open: 1100, high: 1150, low: 1050, close: 1100, ma7: 1050, ma24: 1020, ma60: 1000 },
];
lab.candles.setData = () => {};
lab.maSeries = [];
lab.chart = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({ from: 0, to: 60 }),
    timeToCoordinate: (time) => time,
    fitContent: () => {},
  }),
};

lab.setChartInterval('1h');
assert.equal(lab.chartInterval, '1h');
assert.equal(rendered.length, 2, 'markers must render on 1h interval');
assert.equal(rendered[0].time, 0, 'marker timestamp must be mapped to 1h candle timestamp');
assert.equal(rendered[1].time, 0, 'marker timestamp must be mapped to 1h candle timestamp');

cursor = { time: 0, point: { x: 0, y: 10 } };
lab.onCrosshair(cursor);
assert.equal(lines.size, 8, 'hovering 1h candle must draw reference lines');
assert.equal([...lines][0].price, buy.entry_price);

lab.onTrancheClick(100);
assert.equal(lab.selectedMarkerTime, 0, 'clicking tranche on 1h must select the 1h mapped time');
assert.equal([...lines][0].price, buy.entry_price, 'tranche click on 1h must draw entry and profit lines');

lab.setChartInterval('5m');
assert.equal(lab.chartInterval, '5m');
assert.equal(rendered[0].time, 100, '5m marker time restored on 5m interval');
assert.equal(rendered[1].time, 200, '5m marker time restored on 5m interval');

console.log('Strategy Lab real crosshair callback regression checks passed');
