const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const componentSource = fs.readFileSync(path.join(__dirname, '../strategy-execution-chart.js'), 'utf8');
const lighterTabSource = fs.readFileSync(path.join(__dirname, '../lighter-tab.js'), 'utf8');
const start = html.indexOf('      observedPairExitFeeBps()');
const end = html.indexOf('      renderShortTermChart(data)', start);
assert.ok(start >= 0 && end > start, 'fill-based profit lines must exist before chart rendering');
const method = html.slice(start, end);
const engine = vm.runInNewContext(`({${method}})`, { Number, Array, Set, window: {HeldPairPnl: require("../held-pair-pnl.js")} });
assert.ok(!html.includes('const roundTripCostRate = 16 / 10000'), 'Tab 2 must not retain the unused fixed-cost ladder');

assert.ok(componentSource.includes('rgba(22, 163, 74, 0.18)'), 'net-profit lines must remain visually subtle');
assert.ok(componentSource.includes('lineStyle: this.lineStyle.Dashed'), 'profit ladder must use dashed lines');
assert.ok(componentSource.includes('compactProfitLineTitle'), 'shared controller must compact profit-line axis labels');
assert.ok(componentSource.includes('return "B/E"'), 'break-even axis label must remain compact');
assert.ok(lighterTabSource.includes('axisTitle: `MOVE +${netProfitPct}%`'),
  'Tab 3 must label ratio movement as MOVE rather than implying paired P&L');
assert.ok(lighterTabSource.includes('const netProfitTargets = [0.2, 0.5,'),
  'Tab 3 must not duplicate the separate entry line with a zero-move level');
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
engine.state = {hedgedStatus: {recent_executions: [
  {symbol:'SKHYUSDT',commission_asset:'USDT',commission:.04,qty:1,price:100,time:1},
  {symbol:'CSOPSKHYNIX2LUSDT',commission_asset:'USDT',commission:.04,qty:10,price:10,time:2},
  {symbol:'SKHYUSDT',commission_asset:'USDT',commission:.04,qty:1,price:100,time:3},
  {symbol:'CSOPSKHYNIX2LUSDT',commission_asset:'USDT',commission:.04,qty:10,price:10,time:4},
]}};
assert.ok(Math.abs(engine.observedPairExitFeeBps() - 4) < 1e-10);
engine.renderShortTermReferenceLines(140, {model:{adr_exit_qty:.07,stock_exit_qty:1.2,
 adr_entry_price:140,stock_entry_price:5,entry_fees_usd:.01,entry_time_ms:1000,
 exit_fee_bps:5,slippage_bps:3,funding_reserve_bps_day:3,threshold_usd:.02}});
assert.equal(rendered.levels.length,9,'entry hover must actually pass all paired profit levels to chart renderer');
assert.equal(rendered.entryDirection, 'short', 'Tab 2 paired model is explicitly a short-spread ladder');
assert.ok(rendered.levels.some(level=>level.title.startsWith('Min profit')));
const expected = require('../held-pair-pnl.js').profitLevels({
 adr_exit_qty:.07,stock_exit_qty:1.2,adr_entry_price:140,stock_entry_price:5,
 entry_fees_usd:.01,entry_time_ms:1000,exit_fee_bps:4,funding_reserve_bps_day:3,
 threshold_usd:.02},engine.shortTermHistory.bars[0],301000);
assert.ok(Math.abs(rendered.levels[0].price - expected[0].price) < 1e-10,
 'hover target must use the observed fee rate, not the model fallback');
