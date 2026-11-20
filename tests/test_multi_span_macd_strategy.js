const assert = require("node:assert/strict");
const path = require("node:path");

const modulePath = path.join(__dirname, "../multi-span-tab.js");
delete require.cache[require.resolve(modulePath)];
const engine = require(modulePath);

const DAY = 86400;
const spans = ["1s", "5m", "15m", "1h", "1d"];
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
assert.equal(markerCalls["1d"].filter((marker) => marker.shape === "circle").length, 2,
  "entry chart markers must come from the complete entry_signals stream");
assert.equal(markerCalls["1d"].filter((marker) => marker.shape === "arrowUp").length, 1);
assert.equal(markerCalls["1d"].filter((marker) => marker.shape === "arrowDown").length, 1);
for (const span of spans.filter((span) => span !== "1d")) assert.deepEqual(markerCalls[span], []);

console.log("Multi-span all-MACD-H completed-candle paper strategy tests passed");
