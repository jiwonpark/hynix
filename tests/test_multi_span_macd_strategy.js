const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modulePath = path.join(__dirname, "../multi-span-tab.js");
delete require.cache[require.resolve(modulePath)];
const engine = require(modulePath);
const multiSpanSource = fs.readFileSync(modulePath, "utf8");
const executionFrameSource = fs.readFileSync(path.join(__dirname, "../strategy-execution-chart.js"), "utf8");

assert.match(multiSpanSource, /StrategyExecutionChartFrame/,
  "Multi-Chart paper replay must mount through the shared execution frame");
assert.match(executionFrameSource, /const showHost = options\.showHost !== false/,
  "the shared execution frame must support control-only strategy panels without a fake chart host");
const strategyBody = engine.macdStrategyFrameBody();
assert.match(strategyBody, /id="msStrategyUnifiedConditions"/,
  "Multi-Chart must render Long and Short conditions in the unified single-pane checklist");
assert.match(strategyBody, /class="msSpanDualColumns"/,
  "each timeframe card must split Long conditions (left) and Short conditions (right) inside the same pane");
assert.match(strategyBody, /class="msSpanLongCol"[\s\S]*?Long conditions/,
  "Multi-Chart must render the Long conditions column in each timeframe section");
assert.match(strategyBody, /class="msSpanShortCol"[\s\S]*?Short conditions/,
  "Multi-Chart must render the Short conditions column in each timeframe section");
assert.match(strategyBody, /class="msStrategySpanToggle"/,
  "every visible timeframe rule must remain a real adjustable replay control");
assert.match(strategyBody, /id="msStrategyPresetRsi"/,
  "Multi-Chart must provide a real RSI strategy preset");
assert.match(strategyBody, /id="msStrategyRsiPeriod"[\s\S]*?id="msStrategyRsiEntryThreshold"[\s\S]*?id="msStrategyRsiExitThreshold"/,
  "RSI period, entry threshold, and exit threshold must be adjustable replay controls");
assert.match(strategyBody, /id="msStrategyMaRideAtrPeriod"[\s\S]*?id="msStrategyMaRideSlopeLookback"[\s\S]*?id="msStrategyMaRideMinSlopeAtr"[\s\S]*?id="msStrategyMaRideSideLookback"[\s\S]*?id="msStrategyMaRideRequiredCloses"[\s\S]*?id="msStrategyMaRideTouchLookback"[\s\S]*?id="msStrategyMaRideTouchToleranceAtr"[\s\S]*?id="msStrategyMaRideRequireMa50"/,
  "MA ride/hang ATR, slope, persistence, touch, and MA50-order parameters must all be adjustable replay controls");
assert.match(strategyBody, /MA20 Ride is fixed LONG; MA20 Hang is fixed SHORT/,
  "the strategy panel must state the fixed ride-long and hang-short directions");
assert.match(strategyBody, /class="condRow[^"]*"[\s\S]*?class="toggleSwitch"[\s\S]*?class="msStrategySpanToggle"/,
  "every condition row must contain an inline toggle switch matching other tabs");
assert.doesNotMatch(strategyBody, /id="msStrategySpanToggles"/,
  "detached timeframe toggle bar must be replaced by inline condition row switches");
assert.doesNotMatch(strategyBody, /id="msStrategyConditions"/,
  "the obsolete combined condition-card layout must not return");

const DAY = 86400;
const spans = ["1s", "5m", "15m", "1h", "1d"];
assert.deepEqual(engine.macdStrategyPreset("quick"), {
  clock_span: "5m",
  enabled_spans: ["5m", "15m"],
});
assert.deepEqual(engine.macdStrategyPreset("all"), {
  clock_span: "1s",
  enabled_spans: spans,
});
assert.equal(engine.macdStrategySettings().clock_span, "5m");
assert.deepEqual(engine.macdStrategySettings().enabled_spans, ["5m", "15m"]);
const points = [
  { time: 0, value: -1, color: "red" },
  { time: DAY, value: -2, color: "red" },
  { time: DAY * 2, value: 1, color: "green" },
];

engine.candlesData = {
  "1d": [
    { time: 0, close: 100 },
    { time: DAY, close: 95 },
    { time: DAY * 2, close: 110 },
  ],
};
engine.macdData = Object.fromEntries(spans.map((span) => [span, { histogram: points.map((point) => ({ ...point })) }]));

const settings = {
  clock_span: "1d",
  enabled_spans: spans,
  buy_threshold: 0,
  sell_threshold: 0,
  initial_capital: 10000,
  fee_bps: 5,
};

