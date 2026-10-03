const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const componentSource = fs.readFileSync(path.join(__dirname, '../strategy-execution-chart.js'), 'utf8');
const start = html.indexOf('      shortSpreadProfitLadder(entrySpread');
const end = html.indexOf('      renderShortTermChart(data)', start);
assert.ok(start >= 0 && end > start, 'profit ladder method must exist before chart rendering');
const method = html.slice(start, end);
const engine = vm.runInNewContext(`({${method}})`, { Number, Array, window: {HeldPairPnl: require("../held-pair-pnl.js")} });

const levels = engine.shortSpreadProfitLadder(140, 5);
assert.equal(levels.length, 8, 'ladder should include break-even, +0.2%, +0.5%, and +1% through +5%');
assert.equal(levels[0].title, 'B/E');
assert.equal(levels[1].title, 'NET +0.2%');
assert.equal(levels[2].title, 'NET +0.5%');
assert.equal(levels[3].title, 'NET +1%');
assert.equal(levels[7].title, 'NET +5%');
assert.ok(levels[0].price < 140, 'break-even must recover estimated round-trip costs');
assert.ok(levels[1].price < levels[0].price, 'higher short-spread profit requires more convergence');
assert.ok(Math.abs(levels[0].price - (140 / 1.0016)) < 1e-10);
assert.ok(Math.abs(levels[1].price - (140 / 1.0036)) < 1e-10);
assert.ok(Math.abs(levels[2].price - (140 / 1.0066)) < 1e-10);
assert.ok(Math.abs(levels[5].price - (140 / 1.0316)) < 1e-10);
assert.equal(engine.shortSpreadProfitLadder(0).length, 0);

assert.ok(componentSource.includes('rgba(22, 163, 74, 0.18)'), 'net-profit lines must remain visually subtle');
assert.ok(componentSource.includes('lineStyle: this.lineStyle.Dashed'), 'profit ladder must use dashed lines');
let cleared = 0;
engine.clearShortTermReferenceLines = () => {cleared++;};
engine.renderShortTermReferenceLines(140);
engine.renderCurrentPositionReferenceLines();
assert.equal(cleared, 2, 'stale reference levels must be removed before drawing');
let rendered;
engine.executionChartController = {renderReferenceLines: config => {rendered=config; return [];}};
engine.shortTermHistory = {bars:[{time:1,csop:5,domestic:100}]};
engine.renderShortTermReferenceLines(140);
assert.equal(rendered.entry,140);
assert.equal(rendered.levels.length,0,'missing paired cost data must not invent profit levels');
assert.ok(html.includes('this.isConditionEnabled("entry_base_spread", criteria.condition_toggles)'),
  'scale-in line visibility must follow entry condition #2');
assert.ok(componentSource.includes('if (config.showScaleIn && Number(config.scaleInSpread) > 0)'),
  'scale-in line must not render while entry condition #2 is off');
assert.ok(!html.includes('title: "CONVERGENCE REF"'),
  'obsolete global convergence reference line must be removed');
assert.ok(!html.includes('> Convergence ref</span>'),
  'obsolete convergence reference legend must be removed');

console.log('Profit ladder line regression checks passed');
engine.renderShortTermReferenceLines(140, {model:{adr_exit_qty:.07,stock_exit_qty:1.2,
 adr_entry_price:140,stock_entry_price:5,entry_fees_usd:.01,entry_time_ms:1000,
 exit_fee_bps:5,slippage_bps:3,funding_reserve_bps_day:3,threshold_usd:.02}});
assert.equal(rendered.levels.length,9,'entry hover must actually pass all paired profit levels to chart renderer');
assert.ok(rendered.levels.some(level=>level.title.startsWith('Min profit')));
