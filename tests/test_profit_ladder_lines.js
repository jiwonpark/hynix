const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('      shortSpreadProfitLadder(entrySpread');
const end = html.indexOf('      renderShortTermChart(data)', start);
assert.ok(start >= 0 && end > start, 'profit ladder method must exist before chart rendering');
const method = html.slice(start, end);
const engine = vm.runInNewContext(`({${method}})`, { Number, Array });

const levels = engine.shortSpreadProfitLadder(140, 5);
assert.equal(levels.length, 6, 'ladder should include break-even and net +1% through +5%');
assert.equal(levels[0].title, 'B/E');
assert.equal(levels[1].title, 'NET +1%');
assert.equal(levels[5].title, 'NET +5%');
assert.ok(levels[0].price < 140, 'break-even must recover estimated round-trip costs');
assert.ok(levels[1].price < levels[0].price, 'higher short-spread profit requires more convergence');
assert.ok(Math.abs(levels[0].price - (140 / 1.0016)) < 1e-10);
assert.ok(Math.abs(levels[3].price - (140 / 1.0316)) < 1e-10);
assert.equal(engine.shortSpreadProfitLadder(0).length, 0);

assert.ok(html.includes('rgba(22, 163, 74, 0.18)'), 'net-profit lines must remain visually subtle');
assert.ok(html.includes('lineStyle: LightweightCharts.LineStyle.Dashed'), 'profit ladder must use dashed lines');
assert.ok(html.includes('this.shortTermPriceLines.push'), 'ladder lines must share the existing cleanup lifecycle');

console.log('Profit ladder line regression checks passed');
