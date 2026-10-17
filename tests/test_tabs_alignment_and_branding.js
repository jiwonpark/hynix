const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const termCommon = fs.readFileSync(path.join(root, 'terminal-common.js'), 'utf8');
const lighterTab = fs.readFileSync(path.join(root, 'lighter-tab.js'), 'utf8');
const lighterCryptoTab = fs.readFileSync(path.join(root, 'lighter-crypto-tab.js'), 'utf8');
const cryptoTab = fs.readFileSync(path.join(root, 'crypto-tab.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

// 1. Check terminal-common handles Lighter sanitization
assert(termCommon.includes('options.venue.toLowerCase().includes("lighter")'), 'terminal-common must sanitize lighter venues');
assert(termCommon.includes('Lighter Account Equity'), 'terminal-common must map equity');

// 2. Check Tab 3 labelTerminal and TreeWalker replaces Binance
assert(lighterTab.includes('Lighter Account Collateral') || lighterTab.includes('Lighter Account Equity'), 'lighter-tab has Lighter equity label');
assert(lighterTab.includes('LIGHTER DEX LIVE ENGINE'), 'lighter-tab has LIGHTER DEX LIVE ENGINE');
assert(lighterTab.includes('Lighter Collateral ('), 'lighter-tab has Lighter Collateral tab');
assert(!lighterTab.includes('entry.parentNode.insertBefore(dirSelect, entry);'), 'dirSelect must not be inserted before entry');

// 3. Check Tab 4 and 5 OU quant alignment
assert(cryptoTab.includes('crypto_ouHalflifeMax'), 'cryptoTab must have ouHalflifeMax');
assert(cryptoTab.includes('crypto_LiveRiskBudget'), 'cryptoTab must have crypto_LiveRiskBudget');
assert(cryptoTab.includes('crypto_valOuMacroSlope'), 'cryptoTab must have crypto_valOuMacroSlope');
assert(cryptoTab.includes('crypto_valOuZScore'), 'cryptoTab must have crypto_valOuZScore');

// 4. Check Tab 5 labels
assert(lighterCryptoTab.includes('LIGHTER DEX LIVE ENGINE · SINGLE-LEG PERP'), 'lighterCryptoTab has proper badge');
assert(lighterCryptoTab.includes('Lighter Account Equity'), 'lighterCryptoTab has Lighter equity');

console.log('✅ All tab alignment and branding checks passed successfully!');
