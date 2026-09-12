const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('      executionMarkerTimeAtX(mouseX)');
const end = html.indexOf('      updateMarkerState(hoveredTime = null)', start);
const method = html.slice(start, end);
const host = {clientWidth: 600};
const context = vm.createContext({$: () => host, Number, Math});
const chart = {
  timeScale: () => ({
    getVisibleLogicalRange: () => ({from: 0, to: 60}),
    timeToCoordinate: time => time / 10,
  }),
};
const engine = vm.runInContext(`({
  shortTermChart: chart,
  rawExecutionMarkers: [{time: 1000}, {time: 2000}],
  ${method}
})`, vm.createContext({...context, chart}));

assert.equal(engine.executionMarkerTimeAtX(105), 1000,
  'the entire x-column should activate a marker');
assert.equal(engine.executionMarkerTimeAtX(105), engine.executionMarkerTimeAtX(105),
  'hover selection must not depend on mouse y');
assert.equal(engine.executionMarkerTimeAtX(150), null,
  'unrelated chart columns must not activate a marker');
assert.equal(engine.executionMarkerTimeAtX(196), 2000,
  'the closest visible marker should activate by x-coordinate');

console.log('Trade marker x-hover regression checks passed');