const result = engine.evaluateMacdStrategyReplay(settings, DAY * 4);
assert.equal(result.error, null);
assert.equal(result.metrics.evaluated_candles, 3);
assert.equal(result.entry_signals.length, 2, "every completed negative-alignment candle must remain an entry signal");
assert.equal(result.metrics.simulated_entry_fills, 1, "position state may suppress fills, never entry signals");
assert.equal(result.trades.length, 1);
assert.equal(result.fills.length, 2);
assert.equal(result.fills[0].side, 1);
assert.equal(result.fills[1].side, -1);
assert.equal(result.latest_evaluation.condition_pass.exit_all_histograms_above, true);
assert.ok(result.metrics.net_return_pct > 9 && result.metrics.net_return_pct < 10);
assert.equal(result.open_position, null);

const beforeThirdClose = engine.evaluateMacdStrategyReplay(settings, DAY * 2 + 1000);
assert.equal(beforeThirdClose.metrics.evaluated_candles, 2, "forming clock candle must not be evaluated");
assert.equal(beforeThirdClose.fills.length, 1);
assert.ok(beforeThirdClose.open_position, "the long remains open until a completed all-positive candle");

const completedDaily = engine.findCompletedHistogramAt("1d", DAY * 2 - 1);
assert.equal(completedDaily.time, 0, "the still-forming daily histogram must be excluded");
assert.equal(completedDaily.completed_time, DAY);

const disabledAll = engine.evaluateMacdStrategyReplay({ ...settings, enabled_spans: [] }, DAY * 4);
assert.match(disabledAll.error, /Enable at least one/);

const crossedThresholds = engine.evaluateMacdStrategyReplay({
  ...settings,
  buy_threshold: 1,
  sell_threshold: -1,
}, DAY * 4);
assert.match(crossedThresholds.error, /less than or equal/);

const markerCalls = {};
engine.series = Object.fromEntries(spans.map((span) => [span, {
  setMarkers(markers) { markerCalls[span] = markers; },
}]));
engine.applyMacdStrategyMarkers(result);
for (const span of spans) assert.deepEqual(markerCalls[span], [], "native markers are replaced by exact-price Tab 4/5 overlays");

const visualMarkers = engine.strategyExecutionMarkers;
assert.equal(visualMarkers.filter((marker) => marker.is_entry).length, 2,
  "entry chart markers must come from the complete entry_signals stream");
assert.equal(visualMarkers.filter((marker) => marker.is_entry && marker.is_fill).length, 1,
  "the simulated buy must enrich its entry signal instead of fabricating another marker");
assert.equal(visualMarkers.filter((marker) => marker.signal_only).length, 1,
  "position-suppressed fills must remain visible as entry-signal-only markers");
assert.equal(visualMarkers.filter((marker) => marker.is_exit && marker.is_fill).length, 1);
assert.equal(visualMarkers.filter((marker) => marker.pairKey === "paper:0").length, 2,
  "the filled entry and exit must share a pair for hover/selection P&L rendering");

const shortSignalOnlyResult = engine.evaluateMacdStrategyReplay({
  clock_span: "1d",
  entry_rules: [],
  exit_rules: [{ span: "1d", rule: "macd_h", sign: "+" }],
  buy_threshold: 0,
  sell_threshold: 0,
  initial_capital: 10000,
  fee_bps: 5,
}, DAY * 4);
const shortOnlyMarkers = engine.buildMacdStrategyExecutionMarkers(shortSignalOnlyResult);
assert.equal(shortOnlyMarkers.length, 1, "short signals without an open long position must still produce a visible short-signal marker");
assert.equal(shortOnlyMarkers[0].is_exit, true);
assert.equal(shortOnlyMarkers[0].signal_only, true);

// Test MACD_RULES definition and legend/DOM elements
assert.ok(Array.isArray(engine.MACD_RULES), "engine.MACD_RULES must be an array");
assert.equal(engine.MACD_RULES.length, 14, "engine.MACD_RULES must contain the symmetric MACD matrix, MA definitions, RSI, and MA ride/hang");
const ruleIds = engine.MACD_RULES.map((r) => r.id);
assert.deepEqual(ruleIds, ["macd_h", "macd_h_diff", "macd_h_cross", "macd_h_diff_cross", "macd_h_diff2", "macd_s", "macd_s_diff", "macd_s_cross", "macd_s_diff_cross", "macd_s_diff2", "ma20_diff", "ma50_diff", "rsi", "ma_ride_hang"],
  "must support symmetric MACD-H/MACD-S dynamics, MA slopes, RSI, and fixed-direction MA ride/hang");
const maRideRule = engine.MACD_RULES.find((rule) => rule.id === "ma_ride_hang");
assert.equal(maRideRule.fixedDirection, true);
assert.equal(maRideRule.entryLabel, "MA20 ride");
assert.equal(maRideRule.exitLabel, "MA20 hang");

