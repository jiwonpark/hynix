const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const TerminalCommon = require('../terminal-common.js');

function load(file, name, elements = new Map(), data = {}) {
  const context = {window: {requestAnimationFrame() {}},
    document: {readyState: 'loading', addEventListener() {}, getElementById: id => elements.get(id)},
    fetch: async () => ({ok: true, json: async () => data}), TerminalCommon, URLSearchParams, console};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve(`../${file}`), 'utf8'), context);
  return context.window[name];
}

(async () => {
  const data = {
    entry_signals: [{time: 100, price: 100, side: 1}, {time: 200, price: 105, side: 1},
      {time: 400, price: 110, side: 1}],
    trades: [{entry_time: 100, entry: 100, exit_time: 300, exit: 110, side: 1, pnl_pct: 10}],
    open_positions: [{entry_time: 400, entry: 110, side: 1, unrealized_pnl_pct: 0}],
    summary: {trades: 1, win_rate: 100, net_pct: 10}, metrics: {},
  };
  for (const [file, name] of [['crypto-tab.js', 'cryptoEngine'],
    ['lighter-crypto-tab.js', 'lighterCryptoEngine'], ['lighter-tab.js', 'lighterEngine']]) {
    const engine = load(file, name, new Map(), data);
    engine.bars = [100, 200, 300, 400].map(time => ({time, value: 100}));
    engine.series = {setMarkers() {}};
    engine.actualMarkers = []; engine.ledger = []; engine.entries = [];
    engine.currentParadigm = 'ma_stack';
    engine.updateMarkerState = () => {};
    engine.renderCurrentPositionReferenceLines = () => {};
    engine.updateRulesMatchStatus = () => {};
    engine.renderReplayConditionStatus = () => {};
    await engine.runBacktest();
    assert.equal(engine.backtestMarkers.filter(m => m.is_signal).length, 3, `${file}: keep signals while position is open`);
    const pairs = engine.getTradePairs();
    assert.equal(pairs.length, 1, `${file}: retain simulated fill/exit connection`);
    assert.equal(pairs[0].entry.rawTime, 100, `${file}: exit links to filled signal, not later unfilled signal`);
    const unfilled = engine.rawExecutionMarkers.find(m => m.rawTime === 200);
    assert.equal(unfilled.is_simulated_fill, undefined);
    assert(engine.rawExecutionMarkers.find(m => m.rawTime === 400).is_open);
  }

  const controls = new Map([
    ['crypto_maUseDiffHook', {checked: false}], ['crypto_maUseDiffExit', {checked: true}],
  ]);
  const crypto = load('crypto-tab.js', 'cryptoEngine', controls);
  crypto.currentParadigm = 'ma_stack';
  assert.equal(crypto.replaySettings().use_ma_diff_hook, false);
  assert.equal(crypto.liveStrategyPayload().use_ma_diff_hook, false);
  assert.equal(crypto.replaySettings().use_ma_diff_exit, true);
  controls.get('crypto_maUseDiffExit').checked = false;
  assert.equal(crypto.liveStrategyPayload().use_ma_diff_exit, false);
  controls.clear();
  crypto.botState = {strategy_mode: 'ma_stack', use_ma_diff_hook: false, use_ma_diff_exit: false};
  assert.equal(crypto.replaySettings().use_ma_diff_hook, false, 'honor saved OFF settings before controls mount');

  const pill = {style: {}, dataset: {}, setAttribute() {}, addEventListener() {}};
  const matchButton = {};
  const lighter = load('lighter-crypto-tab.js', 'lighterCryptoEngine', new Map([
    ['lighterCryptoMatchPill', pill], ['lighterCrypto_btnMatchLiveReplay', matchButton],
  ]));
  const settings = {strategy_mode: 'ma_stack', interval: '5m', min_diff_bars: 2,
    use_ma_stack: true, use_ma_diff_hook: true, use_ma_diff_exit: true, use_opposite_stack_exit: true};
  lighter.currentParadigm = 'ma_stack'; lighter.interval = '5m';
  lighter.botState = {...settings, strategy_interval: '5m', min_diff_bars: 5};
  lighter.replaySettings = () => settings;
  lighter.renderReplayConditionStatus = () => {};
  lighter.updateRulesMatchStatus();
  assert.match(pill.textContent, /SETTINGS DIFFER/);
  assert.equal(matchButton.disabled, false);
  settings.min_diff_bars = 5;
  lighter.updateRulesMatchStatus();
  assert.match(pill.textContent, /ALIGNED/);
  assert.equal(matchButton.disabled, true);
  console.log('Review regressions: signal links, independent MA controls and threshold alignment passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
