const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '../lighter-tab.js'), 'utf8');

assert.ok(code.includes('lighter_selTrancheDirection'), 'must inject lighter_selTrancheDirection');
assert.ok(code.includes('PAPER SIMULATION ONLY'), 'must display paper simulation badge');
assert.ok(code.includes('Close All Paper Tranches'), 'must label exit button clearly');
assert.ok(code.includes('➕ Add Paper Tranche'), 'must label add button clearly');

assert.ok(code.includes('window.showToast'), 'must call window.showToast for feedback');
assert.ok(code.includes('Paper Tranche #'), 'must notify when paper tranche is added');
assert.ok(code.includes('Closed'), 'must notify when paper tranches are closed');

assert.ok(code.includes('dirSelect.value === "short"'), 'must support manual short parity selection');
assert.ok(code.includes('dirSelect.value === "long"'), 'must support manual long parity selection');
assert.ok(code.includes('side = -1'), 'must assign negative side for short parity');
assert.ok(code.includes('side = 1'), 'must assign positive side for long parity');

console.log('Lighter paper tranche UI & direction checks passed');