for (const span of spans) {
  for (const rule of engine.MACD_RULES) {
    assert.match(strategyBody, new RegExp(`data-span="${span}"[^>]*data-rule="${rule.id}"[^>]*data-kind="entry"`),
      `must render entry row for ${span} ${rule.id}`);
    assert.match(strategyBody, new RegExp(`data-span="${span}"[^>]*data-rule="${rule.id}"[^>]*data-kind="exit"`),
      `must render exit row for ${span} ${rule.id}`);
  }
}
assert.equal((strategyBody.match(/class="condSignToggle"/g) || []).length, spans.length * (engine.MACD_RULES.length - 1) * 2,
  "MA ride/hang rows must not expose a direction switch that could reverse Ride LONG or Hang SHORT");
assert.equal((strategyBody.match(/class="msMacdConditionMatrix"/g) || []).length, spans.length * 2,
  "every timeframe must render separate long and short MACD condition matrices");
assert.equal((strategyBody.match(/msMacdMatrixCell/g) || []).length, spans.length * 10 * 2,
  "each MACD matrix must expose five real condition columns for both H and S");
for (const header of ["v sign", "Δv sign", "v cross", "Δv cross", "Δ²v sign"]) {
  assert.ok(strategyBody.includes(`>${header}</div>`), `matrix must label the ${header} condition column`);
}

// Test calculateSma and calculateMacd difference and zero-crossing metrics
const testCandles = [];
for (let i = 0; i < 60; i++) {
  testCandles.push({ time: i * 60, close: 100 + Math.sin(i / 3) * 5 });
}
const sma20Calc = engine.calculateSma(testCandles, 20);
const sma50Calc = engine.calculateSma(testCandles, 50);
assert.ok(sma20Calc.length > 2 && sma20Calc[1].diff !== null, "MA20 must include 1st diff");
assert.ok(sma50Calc.length > 2 && sma50Calc[1].diff !== null, "MA50 must include 1st diff");

const macdCalc = engine.calculateMacd(testCandles, 12, 26, 9);
assert.ok(macdCalc.signal.length > 2, "must compute signal line");
assert.ok(macdCalc.signal[1].diff !== null, "signal line must have diff (1st diff)");
assert.ok(macdCalc.signal[2].diff2 !== null, "signal line must have diff2 (2nd diff)");
assert.ok(macdCalc.signal[1].cross !== null, "signal line must have value cross (1, -1, or 0)");
assert.ok(macdCalc.signal[2].diff_cross !== null, "signal line must have diff cross (1, -1, or 0)");
assert.ok(macdCalc.histogram[1].diff !== null, "histogram must have diff");
assert.ok(macdCalc.histogram[2].diff2 !== null, "histogram must have diff2 (2nd diff)");
assert.ok(macdCalc.histogram[1].cross !== null, "histogram must have cross (1, -1, or 0)");
assert.ok(macdCalc.histogram[2].diff_cross !== null, "histogram must have diff_cross (1, -1, or 0)");

// Test evaluateMacdStrategyReplay with symmetric H/S value, diff, cross,
// diff-cross, curvature, plus MA20/MA50 slope rules.
const richPoints = [
  { time: 0, histogram: -1, prev_histogram: null, hist_diff: -0.5, prev_hist_diff: null, hist_diff2: null, hist_cross: 0, hist_diff_cross: 0, signal: -2, prev_signal: null, signal_diff: 0.1, prev_signal_diff: null, signal_diff2: null, signal_cross: 0, signal_diff_cross: 0, ma20_diff: -0.2, ma50_diff: -0.1 },
  { time: DAY, histogram: -0.5, prev_histogram: -1, hist_diff: 0.5, prev_hist_diff: -0.5, hist_diff2: 1, hist_cross: 0, hist_diff_cross: 1, signal: -1.8, prev_signal: -2, signal_diff: 0.2, prev_signal_diff: 0.1, signal_diff2: 0.1, signal_cross: 0, signal_diff_cross: 0, ma20_diff: 0.4, ma50_diff: 0.15 },
  { time: DAY * 2, histogram: 1, prev_histogram: -0.5, hist_diff: 1.5, prev_hist_diff: 0.5, hist_diff2: 1, hist_cross: 1, hist_diff_cross: 0, signal: 0.5, prev_signal: -1.8, signal_diff: -0.1, prev_signal_diff: 0.2, signal_diff2: -0.3, signal_cross: 1, signal_diff_cross: -1, ma20_diff: -0.3, ma50_diff: -0.05 },
];
engine.macdData = Object.fromEntries(spans.map((span) => [span, {
  histogram: richPoints.map((p) => ({ time: p.time, value: p.histogram, prev: p.prev_histogram, diff: p.hist_diff, prev_diff: p.prev_hist_diff, cross: p.hist_cross, diff_cross: p.hist_diff_cross })),
  byTime: new Map(richPoints.map((p) => [p.time, { ...p, value: p.histogram }])),
}]));

