const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

// Ensure isKrw is defined inside renderUpbitTable and onTabActivated triggers backend sync
assert(html.includes('const isKrw = a.currency === "KRW";'), "isKrw must be defined in renderUpbitTable");
assert(html.includes('this.syncWithBackend();'), "syncWithBackend must be called in onTabActivated");
assert(html.includes('this.fetchHedgedStatus();'), "fetchHedgedStatus must be called in onTabActivated");

// Mock DOM elements
const elements = new Map();
const ids = [
  'valAccountEquity', 'valAvailMargin', 'valUnrealizedPnl', 'valMarginRisk',
  'badgeEquitySource', 'valCollateralPills', 'valActivePairs', 'valUpbitEquity',
  'badgeUpbitSource', 'assetsTableBody', 'countAssets', 'upbitAssetsTableBody',
  'countUpbitAssets', 'valUpbitPaneTotalKrw', 'valUpbitPaneTotalUsd',
  'valUpbitPaneCashKrw', 'valUpbitUsdtRate', 'badgeUpbitPaneAuth'
];
for (const id of ids) {
  elements.set(id, {
    textContent: '',
    innerHTML: '',
    style: {},
    className: '',
    title: ''
  });
}

function $(id) {
  return elements.get(id) || null;
}

const state = {
  accountSyncPending: true,
  equity: 852.14,
  availableMargin: 454.38,
  unrealizedPnl: -129.86,
  marginRatio: 6.46,
  binanceSpotUsdt: 0,
  binanceSpotStablecoinUsd: 0,
  binanceSpotAuthenticated: false,
  backendAuthenticated: true,
  upbitAuthenticated: true,
  upbitAuthSource: "keys.json",
  upbitEquityKrw: 1250000,
  upbitEquityUsd: 890.50,
  upbitCashKrw: 500000,
  usdtKrwRate: 1403.5,
  backendPositions: [{ symbol: "SKHYUSDT", notional: 100 }],
  positions: [],
  orderLog: []
};

const lines = html.split('\n');
const s1 = lines.findIndex(l => l.includes('renderAccountStrip() {'));
const s2 = lines.findIndex(l => l.includes('renderAssetsTable(assets) {'));
const s3 = lines.findIndex(l => l.includes('renderUpbitTable(assets, summary = {}) {'));
const s4 = lines.findIndex((l, idx) => idx > s3 && l.includes('renderPositionsAndLogs() {'));

const window = { currentLang: "en" };
const tradingEngine = { state };

const stripCode = lines.slice(s1 + 1, s2 - 2).join('\n');
const assetsCode = lines.slice(s2 + 1, s3 - 2).join('\n');
const upbitCode = lines.slice(s3 + 1, s4 - 2).join('\n');

tradingEngine.renderAccountStrip = new Function('$', 'window', stripCode).bind(tradingEngine, $, window);
tradingEngine.renderAssetsTable = new Function('$', 'window', 'assets', assetsCode).bind(tradingEngine, $, window);
tradingEngine.renderUpbitTable = new Function('$', 'window', 'assets', 'summary', upbitCode).bind(tradingEngine, $, window);

// Test 1: accountSyncPending = true
tradingEngine.state.accountSyncPending = true;
tradingEngine.renderAccountStrip();
assert.equal($('valAccountEquity').textContent, '—');
assert.equal($('valAvailMargin').textContent, '—');
assert.equal($('badgeEquitySource').textContent, 'SYNCING');

// Test 2: accountSyncPending = false
tradingEngine.state.accountSyncPending = false;
tradingEngine.renderAccountStrip();
assert.equal($('valAccountEquity').textContent, '$852.14');
assert.equal($('valAvailMargin').textContent, '$454.38');
assert.equal($('badgeEquitySource').textContent, 'FUTURES');
assert.match($('valUnrealizedPnl').textContent, /-\$129\.86/);
assert.match($('valMarginRisk').textContent, /6\.5%/);
assert.match($('valUpbitEquity').textContent, /₩1,250,000/);

// Test 3: renderAssetsTable
const sampleAssets = [
  {
    asset: "USDT",
    wallet_balance: 981.9965,
    unrealized_profit: -129.86,
    margin_balance: 852.14,
    available_balance: 454.38,
    max_withdraw_amount: 453.58
  }
];
tradingEngine.renderAssetsTable(sampleAssets);
assert.equal($('countAssets').textContent, 1);
assert.match($('assetsTableBody').innerHTML, /USDT/);
assert.match($('assetsTableBody').innerHTML, /852\.14/);

// Test 4: renderUpbitTable with KRW cash and cryptos
const sampleUpbitAssets = [
  {
    currency: "KRW",
    name: "Korean Won",
    total_quantity: 500000,
    avg_buy_price: 0,
    current_price_krw: 1,
    eval_amount_krw: 500000,
    eval_amount_usd: 356.25,
    unrealized_pnl_krw: 0,
    return_rate_percent: 0
  },
  {
    currency: "BTC",
    name: "Bitcoin",
    total_quantity: 0.005,
    avg_buy_price: 90000000,
    current_price_krw: 95000000,
    eval_amount_krw: 475000,
    eval_amount_usd: 338.44,
    unrealized_pnl_krw: 25000,
    return_rate_percent: 5.56
  }
];
tradingEngine.renderUpbitTable(sampleUpbitAssets, {
  total_equity_krw: 975000,
  total_equity_usd: 694.69,
  cash_krw: 500000,
  usdt_krw_rate: 1403.5
});
assert.equal($('countUpbitAssets').textContent, 2);
assert.match($('upbitAssetsTableBody').innerHTML, /KRW/);
assert.match($('upbitAssetsTableBody').innerHTML, /BTC/);
assert.match($('upbitAssetsTableBody').innerHTML, /\+₩25,000/);

console.log("✅ Tab 2 balance and account info sync tests passed successfully!");
