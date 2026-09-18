const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Controller = require('../strategy-execution-chart.js');

const host = { clientWidth: 600, setAttribute() {} };
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
console.log('Strategy Lab real crosshair callback regression checks passed');
