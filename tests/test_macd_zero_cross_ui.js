const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function load(file, globalName, prefix, defaultMode) {
  const nodes = new Map();
  const storage = new Map();
  const localStorage = {getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value)};
  const context = {
    window: {}, URLSearchParams, console, localStorage, clearTimeout() {}, setTimeout() {return 1;},
    document: {
      readyState: "loading",
      addEventListener() {},
      getElementById(id) { return nodes.get(id) || null; },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync("terminal-common.js", "utf8"), context);
  context.TerminalCommon = context.window.TerminalCommon;
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const engine = context.window[globalName];
  engine.botState = {strategy_mode:"macd_zero_cross"};
  engine.currentParadigm = "macd_zero_cross";
  engine.interval = "5m";
  nodes.set(`${prefix}macdFastPeriod`, {value: "8"});
  nodes.set(`${prefix}macdSlowPeriod`, {value: "21"});
  nodes.set(`${prefix}macdSignalPeriod`, {value: "5"});
  nodes.set(`${prefix}macdZeroUseCross`, {checked: true});
  nodes.set(`${prefix}macdZeroUseSignalZone`, {checked: false});
  nodes.set(`${prefix}macdZeroUseExitCross`, {checked: false, addEventListener() {}});

  nodes.set(`${prefix}useTakeProfit`, {checked: false});
  nodes.set(`${prefix}takeProfitPct`, {value: "0.35"});
  nodes.set(`${prefix}useHourlyHist`, {checked: true});
  nodes.set(`${prefix}hourlyHistFast`, {value: "8"});
  nodes.set(`${prefix}hourlyHistSlow`, {value: "21"});
  nodes.set(`${prefix}hourlyHistSignal`, {value: "5"});
  const replay = engine.replaySettings();
  const live = engine.liveStrategyPayload(defaultMode);
  for (const settings of [replay, live]) {
    assert.equal(settings.strategy_mode, "macd_zero_cross");
    assert.equal(settings.use_hourly_hist, true);
    assert.equal(settings.hourly_hist_fast, 8);
    assert.equal(settings.hourly_hist_slow, 21);
    assert.equal(settings.hourly_hist_signal, 5);
    assert.equal(settings.use_take_profit, false);
    assert.equal(settings.take_profit_pct, 0.35);
    assert.deepEqual(
      [settings.macd_fast_period, settings.macd_slow_period, settings.macd_signal_period],
      [8, 21, 5],
    );
    assert.equal(settings.use_macd_hist_exit, false);
    assert.equal(settings.use_macd_zero_cross, true);
    assert.equal(settings.use_macd_signal_zone, false);
  }

  for (const suffix of ["LongPaper", "ShortPaper", "PaperSource"]) nodes.set(`${prefix}hourlyHist${suffix}`, {textContent: ""});
  context.TerminalCommon.renderHourlyHistogram(prefix, "Paper", {
    ready:true,long_ok:true,short_ok:false,source_time:100,periods:[8,21,5],
    source:"COMPLETED_1H_MACD_SIGNAL_SECOND_DIFF",signal:2,previous_signal:1,previous2_signal:1,signal_delta:1,previous_signal_delta:0,signal_acceleration:1}, true);
  assert.match(nodes.get(`${prefix}hourlyHistLongPaper`).textContent, /PASS/);
  assert.match(nodes.get(`${prefix}hourlyHistShortPaper`).textContent, /WAITING/);
  context.TerminalCommon.renderHourlyHistogram(prefix, "Paper", {ready:true,long_ok:false,short_ok:true,source:"COMPLETED_1H_MACD_SIGNAL_SECOND_DIFF",signal:1,previous_signal:2,previous2_signal:2,signal_delta:-1,previous_signal_delta:0,signal_acceleration:-1}, true);
  assert.match(nodes.get(`${prefix}hourlyHistLongPaper`).textContent, /WAITING/);
  assert.match(nodes.get(`${prefix}hourlyHistShortPaper`).textContent, /PASS/);
  assert.match(nodes.get(`${prefix}hourlyHistPaperSource`).textContent,/Δ²S -1.00000/);
  context.TerminalCommon.renderHourlyHistogram(prefix, "Paper", {ready:true,long_ok:true,histogram:2,slope:1}, true);
  assert.match(nodes.get(`${prefix}hourlyHistLongPaper`).textContent,/UNAVAILABLE/,'old cached histogram-slope data cannot masquerade as the new rule');
  context.TerminalCommon.renderHourlyHistogram(prefix, "Paper", null, true);
  assert.match(nodes.get(`${prefix}hourlyHistLongPaper`).textContent, /UNAVAILABLE/);
  context.TerminalCommon.renderHourlyHistogram(prefix, "Paper", null, false);
  assert.match(nodes.get(`${prefix}hourlyHistShortPaper`).textContent, /OFF/);
  nodes.get(`${prefix}useHourlyHist`).checked=false;
  assert.equal(engine.replaySettings().use_hourly_hist,false);
  assert.equal(engine.liveStrategyPayload(defaultMode).use_hourly_hist,false);

  // Plot, replay, and deploy must consume the same editable periods.
  const plotted = [];
  context.TerminalCommon = {
    movingAverage() { return []; },
    macd(bars, ...periods) {
      plotted.push(periods);
      return {macd: [], signal: [], histogram: []};
    },
  };
  nodes.set(`${prefix}macdLegendPeriods`, {textContent: ""});
  engine.maSeries = {};
  engine.renderMaLegendValues = () => {};
  engine.updateMaAndDiffs([{time: 100, value: 123}]);
  assert.deepEqual(plotted.pop(), [8, 21, 5]);
  assert.equal(nodes.get(`${prefix}macdLegendPeriods`).textContent, "MACD (8, 21, 5):");
  nodes.get(`${prefix}macdFastPeriod`).value = "10";
  engine.updateMaAndDiffs([{time: 100, value: 123}]);
  assert.deepEqual(plotted.pop(), [10, 21, 5]);
  assert.equal(engine.replaySettings().macd_fast_period, 10);
  assert.equal(engine.liveStrategyPayload(defaultMode).macd_fast_period, 10);

  // Exercise the real input listener, then recreate the engine to model reload.
  const events = {};
  const fastInput = nodes.get(`${prefix}macdFastPeriod`);
  fastInput.id = `${prefix}macdFastPeriod`;
  fastInput.addEventListener = (event, handler) => { events[event] = handler; };
  nodes.set(`${prefix}paradigmDetailSection`, {querySelectorAll: () => [fastInput]});
  engine.updateRulesMatchStatus = () => {};
  nodes.get(`${prefix}macdZeroUseCross`).addEventListener = () => {};
  nodes.get(`${prefix}macdZeroUseSignalZone`).addEventListener = () => {};
  engine.bindParadigmDetailEvents("macd_zero_cross");
  events.input();
  assert.equal(engine.macdDraftSaveTimer, 1);
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const reloaded = context.window[globalName];
  reloaded.botState = {strategy_mode: "macd_zero_cross", strategy_params: {
    macd_fast_period: 12, macd_slow_period: 26, macd_signal_period: 9}, strategy_drafts:{macd_zero_cross:{macd_fast_period:10,macd_slow_period:21,macd_signal_period:5}}};
  assert.match(reloaded.renderParadigmDetail("macd_zero_cross"), /value="10"/);
  assert.match(reloaded.renderParadigmDetail("macd_zero_cross"), /value="21"/);
  assert.match(reloaded.renderParadigmDetail("macd_zero_cross"), /value="5"/);
  assert.doesNotMatch(reloaded.renderParadigmDetail("macd_reversal"), /value="21"/);
  const otherFile = prefix === "crypto_" ? "lighter-crypto-tab.js" : "crypto-tab.js";
  vm.runInContext(fs.readFileSync(otherFile, "utf8"), context);
  const other = context.window[prefix === "crypto_" ? "lighterCryptoEngine" : "cryptoEngine"];
  assert.doesNotMatch(other.renderParadigmDetail("macd_zero_cross"), /value="21"/);
  reloaded.botState.strategy_drafts = {};
  assert.match(reloaded.renderParadigmDetail("macd_zero_cross"), /value="26"/);

  const html = engine.renderParadigmDetail("macd_zero_cross");
  assert.match(html, /Completed candles only/);
  assert.match(html, /Histogram zero cross: −→\+ long; \+→− short/);
  assert.match(html, /Optional signal-line filter: &lt; 0 long; &gt; 0 short \(default OFF\)/);
  assert.match(html, /Exit long: histogram \+→− · Exit short: −→\+ \(signal-line zone ignored\)/);
  assert.doesNotMatch(html, /Wider trend filters/);
  const signalInput = markup => markup.match(new RegExp(`<input id="${prefix}macdZeroUseSignalZone"[^>]*>`))[0];
  assert.doesNotMatch(signalInput(reloaded.renderParadigmDetail("macd_zero_cross")), / checked/,
    "new Zero Cross settings default to histogram-only entry");
  reloaded.botState.use_macd_signal_zone = true;
  assert.match(signalInput(reloaded.renderParadigmDetail("macd_zero_cross")), / checked/,
    "an existing saved strict filter must remain enabled until the user changes it");
  nodes.get(`${prefix}macdZeroUseSignalZone`).checked = true;
  assert.equal(engine.replaySettings().use_macd_signal_zone, true);
  assert.equal(engine.liveStrategyPayload(defaultMode).use_macd_signal_zone, true);

}

load("crypto-tab.js", "cryptoEngine", "crypto_", "macd_zero_cross");
load("lighter-crypto-tab.js", "lighterCryptoEngine", "lighterCrypto_", "macd_zero_cross");
console.log("MACD zero-cross UI replay/live controls match across Tabs 4 and 5");