const fullWaveSettings = {
  clock_span: "1d",
  entry_rules: [
    { span: "1d", rule: "macd_h", sign: "-" },
    { span: "1d", rule: "macd_s", sign: "-" },
    { span: "1d", rule: "macd_s_diff", sign: "+" },
    { span: "1d", rule: "macd_s_diff2", sign: "+" },
    { span: "1d", rule: "macd_h_diff", sign: "+" },
    { span: "1d", rule: "macd_h_diff_cross", sign: "+" },
    { span: "1d", rule: "ma20_diff", sign: "+" },
    { span: "1d", rule: "ma50_diff", sign: "+" },
  ],
  exit_rules: [
    { span: "1d", rule: "macd_h", sign: "+" },
    { span: "1d", rule: "macd_h_cross", sign: "+" },
    { span: "1d", rule: "macd_s", sign: "+" },
    { span: "1d", rule: "macd_s_diff", sign: "-" },
    { span: "1d", rule: "macd_s_diff2", sign: "-" },
    { span: "1d", rule: "macd_h_diff", sign: "+" },
    { span: "1d", rule: "ma20_diff", sign: "-" },
    { span: "1d", rule: "ma50_diff", sign: "-" },
  ],
  buy_threshold: 0,
  sell_threshold: 0,
  initial_capital: 10000,
  fee_bps: 5,
};

const fullWaveResult = engine.evaluateMacdStrategyReplay(fullWaveSettings, DAY * 4);
assert.equal(fullWaveResult.error, null);
assert.equal(fullWaveResult.entry_signals.length, 1, "only candle 1 (DAY) satisfies every configured entry condition");
assert.equal(fullWaveResult.entry_signals[0].time, DAY);
assert.equal(fullWaveResult.exit_signals.length, 1, "candle 2 (DAY*2) satisfies exit conditions including H crossing +");
assert.equal(fullWaveResult.trades.length, 1, "1 closed trade completed");
assert.ok(fullWaveResult.trades[0].pnl > 0, "trade was profitable");

// Test H crossing +/- rule standalone
const crossEntrySettings = {
  clock_span: "1d",
  entry_rules: [{ span: "1d", rule: "macd_h_cross", sign: "+" }],
  exit_rules: [{ span: "1d", rule: "macd_h_cross", sign: "-" }],
  buy_threshold: 0,
  sell_threshold: 0,
  initial_capital: 10000,
  fee_bps: 5,
};
const crossResult = engine.evaluateMacdStrategyReplay(crossEntrySettings, DAY * 4);
assert.equal(crossResult.error, null);
assert.equal(crossResult.entry_signals.length, 1, "H crossing + matches only when histogram crosses from negative (-0.5) to positive (+1)");
assert.equal(crossResult.entry_signals[0].time, DAY * 2);

const signalCrossResult = engine.evaluateMacdStrategyReplay({
  clock_span: "1d",
  entry_rules: [{ span: "1d", rule: "macd_s_cross", sign: "+" }],
  exit_rules: [{ span: "1d", rule: "macd_s_diff_cross", sign: "-" }],
  initial_capital: 10000,
  fee_bps: 5,
}, DAY * 4);
assert.equal(signalCrossResult.error, null);
assert.deepEqual(signalCrossResult.entry_signals.map((signal) => signal.time), [DAY * 2],
  "S value-cross + must match the completed candle where S moves from negative to positive");
assert.deepEqual(signalCrossResult.exit_signals.map((signal) => signal.time), [DAY * 2],
  "S diff-cross - must match the completed candle where ΔS moves from positive to negative");
assert.equal(engine.evaluateMacdRuleOnPoint(richPoints[1], { rule: "macd_h_diff2", sign: "+" }, true), true,
  "H curvature cell must evaluate the real histogram second difference");

// Test per-chart condition candle highlights (span_matches & DOM layer rendering)
assert.ok(fullWaveResult.span_matches, "replay result must include per-chart span_matches");
assert.equal(fullWaveResult.span_matches["1d"].length, 2, "1d chart must match 1 entry candle (DAY) and 1 exit candle (DAY*2)");
assert.equal(fullWaveResult.span_matches["1d"][0].time, DAY);
assert.equal(fullWaveResult.span_matches["1d"][0].kind, "entry");
assert.equal(fullWaveResult.span_matches["1d"][1].time, DAY * 2);
assert.equal(fullWaveResult.span_matches["1d"][1].kind, "exit");
assert.equal(fullWaveResult.span_matches["5m"].length, 0, "spans without enabled rules must have 0 highlighted candles");

