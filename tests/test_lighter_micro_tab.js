const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {LighterMicroTab} = require("../lighter-micro-tab.js");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
  contains(value) { return this.values.has(value); }
}

class FakeElement {
  constructor(ref, attributes = {}) {
    this.ref = ref;
    this.attributes = new Map(Object.entries(attributes));
    this.textContent = "";
    this.innerHTML = "";
    this.checked = false;
    this.disabled = false;
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.dataset = {};
    this.clientWidth = 760;
    this.clientHeight = ref === "chartHost" ? 340 : 0;
    this.inputs = [];
  }
  getAttribute(name) {
    if (name === "data-micro-ref") return this.ref;
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  querySelectorAll(selector) { return selector === "input" ? this.inputs : []; }
}

class FakeHost {
  constructor() {
    this.dataset = {};
    this.classList = new FakeClassList();
    this.style = {};
    this.html = "";
    this.refs = new Map();
    this.intervals = [];
  }
  set innerHTML(value) {
    this.html = value;
    this.refs.clear();
    this.intervals = [];
    for (const match of value.matchAll(/data-micro-ref="([^"]+)"/g)) {
      if (!this.refs.has(match[1])) this.refs.set(match[1], new FakeElement(match[1]));
    }
    for (const match of value.matchAll(/data-micro-interval="([^"]+)"/g)) {
      this.intervals.push(new FakeElement(null, {"data-micro-interval": match[1], "aria-pressed": "false"}));
    }
  }
  get innerHTML() { return this.html; }
  querySelectorAll(selector) {
    if (selector === "[data-micro-ref]") return [...this.refs.values()];
    if (selector === "[data-micro-interval]") return this.intervals;
    return [];
  }
  replaceChildren() { this.html = ""; }
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: () => "application/json"},
    json: async () => payload,
  };
}

const seriesByTitle = new Map();
let visibleRange = {from: 0, to: 29};
let rangeSubscriber = null;
let chartRemoved = false;
const chart = {
  addLineSeries(options) {
    const series = {
      options,
      data: [],
      markers: [],
      setData(rows) { this.data = rows.map((row) => ({...row})); },
      setMarkers(rows) { this.markers = rows.map((row) => ({...row})); },
    };
    seriesByTitle.set(options.title, series);
    return series;
  },
  applyOptions() {},
  remove() { chartRemoved = true; },
  timeScale() {
    return {
      getVisibleLogicalRange: () => visibleRange,
      setVisibleLogicalRange(range) { visibleRange = {...range}; rangeSubscriber?.(visibleRange); },
      subscribeVisibleLogicalRangeChange(callback) { rangeSubscriber = callback; },
      fitContent() { visibleRange = {from: 0, to: 29}; rangeSubscriber?.(visibleRange); },
    };
  },
};
const chartLibrary = {createChart: () => chart};

const storageValues = new Map();
const storage = {
  getItem: (key) => storageValues.get(key) ?? null,
  setItem: (key, value) => storageValues.set(key, String(value)),
};

let wallNow = 1_800_000_000_000;
const fixedAssumptions = {
  editable: false,
  source: "LIGHTER_MICRO_RUNTIME_CONFIG",
  groups: [
    {key: "entry_model", label: "Fixed entry-model assumptions", items: [
      {key: "depth_levels", label: "Depth imbalance levels per side", value: 5, unit: "levels"},
      {key: "trade_flow_lookback_ms", label: "Aggressor trade-flow lookback", value: 1000, unit: "ms"},
      {key: "price_momentum_weight", label: "Price-momentum edge weight", value: 0.5, unit: "×"},
    ]},
    {key: "cost_model", label: "Fixed research cost assumptions", items: [
      {key: "taker_fee_bps_per_side", label: "Entry taker fee per side", value: 1, unit: "bps"},
    ]},
    {key: "paper_runtime", label: "Fixed paper-runtime settings", items: [
      {key: "paper_order_notional_usd", label: "Paper order notional", value: 10, unit: "USD"},
      {key: "paper_enabled", label: "Paper fills enabled", value: true},
    ]},
  ],
};
function candles(interval) {
  const seconds = {"1m": 60, "5m": 300, "15m": 900}[interval];
  const latest = Math.floor(wallNow / 1000 / seconds) * seconds;
  return Array.from({length: 30}, (_, index) => {
    const value = 60_000 + index * 25 + (interval === "5m" ? 100 : interval === "15m" ? 200 : 0);
    return {time: latest - (29 - index) * seconds, value, open: value - 5, high: value + 10, low: value - 10, close: value};
  });
}

const calls = [];
let failCandles = false;
let failCandleAttempts = 0;
let failAccountAttempts = 0;
let failReplay = false;
const fetchImpl = async (url, options = {}) => {
  calls.push({url, options});
  if (url.includes("/api/lighter-micro/snapshot")) return response({
    success: true,
    source: "lighter websocket book",
    timestamp_ms: wallNow,
    order_book: {bids: [[100, 2]], asks: [[101, 1]]},
    metric_context: {depth_levels: 5, trade_flow_lookback_ms: 1000, momentum_lookback_ms: 1000},
    metrics: {depth_imbalance: 0.4, trade_flow: {value: 4, unit: "contracts"}, momentum: {value: 0.3}},
    paper_prerequisites: {
      entry_direction: {enabled: true, pass: true, status: "PASS", mandatory: true, editable: false,
        label: "Directional edge available", source: "micro replay", source_timestamp_ms: wallNow,
        requirement: "The fixed edge model must produce a non-zero direction; this prerequisite cannot be disabled"},
    },
  });
  if (url.includes("/api/lighter-micro/status")) return response({
    success: true,
    authenticated: false,
    source: "lighter bot",
    timestamp_ms: wallNow,
    stale: false,
    live: {
      order_submission_implemented: false,
      stale: false,
      prerequisites: {
        entry_direction: {enabled: true, pass: true, status: "PASS", mandatory: true, editable: false,
          label: "Directional edge available", source: "lighter bot", source_timestamp_ms: wallNow},
      },
    },
    config: {strategy_enabled_editable: false, conditions: [], fixed_assumptions: fixedAssumptions, raw: {entry: {depth_levels: 5}}},
    safeguards: [],
  });
  if (url.includes("/api/lighter-micro/replay")) {
    if (failReplay) return response({success: false, error: "replay temporarily unavailable"}, 503);
    return response({
    success: true,
    source: "micro replay",
    timestamp_ms: wallNow,
    entry_signals: [
      {timestamp_ms: (candles("1m").at(-1).time + 5) * 1000, side: 1, price: 60_725},
      {time: candles("1m").at(-2).time + 10, side: -1, price: 60_690},
      {time: candles("1m").at(-2).time + 20, side: -1, price: 60_685},
    ],
    fills: [{time: 2}],
    trades: [],
    paper_prerequisites: {
      entry_direction: {enabled: true, pass: true, status: "PASS", mandatory: true, editable: false,
        label: "Directional edge available", source: "micro replay", source_timestamp_ms: wallNow},
    },
    });
  }
  if (url.includes("/api/lighter-crypto/status")) {
    if (failAccountAttempts > 0) {
      failAccountAttempts -= 1;
      return response({success: false, error: "account temporarily unavailable"}, 503);
    }
    return response({
      success: true,
      authenticated: true,
      symbol: "BTC",
      collateral: 250.5,
      available_margin: 200.25,
      positions: [{position_amt: 0.01, size: 0.01, entry_price: 59_500, mark_price: 60_725, unrealized_pnl: 12.25}],
      account_source: "LIGHTER_ACCOUNT_STREAM",
      account_updated_ms: wallNow - 500,
      account_age_ms: 500,
      account_stale: false,
    });
  }
  if (url.includes("/api/lighter-crypto/candles")) {
    if (failCandles || failCandleAttempts > 0) {
      if (failCandleAttempts > 0) failCandleAttempts -= 1;
      return response({success: false, error: "candle feed unavailable"});
    }
    const interval = new URL(`https://example.test${url}`).searchParams.get("interval");
    return response({success: true, symbol: "BTC", interval, source: "LIGHTER_CANDLE_API", bars: candles(interval)});
  }
  if (url.includes("/api/lighter-micro/config")) return response({
    success: true,
    config: {strategy_enabled: false, strategy_enabled_editable: false, conditions: []},
  });
  return response({error: "unknown endpoint"}, 404);
};

