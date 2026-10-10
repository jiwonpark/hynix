const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const start = html.indexOf('const terminalLockManager = {');
const endMarker = 'window.terminalLockManager = terminalLockManager;';
const end = html.indexOf(endMarker, start) + endMarker.length;
assert(start >= 0 && end > start);

const control = (id, unavailable = false) => ({
  id, tagName: 'INPUT', disabled: false,
  dataset: { terminalUnavailable: String(unavailable) },
});
const entry = control('btnStepTranche');
const exit = control('btnReduceTranche');
const optional = control('chkCondEntryBase');
const mandatory = control('chkCondEntryCapacity', true);
const actionControls = [entry, exit, optional, mandatory];
let synced = 0;
const window = {
  currentLang: 'en',
  tradingEngine: { state: { hedgedStatus: { authenticated: true, speculative_tranches_active: 1,
    auto_tranche_criteria: { can_scale_in: false, can_take_profit: true } } } },
  lighterEngine: { applyExecutionLock() { synced++; } },
  cryptoEngine: { applyExecutionLock() { synced++; } },
  lighterCryptoEngine: { applyExecutionLock() { synced++; } },
};
const document = { querySelectorAll() { return actionControls; } };
const context = { window, document, $: () => null, clearTimeout, setTimeout };
vm.createContext(context);
vm.runInContext(`${html.slice(start, end)}\nwindow.lock = terminalLockManager;`, context);
window.lock.applyState();
assert(actionControls.every((item) => item.disabled));
window.lock.isLocked = false;
window.lock.applyState();
assert.equal(optional.disabled, false, 'usable condition unlocks');
assert.equal(mandatory.disabled, true, 'mandatory safeguard stays unavailable');
assert.equal(entry.disabled, true, 'ineligible live entry stays blocked');
assert.equal(exit.disabled, false, 'eligible live exit unlocks');
assert.equal(synced, 6, 'each trading tab refreshes on lock and unlock');

for (const [file, engineName, prefix] of [
  ['lighter-tab.js', 'lighterEngine', 'lighter_'],
  ['crypto-tab.js', 'cryptoEngine', 'crypto_'],
  ['lighter-crypto-tab.js', 'lighterCryptoEngine', 'lighterCrypto_'],
]) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, { id, disabled: true, style: {}, dataset: {} });
    return elements.get(id);
  };
  const browser = {
    terminalLockManager: { isLocked: false },
    addEventListener() {},
  };
  const sandbox = {
    window: browser,
    document: { readyState: 'loading', addEventListener() {}, getElementById: el },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox);
  const engine = browser[engineName];
  engine.liveVenue = { execution_enabled: true };
  engine.botState = { enabled: false, recovery_required: false };
  engine.currentParadigm = 'grid';
  engine.applyExecutionLock();
  assert.equal(el(`${prefix}chkAutoPeriodic48h`).disabled, false, `${file}: live toggle unlocks`);
  assert.equal(el(`${prefix}inputLiveTradeRate`).disabled, false, `${file}: live rate unlocks`);
  assert.equal(el(`${prefix}btnSaveLiveCooldown`).disabled, false, `${file}: save unlocks`);
  if (file === 'lighter-tab.js') {
    assert.equal(el(`${prefix}inputLiveMinProfitPct`).disabled, false, `${file}: profit hurdle unlocks`);
  } else {
    assert.equal(el(`${prefix}inputLiveGridEntryZ`).disabled, false, `${file}: Grid threshold unlocks`);
    engine.botState.enabled = true;
    engine.applyExecutionLock();
    assert.equal(el(`${prefix}inputLiveGridEntryZ`).disabled, true, `${file}: active Grid threshold stays blocked`);
    assert.equal(el(`${prefix}inputLiveTradeRate`).disabled, false, `${file}: rate remains adjustable`);
  }
  engine.botState.enabled = false;
  engine.liveVenue.execution_enabled = false;
  engine.applyExecutionLock();
  assert.equal(el(`${prefix}chkAutoPeriodic48h`).disabled, true, `${file}: unavailable venue cannot start bot`);
  browser.terminalLockManager.isLocked = true;
  engine.applyExecutionLock();
  assert.equal(el(`${prefix}inputLiveTradeRate`).disabled, true, `${file}: relock disables live settings`);
}

console.log('Terminal unlock respects active controls and execution safeguards across trading tabs');
