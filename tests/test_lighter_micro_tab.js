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

const wallNow = 1_800_000_000_000;
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
  if (url.includes("/api/lighter-micro/replay")) return response({
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
  if (url.includes("/api/lighter-crypto/status")) return response({
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
  if (url.includes("/api/lighter-crypto/candles")) {
    if (failCandles) return response({success: false, error: "candle feed unavailable"});
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

  visibleRange = {from: 4, to: 18};
  await tab.refreshChart();
  assert.deepEqual(visibleRange, {from: 4, to: 18}, "same-interval refresh preserves the visible chart range");
  await tab.setChartInterval("5m");
  assert.equal(tab.interval, "5m");
  assert.deepEqual(tab.chartRanges["1m"], {from: 4, to: 18}, "interval switch preserves the prior interval viewport");
  assert.equal(storageValues.get("skhynix_lighter_micro_interval"), "5m");
  assert.ok(calls.some((call) => call.url === "/skhynix/api/lighter-crypto/candles?symbol=BTC&interval=5m&limit=180"));
  assert.equal(host.intervals.find((button) => button.getAttribute("data-micro-interval") === "5m").getAttribute("aria-pressed"), "true");
  assert.equal(seriesByTitle.get("BTC").data.at(-1).value, 60_825);
  assert.equal(seriesByTitle.get("MA7").data.length, 24);
  assert.equal(seriesByTitle.get("MA24").data.length, 7);
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

  const conditionTime = 1791500000123;
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
    live: {order_submission_implemented: false},
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
  assert.deepEqual(tab.collectLiveConfig(), {conditions: []},
    "locked execution omits strategy_enabled from the evaluator payload");
  tab.collectLiveConfig = () => ({conditions: [{key: "spread_ok", enabled: true, threshold: 2.5}]});
  const saved = await tab.saveLiveConfig();
  assert.equal(saved, true);
  const post = calls.find((call) => call.url.endsWith("/api/lighter-micro/config"));
  assert.ok(post, "authenticated configuration save uses the proposed config endpoint");
  assert.equal(post.options.method, "POST");
  assert.equal(post.options.headers.Authorization, "Bearer secret-token");
  assert.deepEqual(JSON.parse(post.options.body), {
    conditions: [{key: "spread_ok", enabled: true, threshold: 2.5}],
  });
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

  const previousCycle = tab.readiness.cycle;
  await tab.onTabActivated();
  assert.equal(tab.readiness.cycle, previousCycle + 1, "each activation starts a new readiness timing cycle");
  assert.notEqual(tab.readiness.accountMs, null);
  assert.notEqual(tab.readiness.chartMs, null);
  tab.startPolling();
  assert.ok(tab.pollTimer, "active tab can poll read-only telemetry");
  visibleRange = {from: 6, to: 17};
  tab.onTabDeactivated();
  assert.equal(tab.pollTimer, null, "deactivation stops telemetry polling");
  assert.deepEqual(tab.chartRanges[tab.interval], {from: 6, to: 17}, "deactivation preserves chart navigation state");
  tab.destroy();
  assert.equal(chartRemoved, true, "destroy releases the LightweightCharts instance");
  assert.equal(tab.mounted, false);

  console.log("Standalone Lighter micro account, chart, interval, lifecycle, and evaluator-lock checks passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