const createdHighlights = [];
const mockMainLayer = { style: {}, textContent: "", children: [], appendChild(child) { this.children.push(child); } };
const mockMacdLayer = { style: {}, textContent: "", children: [], appendChild(child) { this.children.push(child); } };
const mockCondBadge = { style: {}, textContent: "" };
const mockChartHost = { clientWidth: 500, clientHeight: 240 };
const mockMacdHost = { clientWidth: 500, clientHeight: 90 };
const prevDoc = global.document;
global.document = {
  getElementById(id) {
    if (id === "msCondHighlight_1d") return mockMainLayer;
    if (id === "msMacdCondHighlight_1d") return mockMacdLayer;
    if (id === "msCardCondBadge_1d") return mockCondBadge;
    if (id === "msChartHost_1d") return mockChartHost;
    if (id === "msMacdHost_1d") return mockMacdHost;
    return null;
  },
  createElement(tag) {
    const el = { tag, className: "", dataset: {}, style: {} };
    createdHighlights.push(el);
    return el;
  },
};
engine.strategyReplayResult = fullWaveResult;
engine.charts = {
  "1d": {
    timeScale: () => ({
      width: () => 420,
      getVisibleLogicalRange: () => ({ from: 0, to: 10 }),
      logicalToCoordinate: (idx) => 50 + idx * 30,
      timeToCoordinate: (t) => 50 + (t / DAY) * 30,
    }),
  },
};
engine.macdCharts = { "1d": engine.charts["1d"] };
engine.renderSpanConditionCandleHighlights("1d");
global.document = prevDoc;

assert.equal(mockCondBadge.textContent, "MATCH: LONG 1 · SHORT 1", "chart header badge must summarize matching LONG and SHORT candles for that chart");
assert.equal(mockMainLayer.children.length, 2, "main chart layer must render highlight bars for each matching candle");
assert.equal(mockMacdLayer.children.length, 2, "MACD sub-chart layer must render highlight bars for each matching candle");
assert.equal(mockMainLayer.children[0].dataset.kind, "entry");
assert.equal(mockMainLayer.children[0].dataset.time, String(DAY));
assert.equal(mockMainLayer.children[1].dataset.kind, "exit");
assert.equal(mockMainLayer.children[1].dataset.time, String(DAY * 2));

// Test condition persistence via localStorage and in-place DOM updates without resetting signs or unchecked states
const storageBacking = new Map();
const prevLocalStorage = global.localStorage;
global.localStorage = {
  getItem(k) { return storageBacking.has(k) ? storageBacking.get(k) : null; },
  setItem(k, v) { storageBacking.set(k, String(v)); },
  removeItem(k) { storageBacking.delete(k); },
};

const customPersistedSettings = {
  clock_span: "15m",
  signal_basis: "parabolic",
  buy_threshold: -0.05,
  sell_threshold: 0.08,
  rsi_period: 21,
  rsi_entry_threshold: 25,
  rsi_exit_threshold: 75,
  ma_ride_atr_period: 18,
  ma_ride_slope_lookback: 4,
  ma_ride_min_slope_atr: 0.12,
  ma_ride_side_lookback: 7,
  ma_ride_required_closes: 5,
  ma_ride_touch_lookback: 4,
  ma_ride_touch_tolerance_atr: 0.2,
  ma_ride_require_ma50: false,
  initial_capital: 25000,
  fee_bps: 4,
  entry_rules: [
    { span: "1h", rule: "macd_s_diff", sign: "-" },
    { span: "1d", rule: "ma20_diff", sign: "+" },
  ],
  exit_rules: [
    { span: "15m", rule: "macd_h_cross", sign: "-" },
  ],
  rule_signs: {
    "entry:1h:macd_s_diff": "-",
    "entry:5m:macd_h": "+", // custom sign on a disabled row!
    "exit:15m:macd_h_cross": "-",
  },
};
engine.saveMacdStrategySettings(customPersistedSettings);

