const assert = require("node:assert/strict");
const {
  DEFAULT_ENDPOINTS,
  utils: {
    deriveBookMetrics,
    conditionState,
    normalizeConditionCollection,
    combineConditionStreams,
    normalizeReplayCounts,
    normalizeCandleBars,
    movingAverageSeries,
    accountUnrealizedPnl,
    accountPayloadUsable,
    sourceTimestampMilliseconds,
    sourceAgeMilliseconds,
    payloadStaleByAge,
    accountAgeMilliseconds,
    accountPayloadStale,
    chartPayloadStale,
    replayEntrySignalMarkers,
    usdDisplay,
    formatKstDateTime,
    sourceLine,
  },
} = require("../lighter-micro-tab.js");

assert.deepEqual(DEFAULT_ENDPOINTS, {
  snapshot: "/api/lighter-micro/snapshot",
  status: "/api/lighter-micro/status",
  replay: "/api/lighter-micro/replay?limit=500",
  config: "/api/lighter-micro/config",
  account: "/api/lighter-crypto/status?symbol=BTC",
  candles: "/api/lighter-crypto/candles",
});

const metrics = deriveBookMetrics({
  book: {
    bids: [[100, 2], [99, 3]],
    asks: [{price: 101, size: 1}, {price: 102, quantity: 4}],
  },
}, 2);
assert.equal(metrics.book.bids.length, 2);
assert.equal(metrics.book.asks.length, 2);
assert.equal(metrics.bestBid, 100);
assert.equal(metrics.bestAsk, 101);
assert.equal(metrics.spread, 1);
assert.ok(Math.abs(metrics.spreadBps - (1 / 100.5) * 10000) < 1e-9);
assert.equal(metrics.imbalance, 0, "top-N imbalance uses actual bid and ask sizes");
assert.ok(Math.abs(metrics.microprice - (302 / 3)) < 1e-9);
assert.equal(metrics.tradeFlow, null, "trade flow must not be invented from book depth");
assert.equal(metrics.momentum, null, "momentum must remain unavailable unless supplied");
assert.equal(metrics.source.microprice, "derived from top of book");

const supplied = deriveBookMetrics({
  order_book: {bids: [[100, 1]], asks: [[101, 1]]},
  metrics: {
    spread_bps: {value: 7.5, unit: "bps"},
    top_n_depth_imbalance: {value: -0.25},
    microprice: {value: 100.4},
    trade_flow: {display: "+42.5 contracts", value: 42.5},
    momentum: {display: "SELL ACCELERATING", value: -0.8},
  },
}, 10);
assert.deepEqual(supplied.spreadBps, {value: 7.5, unit: "bps"});
assert.deepEqual(supplied.imbalance, {value: -0.25});
assert.deepEqual(supplied.tradeFlow, {display: "+42.5 contracts", value: 42.5});
assert.equal(supplied.source.tradeFlow, "endpoint");

const missing = deriveBookMetrics({book: {bids: [], asks: []}}, 10);
for (const key of ["bestBid", "bestAsk", "spread", "spreadBps", "imbalance", "microprice", "tradeFlow", "momentum"]) {
  assert.equal(missing[key], null, `${key} stays null when the endpoint has no source value`);
}
const shallow = deriveBookMetrics({book: {bids: [[100, 1]], asks: [[101, 1]]}}, 5);
assert.equal(shallow.imbalance, null, "top-N imbalance is unavailable when either side has fewer than N levels");
assert.equal(shallow.microprice, 100.5, "top-of-book microprice remains available from complete best levels");

const evaluatorMetrics = deriveBookMetrics({metrics: {
  spread_bps: 1.25,
  depth_imbalance: 0.4,
  microprice: 100.2,
  trade_flow_imbalance: 0.6,
  price_momentum_bps: 0.8,
}}, 5);
assert.equal(evaluatorMetrics.tradeFlow, 0.6);
assert.equal(evaluatorMetrics.momentum, 0.8);

assert.equal(conditionState({enabled: true, state: "pass"}), "PASS");
assert.equal(conditionState({enabled: true, pass: false}), "WAITING");
assert.equal(conditionState({enabled: false, pass: true}), "OFF");
assert.equal(conditionState({enabled: true}), "UNAVAILABLE");
assert.equal(conditionState({enabled: true, pass: true}, {available: false}), "UNAVAILABLE");
assert.equal(conditionState({enabled: true, state: "UNKNOWN"}), "UNAVAILABLE");

