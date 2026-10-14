const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const lighterJs = fs.readFileSync(path.join(root, 'lighter-tab.js'), 'utf8');

// Verify static code expectations
assert.match(lighterJs, /cryptoDirectionalScalingBox[\s\S]*display\s*=\s*"block"/);
assert.match(lighterJs, /rangeCryptoLongMultiplier/);
assert.match(lighterJs, /inputCryptoLongMultiplier/);
assert.match(lighterJs, /rangeCryptoShortMultiplier/);
assert.match(lighterJs, /inputCryptoShortMultiplier/);
assert.match(lighterJs, /longMultiplier\s*\(/);
assert.match(lighterJs, /shortMultiplier\s*\(/);
assert.match(lighterJs, /orderNotional\s*\(/);
assert.match(lighterJs, /renderCryptoNotionals\s*\(/);
assert.match(lighterJs, /saveCryptoScaling\s*\(/);
assert.match(lighterJs, /lastUserMultiplierUpdate/);
assert.match(lighterJs, /long_multiplier:\s*this\.longMultiplier\(\)/);
assert.match(lighterJs, /short_multiplier:\s*this\.shortMultiplier\(\)/);

// Test runtime behavior via VM
const elementMap = new Map();
function createMockEl(id, tagName = 'div') {
  const el = {
    id,
    tagName: tagName.toUpperCase(),
    value: '',
    textContent: '',
    style: {},
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    dataset: {},
    disabled: false,
    addEventListener(event, handler) {
      if (!this._listeners) this._listeners = {};
      if (!this._listeners[event]) this._listeners[event] = [];
      this._listeners[event].push(handler);
    },
    dispatchEvent(event) {
      const handlers = this._listeners?.[event.type] || [];
      handlers.forEach((h) => h(event));
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    prepend() {},
    appendChild() {},
    setAttribute() {},
    removeAttribute() {},
  };
  elementMap.set(id, el);
  return el;
}

const context = {
  window: {},
  document: {
    readyState: 'complete',
    activeElement: null,
    addEventListener() {},
    getElementById(id) {
      return elementMap.get(id) || null;
    },
    createElement(tag) {
      return createMockEl(`mock_${Math.random()}`, tag);
    },
    querySelectorAll() { return []; },
  },
  URLSearchParams,
  console,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  Number,
  parseFloat,
  parseInt,
};

vm.createContext(context);
vm.runInContext(lighterJs, context);

const engine = context.window.lighterEngine;
assert.ok(engine, 'lighterEngine should be defined on window');

// Setup mock DOM elements with lighter_ prefix
const elNotional = createMockEl('lighter_inputOrderNotional', 'input');
elNotional.value = '50';
const elLongRange = createMockEl('lighter_rangeCryptoLongMultiplier', 'input');
elLongRange.value = '2.00';
const elLongInp = createMockEl('lighter_inputCryptoLongMultiplier', 'input');
elLongInp.value = '2.00';
const elShortRange = createMockEl('lighter_rangeCryptoShortMultiplier', 'input');
elShortRange.value = '1.50';
const elShortInp = createMockEl('lighter_inputCryptoShortMultiplier', 'input');
elShortInp.value = '1.50';
const elLongBadge = createMockEl('lighter_badgeCryptoLongMultiplier', 'span');
const elShortBadge = createMockEl('lighter_badgeCryptoShortMultiplier', 'span');
const elLongLbl = createMockEl('lighter_lblCryptoLongNotional', 'div');
const elShortLbl = createMockEl('lighter_lblCryptoShortNotional', 'div');
const elBox = createMockEl('lighter_cryptoDirectionalScalingBox', 'div');

// Test multipliers
assert.equal(engine.longMultiplier(), 2.0);
assert.equal(engine.shortMultiplier(), 1.5);

// Test orderNotional with directional scaling
assert.equal(engine.orderNotional(1), 100.0); // 50 * 2.0
assert.equal(engine.orderNotional(-1), 75.0); // 50 * 1.5
assert.equal(engine.orderNotional(0), 50.0);  // base

// Test renderCryptoNotionals
engine.renderCryptoNotionals();
assert.equal(elLongLbl.textContent, 'Long: $100 (2.00×)');
assert.equal(elShortLbl.textContent, 'Short: $75 (1.50×)');

// Test replaySettings includes multipliers
const settings = engine.replaySettings();
assert.equal(settings.long_multiplier, 2.0);
assert.equal(settings.short_multiplier, 1.5);

// Test interaction guard in updateBotStatus
engine.lastUserMultiplierUpdate = Date.now(); // user recently dragged
engine.updateBotStatus({ long_multiplier: 1.0, short_multiplier: 1.0 });
// Because within 5 seconds, slider values should NOT be overwritten by background status
assert.equal(elLongInp.value, '2.00');
assert.equal(elShortInp.value, '1.50');

// When cooldown expires, updateBotStatus should sync
engine.lastUserMultiplierUpdate = Date.now() - 6000;
engine.updateBotStatus({ long_multiplier: 3.5, short_multiplier: 4.0 });
assert.equal(elLongInp.value, '3.50');
assert.equal(elShortInp.value, '4.00');
assert.equal(elLongBadge.textContent, '3.50×');
assert.equal(elShortBadge.textContent, '4.00×');

console.log('✅ Tab 3 multiplier slider unit tests passed successfully');
