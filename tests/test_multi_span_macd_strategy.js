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
assert.match(strategyBody, /class="terminalConditionGroup"[\s\S]*?>Entry conditions</,
  "Multi-Chart must use the common terminal Entry conditions layout");
assert.match(strategyBody, /class="terminalConditionGroup"[\s\S]*?>Exit conditions</,
  "Multi-Chart must use the common terminal Exit conditions layout");
assert.match(strategyBody, /id="msStrategyEntryConditions"/);
assert.match(strategyBody, /id="msStrategyExitConditions"/);
assert.match(strategyBody, /class="msStrategySpanToggle"/,
  "every visible timeframe rule must remain a real adjustable replay control");
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

console.log("Multi-span all-MACD-H completed-candle paper strategy tests passed");
