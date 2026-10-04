const assert = require('node:assert/strict');
const Controller = require('../strategy-execution-chart.js');
function chart(queue) {
  let range = null;
  const listeners = new Set();
  const scale = {
    getVisibleLogicalRange: () => range,
    setVisibleLogicalRange(value) {
      range = {...value};
      for (const listener of listeners) {
        if (queue) queue.push(() => listener(value));
        else listener(value);
      }
    },
    subscribeVisibleLogicalRangeChange: cb => listeners.add(cb),
    unsubscribeVisibleLogicalRangeChange: cb => listeners.delete(cb),
  };
  return {timeScale: () => scale, applyOptions(options) {this.options = options;}};
}
for (const deferred of [false, true]) {
  const queue = deferred ? [] : null;
  const flush = () => {let limit = 100; while (queue?.length && limit--) queue.shift()(); assert.ok(limit > 0, 'no feedback loop');};
  const a = chart(queue), b = chart(queue);
  const sync = Controller.linkTimeScales(a, b, cb => cb());
  for (let i = 0; i < 10; i++) a.timeScale().setVisibleLogicalRange({from: i + .25, to: 100 - i});
  flush();
  assert.deepEqual(b.timeScale().getVisibleLogicalRange(), {from:9.25, to:91}, 'rapid zoom keeps final range');
  b.timeScale().setVisibleLogicalRange({from:-50, to:25});
  flush();
  assert.deepEqual(a.timeScale().getVisibleLogicalRange(), {from:-50, to:25}, 'price pane pans premium pane');
  sync.pause();
  a.timeScale().setVisibleLogicalRange({from:100, to:175});
  b.timeScale().setVisibleLogicalRange({from:0, to:75});
  flush();
  sync.resume();
  flush();
  assert.deepEqual(b.timeScale().getVisibleLogicalRange(), {from:100, to:175}, 'batched prepend restores authoritative range');
  assert.deepEqual(a.options, b.options, 'same gutters and spacing constraints');
  sync.dispose();
  a.timeScale().setVisibleLogicalRange({from:1,to:2});
  flush();
  assert.deepEqual(b.timeScale().getVisibleLogicalRange(), {from:100, to:175});
}
const bars = times => times.map(time => ({time}));
assert.deepEqual(Controller.preserveRange({from:.5,to:2.5},bars([1,2,3,4,5]),bars([2,3,4,5,6])), {from:-.5,to:1.5});
assert.deepEqual(Controller.preserveRange({from:2,to:5},bars([1,2,3,4,5]),bars([2,3,4,5,6])), {from:2,to:5});
assert.deepEqual(Controller.preserveRange({from:.5,to:2.5},bars([3,4,5,6,7]),bars([1,2,3,4,5,6,7])), {from:2.5,to:4.5});
console.log('Chart synchronization tests passed');

const fs = require('node:fs');
const vm = require('node:vm');
const lighter = fs.readFileSync(require.resolve('../lighter-tab.js'), 'utf8');
const alignMethod = lighter.slice(lighter.indexOf('    alignChartOverlay(layer) {'), lighter.indexOf('    renderTrendRanges() {'));
const overlayEngine = vm.runInNewContext(`({${alignMethod}})`);
overlayEngine.chart = {priceScale: () => ({width: () => 80}), timeScale: () => ({width: () => 988})};
const layer = {style:{}};
assert.equal(overlayEngine.alignChartOverlay(layer), 988);
assert.deepEqual(layer.style, {left:'80px', right:'auto', width:'988px'});

assert.deepEqual(Controller.initialRange(120), {from:11.5, to:119.5});
assert.deepEqual(Controller.initialRange(300), {from:29.5, to:299.5});
assert.deepEqual(Controller.initialRange(80), {from:7.5, to:79.5});
assert.deepEqual(Controller.initialRange(1), {from:-.5, to:.5});
assert.equal(Controller.initialRange(0), null);

// Model the real chart API: setters queue a draw, getters still return the old range.
const frames = [];
function delayedChart() {
  const c = chart();
  const apply = c.timeScale().setVisibleLogicalRange;
  c.timeScale().setVisibleLogicalRange = range => frames.push(() => apply(range));
  return c;
}
const primary = delayedChart(), secondary = delayedChart();
const linked = Controller.linkTimeScales(primary, secondary, cb => frames.push(cb));
const initial = Controller.initialRange(120);
linked.setRange(initial);
assert.deepEqual(linked.getRange(), initial, 'redraws must see the requested viewport before the next draw');
linked.pause();
linked.resume();
while (frames.length) frames.shift()();
assert.deepEqual(primary.timeScale().getVisibleLogicalRange(), initial);
assert.deepEqual(secondary.timeScale().getVisibleLogicalRange(), initial);
