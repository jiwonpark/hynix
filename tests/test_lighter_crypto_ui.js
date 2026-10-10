const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const common = fs.readFileSync(path.join(root, 'terminal-common.js'), 'utf8');
const lighter = fs.readFileSync(path.join(root, 'lighter-crypto-tab.js'), 'utf8');

assert.match(html, /id="navTabLighterCrypto"/);
assert.match(html, /id="tabContentLighterCrypto"/);
assert.match(html, /lighter-crypto-tab\.js/);
assert.match(common, /venue: "lighterCrypto", prefix: "lighterCrypto_"/);
assert.match(lighter, /\/api\/lighter-crypto\/status/);
assert.match(lighter, /\/api\/lighter-crypto\/bot\/toggle/);
assert.match(lighter, /market_source=lighter/);
assert.doesNotMatch(lighter, /\/api\/crypto\//);

const context = {
  window: {},
  document: { readyState: 'loading', addEventListener() {}, getElementById() { return null; } },
  URLSearchParams, console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'crypto-tab.js'), 'utf8'), context);
vm.runInContext(lighter, context);
assert.notEqual(context.window.cryptoEngine, context.window.lighterCryptoEngine);
assert.equal(context.window.cryptoEngine.selectedSymbol, 'BTCUSDT');
assert.equal(context.window.lighterCryptoEngine.selectedSymbol, 'BTC');
assert.equal(context.window.lighterCryptoEngine.replaySettings().symbol, 'BTC');
console.log('Independent Binance Tab 4 and Lighter Tab 5 UI checks passed');