const restoredSettings = engine.macdStrategySettings();
assert.equal(restoredSettings.clock_span, "15m", "must restore persisted clock_span");
assert.equal(restoredSettings.signal_basis, "parabolic", "must restore persisted signal_basis");
assert.equal(restoredSettings.buy_threshold, -0.05, "must restore persisted buy_threshold");
assert.equal(restoredSettings.sell_threshold, 0.08, "must restore persisted sell_threshold");
assert.equal(restoredSettings.rsi_period, 21, "must restore persisted RSI period");
assert.equal(restoredSettings.rsi_entry_threshold, 25, "must restore persisted RSI entry threshold");
assert.equal(restoredSettings.rsi_exit_threshold, 75, "must restore persisted RSI exit threshold");
assert.equal(restoredSettings.ma_ride_atr_period, 18, "must restore persisted MA ride ATR period");
assert.equal(restoredSettings.ma_ride_slope_lookback, 4, "must restore persisted MA ride slope lookback");
assert.equal(restoredSettings.ma_ride_min_slope_atr, 0.12, "must restore persisted MA ride slope threshold");
assert.equal(restoredSettings.ma_ride_side_lookback, 7, "must restore persisted MA ride side lookback");
assert.equal(restoredSettings.ma_ride_required_closes, 5, "must restore persisted MA ride close quorum");
assert.equal(restoredSettings.ma_ride_touch_lookback, 4, "must restore persisted MA ride touch lookback");
assert.equal(restoredSettings.ma_ride_touch_tolerance_atr, 0.2, "must restore persisted MA ride touch tolerance");
assert.equal(restoredSettings.ma_ride_require_ma50, false, "must restore persisted MA50 order switch");
assert.deepEqual(restoredSettings.entry_rules, customPersistedSettings.entry_rules, "must restore persisted entry_rules");
assert.deepEqual(restoredSettings.exit_rules, customPersistedSettings.exit_rules, "must restore persisted exit_rules");
assert.equal(restoredSettings.rule_signs["entry:5m:macd_h"], "+", "must preserve custom sign even for disabled rule");

global.localStorage = prevLocalStorage;

// Test Parabolic / 2nd-order Taylor projection from completed (t-2, t-1) to candle t:
// At t = DAY*2:
// t-2 (0): H = -1.0, ΔH = -0.5
// t-1 (DAY): H = -0.5, ΔH = +0.5, Δ²H = +0.5 - (-0.5) = +1.0
// Parabolic prediction for t (DAY*2):
// ΔH_hat_t = ΔH_{t-1} + 0.5 * Δ²H_{t-1} = 0.5 + 0.5 * 1.0 = +1.0
// H_hat_t = H_{t-1} + ΔH_hat_t = -0.5 + 1.0 = +0.5
// Since H_{t-1} = -0.5 < 0 and H_hat_t = +0.5 > 0, predicted hist_cross = +1!
const parabolicAtDay2 = engine.findCompletedHistogramAt("1d", DAY * 3, "parabolic");
assert.ok(parabolicAtDay2, "must compute parabolic projection for candle t from prior completed candles");
assert.equal(parabolicAtDay2.signal_basis, "parabolic");
assert.equal(parabolicAtDay2.time, DAY * 2, "projected point must stay anchored at candle t's timestamp");
assert.equal(parabolicAtDay2.hist_diff, 1.0, "parabolic ΔH_hat_t = ΔH_{t-1} + 0.5*Δ²H_{t-1} = 0.5 + 0.5*(1.0) = 1.0");
assert.equal(parabolicAtDay2.histogram, 0.5, "parabolic H_hat_t = H_{t-1} + ΔH_hat_t = -0.5 + 1.0 = 0.5");
assert.equal(parabolicAtDay2.hist_cross, 1, "parabolic H_hat_t crosses zero from -0.5 to +0.5");

const parabolicReplay = engine.evaluateMacdStrategyReplay({
  clock_span: "1d",
  signal_basis: "parabolic",
  entry_rules: [{ span: "1d", rule: "macd_h_cross", sign: "+" }],
  exit_rules: [],
  buy_threshold: 0,
  sell_threshold: 0,
  initial_capital: 10000,
  fee_bps: 5,
}, DAY * 4);
assert.equal(parabolicReplay.error, null);
assert.equal(parabolicReplay.entry_signals.length, 1, "parabolic replay must trigger entry signal at DAY*2 where predicted H crosses +");
assert.equal(parabolicReplay.entry_signals[0].time, DAY * 2);

// Wilder RSI strategy: oversold matches remain position-independent signals,
// while the paper portfolio opens only once and exits when RSI becomes overbought.
const rsiCandles = [];
for (let i = 0; i < 24; i += 1) {
  rsiCandles.push({ time: i * DAY, close: 130 - i * 2 });
}
for (let i = 24; i < 52; i += 1) {
  rsiCandles.push({ time: i * DAY, close: 84 + (i - 23) * 4 });
}
engine.candlesData["1d"] = rsiCandles;
engine.rsiCache = {};
const rsiValues = engine.calculateRsi(rsiCandles, 14);
assert.equal(rsiValues.length, rsiCandles.length - 14, "RSI must begin after the configured Wilder seed period");
assert.equal(rsiValues[0].value, 0, "a strictly declining Wilder seed must produce RSI 0");
assert.ok(rsiValues.some((point) => point.value > 70), "the recovery leg must produce overbought RSI values");

