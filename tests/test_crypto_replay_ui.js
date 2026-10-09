const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const elements = new Map();
const pillEvents = {};
elements.set('cryptoMatchPill', {
  style: {}, dataset: {}, setAttribute() {},
  addEventListener(type, handler) { pillEvents[type] = handler; },
});
elements.set('crypto_btnMatchLiveReplay', {});
for (const suffix of ['EntryMaStretch', 'EntryBase', 'EntryPeak', 'EntryMaStack5m',
  'ExitConvergence', 'ExitDwell', 'ExitBottoming']) {
  elements.set(`crypto_chkCond${suffix}`, {checked: true});
}
const context = {
  window: {},
  document: {getElementById: (id) => elements.get(id), readyState: 'loading', addEventListener() {}},
  URLSearchParams, console,
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../crypto-tab.js'), 'utf8'), context);
const engine = context.window.cryptoEngine;
engine.currentParadigm = 'grid';
engine.interval = '5m';
engine.botState = {
  enabled: false, strategy_mode: 'grid', strategy_interval: '5m',
  strategy_params: {entry_z: 1.5, exit_z: .25},
};
engine.updateRulesMatchStatus();
assert.match(elements.get('cryptoMatchPill').textContent, /PAPER SETTINGS DIFFER/);
assert.equal(elements.get('crypto_btnMatchLiveReplay').disabled, false);
assert.equal(typeof pillEvents.click, 'function');

let replayCalls = 0;
engine.setParadigm = (mode) => { engine.currentParadigm = mode; };
engine.refreshChart = () => {};
engine.runBacktest = () => { replayCalls++; };
pillEvents.click();
assert.equal(elements.get('crypto_chkCondEntryBase').checked, false);
assert.equal(elements.get('crypto_chkCondEntryPeak').checked, false);
assert.equal(elements.get('crypto_chkCondEntryMaStack5m').checked, false);
assert.equal(elements.get('crypto_chkCondExitDwell').checked, false);
assert.equal(elements.get('crypto_chkCondExitBottoming').checked, false);
assert.match(elements.get('cryptoMatchPill').textContent, /PAPER ALIGNED TO SAVED BOT THRESHOLDS/);
assert.equal(elements.get('crypto_btnMatchLiveReplay').disabled, true);
assert.equal(replayCalls, 1);

// Live thresholds need to flow into the next paper replay, even for Grid.
engine.botState.strategy_params = {entry_z: 2, exit_z: .4};
engine.updateRulesMatchStatus();
pillEvents.click();
assert.equal(engine.replaySettings().entry_z, 2);
assert.equal(engine.replaySettings().exit_z, .4);
assert.equal(replayCalls, 2);

// The visible Grid controls drive the same values sent to replay.
assert.doesNotMatch(engine.gridMatrixTemplate(), /ARMED|Round-Trip Est. PnL/);
const gridEvents = {};
for (const [id, value, min, max] of [
  ['crypto_gridReplayEntryZ', '2', '0.1', '10'],
  ['crypto_gridReplayExitZ', '0.4', '0', '5'],
]) {
  elements.set(id, { value, min, max, addEventListener(type, handler) { gridEvents[id] = handler; } });
}
elements.set('crypto_gridReplayRerun', {addEventListener() {}});
engine.bindGridMatrixEvents();
elements.get('crypto_gridReplayEntryZ').value = '2.6';
gridEvents.crypto_gridReplayEntryZ();
assert.equal(engine.replaySettings().entry_z, 2.6);
assert.equal(replayCalls, 3);
elements.get('crypto_gridReplayExitZ').value = '0.35';
gridEvents.crypto_gridReplayExitZ();
assert.equal(engine.replaySettings().exit_z, 0.35);
assert.equal(replayCalls, 4);

console.log('Crypto Tab 4 live-match replay checks passed');
