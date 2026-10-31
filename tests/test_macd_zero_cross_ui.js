const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function load(file, globalName, prefix, defaultMode) {
  const nodes = new Map();
  const context = {
    window: {}, URLSearchParams, console,
    document: {
      readyState: "loading",
      addEventListener() {},
      getElementById(id) { return nodes.get(id) || null; },
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(file, "utf8"), context);
  const engine = context.window[globalName];
  engine.currentParadigm = "macd_zero_cross";
  engine.interval = "5m";
  nodes.set(`${prefix}macdFastPeriod`, {value: "8"});
  nodes.set(`${prefix}macdSlowPeriod`, {value: "21"});
  nodes.set(`${prefix}macdSignalPeriod`, {value: "5"});
  nodes.set(`${prefix}macdZeroUseCross`, {checked: true});
  nodes.set(`${prefix}macdZeroUseSignalZone`, {checked: false});

  const replay = engine.replaySettings();
  const live = engine.liveStrategyPayload(defaultMode);
  for (const settings of [replay, live]) {
    assert.equal(settings.strategy_mode, "macd_zero_cross");
    assert.deepEqual(
      [settings.macd_fast_period, settings.macd_slow_period, settings.macd_signal_period],
      [8, 21, 5],
    );
    assert.equal(settings.use_macd_zero_cross, true);
    assert.equal(settings.use_macd_signal_zone, false);
  }

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

  const html = engine.renderParadigmDetail("macd_zero_cross");
  assert.match(html, /Completed candles only/);
  assert.match(html, /Histogram zero cross: −→\+ long; \+→− short/);
  assert.match(html, /Signal on origin side: &lt; 0 long; &gt; 0 short/);
  assert.doesNotMatch(html, /Wider trend filters/);
}

load("crypto-tab.js", "cryptoEngine", "crypto_", "macd_zero_cross");
load("lighter-crypto-tab.js", "lighterCryptoEngine", "lighterCrypto_", "macd_zero_cross");
console.log("MACD zero-cross UI replay/live controls match across Tabs 4 and 5");