async function run() {
  const host = new FakeHost();
  let elapsed = 0;
  const tab = new LighterMicroTab(host, {
    fetchImpl,
    apiPrefix: "/skhynix",
    autoPoll: false,
    chartLibrary,
    storage,
    wallNowProvider: () => wallNow,
    elapsedNowProvider: () => { elapsed += 11; return elapsed; },
    retryDelayMs: 0,
    tokenProvider: () => null,
    confirmImpl: () => true,
  });
  tab.mount();
  assert.equal(host.dataset.lighterMicroMounted, "true");
  assert.match(host.innerHTML, /Bid \/ ask ladder/);
  assert.match(host.innerHTML, /Paper replay · signals are not fills/);
  assert.match(host.innerHTML, /Execution safeguards · not optional strategy conditions/);
  assert.match(host.innerHTML, /Read-only Lighter BTC account/);
  assert.match(host.innerHTML, /BTC price · Lighter candles/);
  assert.match(host.innerHTML, /id="lighterMicro_chartHost"/);
  assert.match(host.innerHTML, /READ-ONLY/);
  assert.match(host.innerHTML, /Save evaluator settings/);
  assert.doesNotMatch(host.innerHTML, /Save &amp; Deploy|executing bot/i);

  const refreshed = await tab.onTabActivated();
  assert.equal(refreshed, true);
  assert.deepEqual(calls.slice(0, 5).map((call) => new URL(`https://example.test${call.url}`).pathname), [
    "/skhynix/api/lighter-crypto/candles",
    "/skhynix/api/lighter-crypto/status",
    "/skhynix/api/lighter-micro/snapshot",
    "/skhynix/api/lighter-micro/status",
    "/skhynix/api/lighter-micro/replay",
  ], "activation serializes chart then account before ancillary microstructure reads");
  assert.equal(tab.pollIntervalMs, 10_000, "default polling refreshes proactively without hammering account telemetry every two seconds");
  assert.equal(tab.snapshot.source, "lighter websocket book");
  assert.equal(tab.status.authenticated, false);
  assert.equal(tab.replay.entry_signals.length, 3);
  assert.match(tab.refs.marketSource.textContent, /MARKET · lighter websocket book · .* KST/);
  assert.notEqual(tab.refs.spread.textContent, "UNAVAILABLE");
  assert.equal(tab.refs.imbalance.textContent, "40.00%");
  assert.equal(tab.refs.imbalanceLabel.textContent, "Top 5 depth imbalance");
  assert.equal(tab.refs.imbalanceSource.textContent, "endpoint · top 5 levels / side");
  assert.equal(tab.refs.tradeFlow.textContent, "4.000000 contracts");
  assert.equal(tab.refs.entrySignals.textContent, "3");
  assert.equal(tab.refs.exitSignals.textContent, "UNAVAILABLE");
  assert.equal(tab.refs.fills.textContent, "1");
  assert.equal(tab.refs.trades.textContent, "0");
  assert.match(tab.refs.replaySource.textContent, /PAPER · micro replay · .* KST/);
  assert.equal(tab.refs.accessBadge.textContent, "READ-ONLY · NOT AUTHENTICATED");
  assert.equal(tab.refs.accountCollateral.textContent, "$250.50 USD");
  assert.equal(tab.refs.accountAvailable.textContent, "$200.25 USD");
  assert.equal(tab.refs.accountPositionCount.textContent, "1");
  assert.equal(tab.refs.accountUnrealized.textContent, "$12.25 USD");
  assert.match(tab.refs.accountPositions.innerHTML, /LONG/);
  assert.match(tab.refs.accountSource.textContent, /ACCOUNT · LIGHTER_ACCOUNT_STREAM · .* KST · age 500 ms/);
  assert.match(tab.refs.accountReadyTime.textContent, /^\d+ ms$/);
  assert.match(tab.refs.chartReadyTime.textContent, /^\d+ ms$/);
  assert.equal(seriesByTitle.get("BTC").data.length, 30);
  assert.equal(seriesByTitle.get("MA7").data.length, 24);
  assert.equal(seriesByTitle.get("MA24").data.length, 7);
  assert.equal(seriesByTitle.get("MA7").data[0].value, 60_075);
  assert.equal(seriesByTitle.get("MA24").data[0].value, 60_287.5);
  assert.equal(tab.entryMarkers.length, 2, "same-candle signals are grouped by direction");
  assert.deepEqual(seriesByTitle.get("BTC").markers, tab.entryMarkers,
    "entry-signal markers are applied to the BTC price series");
  const longMarker = tab.entryMarkers.find((marker) => marker.direction === "long");
  const shortMarker = tab.entryMarkers.find((marker) => marker.direction === "short");
  assert.equal(longMarker.time, candles("1m").at(-1).time,
    "long signal maps to its containing selected candle");
  assert.equal(longMarker.shape, "arrowUp");
  assert.equal(longMarker.position, "belowBar");
  assert.equal(longMarker.count, 1);
  assert.equal(shortMarker.time, candles("1m").at(-2).time,
    "short signals map to their containing selected candle");
  assert.equal(shortMarker.shape, "arrowDown");
  assert.equal(shortMarker.position, "aboveBar");
  assert.equal(shortMarker.count, 2);
  assert.equal(shortMarker.text, "×2");
  assert.ok(tab.entryMarkers.every((marker) => marker.source === "replay.entry_signals"));
  assert.match(tab.refs.chartSource.textContent, /CHART · LIGHTER_CANDLE_API · .* KST · interval 1m/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /Directional edge available/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /PAPER · PASS/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /LIVE · PASS/,
    "fresh live-shadow verdicts remain visible without account authentication");
  assert.match(tab.refs.fixedAssumptions.innerHTML, /Depth imbalance levels per side/);
  assert.match(tab.refs.fixedAssumptions.innerHTML, /Aggressor trade-flow lookback/);
  assert.match(tab.refs.fixedAssumptions.innerHTML, /Price-momentum edge weight/);
  assert.match(tab.refs.fixedAssumptions.innerHTML, /Entry taker fee per side/);
  assert.match(tab.refs.fixedAssumptions.innerHTML, /Paper order notional/);
  assert.doesNotMatch(tab.refs.fixedAssumptions.innerHTML, /<input|<button|<select/,
    "fixed assumptions are disclosures, never decorative controls");
  assert.equal(tab.refs.fixedAssumptionSource.textContent,
    "FIXED ASSUMPTIONS · LIGHTER_MICRO_RUNTIME_CONFIG · read-only");
  assert.equal(host.intervals.find((button) => button.getAttribute("data-micro-interval") === "1m").getAttribute("aria-pressed"), "true");
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-micro/snapshot?depth=10"));
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-micro/status"));
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-micro/replay?limit=500"));
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-crypto/status?symbol=BTC"));
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-crypto/candles?symbol=BTC&interval=1m&limit=180"));
  assert.ok(calls.every((call) => !call.url.includes("/order")), "read-only refresh exposes no order route");
  assert.equal(tab.marketPollIntervalMs, 400,
    "the independent market loop refreshes inside the 500 ms quote-freshness limit");

  const accountCallsBeforeFastRefresh = calls.filter((call) => call.url.includes("/api/lighter-crypto/status")).length;
  const candleCallsBeforeFastRefresh = calls.filter((call) => call.url.includes("/api/lighter-crypto/candles")).length;
  assert.equal(await tab.refreshMarket(), true);
  assert.equal(calls.filter((call) => call.url.includes("/api/lighter-crypto/status")).length, accountCallsBeforeFastRefresh,
    "fast market refresh never requests account telemetry");
  assert.equal(calls.filter((call) => call.url.includes("/api/lighter-crypto/candles")).length, candleCallsBeforeFastRefresh,
    "fast market refresh never requests candles");

  const normalFastFetch = tab.fetchImpl;
  let releaseFastSnapshot;
  const fastSnapshotReleased = new Promise((resolve) => { releaseFastSnapshot = resolve; });
  let fastSnapshotStarts = 0;
  let holdFastSnapshot = true;
  tab.fetchImpl = async (url, options) => {
    if (holdFastSnapshot && url.includes("/api/lighter-micro/snapshot")) {
      holdFastSnapshot = false;
      fastSnapshotStarts += 1;
      await fastSnapshotReleased;
    }
    return normalFastFetch(url, options);
  };
  const firstFastRefresh = tab.refreshMarket();
  const secondFastRefresh = tab.refreshMarket();
  assert.equal(fastSnapshotStarts, 1, "fast market ticks are single-flight");
  releaseFastSnapshot();
  assert.equal(await firstFastRefresh, true);
  assert.equal(await secondFastRefresh, true);
  tab.fetchImpl = normalFastFetch;

  let releaseRacingFastSnapshot;
  const racingFastSnapshotReleased = new Promise((resolve) => { releaseRacingFastSnapshot = resolve; });
  let racingSnapshotCalls = 0;
  let racingSnapshotInFlight = 0;
  let racingSnapshotMaxInFlight = 0;
  tab.fetchImpl = async (url, options) => {
    if (url.includes("/api/lighter-micro/snapshot")) {
      racingSnapshotCalls += 1;
      racingSnapshotInFlight += 1;
      racingSnapshotMaxInFlight = Math.max(racingSnapshotMaxInFlight, racingSnapshotInFlight);
      if (racingSnapshotCalls === 1) {
        await racingFastSnapshotReleased;
        racingSnapshotInFlight -= 1;
        return response({
          success: true,
          source: "superseded fast snapshot",
          timestamp_ms: wallNow,
          order_book: {bids: [[90, 1]], asks: [[91, 1]]},
        });
      }
      racingSnapshotInFlight -= 1;
    }
    return normalFastFetch(url, options);
  };
  const racingFastRefresh = tab.refreshMarket();
  const owningFullRefresh = tab.refresh({
    includeReplay: false,
    includeAccount: false,
    includeChart: false,
    includeMarket: true,
    retryCritical: false,
  });
  assert.equal(racingSnapshotCalls, 1,
    "a full market refresh waits for the superseded fast request instead of racing it");
  releaseRacingFastSnapshot();
  assert.equal(await racingFastRefresh, false);
  assert.equal(await owningFullRefresh, true);
  assert.equal(racingSnapshotCalls, 2);
  assert.equal(racingSnapshotMaxInFlight, 1);
  assert.equal(tab.snapshot.source, "lighter websocket book",
    "the aborted fast generation cannot overwrite the full refresh result");
  tab.fetchImpl = normalFastFetch;

  const baseWallNow = wallNow;
  wallNow = baseWallNow + 501;
  assert.equal(tab.renderFreshnessState(), true,
    "crossing a freshness boundary triggers one transition render");
  assert.equal(tab.renderFreshnessState(), false,
    "unchanged stale/loading state does not rerender heavy DOM or markers every 250 ms");
  assert.equal(tab.refs.spread.textContent, "UNAVAILABLE",
    "L2 values are withheld one millisecond beyond the local 500 ms freshness limit");
  assert.match(tab.refs.marketSource.textContent, /MARKET · STALE/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /LIVE · UNAVAILABLE/,
    "locally stale live status cannot keep showing a PASS verdict");
  assert.equal(tab.refs.entrySignals.textContent, "3",
    "historical replay results do not expire on the live quote freshness clock");
  assert.equal(tab.entryMarkers.length, 2,
    "historical replay markers remain visible during ordinary live-feed aging");
  assert.doesNotMatch(tab.refs.replaySource.textContent, /UPDATING/);

  wallNow = baseWallNow + 14_501;
  tab.renderFreshnessState();
  assert.equal(tab.refs.accountCollateral.textContent, "UNAVAILABLE · STALE",
    "account values are withheld when account_updated_ms is over 15 seconds old");
  assert.equal(tab.readiness.accountMs, null, "aged account data no longer satisfies readiness");

  wallNow = baseWallNow + 180_001;
  tab.renderFreshnessState();
  assert.match(tab.refs.chartSource.textContent, /CHART · STALE/,
    "candles age stale beyond three selected intervals without another API request");
  assert.equal(tab.readiness.chartMs, null, "aged candle data no longer satisfies readiness");
  assert.equal(tab.refs.entrySignals.textContent, "3", "chart aging does not invalidate replay history");

  wallNow = baseWallNow;
  tab.renderFreshnessState();
  assert.equal(tab.refs.accountCollateral.textContent, "$250.50 USD");
  assert.notEqual(tab.refs.spread.textContent, "UNAVAILABLE");

  const retainedReplay = tab.replay;
  const replayCallsBeforeOrdinaryRefresh = calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length;
  tab.beginReadinessCycle({includeReplay: false});
  assert.equal(tab.replay, retainedReplay);
  assert.equal(tab.replayLoading, false);
  assert.equal(tab.refs.entrySignals.textContent, "3",
    "ordinary live refresh preserves the last completed replay while feeds update");
  assert.equal(await tab.refresh({includeReplay: false, includeAccount: true, includeChart: true, includeMarket: true}), true);
  assert.equal(
    calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length,
    replayCallsBeforeOrdinaryRefresh,
    "ordinary live refresh does not silently rerun replay",
  );
  assert.equal(tab.replay, retainedReplay);

  visibleRange = {from: 4, to: 18};
  await tab.refreshChart();
  assert.deepEqual(visibleRange, {from: 4, to: 18}, "same-interval refresh preserves the visible chart range");
  const normalIntervalFetch = tab.fetchImpl;
  let releaseFiveMinuteCandles;
  const fiveMinuteCandlesReleased = new Promise((resolve) => { releaseFiveMinuteCandles = resolve; });
  let delayFiveMinuteCandles = true;
  tab.fetchImpl = async (url, options) => {
    if (delayFiveMinuteCandles && url.includes("/api/lighter-crypto/candles") && url.includes("interval=5m")) {
      delayFiveMinuteCandles = false;
      await fiveMinuteCandlesReleased;
    }
    return normalIntervalFetch(url, options);
  };
  tab.errors.chart = "BTC candle data is stale";
  tab.renderErrors();
  assert.match(tab.refs.error.textContent, /chart: BTC candle data is stale/);
  const fiveMinuteSwitch = tab.setChartInterval("5m");
  assert.equal(tab.interval, "5m");
  assert.equal(tab.chartLoading, true);
  assert.equal(tab.chartRendered, false);
  assert.equal(tab.chartDataInterval, null,
    "the prior interval cannot remain rendered under the newly selected interval label");
  assert.deepEqual(tab.bars, []);
  assert.deepEqual(seriesByTitle.get("BTC").data, []);
  assert.match(tab.refs.chartSource.textContent, /CHART · STALE/);
  assert.match(tab.refs.chartSource.textContent, /interval 5m/);
  assert.match(tab.refs.chartError.textContent, /CHART REFRESHING/);
  assert.equal(tab.readiness.chartMs, null);
  assert.notEqual(storageValues.get("skhynix_lighter_micro_interval"), "5m",
    "the selected interval is persisted only after its own response succeeds");
  releaseFiveMinuteCandles();
  assert.equal(await fiveMinuteSwitch, true);
  tab.fetchImpl = normalIntervalFetch;
  assert.equal(tab.interval, "5m");
  assert.deepEqual(tab.chartRanges["1m"], {from: 4, to: 18}, "interval switch preserves the prior interval viewport");
  assert.equal(storageValues.get("skhynix_lighter_micro_interval"), "5m");
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-crypto/candles?symbol=BTC&interval=5m&limit=180"));
  assert.equal(host.intervals.find((button) => button.getAttribute("data-micro-interval") === "5m").getAttribute("aria-pressed"), "true");
  assert.equal(seriesByTitle.get("BTC").data.at(-1).value, 60_825);
  assert.equal(seriesByTitle.get("MA7").data.length, 24);
  assert.equal(seriesByTitle.get("MA24").data.length, 7);
  assert.doesNotMatch(tab.refs.error.textContent, /chart:/,
    "a successful interval recovery clears the aggregate chart error immediately");
  assert.ok(tab.entryMarkers.every((marker) => marker.time % 300 === 0),
    "interval change remaps signals to containing 5m candles");

  const replayWithSignals = tab.replay;
  tab.replay = {
    success: true,
    source: "fills-only replay",
    timestamp_ms: wallNow,
    fills: [{time: candles("5m").at(-1).time, side: 1}],
    trades: [{entry_time: candles("5m").at(-1).time, side: -1}],
  };
  tab.errors.replay = null;
  tab.renderEntrySignalMarkers();
  assert.deepEqual(tab.entryMarkers, [], "fills and trades alone never create entry-condition markers");
  assert.deepEqual(seriesByTitle.get("BTC").markers, [], "fills-only replay clears prior entry markers");
  tab.replay = replayWithSignals;
  tab.renderEntrySignalMarkers();
  assert.ok(tab.entryMarkers.length > 0, "restoring entry_signals restores causal chart markers");

  const freshAccount = tab.account;
  tab.applyAccountPayload({...freshAccount, collateral: 0, available_margin: 0, positions: [], account_stale: true});
  assert.equal(tab.refs.accountCollateral.textContent, "UNAVAILABLE · STALE");
  assert.equal(tab.refs.accountAvailable.textContent, "UNAVAILABLE · STALE");
  assert.equal(tab.refs.accountPositionCount.textContent, "UNAVAILABLE · STALE");
  assert.equal(tab.refs.accountUnrealized.textContent, "UNAVAILABLE · STALE");
  assert.doesNotMatch(tab.refs.accountPositions.innerHTML, /No open BTC positions/,
    "a stale empty position array must not masquerade as a fresh flat account");
  assert.doesNotMatch(tab.refs.accountCollateral.textContent, /\$0\.00/);
  tab.applyAccountPayload(freshAccount);

  const priorPriceData = seriesByTitle.get("BTC").data.map((row) => ({...row}));
  failCandles = true;
  assert.equal(await tab.refreshChart(), false);
  assert.deepEqual(seriesByTitle.get("BTC").data, priorPriceData, "failed refresh preserves the prior chart instead of blanking it");
  assert.match(tab.refs.chartSource.textContent, /CHART · STALE/);
  assert.match(tab.refs.chartError.textContent, /candle feed unavailable/);
  failCandles = false;
  assert.equal(await tab.refreshChart(), true);

  const candleCallsBeforeRetry = calls.filter((call) => call.url.includes("/api/lighter-crypto/candles")).length;
  failCandleAttempts = 1;
  assert.equal(await tab.refresh({includeReplay: false, includeAccount: false, includeChart: true, includeMarket: false}), true,
    "a transient candle failure is retried without running critical reads concurrently");
  assert.equal(
    calls.filter((call) => call.url.includes("/api/lighter-crypto/candles")).length - candleCallsBeforeRetry,
    2,
    "critical candle loading has one bounded retry",
  );
  assert.equal(tab.errors.chart, null);

  const accountCallsBeforeRetry = calls.filter((call) => call.url.includes("/api/lighter-crypto/status")).length;
  const snapshotCallsBeforeSlowRefresh = calls.filter((call) => call.url.includes("/api/lighter-micro/snapshot")).length;
  const statusCallsBeforeSlowRefresh = calls.filter((call) => call.url.includes("/api/lighter-micro/status")).length;
  failAccountAttempts = 1;
  assert.equal(await tab.refresh({includeReplay: false, includeAccount: true, includeChart: false, includeMarket: false}), true,
    "a transient account failure recovers from the last-good stale display on its bounded retry");
  assert.equal(
    calls.filter((call) => call.url.includes("/api/lighter-crypto/status")).length - accountCallsBeforeRetry,
    2,
    "critical account loading has one bounded retry",
  );
  assert.equal(calls.filter((call) => call.url.includes("/api/lighter-micro/snapshot")).length, snapshotCallsBeforeSlowRefresh);
  assert.equal(calls.filter((call) => call.url.includes("/api/lighter-micro/status")).length, statusCallsBeforeSlowRefresh,
    "slow account/chart polling leaves snapshot/status to the fast market loop");
  assert.equal(tab.errors.account, null);
  assert.equal(tab.refs.accountCollateral.textContent, "$250.50 USD");

  const conditionTime = wallNow - 100;
  tab.replay = {evaluations: [{
    source: {name: "LIGHTER_REPLAY", instrument: "SKHY-USDT", timestamp_ms: conditionTime},
    source_timestamp_ms: conditionTime,
    conditions: {
      entry_direction: {enabled: true, status: "PASS", pass: true, measured_value: 1.4, threshold: 0, source_timestamp_ms: conditionTime},
      entry_max_spread: {enabled: true, status: "PASS", pass: true, measured_value: 1.2, threshold: 3, operator: "<=", unit: "bps", source_timestamp_ms: conditionTime},
      entry_trade_flow: {enabled: false, status: "OFF", pass: null, measured_value: 0.4, threshold: 0.2, operator: ">=", unit: "ratio", source_timestamp_ms: conditionTime},
      entry_price_momentum: {enabled: true, status: "UNAVAILABLE", pass: null, measured_value: null, threshold: 0.25, operator: ">=", unit: "bps", source_timestamp_ms: conditionTime},
    },
  }]};
  tab.status = {
    authenticated: true,
    live: {
      source: "LIGHTER_LIVE_EVALUATOR",
      timestamp_ms: conditionTime,
      order_submission_implemented: false,
      conditions: {
        entry_direction: {enabled: true, status: "PASS", pass: true, measured_value: 1.4, threshold: 0, source_timestamp_ms: conditionTime},
        entry_max_spread: {enabled: true, status: "WAITING", pass: false, measured_value: 3.5, threshold: 3, operator: "<=", unit: "bps", source_timestamp_ms: conditionTime},
        entry_trade_flow: {enabled: false, status: "OFF", pass: null, source_timestamp_ms: conditionTime},
        entry_price_momentum: {enabled: true, status: "UNAVAILABLE", pass: null, source_timestamp_ms: conditionTime},
      },
      prerequisites: {
        entry_direction: {enabled: true, status: "PASS", pass: true, mandatory: true, editable: false,
          label: "Directional edge available", source_timestamp_ms: conditionTime,
          requirement: "The fixed edge model must produce a non-zero direction; this prerequisite cannot be disabled"},
      },
    },
    safeguards: {
      quote_fresh: {status: "PASS", detail: "Quote age within server limit"},
      account_capacity_ok: {status: "WAITING", detail: "Capacity unavailable"},
    },
    source: "LIGHTER_EXECUTION_GATE",
    timestamp_ms: conditionTime,
    config: {strategy_enabled: false, strategy_enabled_editable: false, conditions: []},
  };
  tab.errors.replay = null;
  tab.errors.status = null;
  tab.replay.evaluations[0].prerequisites = {
    entry_direction: {enabled: true, status: "PASS", pass: true, mandatory: true, editable: false,
      label: "Directional edge available", source_timestamp_ms: conditionTime,
      requirement: "The fixed edge model must produce a non-zero direction; this prerequisite cannot be disabled"},
  };
  tab.renderConditions();
  tab.renderMandatoryPrerequisites();
  tab.renderSafeguards();
  assert.match(tab.refs.conditions.innerHTML, /PAPER · PASS/);
  assert.match(tab.refs.conditions.innerHTML, /LIVE · WAITING/);
  assert.match(tab.refs.conditions.innerHTML, /PAPER · OFF/);
  assert.match(tab.refs.conditions.innerHTML, /LIVE · UNAVAILABLE/);
  assert.match(tab.refs.conditions.innerHTML, /measured 1\.2 bps · &lt;= 3 bps/);
  assert.match(tab.refs.conditions.innerHTML, /LIGHTER_REPLAY · SKHY-USDT · .* KST/);
  assert.doesNotMatch(tab.refs.conditions.innerHTML, /Directional Edge Available|entry_direction/,
    "derived direction is hidden from optional condition rows");
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /Directional edge available/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /PAPER · PASS/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /LIVE · PASS/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /cannot be disabled/);
  assert.match(tab.refs.safeguards.innerHTML, /quote_fresh|Quote Fresh/);
  assert.match(tab.refs.safeguards.innerHTML, /PASS/);
  assert.match(tab.refs.safeguards.innerHTML, /WAITING/);
  assert.doesNotMatch(tab.refs.safeguards.innerHTML, /type="checkbox"/,
    "execution safeguards are statuses, never decorative switches");

  tab.status = {authenticated: false};
  tab.liveUnlocked = true;
  await assert.rejects(tab.saveLiveConfig(), /Authenticated Lighter status is required/);

  tab.status = {
    authenticated: true,
    timestamp_ms: wallNow,
    stale: false,
    live: {order_submission_implemented: false, timestamp_ms: wallNow, stale: false},
    config: {strategy_enabled: false, strategy_enabled_editable: false, conditions: []},
  };
  await assert.rejects(tab.saveLiveConfig(), /Unlock the authenticated terminal first/);

  tab.tokenProvider = () => "secret-token";
  const evaluatorInput = {disabled: true};
  tab.refs.liveControls.inputs = [evaluatorInput];
  tab.syncLiveControlAccess();
  assert.equal(tab.refs.executionLockStatus.textContent, "LOCKED");
  assert.match(tab.refs.executionLockHelp.textContent, /Shadow\/paper only/);
  assert.doesNotMatch(host.innerHTML, /data-micro-ref="liveEnabled"/,
    "locked execution is a status disclosure, not a decorative checkbox");
  assert.equal(evaluatorInput.disabled, false, "authenticated unlock still permits shared evaluator edits");
  assert.equal(tab.refs.saveLive.disabled, false, "locked execution does not block saving evaluator thresholds");
  const configEditWallNow = wallNow;
  wallNow = configEditWallNow + 501;
  tab.renderFreshnessState();
  assert.equal(tab.statusIsStale(), true, "live evaluator verdicts still fail closed after 500 ms");
  assert.equal(tab.configEnvelopeIsStale(), false,
    "the authenticated config response has an independent editing freshness window");
  assert.equal(tab.liveUnlocked, true);
  assert.equal(evaluatorInput.disabled, false,
    "live-verdict aging cannot deadlock an authenticated evaluator draft");
  assert.equal(tab.refs.unlockLive.checked, true);
  wallNow = configEditWallNow;
  tab.renderFreshnessState();

  const fetchBeforeTransientStatusFailure = tab.fetchImpl;
  const recoveredAuthenticatedStatus = {
    ...tab.status,
    timestamp_ms: wallNow,
    stale: false,
    live: {...tab.status.live, timestamp_ms: wallNow, stale: false},
  };
  let transientStatusAttempts = 0;
  tab.fetchImpl = async (url, options) => {
    if (url.includes("/api/lighter-micro/status")) {
      transientStatusAttempts += 1;
      if (transientStatusAttempts === 1) {
        return response({success: false, error: "status temporarily unavailable"}, 503);
      }
      return response(recoveredAuthenticatedStatus);
    }
    return fetchBeforeTransientStatusFailure(url, options);
  };
  tab.draftDirty = true;
  tab.refs.liveControls.innerHTML = '<div data-unsaved-draft="true">unsaved threshold draft</div>';
  const unsavedDraftMarkup = tab.refs.liveControls.innerHTML;
  assert.equal(await tab.refreshMarket(), false);
  assert.equal(tab.statusIsStale(), true,
    "a transient fast-status failure still fails live evaluator verdicts closed");
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /LIVE · UNAVAILABLE/);
  assert.equal(tab.configEnvelopeIsStale(), false,
    "the last successful authenticated config envelope remains fresh through a transient status failure");
  assert.equal(tab.liveUnlocked, true, "a transient status failure cannot revoke the editor unlock");
  assert.equal(tab.draftDirty, true, "a transient status failure cannot clear the dirty draft flag");
  assert.equal(tab.refs.liveControls.innerHTML, unsavedDraftMarkup,
    "a transient status failure cannot rebuild and discard unsaved controls");
  assert.equal(evaluatorInput.disabled, false);
  assert.equal(tab.refs.saveLive.disabled, false,
    "a fresh authenticated config envelope may remain saveable while live verdicts are unavailable");
  assert.equal(tab.refs.unlockLive.checked, true);
  wallNow = configEditWallNow + 30_001;
  assert.equal(tab.configEnvelopeIsStale(), true,
    "the retained authenticated config envelope still expires after its 30 second freshness window");
  wallNow = configEditWallNow;

  assert.equal(await tab.refreshMarket(), true);
  assert.equal(tab.errors.status, null);
  assert.equal(tab.statusIsStale(), false);
  assert.equal(tab.liveUnlocked, true);
  assert.equal(tab.draftDirty, true);
  assert.equal(tab.refs.liveControls.innerHTML, unsavedDraftMarkup,
    "status recovery preserves the same in-progress editor DOM");
  tab.fetchImpl = fetchBeforeTransientStatusFailure;

  assert.deepEqual(tab.collectLiveConfig(), {conditions: []},
    "locked execution omits strategy_enabled from the evaluator payload");
  tab.collectLiveConfig = () => ({conditions: [{key: "spread_ok", enabled: true, threshold: 2.5}]});
  const replayBeforeConfigSave = tab.replay;
  const replayCallsBeforeConfigSave = calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length;
  const saved = await tab.saveLiveConfig();
  assert.equal(saved, true);
  const post = calls.find((call) => call.url.endsWith("/api/lighter-micro/config"));
  assert.ok(post, "authenticated configuration save uses the proposed config endpoint");
  assert.equal(post.options.method, "POST");
  assert.equal(post.options.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(post.options.body), {
    conditions: [{key: "spread_ok", enabled: true, threshold: 2.5}],
  });
  assert.equal(
    calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length,
    replayCallsBeforeConfigSave + 1,
    "saving shared evaluator settings immediately reruns replay under the saved thresholds",
  );
  assert.notEqual(tab.replay, replayBeforeConfigSave,
    "the completed replay is replaced after a successful evaluator config save");
  assert.equal(tab.replayInvalidatedByConfig, false);
  assert.equal(tab.liveUnlocked, false, "successful evaluator save returns the module to read-only mode");
  assert.ok(calls.every((call) => !call.url.includes("/order")), "evaluator configuration never calls an order endpoint");

  const source = fs.readFileSync(path.join(__dirname, "../lighter-micro-tab.js"), "utf8");
  assert.match(source, /Asia\/Seoul/);
  assert.match(source, /\$\{kind\.toUpperCase\(\)\} · \$\{condition\.state\}/,
    "condition rows render the PAPER/LIVE stream name beside each backend verdict");
  assert.match(source, /authenticated === true/);
  assert.doesNotMatch(source, /data-micro-ref="liveEnabled"/);
  assert.doesNotMatch(source, /payload\.strategy_enabled/);
  assert.doesNotMatch(source, /Save &amp; Deploy|Deploy these microstructure settings/);
  assert.doesNotMatch(source, /api\/lighter-micro\/order/);
  assert.doesNotMatch(source, /\$187\.55|mock|sample price/i, "module must not contain fabricated market/account values");

  tab.replay = replayWithSignals;
  tab.replayLoading = false;
  tab.errors.replay = null;
  tab.renderAll();
  const completedReplay = tab.replay;
  tab.replayInvalidatedByConfig = true;
  tab.errors.replay = "replay temporarily unavailable";
  tab.renderAll();
  assert.equal(tab.refs.entrySignals.textContent, "UNAVAILABLE",
    "a replay evaluated under pre-save settings is withheld after a config change");
  assert.deepEqual(tab.entryMarkers, []);
  assert.match(tab.refs.replaySource.textContent, /CONFIG CHANGED · RERUN FAILED · prior replay withheld/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /PAPER · UNAVAILABLE/);
  tab.replayInvalidatedByConfig = false;
  tab.errors.replay = null;
  tab.renderAll();
  const replayCallsBeforeNavigation = calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length;
  const previousCycle = tab.readiness.cycle;
  await tab.onTabActivated();
  assert.equal(tab.readiness.cycle, previousCycle + 1, "each activation starts a new readiness timing cycle");
  assert.notEqual(tab.readiness.accountMs, null);
  assert.notEqual(tab.readiness.chartMs, null);
  assert.equal(tab.replay, completedReplay, "navigation preserves the last completed replay object");
  assert.equal(calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length, replayCallsBeforeNavigation,
    "navigation does not rerun a completed replay");

  const completedMarkers = tab.entryMarkers.map((marker) => ({...marker}));
  failReplay = true;
  const failedRerun = tab.rerunReplay();
  assert.equal(tab.replayLoading, true);
  assert.equal(tab.refs.entrySignals.textContent, "3");
  assert.deepEqual(tab.entryMarkers, completedMarkers);
  assert.match(tab.refs.replaySource.textContent, /UPDATING · showing last completed replay/);
  assert.equal(await failedRerun, false);
  assert.equal(tab.replay, completedReplay, "failed rerun cannot replace the last completed replay");
  assert.equal(tab.refs.entrySignals.textContent, "3");
  assert.deepEqual(tab.entryMarkers, completedMarkers);
  assert.match(tab.refs.replaySource.textContent, /RERUN FAILED · showing last completed replay/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /PAPER · PASS/);
  failReplay = false;
  tab.errors.replay = null;
  tab.renderAll();

  tab.startPolling();
  assert.ok(tab.pollTimer, "active tab can poll read-only telemetry");
  tab.startMarketPolling();
  assert.ok(tab.marketPollTimer, "active tab has an independent fast snapshot/status loop");
  visibleRange = {from: 6, to: 17};
  tab.onTabDeactivated();
  assert.equal(tab.pollTimer, null, "deactivation stops telemetry polling");
  assert.equal(tab.marketPollTimer, null, "deactivation stops fast market polling");
  assert.deepEqual(tab.chartRanges[tab.interval], {from: 6, to: 17}, "deactivation preserves chart navigation state");

  const normalFetch = tab.fetchImpl;
  let releaseDelayedChart;
  const delayedChart = new Promise((resolve) => { releaseDelayedChart = resolve; });
  let chartRequestPending = true;
  tab.fetchImpl = async (url, options) => {
    if (chartRequestPending && url.includes("/api/lighter-crypto/candles")) {
      chartRequestPending = false;
      await delayedChart;
    }
    return normalFetch(url, options);
  };
  const cycleBeforeDelayedReactivation = tab.readiness.cycle;
  const delayedReactivation = tab.onTabActivated();
  assert.equal(chartRequestPending, false, "reactivation starts the staged chart request immediately");
  assert.equal(tab.readiness.cycle, cycleBeforeDelayedReactivation + 1);
  assert.equal(tab.readiness.accountMs, null);
  assert.equal(tab.readiness.chartMs, null);
  assert.equal(tab.account.account_stale, true, "retained account payload is marked stale before the request resolves");
  assert.equal(tab.account.refresh_pending, true);
  assert.equal(tab.refs.accountCollateral.textContent, "UNAVAILABLE · STALE · LOADING");
  assert.match(tab.refs.accountPositions.innerHTML, /CACHED VALUES MARKED STALE AND WITHHELD/);
  assert.match(tab.refs.accountSource.textContent, /ACCOUNT · STALE .*refresh pending/);
  assert.match(tab.refs.accountError.textContent, /ACCOUNT REFRESHING/);
  assert.equal(tab.chartPayload.stale, true, "retained candles are marked stale before the request resolves");
  assert.equal(tab.chartPayload.refresh_pending, true);
  assert.equal(tab.chartRendered, false, "retained chart cannot satisfy readiness while reload is pending");
  assert.match(tab.refs.chartSource.textContent, /CHART · STALE .*refresh pending/);
  assert.match(tab.refs.chartError.textContent, /CHART REFRESHING/);
  assert.equal(tab.snapshotLoading, true);
  assert.equal(tab.snapshot.stale, true,
    "retained L2 is marked stale immediately when activation starts");
  assert.equal(tab.snapshot.refresh_pending, true);
  assert.equal(tab.refs.spread.textContent, "UNAVAILABLE");
  assert.match(tab.refs.asks.innerHTML, /UNAVAILABLE/);
  assert.match(tab.refs.marketSource.textContent, /MARKET · STALE .*UPDATING/);
  assert.equal(tab.statusLoading, true);
  assert.equal(tab.status.stale, true,
    "retained live condition and safeguard status is marked stale during activation");
  assert.equal(tab.status.refresh_pending, true);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /LIVE · UNAVAILABLE/);
  assert.match(tab.refs.safeguards.innerHTML, /UNAVAILABLE/);
  assert.match(tab.refs.safeguardSource.textContent, /STALE .*UPDATING/);
  assert.equal(tab.replayLoading, false);
  assert.equal(tab.replay, completedReplay);
  assert.equal(tab.refs.entrySignals.textContent, "3");
  assert.deepEqual(tab.entryMarkers, completedMarkers);
  assert.doesNotMatch(tab.refs.replaySource.textContent, /UPDATING/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /PAPER · PASS/);
  releaseDelayedChart();
  assert.equal(await delayedReactivation, true);
  assert.equal(tab.account.account_stale, false);
  assert.equal(tab.chartPayload.stale, false);
  assert.equal(tab.snapshotLoading, false);
  assert.equal(tab.statusLoading, false);
  assert.equal(tab.replayLoading, false);
  assert.equal(tab.snapshot.stale, undefined);
  assert.equal(tab.status.stale, false);
  assert.equal(tab.replay.stale, undefined);
  assert.equal(tab.refs.entrySignals.textContent, "3");
  assert.equal(calls.filter((call) => call.url.includes("/api/lighter-micro/replay")).length,
    replayCallsBeforeNavigation + 1,
    "only the explicit failed rerun called the replay endpoint across navigation");
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /PAPER · PASS/);
  assert.match(tab.refs.mandatoryPrerequisites.innerHTML, /LIVE · PASS/);
  assert.notEqual(tab.readiness.accountMs, null);
  assert.notEqual(tab.readiness.chartMs, null);
  tab.fetchImpl = normalFetch;
  tab.onTabDeactivated();
  tab.destroy();
  assert.equal(chartRemoved, true, "destroy releases the LightweightCharts instance");
  assert.equal(tab.mounted, false);

  let stagedInFlight = 0;
  let stagedMaxInFlight = 0;
  const stagedFetch = async (...args) => {
    stagedInFlight += 1;
    stagedMaxInFlight = Math.max(stagedMaxInFlight, stagedInFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return await fetchImpl(...args);
    } finally {
      stagedInFlight -= 1;
    }
  };
  const stagedTab = new LighterMicroTab(new FakeHost(), {
    fetchImpl: stagedFetch,
    apiPrefix: "/skhynix",
    autoPoll: false,
    autoMarketPoll: true,
    chartLibrary,
    storage,
    wallNowProvider: () => wallNow,
    retryDelayMs: 0,
  });
  assert.equal(await stagedTab.onTabActivated(), true);
  assert.equal(stagedMaxInFlight, 1,
    "activation never overlaps account, candle, L2, status, or replay requests on a loaded backend");
  assert.equal(stagedTab.pollTimer, null);
  assert.ok(stagedTab.marketPollTimer,
    "autoMarketPoll can run independently when the slow autoPoll loop is disabled");
  stagedTab.destroy();
  assert.equal(stagedTab.marketPollTimer, null, "destroy cleans the independent market timer");

  const interleavedStorageValues = new Map();
  const interleavedStorage = {
    getItem: (key) => interleavedStorageValues.get(key) ?? null,
    setItem: (key, value) => interleavedStorageValues.set(key, String(value)),
  };
  let resolveHeldStatusStarted;
  const heldStatusStarted = new Promise((resolve) => { resolveHeldStatusStarted = resolve; });
  let releaseHeldStatus;
  let heldStatusAborted = false;
  let holdInterleavedStatus = true;
  let resolveFiveMinuteStarted;
  const fiveMinuteStarted = new Promise((resolve) => { resolveFiveMinuteStarted = resolve; });
  let resolveResumedReplayStarted;
  const resumedReplayStarted = new Promise((resolve) => { resolveResumedReplayStarted = resolve; });
  let releaseResumedReplay;
  const resumedReplayReleased = new Promise((resolve) => { releaseResumedReplay = resolve; });
  let resumedReplayCalls = 0;
  const interleavedFetch = async (url, options = {}) => {
    if (holdInterleavedStatus && url.includes("/api/lighter-micro/status")) {
      holdInterleavedStatus = false;
      resolveHeldStatusStarted();
      await new Promise((resolve, reject) => {
        releaseHeldStatus = resolve;
        const abort = () => {
          heldStatusAborted = true;
          const error = new Error("held status request aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener?.("abort", abort, {once: true});
      });
    }
    if (url.includes("/api/lighter-crypto/candles") && url.includes("interval=5m")) {
      resolveFiveMinuteStarted();
    }
    if (url.includes("/api/lighter-micro/replay")) {
      resumedReplayCalls += 1;
      resolveResumedReplayStarted();
      await resumedReplayReleased;
    }
    return fetchImpl(url, options);
  };
  const interleavedTab = new LighterMicroTab(new FakeHost(), {
    fetchImpl: interleavedFetch,
    apiPrefix: "/skhynix",
    autoMarketPoll: false,
    autoFreshness: false,
    chartLibrary,
    storage: interleavedStorage,
    interval: "1m",
    wallNowProvider: () => wallNow,
    retryDelayMs: 0,
  });
  const interleavedActivation = interleavedTab.onTabActivated();
  await heldStatusStarted;
  assert.equal(interleavedTab.chartDataInterval, "1m");
  assert.equal(interleavedTab.accountLoading, false,
    "the activation account request completes before the held ancillary status request");
  assert.equal(interleavedTab.snapshotLoading, false,
    "the activation snapshot request completes before the held ancillary status request");
  assert.equal(interleavedTab.statusLoading, true);
  const interleavedIntervalSwitch = interleavedTab.setChartInterval("5m");
  assert.equal(interleavedTab.interval, "1m",
    "the loaded chart keeps its truthful interval label while the prior refresh aborts");
  const fiveMinuteStartedPromptly = await Promise.race([
    fiveMinuteStarted.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 50)),
  ]);
  if (!fiveMinuteStartedPromptly) releaseHeldStatus();
  assert.equal(await interleavedActivation, false,
    "interval navigation preempts the unrelated activation tail");
  assert.equal(await interleavedIntervalSwitch, true,
    "the selected interval renders without waiting for the held ancillary request");
  assert.equal(fiveMinuteStartedPromptly, true);
  assert.equal(heldStatusAborted, true);
  assert.equal(interleavedTab.chartDataInterval, "5m");
  assert.equal(interleavedStorageValues.get("skhynix_lighter_micro_interval"), "5m");
  assert.equal(interleavedTab.accountLoading, false);
  assert.equal(interleavedTab.snapshotLoading, false);
  assert.equal(interleavedTab.statusLoading, false,
    "preemption settles the cancelled ancillary loading flag");
  await resumedReplayStarted;
  assert.equal(resumedReplayCalls, 1,
    "interval navigation resumes the one-time replay request cancelled during activation");
  assert.equal(interleavedTab.replayLoading, true);
  assert.equal(interleavedTab.chartDataInterval, "5m",
    "the selected chart is usable while the recovery replay remains in flight");
  const resumedReplayRefresh = interleavedTab.refreshPromise;
  assert.ok(resumedReplayRefresh);
  releaseResumedReplay();
  assert.equal(await resumedReplayRefresh, true);
  assert.equal(interleavedTab.replayLoading, false);
  assert.equal(interleavedTab.refs.entrySignals.textContent, "3");
  assert.notEqual(interleavedTab.refs.spread.textContent, "UNAVAILABLE");
  assert.match(interleavedTab.refs.mandatoryPrerequisites.innerHTML, /LIVE · UNAVAILABLE/);
  assert.ok(interleavedTab.pollTimer,
    "automatic account/chart polling still starts after the preempted activation settles");

  const interleavedNormalFetch = interleavedTab.fetchImpl;
  let releaseLateFifteenMinuteCandles;
  const lateFifteenMinuteCandlesReleased = new Promise((resolve) => {
    releaseLateFifteenMinuteCandles = resolve;
  });
  let holdLateFifteenMinuteCandles = true;
  interleavedTab.fetchImpl = async (url, options) => {
    if (holdLateFifteenMinuteCandles
        && url.includes("/api/lighter-crypto/candles")
        && url.includes("interval=15m")) {
      holdLateFifteenMinuteCandles = false;
      await lateFifteenMinuteCandlesReleased;
    }
    return interleavedNormalFetch(url, options);
  };
  const lateIntervalSwitch = interleavedTab.setChartInterval("15m");
  assert.equal(interleavedTab.chartLoading, true);
  interleavedTab.onTabDeactivated();
  releaseLateFifteenMinuteCandles();
  assert.equal(await lateIntervalSwitch, false,
    "a candle success arriving after deactivation is rejected by abort/generation guards");
  assert.notEqual(interleavedTab.chartDataInterval, "15m");
  assert.equal(resumedReplayCalls, 1,
    "later interval navigation never duplicates an already completed replay");
  assert.notEqual(interleavedStorageValues.get("skhynix_lighter_micro_interval"), "15m");
  assert.equal(interleavedTab.readiness.chartMs, null);
  interleavedTab.destroy();

  console.log("Standalone Lighter micro account, chart, interval, lifecycle, and evaluator-lock checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