const alignedRsi = engine.getRsiDataForSpan("1d", 14);
assert.equal(alignedRsi.plotValues.length, rsiCandles.length,
  "the plotted RSI timeline must preserve every price-candle timestamp");
assert.deepEqual(alignedRsi.plotValues.map((point) => point.time), rsiCandles.map((candle) => candle.time),
  "price and RSI panes must contain the same ordered timestamps");
assert.ok(alignedRsi.plotValues.slice(0, 14).every((point) => !("value" in point)),
  "Wilder warm-up candles must be represented as whitespace instead of removed bars");
assert.equal(alignedRsi.plotValues[14].value, rsiValues[0].value,
  "the first computed RSI must remain attached to its original candle");

const plottedRsiRows = {};
engine.rsiLine["1d"] = { setData(rows) { plottedRsiRows.line = rows; } };
engine.rsiUpper["1d"] = { setData(rows) { plottedRsiRows.upper = rows; } };
engine.rsiLower["1d"] = { setData(rows) { plottedRsiRows.lower = rows; } };
engine.updateRsiForSpan("1d", rsiCandles, {
  settings: { rsi_period: 14, rsi_entry_threshold: 30, rsi_exit_threshold: 70 },
});
assert.equal(plottedRsiRows.line.length, rsiCandles.length,
  "RSI line data must keep the price timeline length");
assert.deepEqual(plottedRsiRows.upper.map((point) => point.time), rsiCandles.map((candle) => candle.time),
  "the upper threshold must anchor the RSI time scale to every candle");
assert.deepEqual(plottedRsiRows.lower.map((point) => point.time), rsiCandles.map((candle) => candle.time),
  "the lower threshold must anchor the RSI time scale to every candle");

const rsiResult = engine.evaluateMacdStrategyReplay({
  clock_span: "1d",
  signal_basis: "completed",
  entry_rules: [{ span: "1d", rule: "rsi", sign: "-" }],
  exit_rules: [{ span: "1d", rule: "rsi", sign: "+" }],
  rsi_period: 14,
  rsi_entry_threshold: 30,
  rsi_exit_threshold: 70,
  buy_threshold: 0,
  sell_threshold: 0,
  initial_capital: 10000,
  fee_bps: 5,
}, DAY * 53);
assert.equal(rsiResult.error, null);
assert.equal(rsiResult.settings.strategy_mode, "all_rsi_reversion");
assert.ok(rsiResult.entry_signals.length > 1, "every completed oversold RSI candle must remain an entry signal");
assert.equal(rsiResult.metrics.simulated_entry_fills, 1, "open-position state may suppress RSI fills, never RSI entry signals");
assert.ok(rsiResult.exit_signals.length > 0, "overbought completed candles must produce exit signals");
assert.equal(rsiResult.trades.length, 1, "RSI 30/70 replay must close the paper long once");
assert.ok(Number.isFinite(rsiResult.latest_evaluation.histograms["1d"].rsi));

const invalidRsi = engine.evaluateMacdStrategyReplay({
  clock_span: "1d",
  entry_rules: [{ span: "1d", rule: "rsi", sign: "-" }],
  exit_rules: [{ span: "1d", rule: "rsi", sign: "+" }],
  rsi_entry_threshold: 75,
  rsi_exit_threshold: 70,
}, DAY * 53);
assert.match(invalidRsi.error, /entry threshold must be lower/);

const predictedRsi = engine.evaluateMacdStrategyReplay({
  clock_span: "1d",
  signal_basis: "parabolic",
  entry_rules: [{ span: "1d", rule: "rsi", sign: "-" }],
  exit_rules: [{ span: "1d", rule: "rsi", sign: "+" }],
  rsi_entry_threshold: 30,
  rsi_exit_threshold: 70,
}, DAY * 53);
assert.match(predictedRsi.error, /completed candles only/,
  "the UI/replay must clearly reject unsupported parabolic RSI modeling");

// Fixed-direction MA20 Ride (long) / Hang (short) strategy. A steady trend uses
// wide candles whose near-side wick repeatedly touches MA20 within 0.15 ATR.
const maRideCandles = [];
for (let i = 0; i < 160; i += 1) {
  const rising = i < 80;
  const close = rising ? 100 + i * 1.5 : 218.5 - (i - 79) * 1.5;
  maRideCandles.push({
    time: i * DAY,
    open: close + (rising ? -0.25 : 0.25),
    high: close + 15,
    low: close - 15,
    close,
  });
}
engine.candlesData["1d"] = maRideCandles;
engine.maRideCache = {};
const atr14 = engine.calculateAtr(maRideCandles, 14);
assert.ok(atr14.length > 100, "Wilder ATR must cover the MA ride/hang replay window");
assert.ok(Math.abs(atr14[atr14.length - 1].value - 30) < 1e-8, "constant 30-point true ranges must produce ATR 30");