const normalized = normalizeConditionCollection({
  condition_pass: {spread_ok: true, flow_ok: false, momentum_ok: true},
  condition_enabled: {spread_ok: true, flow_ok: true, momentum_ok: false},
  condition_values: {spread_ok: {value: 1.2, unit: "bps"}},
  condition_thresholds: {spread_ok: {value: 2, unit: "bps"}},
}, {source: "replay evaluator", timestamp: 1791500000, available: true});
assert.deepEqual(normalized.map((row) => row.state), ["PASS", "WAITING", "OFF"]);
assert.equal(normalized[0].source, "replay evaluator");
assert.equal(normalized[0].timestamp, 1791500000);

const backendCondition = normalizeConditionCollection({
  condition_pass: {entry_max_spread: true},
  conditions: {
    entry_max_spread: {
      enabled: true,
      status: "PASS",
      pass: true,
      measured_value: 1.1,
      threshold: 3,
      source_timestamp_ms: 1791500000123,
    },
  },
}, {available: true});
assert.equal(backendCondition[0].state, "PASS");
assert.equal(backendCondition[0].measured, 1.1);
assert.equal(backendCondition[0].timestamp, 1791500000123);

const combined = combineConditionStreams(
  [{key: "spread_ok", label: "Spread", enabled: true, pass: true}],
  [{key: "flow_ok", label: "Flow", enabled: true, pass: false}],
  {available: true},
  {available: true},
);
assert.equal(combined.length, 2);
assert.equal(combined[0].paper.state, "PASS");
assert.equal(combined[0].live, null, "missing live verdict is not copied from paper");
assert.equal(combined[1].paper, null, "missing paper verdict is not copied from live");
assert.equal(combined[1].live.state, "WAITING");

assert.deepEqual(normalizeReplayCounts({
  entry_signals: [{}, {}, {}],
  exit_signals: [{}],
  fills: [{}, {}],
  trades: [{}],
}), {entrySignals: 3, exitSignals: 1, fills: 2, trades: 1});
assert.deepEqual(normalizeReplayCounts({summary: {
  entry_signal_count: 0,
  exit_signal_count: 0,
  simulated_fill_count: 0,
  trade_count: 0,
}}), {entrySignals: 0, exitSignals: 0, fills: 0, trades: 0});
assert.deepEqual(normalizeReplayCounts({trades: [{}, {}]}), {
  entrySignals: null,
  exitSignals: null,
  fills: null,
  trades: 2,
}, "trades must never be relabeled as signals or fills");

const candleBars = normalizeCandleBars({bars: [
  {time: 300, value: 103},
  {time: 100, close: 101},
  {time: 200, value: null},
  {time: 200, close: 102},
  {time: 300, value: 103.5},
  {time: 400, value: 0},
]});
assert.deepEqual(candleBars.map((bar) => [bar.time, bar.value]), [[100, 101], [200, 102], [300, 103.5]],
  "candles are numeric, ordered, deduplicated, and never receive a fake zero");
const thirtyBars = Array.from({length: 30}, (_, index) => ({time: 1_000 + index * 60, value: 100 + index}));
const ma7 = movingAverageSeries(thirtyBars, 7);
const ma24 = movingAverageSeries(thirtyBars, 24);
assert.equal(ma7.length, 24);
assert.equal(ma24.length, 7);
assert.equal(ma7[0].value, 103);
assert.equal(ma24[0].value, 111.5);
assert.deepEqual(movingAverageSeries(thirtyBars.slice(0, 6), 7), [], "MA7 remains unavailable without seven prices");

const accountTimestamp = 1_800_000_000_000;
const freshAccount = {
  success: true,
  authenticated: true,
  account_stale: false,
  collateral: 0,
  available_margin: 0,
  positions: [],
  account_updated_ms: accountTimestamp,
};
assert.equal(accountPayloadUsable(freshAccount), true, "authenticated fresh zero balances are legitimate source values");
assert.equal(accountUnrealizedPnl(freshAccount), 0);
assert.equal(usdDisplay(0), "$0.00 USD");
assert.equal(usdDisplay(null), "UNAVAILABLE");
assert.equal(accountPayloadUsable({...freshAccount, collateral: null}), false);
assert.equal(accountPayloadUsable({...freshAccount, account_stale: true}), false);
assert.equal(accountUnrealizedPnl({...freshAccount, positions: [{unrealized_pnl: null}]}), null,
  "missing position P&L is not replaced with zero");

