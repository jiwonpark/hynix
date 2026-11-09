const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TerminalCommon = require('../terminal-common.js');

const points = [
  {time: 1, value: 1},
  {time: 2, value: 3},
  {time: 3, value: 2},
  {time: 4, value: 0},
  {time: 5, value: 2},
  {time: 6, value: 4},
];

assert.deepStrictEqual(
  TerminalCommon.previousLocalExtremumSegment(points, 6),
  [{time: 4, value: 0}, {time: 6, value: 4}],
  'uses the most recent prior local minimum',
);
assert.deepStrictEqual(
  TerminalCommon.previousLocalExtremumSegment(points, 4),
  [{time: 2, value: 3}, {time: 4, value: 0}],
  'uses the most recent prior local maximum',
);
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment(points, 2), [], 'requires a confirmed earlier turn');
assert.deepStrictEqual(TerminalCommon.previousLocalExtremumSegment([], 6), [], 'handles unavailable MA data');

const writes = [];
const overlays = {
  7: {setData: (data) => writes.push(['7', data]), applyOptions: () => {}},
  24: {setData: (data) => writes.push(['24', data]), applyOptions: () => {}},
};
TerminalCommon.renderMaExtremumHover(overlays, {7: points, 24: points}, 6, {7: true, 24: false});
assert.deepStrictEqual(writes[0][1], [{time: 4, value: 0}, {time: 6, value: 4}]);
assert.deepStrictEqual(writes[1][1], [], 'hidden MAs never leave a hover segment visible');

const root = path.join(__dirname, '..');
for (const [name, file] of [
  ['Tab 2', 'index.html'],
  ['Tab 3', 'lighter-tab.js'],
  ['Tab 4', 'crypto-tab.js'],
  ['Tab 5', 'lighter-crypto-tab.js'],
]) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(source, /createMaExtremumHoverSeries\(/, `${name} creates the shared hover-only MA overlay`);
  assert.match(source, /renderMaExtremumHover\(/, `${name} updates the overlay from its chart crosshair`);
}

console.log('MA extremum hover tests passed');