const maRideSettings = {
  clock_span: "1d",
  signal_basis: "completed",
  entry_rules: [{ span: "1d", rule: "ma_ride_hang", sign: "-" }], // sign is intentionally wrong: direction is fixed LONG
  exit_rules: [{ span: "1d", rule: "ma_ride_hang", sign: "+" }], // sign is intentionally wrong: direction is fixed SHORT
  ma_ride_atr_period: 14,
  ma_ride_slope_lookback: 3,
  ma_ride_min_slope_atr: 0.10,
  ma_ride_side_lookback: 5,
  ma_ride_required_closes: 4,
  ma_ride_touch_lookback: 3,
  ma_ride_touch_tolerance_atr: 0.15,
  ma_ride_require_ma50: true,
  initial_capital: 10000,
  fee_bps: 5,
};
const maRideData = engine.getMaRideDataForSpan("1d", maRideSettings);
const ridingPoint = maRideData.byTime.get(60 * DAY);
const hangingPoint = maRideData.byTime.get(130 * DAY);
assert.ok(ridingPoint?.ma_ride_long, "rising candles above and touching MA20 must classify as LONG Ride");
assert.equal(ridingPoint.ma_hang_short, false);
assert.equal(ridingPoint.ma_ride_above_count, 5);
assert.ok(ridingPoint.ma_ride_slope_atr >= 0.10);
assert.ok(ridingPoint.ma_ride_ride_touch_distance_atr <= 0.15);
assert.ok(hangingPoint?.ma_hang_short, "falling candles below and rejecting MA20 must classify as SHORT Hang");
assert.equal(hangingPoint.ma_ride_long, false);
assert.equal(hangingPoint.ma_ride_below_count, 5);
assert.ok(hangingPoint.ma_ride_slope_atr <= -0.10);
assert.ok(hangingPoint.ma_ride_hang_touch_distance_atr <= 0.15);
assert.equal(engine.evaluateMacdRuleOnPoint(ridingPoint, maRideSettings.entry_rules[0], true), true,
  "Ride must remain a LONG condition even when stale storage supplies the opposite sign");
assert.equal(engine.evaluateMacdRuleOnPoint(hangingPoint, maRideSettings.exit_rules[0], false), true,
  "Hang must remain a SHORT condition even when stale storage supplies the opposite sign");

const maRideResult = engine.evaluateMacdStrategyReplay(maRideSettings, DAY * 161);
assert.equal(maRideResult.error, null);
assert.equal(maRideResult.settings.strategy_mode, "ma_ride_hang");
assert.ok(maRideResult.entry_signals.length > 1,
  "every completed riding candle must remain an entry signal while the simulated long is open");
assert.equal(maRideResult.metrics.simulated_entry_fills, 1,
  "position state may suppress Ride fills but never Ride entry signals");
assert.ok(maRideResult.exit_signals.length > 1, "completed hanging candles must produce SHORT signals");
assert.equal(maRideResult.trades.length, 1, "the first Hang signal must close the simulated Ride long");
assert.ok(maRideResult.span_matches["1d"].some((match) => match.kind === "entry"));
assert.ok(maRideResult.span_matches["1d"].some((match) => match.kind === "exit"));

const strictSlopeResult = engine.evaluateMacdStrategyReplay({
  ...maRideSettings,
  ma_ride_min_slope_atr: 0.20,
}, DAY * 161);
assert.equal(strictSlopeResult.error, null);
assert.equal(strictSlopeResult.entry_signals.length, 0,
  "raising the wired slope threshold above the measured trend must flip Ride to WAITING");
assert.equal(strictSlopeResult.exit_signals.length, 0,
  "raising the wired slope threshold above the measured trend must flip Hang to WAITING");

const invalidMaRideQuorum = engine.evaluateMacdStrategyReplay({
  ...maRideSettings,
  ma_ride_side_lookback: 5,
  ma_ride_required_closes: 6,
}, DAY * 161);
assert.match(invalidMaRideQuorum.error, /required closes cannot exceed/);

const predictedMaRide = engine.evaluateMacdStrategyReplay({
  ...maRideSettings,
  signal_basis: "parabolic",
}, DAY * 161);
assert.match(predictedMaRide.error, /completed candles only/,
  "the UI/replay must clearly reject unsupported parabolic MA ride/hang modeling");

console.log("Multi-span MACD matrix + RSI + MA ride/hang completed-candle paper strategy tests passed");
