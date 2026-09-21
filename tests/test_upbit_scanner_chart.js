const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

assert.match(html, /id="upbitCoinChartHost"/);
assert.match(html, /data-market="\$\{esc\(row\.market\)\}"/);
assert.match(html, /this\.openChart\(row\.dataset\.market\)/);
assert.match(html, /api\/upbit\/coin-chart\?\$\{params\}/);
assert.match(html, /addCandlestickSeries/);
assert.match(html, /movingAverage\(candles, 24\)/);
assert.match(html, /Purged Walk-Forward Backtest/);
assert.match(html, /renderBacktest\(row\?\.backtest\)/);
assert.match(html, /upbitBtBrier/);
assert.match(html, /data-interval="15"/);
assert.match(html, /data-interval="240"/);

console.log('Upbit scanner chart regression checks passed');