assert.equal(sourceTimestampMilliseconds({timestamp_ms: accountTimestamp}), accountTimestamp);
assert.equal(sourceTimestampMilliseconds({source: {timestamp_ms: accountTimestamp}}), accountTimestamp);
assert.equal(sourceAgeMilliseconds({timestamp_ms: accountTimestamp}, accountTimestamp + 500), 500);
assert.equal(payloadStaleByAge({timestamp_ms: accountTimestamp}, accountTimestamp + 500, 500), false,
  "a quote exactly on its 500 ms freshness boundary remains usable");
assert.equal(payloadStaleByAge({timestamp_ms: accountTimestamp}, accountTimestamp + 501, 500), true,
  "a quote one millisecond beyond its 500 ms freshness boundary is stale");
assert.equal(payloadStaleByAge({}, accountTimestamp, 500), true,
  "a missing source timestamp fails closed");
assert.equal(payloadStaleByAge({timestamp_ms: accountTimestamp + 2_001}, accountTimestamp, 500), true,
  "a source timestamp beyond the bounded future-clock tolerance fails closed");
assert.equal(accountAgeMilliseconds(freshAccount, accountTimestamp + 15_000), 15_000);
assert.equal(accountPayloadStale(freshAccount, accountTimestamp + 15_000), false,
  "an account exactly on its 15 second freshness boundary remains usable");
assert.equal(accountPayloadStale(freshAccount, accountTimestamp + 15_001), true,
  "an account one millisecond beyond its freshness boundary is withheld");

const chartPayload = {bars: thirtyBars};
const latestMs = thirtyBars.at(-1).time * 1000;
assert.equal(chartPayloadStale(chartPayload, thirtyBars, "1m", latestMs + 120_000), false);
assert.equal(chartPayloadStale(chartPayload, thirtyBars, "1m", latestMs + 180_000), false,
  "a chart exactly three selected intervals old remains usable");
assert.equal(chartPayloadStale(chartPayload, thirtyBars, "1m", latestMs + 180_001), true,
  "a chart one millisecond beyond three selected intervals is stale");
assert.equal(chartPayloadStale(chartPayload, thirtyBars, "1m", latestMs + 181_000), true);
assert.equal(chartPayloadStale(chartPayload, thirtyBars, "1m", latestMs - 2_001), true,
  "a latest candle beyond the bounded future-clock tolerance fails closed");
assert.equal(chartPayloadStale({stale: true}, thirtyBars, "1m", latestMs), true);

const markerBars = Array.from({length: 4}, (_, index) => ({time: 1_800_000_000 + index * 60, value: 100 + index}));
const causalMarkers = replayEntrySignalMarkers({
  entry_signals: [
    {timestamp_ms: 1_800_000_005_000, side: 1},
    {time: 1_800_000_065, side: -1},
    {time: 1_800_000_075, side: -1},
    {time: 1_800_000_125, direction: "long"},
  ],
  fills: [{time: 1_800_000_185, side: -1}],
  trades: [{entry_time: 1_800_000_185, side: -1}],
}, markerBars, "1m");
assert.deepEqual(causalMarkers.map((marker) => [marker.time, marker.direction, marker.count, marker.shape, marker.text]), [
  [1_800_000_000, "long", 1, "arrowUp", ""],
  [1_800_000_060, "short", 2, "arrowDown", "×2"],
  [1_800_000_120, "long", 1, "arrowUp", ""],
]);
assert.deepEqual(replayEntrySignalMarkers({
  fills: [{time: 1_800_000_005, side: 1}],
  trades: [{entry_time: 1_800_000_065, side: -1}],
}, markerBars, "1m"), [], "fills and trades cannot fabricate an entry-condition marker");
assert.deepEqual(replayEntrySignalMarkers({
  entry_signals: [{time: 1_799_999_999, side: 1}, {time: 1_800_000_999, side: -1}],
}, markerBars, "1m"), [], "signals outside the displayed candle window are not snapped to unrelated bars");

const kst = formatKstDateTime(Date.UTC(2026, 0, 1, 0, 0, 0));
assert.match(kst, /2026-01-01 09:00:00 KST/);
assert.equal(formatKstDateTime(null), "time unavailable");
assert.match(sourceLine("paper", {source: "micro replay", timestamp: 1791500000}), /^PAPER · micro replay · .* KST$/);
assert.match(sourceLine("paper", {source: {name: "LIGHTER_ORDER_BOOK", instrument: "SKHY-USDT", timestamp_ms: 1791500000123}}),
  /^PAPER · LIGHTER_ORDER_BOOK · SKHY-USDT · .* KST$/);
assert.match(sourceLine("live", null, {stale: true}), /^LIVE · STALE · source unavailable · time unavailable$/);

console.log("Lighter microstructure math, condition-state, replay-count, and KST checks passed");
