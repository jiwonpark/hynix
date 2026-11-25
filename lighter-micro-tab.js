(function (root, factory) {
  "use strict";

  const exported = factory(root || {});
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
  if (root) {
    root.LighterMicroTab = exported.LighterMicroTab;
    root.createLighterMicroTab = exported.createLighterMicroTab;
    root.LighterMicroTabUtils = exported.utils;
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  const KST_TIME_ZONE = "Asia/Seoul";
  const VALID_CONDITION_STATES = new Set(["PASS", "WAITING", "OFF", "UNAVAILABLE"]);
  const CHART_INTERVALS = Object.freeze(["1m", "5m", "15m"]);
  const INTERVAL_SECONDS = Object.freeze({"1m": 60, "5m": 300, "15m": 900});
  const SNAPSHOT_DEPTH_LIMIT = 20;
  const INTERVAL_STORAGE_KEY = "skhynix_lighter_micro_interval";
  const DEFAULT_POLL_INTERVAL_MS = 10000;
  const DEFAULT_MARKET_POLL_INTERVAL_MS = 400;
  const FRESHNESS_RENDER_INTERVAL_MS = 250;
  const DEFAULT_QUOTE_FRESHNESS_MS = 500;
  const ACCOUNT_FRESHNESS_MS = 15000;
  const CONFIG_STATUS_FRESHNESS_MS = 30000;
  const FUTURE_TIMESTAMP_TOLERANCE_MS = 2000;
  const DEFAULT_RETRY_DELAY_MS = 1000;
  const DEFAULT_ENDPOINTS = Object.freeze({
    snapshot: "/api/lighter-micro/snapshot",
    status: "/api/lighter-micro/status",
    replay: "/api/lighter-micro/replay?limit=500",
    config: "/api/lighter-micro/config",
    account: "/api/lighter-crypto/status?symbol=BTC",
    candles: "/api/lighter-crypto/candles",
  });

  /*
   * Proposed JSON contract (all timestamps are exchange/source timestamps):
   * snapshot: {source,timestamp_ms,order_book:{bids,asks},metrics:{spread_bps,
   *   depth_imbalance,microprice,trade_flow_imbalance,price_momentum_bps},paper_conditions?}
   * replay: {source,timestamp_ms,entry_signals,exit_signals?,fills?,trades?,
   *   evaluations?}. Signal and fill counts are intentionally never substituted for one another.
   * status: {authenticated,source,timestamp_ms,last_evaluation|live_conditions,
   *   safeguards,config:{strategy_enabled,conditions:[{key,label,enabled,
   *   editable_threshold,threshold:{value,min,max,step,unit}}]}}
   * config POST: {conditions:[{key,enabled,threshold?}]}; it changes the shared
   * evaluator only. This module intentionally has no order or execution-arm endpoint.
   * Existing read-only dependencies: GET /api/lighter-crypto/status?symbol=BTC and
   * GET /api/lighter-crypto/candles?symbol=BTC&interval={1m|5m|15m}&limit=180.
   */

  function storageGet(storage, key) {
    try { return storage?.getItem?.(key) ?? null; } catch (_) { return null; }
  }

  function storageSet(storage, key, value) {
    try { storage?.setItem?.(key, value); } catch (_) {}
  }

  function validChartInterval(value) {
    return CHART_INTERVALS.includes(value) ? value : null;
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean" || typeof value === "object") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function timestampMilliseconds(value) {
    const numeric = finiteNumber(value instanceof Date ? value.getTime() : value);
    if (numeric === null || numeric <= 0) return null;
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }

  function formatKstDateTime(value) {
    const milliseconds = timestampMilliseconds(value);
    if (milliseconds === null) return "time unavailable";
    const date = new Date(milliseconds);
    if (!Number.isFinite(date.getTime())) return "time unavailable";
    return `${date.toLocaleString("en-CA", {
      timeZone: KST_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).replace(",", "")} KST`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function displayValue(value, options = {}) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (typeof value.display === "string" && value.display.trim()) return value.display.trim();
      const numeric = finiteNumber(value.value);
      if (numeric === null) return "UNAVAILABLE";
      const digits = Number.isInteger(value.decimals) ? value.decimals : options.digits;
      const formatted = Number.isInteger(digits) ? numeric.toFixed(digits) : String(numeric);
      return `${formatted}${value.unit ? ` ${value.unit}` : ""}`;
    }
    if (typeof value === "string" && value.trim() && finiteNumber(value) === null) return value.trim();
    const numeric = finiteNumber(value);
    if (numeric === null) return "UNAVAILABLE";
    const formatted = Number.isInteger(options.digits) ? numeric.toFixed(options.digits) : String(numeric);
    return `${options.prefix || ""}${formatted}${options.suffix || ""}`;
  }

  function normalizeLevel(level) {
    const price = finiteNumber(Array.isArray(level) ? level[0] : level?.price);
    const size = finiteNumber(Array.isArray(level) ? level[1] : (level?.size ?? level?.quantity ?? level?.qty));
    if (price === null || price <= 0 || size === null || size <= 0) return null;
    return {price, size};
  }

  function normalizeBook(payload, requestedDepth = 10) {
    const depth = Math.max(1, Math.min(100, Math.floor(finiteNumber(requestedDepth) ?? 10)));
    const rawBook = payload?.order_book || payload?.book || payload || {};
    const normalizeSide = (levels, descending) => {
      const result = Array.isArray(levels) ? levels.map(normalizeLevel).filter(Boolean) : [];
      result.sort((left, right) => descending ? right.price - left.price : left.price - right.price);
      let cumulative = 0;
      return result.slice(0, depth).map((level) => {
        cumulative += level.size;
        return {...level, cumulative};
      });
    };
    return {
      depth,
      bids: normalizeSide(rawBook.bids, true),
      asks: normalizeSide(rawBook.asks, false),
    };
  }

  function metricValue(container, keys) {
    for (const key of keys) {
      const candidate = container?.[key];
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        if (finiteNumber(candidate.value) !== null || (typeof candidate.display === "string" && candidate.display.trim())) {
          return candidate;
        }
      } else if (finiteNumber(candidate) !== null) {
        return candidate;
      }
    }
    return null;
  }

  function metricNumeric(metric) {
    return finiteNumber(metric && typeof metric === "object" ? metric.value : metric);
  }

  function deriveBookMetrics(payload, requestedDepth = 10) {
    const book = normalizeBook(payload, requestedDepth);
    const supplied = payload?.metrics || payload?.microstructure || payload?.latest_evaluation?.metrics || {};
    const bestBid = book.bids[0] || null;
    const bestAsk = book.asks[0] || null;
    const spreadDerived = bestBid && bestAsk ? bestAsk.price - bestBid.price : null;
    const midpoint = bestBid && bestAsk ? (bestAsk.price + bestBid.price) / 2 : null;
    const spreadBpsDerived = spreadDerived !== null && midpoint > 0 ? (spreadDerived / midpoint) * 10000 : null;
    const hasRequestedDepth = book.bids.length >= book.depth && book.asks.length >= book.depth;
    const bidDepth = hasRequestedDepth ? book.bids.reduce((sum, level) => sum + level.size, 0) : null;
    const askDepth = hasRequestedDepth ? book.asks.reduce((sum, level) => sum + level.size, 0) : null;
    const totalDepth = bidDepth !== null && askDepth !== null ? bidDepth + askDepth : null;
    const imbalanceDerived = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : null;
    const topSize = bestBid && bestAsk ? bestBid.size + bestAsk.size : null;
    const micropriceDerived = topSize > 0
      ? ((bestAsk.price * bestBid.size) + (bestBid.price * bestAsk.size)) / topSize
      : null;

    const suppliedSpread = metricValue(supplied, ["spread", "spread_absolute"]);
    const suppliedSpreadBps = metricValue(supplied, ["spread_bps"]);
    const suppliedImbalance = metricValue(supplied, ["top_n_depth_imbalance", "depth_imbalance"]);
    const suppliedMicroprice = metricValue(supplied, ["microprice"]);
    const tradeFlow = metricValue(supplied, ["trade_flow", "signed_trade_flow", "trade_flow_imbalance"]);
    const momentum = metricValue(supplied, ["momentum", "trade_momentum", "price_momentum_bps"]);

    return {
      book,
      bestBid: bestBid?.price ?? null,
      bestAsk: bestAsk?.price ?? null,
      spread: suppliedSpread ?? spreadDerived,
      spreadBps: suppliedSpreadBps ?? spreadBpsDerived,
      imbalance: suppliedImbalance ?? imbalanceDerived,
      microprice: suppliedMicroprice ?? micropriceDerived,
      tradeFlow,
      momentum,
      source: {
        spread: suppliedSpread !== null ? "endpoint" : (spreadDerived !== null ? "derived from visible book" : "unavailable"),
        spreadBps: suppliedSpreadBps !== null ? "endpoint" : (spreadBpsDerived !== null ? "derived from visible book" : "unavailable"),
        imbalance: suppliedImbalance !== null ? "endpoint" : (imbalanceDerived !== null ? "derived from visible book" : "unavailable"),
        microprice: suppliedMicroprice !== null ? "endpoint" : (micropriceDerived !== null ? "derived from top of book" : "unavailable"),
        tradeFlow: tradeFlow !== null ? "endpoint" : "unavailable",
        momentum: momentum !== null ? "endpoint" : "unavailable",
      },
    };
  }

  function conditionState(condition, context = {}) {
    if (!condition || context.available === false || condition.available === false || condition.stale === true) {
      return "UNAVAILABLE";
    }
    if (condition.enabled === false) return "OFF";
    const explicit = typeof condition.state === "string" ? condition.state.trim().toUpperCase() : "";
    if (VALID_CONDITION_STATES.has(explicit)) return explicit;
    if (condition.pass === true || condition.passed === true) return "PASS";
    if (condition.pass === false || condition.passed === false) return "WAITING";
    return "UNAVAILABLE";
  }

  function humanizeKey(key) {
    return String(key || "condition").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function normalizeConditionCollection(raw, meta = {}) {
    if (!raw) return [];
    let values;
    if (Array.isArray(raw)) {
      values = raw;
    } else if (raw.conditions && Array.isArray(raw.conditions)) {
      values = raw.conditions;
    } else if (raw.conditions && typeof raw.conditions === "object") {
      values = Object.entries(raw.conditions).map(([key, value]) => ({key, ...(value || {})}));
    } else if (raw.condition_pass && typeof raw.condition_pass === "object") {
      values = Object.entries(raw.condition_pass).map(([key, pass]) => ({
        key,
        pass,
        enabled: raw.condition_enabled?.[key] !== false,
        measured: raw.condition_values?.[key],
        threshold: raw.condition_thresholds?.[key],
      }));
    } else if (typeof raw === "object") {
      values = Object.entries(raw).map(([key, value]) => {
        if (value && typeof value === "object") return {key, ...value};
        return {key, pass: value};
      });
    } else {
      return [];
    }

    return values.map((value, index) => {
      const condition = value && typeof value === "object" ? value : {};
      const key = String(condition.key || condition.id || `condition_${index + 1}`);
      const normalizedCondition = {
        ...condition,
        state: condition.state ?? condition.status,
        measured: condition.measured ?? condition.measured_value,
      };
      return {
        ...normalizedCondition,
        key,
        label: String(condition.label || condition.name || humanizeKey(key)),
        state: conditionState(normalizedCondition, meta),
        source: condition.source || meta.source || null,
        timestamp: condition.timestamp_ms ?? condition.timestamp ?? condition.source_timestamp_ms ?? meta.timestamp ?? null,
      };
    });
  }

  function combineConditionStreams(paperRaw, liveRaw, paperMeta = {}, liveMeta = {}) {
    const paper = normalizeConditionCollection(paperRaw, paperMeta);
    const live = normalizeConditionCollection(liveRaw, liveMeta);
    const orderedKeys = [];
    const byKey = new Map();
    const add = (stream, kind) => stream.forEach((condition) => {
      if (!byKey.has(condition.key)) {
        orderedKeys.push(condition.key);
        byKey.set(condition.key, {key: condition.key, label: condition.label, paper: null, live: null});
      }
      const row = byKey.get(condition.key);
      row.label ||= condition.label;
      row[kind] = condition;
    });
    add(paper, "paper");
    add(live, "live");
    return orderedKeys.map((key) => byKey.get(key));
  }

  function countField(payload, fieldNames, arrayNames) {
    for (const container of [payload?.summary, payload]) {
      for (const field of fieldNames) {
        const value = finiteNumber(container?.[field]);
        if (value !== null && value >= 0) return Math.floor(value);
      }
    }
    for (const field of arrayNames) {
      if (Array.isArray(payload?.[field])) return payload[field].length;
    }
    return null;
  }

  function normalizeReplayCounts(payload) {
    return {
      entrySignals: countField(payload, ["entry_signal_count", "signal_count"], ["entry_signals"]),
      exitSignals: countField(payload, ["exit_signal_count"], ["exit_signals"]),
      fills: countField(payload, ["fill_count", "simulated_fill_count"], ["fills", "simulated_fills"]),
      trades: countField(payload, ["trade_count", "trades"], ["trades"]),
    };
  }

  function normalizeCandleBars(payload) {
    const rows = Array.isArray(payload?.bars) ? payload.bars : [];
    const byTime = new Map();
    rows.forEach((row) => {
      const time = finiteNumber(row?.time ?? row?.timestamp);
      const value = finiteNumber(row?.value ?? row?.close);
      if (time === null || time <= 0 || value === null || value <= 0) return;
      byTime.set(time, {
        time,
        value,
        open: finiteNumber(row?.open),
        high: finiteNumber(row?.high),
        low: finiteNumber(row?.low),
        close: finiteNumber(row?.close) ?? value,
        volume: finiteNumber(row?.volume),
      });
    });
    return [...byTime.values()].sort((left, right) => left.time - right.time);
  }

  function movingAverageSeries(bars, windowSize) {
    const size = Math.floor(finiteNumber(windowSize) ?? 0);
    if (!Array.isArray(bars) || size < 1 || bars.length < size) return [];
    let rolling = 0;
    const result = [];
    bars.forEach((bar, index) => {
      rolling += bar.value;
      if (index >= size) rolling -= bars[index - size].value;
      if (index >= size - 1) result.push({time: bar.time, value: rolling / size});
    });
    return result;
  }

  function accountUnrealizedPnl(account) {
    if (!Array.isArray(account?.positions)) return null;
    if (!account.positions.length) return 0;
    let total = 0;
    for (const position of account.positions) {
      const pnl = finiteNumber(position?.unrealized_pnl);
      if (pnl === null) return null;
      total += pnl;
    }
    return total;
  }

  function accountPayloadUsable(account) {
    return Boolean(
      account
      && account.success !== false
      && account.authenticated === true
      && account.account_stale !== true
      && finiteNumber(account.collateral) !== null
      && finiteNumber(account.available_margin) !== null
      && Array.isArray(account.positions)
      && accountUnrealizedPnl(account) !== null
      && timestampMilliseconds(account.account_updated_ms) !== null
    );
  }

  function sourceTimestampMilliseconds(payload) {
    if (!payload || typeof payload !== "object") return null;
    const source = payload.source && typeof payload.source === "object" ? payload.source : null;
    const sourceMeta = payload.source_meta && typeof payload.source_meta === "object" ? payload.source_meta : null;
    return timestampMilliseconds(
      payload.timestamp_ms
      ?? payload.source_timestamp_ms
      ?? payload.received_at_ms
      ?? payload.condition_timestamp_ms
      ?? payload.latest_condition_time
      ?? payload.time
      ?? source?.timestamp_ms
      ?? source?.source_timestamp_ms
      ?? sourceMeta?.latest_timestamp_ms
      ?? sourceMeta?.timestamp_ms,
    );
  }

  function sourceAgeMilliseconds(payload, wallNowMilliseconds) {
    const timestamp = sourceTimestampMilliseconds(payload);
    const now = finiteNumber(wallNowMilliseconds);
    if (timestamp === null || now === null) return null;
    if (timestamp > now + FUTURE_TIMESTAMP_TOLERANCE_MS) return null;
    return Math.max(0, now - timestamp);
  }

  function payloadStaleByAge(payload, wallNowMilliseconds, maximumAgeMilliseconds) {
    if (!payload || payload.stale === true) return true;
    const age = sourceAgeMilliseconds(payload, wallNowMilliseconds);
    const maximumAge = finiteNumber(maximumAgeMilliseconds);
    return age === null || maximumAge === null || maximumAge < 0 || age > maximumAge;
  }

  function accountAgeMilliseconds(account, wallNowMilliseconds) {
    const timestamp = timestampMilliseconds(account?.account_updated_ms);
    const now = finiteNumber(wallNowMilliseconds);
    if (timestamp === null || now === null) return null;
    if (timestamp > now + FUTURE_TIMESTAMP_TOLERANCE_MS) return null;
    return Math.max(0, now - timestamp);
  }

  function accountPayloadStale(account, wallNowMilliseconds, maximumAgeMilliseconds = ACCOUNT_FRESHNESS_MS) {
    if (!account || account.account_stale === true) return true;
    const age = accountAgeMilliseconds(account, wallNowMilliseconds);
    const maximumAge = finiteNumber(maximumAgeMilliseconds);
    return age === null || maximumAge === null || maximumAge < 0 || age > maximumAge;
  }

  function chartPayloadStale(payload, bars, interval, wallNowMilliseconds) {
    if (payload?.stale === true || !bars.length) return true;
    const lastMilliseconds = timestampMilliseconds(bars.at(-1)?.time);
    const seconds = INTERVAL_SECONDS[interval];
    if (lastMilliseconds === null || !seconds) return true;
    const now = finiteNumber(wallNowMilliseconds);
    if (now === null) return true;
    if (lastMilliseconds > now + FUTURE_TIMESTAMP_TOLERANCE_MS) return true;
    return Math.max(0, now - lastMilliseconds) > seconds * 3 * 1000;
  }

  function entrySignalTimestampSeconds(signal) {
    const candidate = signal?.timestamp_ms
      ?? signal?.source_timestamp_ms
      ?? signal?.time
      ?? signal?.source?.timestamp_ms;
    const milliseconds = timestampMilliseconds(candidate);
    return milliseconds === null ? null : milliseconds / 1000;
  }

  function entrySignalSide(signal) {
    const numeric = finiteNumber(signal?.side ?? signal?.candidate_side);
    if (numeric !== null && numeric !== 0) return numeric > 0 ? 1 : -1;
    const direction = String(signal?.direction || "").trim().toLowerCase();
    if (direction === "long") return 1;
    if (direction === "short") return -1;
    return null;
  }

  function containingCandleTime(bars, timestampSeconds, interval) {
    const seconds = INTERVAL_SECONDS[interval];
    const timestamp = finiteNumber(timestampSeconds);
    if (!Array.isArray(bars) || !bars.length || timestamp === null || !seconds) return null;
    let low = 0;
    let high = bars.length - 1;
    let match = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const time = finiteNumber(bars[middle]?.time);
      if (time === null) return null;
      if (time <= timestamp) {
        match = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (match < 0) return null;
    const candleTime = Number(bars[match].time);
    return timestamp < candleTime + seconds ? candleTime : null;
  }

  function replayEntrySignalMarkers(replay, bars, interval) {
    const signals = Array.isArray(replay?.entry_signals) ? replay.entry_signals : [];
    const grouped = new Map();
    signals.forEach((signal) => {
      const timestamp = entrySignalTimestampSeconds(signal);
      const side = entrySignalSide(signal);
      const candleTime = containingCandleTime(bars, timestamp, interval);
      if (candleTime === null || side === null) return;
      const key = `${candleTime}:${side}`;
      const group = grouped.get(key) || {time: candleTime, side, count: 0, signals: []};
      group.count += 1;
      group.signals.push(signal);
      grouped.set(key, group);
    });
    return [...grouped.values()]
      .sort((left, right) => left.time - right.time || right.side - left.side)
      .map((group) => {
        const long = group.side > 0;
        return {
          time: group.time,
          position: long ? "belowBar" : "aboveBar",
          color: long ? "#16a34a" : "#dc2626",
          shape: long ? "arrowUp" : "arrowDown",
          text: group.count > 1 ? `×${group.count}` : "",
          direction: long ? "long" : "short",
          count: group.count,
          is_entry: true,
          is_signal: true,
          source: "replay.entry_signals",
          signals: group.signals,
        };
      });
  }

  function usdDisplay(value) {
    const numeric = finiteNumber(value);
    return numeric === null ? "UNAVAILABLE" : `$${numeric.toFixed(2)} USD`;
  }

  function sourceLine(kind, payload, options = {}) {
    const rawSource = payload?.source || payload?.market_source || options.source;
    const source = rawSource && typeof rawSource === "object"
      ? [rawSource.name, rawSource.instrument].filter(Boolean).join(" · ") || "source unavailable"
      : rawSource || "source unavailable";
    const timestamp = payload?.timestamp_ms ?? payload?.timestamp ?? payload?.source_timestamp_ms ?? payload?.time
      ?? (rawSource && typeof rawSource === "object" ? rawSource.timestamp_ms : null) ?? options.timestamp;
    const stale = options.stale || payload?.stale === true;
    const freshness = stale ? "STALE · " : "";
    return `${kind.toUpperCase()} · ${freshness}${source} · ${formatKstDateTime(timestamp)}`;
  }

  function apiPrefixFromLocation(locationLike) {
    const pathname = locationLike?.pathname || "";
    return pathname.startsWith("/skhynix") ? "/skhynix" : "";
  }

  function configConditions(status) {
    const raw = status?.config?.conditions || status?.config_schema?.conditions;
    return Array.isArray(raw) ? raw.filter((condition) => condition && (condition.key || condition.id)) : [];
  }

  class LighterMicroTab {
    constructor(host, options = {}) {
      if (!host) throw new Error("LighterMicroTab requires a host element");
      this.host = host;
      this.options = options;
      this.endpoints = {...DEFAULT_ENDPOINTS, ...(options.endpoints || {})};
      this.apiPrefix = options.apiPrefix ?? apiPrefixFromLocation(options.location || root.location);
      this.fetchImpl = options.fetchImpl || root.fetch?.bind(root);
      this.confirmImpl = options.confirmImpl || root.confirm?.bind(root) || (() => false);
      this.tokenProvider = options.tokenProvider || (() => root.terminalLockManager?.token || null);
      this.storage = options.storage || root.localStorage || null;
      this.chartLibrary = options.chartLibrary || root.LightweightCharts || null;
      this.elapsedNow = options.elapsedNowProvider || (() => root.performance?.now?.() ?? Date.now());
      this.wallNow = options.wallNowProvider || (() => Date.now());
      this.pollIntervalMs = Math.max(1000, finiteNumber(options.pollIntervalMs) ?? DEFAULT_POLL_INTERVAL_MS);
      this.marketPollIntervalMs = Math.max(100, Math.min(
        DEFAULT_QUOTE_FRESHNESS_MS,
        finiteNumber(options.marketPollIntervalMs) ?? DEFAULT_MARKET_POLL_INTERVAL_MS,
      ));
      this.freshnessIntervalMs = Math.max(100, finiteNumber(options.freshnessIntervalMs) ?? FRESHNESS_RENDER_INTERVAL_MS);
      this.retryDelayMs = Math.max(0, finiteNumber(options.retryDelayMs) ?? DEFAULT_RETRY_DELAY_MS);
      this.criticalRetryAttempts = Math.max(1, Math.min(3, Math.floor(finiteNumber(options.criticalRetryAttempts) ?? 2)));
      this.accountRequestTimeoutMs = Math.max(5000, finiteNumber(options.accountRequestTimeoutMs) ?? 35000);
      this.chartRequestTimeoutMs = Math.max(5000, finiteNumber(options.chartRequestTimeoutMs) ?? 30000);
      this.delayImpl = options.delayImpl || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
      this.depth = Math.max(1, Math.min(SNAPSHOT_DEPTH_LIMIT, Math.floor(finiteNumber(options.depth) ?? 10)));
      this.interval = validChartInterval(options.interval)
        || validChartInterval(storageGet(this.storage, INTERVAL_STORAGE_KEY))
        || "1m";
      this.mounted = false;
      this.refreshing = false;
      this.refreshPromise = null;
      this.refreshController = null;
      this.active = false;
      this.activationSequence = 0;
      this.pollTimer = null;
      this.marketPollTimer = null;
      this.marketRefreshPromise = null;
      this.marketRefreshController = null;
      this.marketRefreshGeneration = 0;
      this.fullRefreshOwnsMarket = false;
      this.freshnessTimer = null;
      this.lastFreshnessSignature = null;
      this.snapshot = null;
      this.status = null;
      this.statusReceivedAtMs = null;
      this.replay = null;
      this.replayInvalidatedByConfig = false;
      this.account = null;
      this.accountLastFresh = null;
      this.chartPayload = null;
      this.accountLoading = false;
      this.chartLoading = false;
      this.snapshotLoading = false;
      this.statusLoading = false;
      this.replayLoading = false;
      this.errors = {snapshot: null, status: null, replay: null, config: null, account: null, chart: null};
      this.liveUnlocked = false;
      this.draftDirty = false;
      this.refs = {};
      this.chart = null;
      this.priceSeries = null;
      this.ma7Series = null;
      this.ma24Series = null;
      this.bars = [];
      this.ma7 = [];
      this.ma24 = [];
      this.chartRendered = false;
      this.chartDataInterval = null;
      this.chartRequest = 0;
      this.intervalChartController = null;
      this.chartRanges = {};
      this.entryMarkers = [];
      this.entryMarkerPrimitive = null;
      this.resizeObserver = null;
      this.readiness = {cycle: 0, startedAt: null, accountMs: null, chartMs: null};
    }

    markup() {
      return `
        <style>
          .lighterMicroTerminal{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#0f172a;background:#f8fafc;padding:16px;box-sizing:border-box}
          .lighterMicroTerminal *{box-sizing:border-box}.lm-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}
          .lm-head h2{font-size:20px;margin:0}.lm-sub{font-size:12px;color:#64748b;margin:4px 0 0}.lm-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
          .lm-btn{border:1px solid #cbd5e1;background:#fff;color:#0f172a;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer}.lm-btn:disabled{opacity:.45;cursor:not-allowed}
          .lm-btn-primary{background:#0f172a;color:#fff;border-color:#0f172a}.lm-pill{font-size:11px;font-weight:800;border-radius:999px;padding:6px 9px;background:#e2e8f0;color:#334155}
          .lm-pill.editing{background:#fff7ed;color:#9a3412}.lm-source{font-size:11px;color:#64748b;margin-top:6px}.lm-error{font-size:12px;color:#b91c1c;min-height:18px;margin:4px 0 8px}
          .lm-grid{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr));gap:10px;margin:12px 0}.lm-card,.lm-panel{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:12px}
          .lm-card span{display:block;font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#64748b}.lm-card strong{display:block;font-size:18px;margin-top:5px}.lm-card small{color:#94a3b8;font-size:10px}
          .lm-columns{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:12px;margin-top:12px}.lm-panel h3{font-size:14px;margin:0 0 8px}.lm-panel h4{font-size:12px;margin:12px 0 7px;color:#334155}
          .lm-ladders{display:grid;grid-template-columns:1fr 1fr;gap:10px}.lm-table{width:100%;border-collapse:collapse;font-size:11px}.lm-table th,.lm-table td{padding:6px;border-bottom:1px solid #f1f5f9;text-align:right}.lm-table th:first-child,.lm-table td:first-child{text-align:left}.lm-ask{color:#dc2626}.lm-bid{color:#16a34a}
          .lm-unavailable{text-align:center!important;color:#94a3b8!important;padding:18px!important}.lm-condition td:nth-child(2),.lm-condition td:nth-child(3){text-align:left}.lm-badge{display:inline-block;border-radius:999px;padding:3px 7px;font-weight:800;font-size:10px;background:#e2e8f0;color:#475569}
          .lm-badge.pass{background:#dcfce7;color:#166534}.lm-badge.waiting{background:#fef3c7;color:#92400e}.lm-badge.off{background:#e2e8f0;color:#475569}.lm-badge.unavailable{background:#f1f5f9;color:#64748b}.lm-badge.blocked{background:#fee2e2;color:#991b1b}
          .lm-replay{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.lm-replay .lm-card{background:#f8fafc}.lm-safeguard{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid #f1f5f9}.lm-safeguard:last-child{border-bottom:0}.lm-safeguard small{display:block;color:#64748b;margin-top:2px}
          .lm-live-note{font-size:11px;color:#64748b;background:#f8fafc;border-radius:8px;padding:9px;margin-bottom:10px}.lm-control-row{display:grid;grid-template-columns:minmax(140px,1fr) 90px minmax(120px,.8fr);align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px}
          .lm-control-row input[type=number]{width:100%;padding:6px;border:1px solid #cbd5e1;border-radius:6px}.lm-live-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:12px}.lm-live-footer label{font-size:11px;font-weight:700}.lm-live-message{font-size:11px;color:#64748b}
          .lm-readiness{display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:#475569;background:#e2e8f0;border-radius:9px;padding:8px 10px}.lm-readiness strong{color:#0f172a}.lm-account-grid{display:grid;grid-template-columns:repeat(4,minmax(115px,1fr));gap:8px;margin-bottom:10px}
          .lm-chart-head{display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap}.lm-intervals{display:flex;gap:5px}.lm-interval.active,.lm-interval[aria-pressed=true]{background:#0f172a;color:#fff;border-color:#0f172a}.lm-chart-host{height:340px;min-height:260px;width:100%;position:relative;margin-top:8px}.lm-chart-legend{display:flex;gap:12px;flex-wrap:wrap;font-size:10px;color:#64748b;margin-top:6px}.lm-chart-legend i{display:inline-block;width:16px;height:2px;vertical-align:middle;margin-right:4px}.lm-account-stale{background:#fff7ed}.lm-position-side.long{color:#16a34a}.lm-position-side.short{color:#dc2626}
          .lm-assumption-groups{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.lm-assumption-group{border:1px solid #e2e8f0;border-radius:9px;padding:10px;background:#f8fafc}.lm-assumption-group h4{margin:0 0 6px}.lm-assumption-row{display:flex;justify-content:space-between;gap:12px;padding:5px 0;border-bottom:1px solid #e2e8f0;font-size:11px}.lm-assumption-row:last-child{border-bottom:0}.lm-assumption-row span{color:#475569}.lm-assumption-row strong{text-align:right}.lm-assumption-detail{display:block;color:#64748b;font-weight:400;margin-top:2px}.lm-mandatory-note{font-size:11px;color:#7c2d12;background:#fff7ed;border-radius:8px;padding:8px;margin:6px 0}
          @media(max-width:1000px){.lm-grid{grid-template-columns:repeat(2,minmax(130px,1fr))}.lm-columns{grid-template-columns:1fr}.lm-replay{grid-template-columns:repeat(2,1fr)}.lm-assumption-groups{grid-template-columns:1fr}}
          @media(max-width:600px){.lighterMicroTerminal{padding:10px}.lm-grid,.lm-ladders{grid-template-columns:1fr}.lm-account-grid{grid-template-columns:repeat(2,1fr)}.lm-control-row{grid-template-columns:1fr 70px}.lm-control-row .lm-threshold{grid-column:1/-1}.lm-chart-host{height:290px}}
        </style>
        <section class="lighterMicroTerminal" data-micro-ref="terminal" aria-label="Lighter order-book microstructure terminal">
          <header class="lm-head">
            <div>
              <h2>Lighter Microstructure</h2>
              <p class="lm-sub">Shadow/paper microstructure lab. Market and account views are read-only; authenticated controls save shared evaluator settings only.</p>
              <div class="lm-source" data-micro-ref="marketSource">MARKET · source unavailable · time unavailable</div>
            </div>
            <div class="lm-actions">
              <span class="lm-pill" data-micro-ref="accessBadge">READ-ONLY</span>
              <button class="lm-btn" type="button" data-micro-ref="rerunButton">Rerun paper replay</button>
              <button class="lm-btn" type="button" data-micro-ref="refreshButton">Refresh</button>
            </div>
          </header>
          <div class="lm-error" data-micro-ref="error" role="status" aria-live="polite"></div>
          <div class="lm-readiness" aria-label="Usability timing">
            <span>Account usable: <strong data-micro-ref="accountReadyTime">waiting</strong></span>
            <span>Chart price + MA7 + MA24 usable: <strong data-micro-ref="chartReadyTime">waiting</strong></span>
          </div>

          <div class="lm-columns">
            <section class="lm-panel" aria-label="Read-only Lighter BTC account">
              <h3>Read-only Lighter BTC account</h3>
              <div class="lm-account-grid">
                <div class="lm-card"><span>Equity / collateral</span><strong data-micro-ref="accountCollateral">UNAVAILABLE</strong></div>
                <div class="lm-card"><span>Available margin</span><strong data-micro-ref="accountAvailable">UNAVAILABLE</strong></div>
                <div class="lm-card"><span>BTC positions</span><strong data-micro-ref="accountPositionCount">UNAVAILABLE</strong></div>
                <div class="lm-card"><span>Applicable unrealized P&amp;L</span><strong data-micro-ref="accountUnrealized">UNAVAILABLE</strong></div>
              </div>
              <table class="lm-table"><thead><tr><th>Side</th><th>Size BTC</th><th>Entry</th><th>Mark</th><th>Unrealized P&amp;L</th></tr></thead>
                <tbody data-micro-ref="accountPositions"><tr><td colspan="5" class="lm-unavailable">UNAVAILABLE</td></tr></tbody>
              </table>
              <div class="lm-source" data-micro-ref="accountSource">ACCOUNT · source unavailable · time unavailable</div>
              <div class="lm-error" data-micro-ref="accountError"></div>
            </section>

            <section class="lm-panel" aria-label="BTC price chart">
              <div class="lm-chart-head"><h3>BTC price · Lighter candles</h3><div class="lm-intervals" role="group" aria-label="BTC candle interval">
                <button class="lm-btn lm-interval" type="button" data-micro-interval="1m" aria-pressed="false">1m</button>
                <button class="lm-btn lm-interval" type="button" data-micro-interval="5m" aria-pressed="false">5m</button>
                <button class="lm-btn lm-interval" type="button" data-micro-interval="15m" aria-pressed="false">15m</button>
              </div></div>
              <div id="lighterMicro_chartHost" class="lm-chart-host" data-micro-ref="chartHost" aria-label="BTC price with MA7 and MA24 and replay entry-signal markers"></div>
              <div class="lm-chart-legend"><span><i style="background:#0f172a"></i>BTC price</span><span><i style="background:#00a6c7"></i>MA7</span><span><i style="background:#f59e0b"></i>MA24</span></div>
              <div class="lm-source" data-micro-ref="chartSource">CHART · source unavailable · time unavailable</div>
              <div class="lm-error" data-micro-ref="chartError"></div>
            </section>
          </div>

          <div class="lm-grid" aria-label="Microstructure metrics">
            <div class="lm-card"><span>Spread</span><strong data-micro-ref="spread">UNAVAILABLE</strong><small data-micro-ref="spreadSource">source unavailable</small></div>
            <div class="lm-card"><span data-micro-ref="imbalanceLabel">Top-N depth imbalance</span><strong data-micro-ref="imbalance">UNAVAILABLE</strong><small data-micro-ref="imbalanceSource">source unavailable</small></div>
            <div class="lm-card"><span>Microprice</span><strong data-micro-ref="microprice">UNAVAILABLE</strong><small data-micro-ref="micropriceSource">source unavailable</small></div>
            <div class="lm-card"><span>Trade flow</span><strong data-micro-ref="tradeFlow">UNAVAILABLE</strong><small data-micro-ref="tradeFlowSource">source unavailable</small></div>
            <div class="lm-card"><span>Momentum</span><strong data-micro-ref="momentum">UNAVAILABLE</strong><small data-micro-ref="momentumSource">source unavailable</small></div>
          </div>

          <div class="lm-columns">
            <section class="lm-panel" aria-label="Order book ladder">
              <h3>Bid / ask ladder</h3>
              <div class="lm-ladders">
                <div><h4>Asks</h4><table class="lm-table"><thead><tr><th>Level</th><th>Price</th><th>Size</th><th>Cumulative</th></tr></thead><tbody data-micro-ref="asks"><tr><td colspan="4" class="lm-unavailable">UNAVAILABLE</td></tr></tbody></table></div>
                <div><h4>Bids</h4><table class="lm-table"><thead><tr><th>Level</th><th>Price</th><th>Size</th><th>Cumulative</th></tr></thead><tbody data-micro-ref="bids"><tr><td colspan="4" class="lm-unavailable">UNAVAILABLE</td></tr></tbody></table></div>
              </div>
            </section>

            <section class="lm-panel" aria-label="Replay summary">
              <h3>Paper replay · signals are not fills</h3>
              <div class="lm-replay">
                <div class="lm-card"><span>Entry signals</span><strong data-micro-ref="entrySignals">UNAVAILABLE</strong></div>
                <div class="lm-card"><span>Exit signals</span><strong data-micro-ref="exitSignals">UNAVAILABLE</strong></div>
                <div class="lm-card"><span>Simulated fills</span><strong data-micro-ref="fills">UNAVAILABLE</strong></div>
                <div class="lm-card"><span>Completed trades</span><strong data-micro-ref="trades">UNAVAILABLE</strong></div>
              </div>
              <div class="lm-source" data-micro-ref="replaySource">PAPER · source unavailable · time unavailable</div>
            </section>
          </div>

          <section class="lm-panel" style="margin-top:12px" aria-label="Strategy condition status">
            <h3>Strategy conditions</h3>
            <h4>Mandatory derived prerequisite · fixed, cannot be disabled</h4>
            <div class="lm-mandatory-note">Direction is a prerequisite produced by the fixed edge model, not an optional strategy switch.</div>
            <table class="lm-table lm-condition">
              <thead><tr><th>Prerequisite</th><th>PAPER</th><th>LIVE</th><th>Requirement</th></tr></thead>
              <tbody data-micro-ref="mandatoryPrerequisites"><tr><td colspan="4" class="lm-unavailable">Directional prerequisite unavailable</td></tr></tbody>
            </table>
            <h4>Optional entry and exit conditions · authenticated evaluator settings</h4>
            <table class="lm-table lm-condition">
              <thead><tr><th>Condition</th><th>PAPER</th><th>LIVE</th><th>Measured / threshold</th></tr></thead>
              <tbody data-micro-ref="conditions"><tr><td colspan="4" class="lm-unavailable">No backend condition verdicts available</td></tr></tbody>
            </table>
            <div class="lm-source" data-micro-ref="paperConditionSource">PAPER · source unavailable · time unavailable</div>
            <div class="lm-source" data-micro-ref="liveConditionSource">LIVE · source unavailable · time unavailable</div>
          </section>

          <section class="lm-panel" style="margin-top:12px" aria-label="Fixed model and paper assumptions">
            <h3>Fixed model &amp; paper assumptions · read-only</h3>
            <div class="lm-live-note">These values are active runtime/model assumptions, not controls. They cannot be changed from this tab.</div>
            <div data-micro-ref="fixedAssumptions"><div class="lm-unavailable">Fixed assumptions unavailable</div></div>
            <div class="lm-source" data-micro-ref="fixedAssumptionSource">FIXED ASSUMPTIONS · source unavailable</div>
          </section>

          <div class="lm-columns">
            <section class="lm-panel" aria-label="Execution safeguards">
              <h3>Execution safeguards · not optional strategy conditions</h3>
              <div data-micro-ref="safeguards"><div class="lm-unavailable">UNAVAILABLE</div></div>
              <div class="lm-source" data-micro-ref="safeguardSource">LIVE SAFEGUARDS · source unavailable · time unavailable</div>
            </section>

            <section class="lm-panel" aria-label="Authenticated evaluator configuration">
              <h3>Authenticated evaluator configuration</h3>
              <div class="lm-live-note">Read-only by default. Saving changes shared PAPER/LIVE evaluator thresholds only. Live execution remains locked unless the backend explicitly reports an implemented order submitter; this module has no order route.</div>
              <div class="lm-safeguard" aria-label="Live execution status">
                <div><strong>Live execution</strong><small data-micro-ref="executionLockHelp">Shadow/paper only · no live order submitter or arm route</small></div>
                <span class="lm-badge blocked" data-micro-ref="executionLockStatus">LOCKED</span>
              </div>
              <div data-micro-ref="liveControls"><div class="lm-unavailable">Authenticated configuration unavailable</div></div>
              <div class="lm-live-footer">
                <label><input type="checkbox" data-micro-ref="unlockLive"> Unlock evaluator setting edits</label>
                <button class="lm-btn lm-btn-primary" type="button" data-micro-ref="saveLive" disabled>Save evaluator settings</button>
              </div>
              <div class="lm-live-message" data-micro-ref="liveMessage">READ-ONLY · authenticate and unlock to edit</div>
            </section>
          </div>
        </section>`;
    }

    mount() {
      if (this.mounted) return this;
      this.host.innerHTML = this.markup();
      this.host.dataset.lighterMicroMounted = "true";
      if (this.host.classList?.add) this.host.classList.add("lighter-micro-tab-host");
      this.refs = {};
      this.host.querySelectorAll?.("[data-micro-ref]").forEach((element) => {
        this.refs[element.getAttribute("data-micro-ref")] = element;
      });
      this.refs.refreshButton?.addEventListener("click", () => {
        this.beginReadinessCycle({includeReplay: false});
        this.refresh({includeReplay: false, includeAccount: true, includeChart: true, includeMarket: true});
      });
      this.refs.rerunButton?.addEventListener("click", () => {
        this.rerunReplay();
      });
      this.host.querySelectorAll?.("[data-micro-interval]").forEach((button) => {
        button.addEventListener("click", () => this.setChartInterval(button.getAttribute("data-micro-interval")));
      });
      this.refs.unlockLive?.addEventListener("change", () => {
        this.liveUnlocked = this.refs.unlockLive.checked === true;
        this.syncLiveControlAccess();
      });
      this.refs.liveControls?.addEventListener("change", () => { this.draftDirty = true; });
      this.refs.saveLive?.addEventListener("click", () => this.saveLiveConfig().catch((error) => {
        this.errors.config = error?.message || String(error);
        this.renderErrors();
        this.syncLiveControlAccess();
      }));
      this.mounted = true;
      this.renderIntervalButtons();
      this.ensureChart();
      this.renderAll();
      return this;
    }

    beginReadinessCycle(options = {}) {
      const startedAt = finiteNumber(this.elapsedNow()) ?? Date.now();
      this.readiness = {
        cycle: this.readiness.cycle + 1,
        startedAt,
        accountMs: null,
        chartMs: null,
      };
      this.markCriticalDataLoading({includeReplay: options.includeReplay === true});
      this.renderReadiness();
      return this.readiness.cycle;
    }

    markCriticalDataLoading(options = {}) {
      this.accountLoading = true;
      this.chartLoading = true;
      this.snapshotLoading = true;
      this.statusLoading = true;
      this.errors.account = null;
      this.errors.chart = null;
      this.errors.snapshot = null;
      this.errors.status = null;
      if (this.account) this.account = {...this.account, account_stale: true, refresh_pending: true};
      if (this.chartPayload) this.chartPayload = {...this.chartPayload, stale: true, refresh_pending: true};
      if (this.snapshot) this.snapshot = {...this.snapshot, stale: true, refresh_pending: true};
      if (this.status) this.status = {...this.status, stale: true, refresh_pending: true};
      if (options.includeReplay) {
        this.replayLoading = true;
        this.errors.replay = null;
      }
      this.chartRequest += 1;
      this.chartRendered = false;
      this.renderAll();
    }

    quoteFreshnessLimitMs() {
      const configured = finiteNumber(
        this.status?.config?.raw?.runtime?.max_quote_age_ms
        ?? this.status?.max_quote_age_ms
        ?? this.snapshot?.max_quote_age_ms,
      );
      return configured === null || configured < 0 ? DEFAULT_QUOTE_FRESHNESS_MS : configured;
    }

    snapshotIsStale() {
      return Boolean(
        this.snapshotLoading
        || this.errors.snapshot
        || payloadStaleByAge(this.snapshot, this.wallNow(), this.quoteFreshnessLimitMs()),
      );
    }

    statusIsStale() {
      const nested = this.status?.live || this.status?.last_evaluation || null;
      const payload = sourceTimestampMilliseconds(nested) === null ? this.status : nested;
      return Boolean(
        this.statusLoading
        || this.errors.status
        || this.status?.stale === true
        || payloadStaleByAge(payload, this.wallNow(), this.quoteFreshnessLimitMs()),
      );
    }

    configEnvelopeIsStale() {
      // Live verdict freshness and authenticated config-envelope freshness are
      // separate clocks. A transient quote/status request failure must fail the
      // verdicts closed without invalidating a recently authenticated editor.
      if (!this.status) return true;
      const receivedAt = finiteNumber(this.statusReceivedAtMs);
      const sourceTimestamp = receivedAt ?? timestampMilliseconds(
        this.status.server_time_ms ?? this.status.timestamp_ms,
      );
      const now = finiteNumber(this.wallNow());
      if (sourceTimestamp === null || now === null) return true;
      if (sourceTimestamp > now + FUTURE_TIMESTAMP_TOLERANCE_MS) return true;
      const freshnessLimit = Math.max(CONFIG_STATUS_FRESHNESS_MS, this.pollIntervalMs * 2);
      return Math.max(0, now - sourceTimestamp) > freshnessLimit;
    }

    completedReplayAvailable(payload = this.replay) {
      const evidence = payload?.paper
        || (Array.isArray(payload?.evaluations) ? payload.evaluations.at(-1) : null)
        || payload;
      const recognizedShape = Boolean(
        payload?.paper
        || Array.isArray(payload?.evaluations)
        || Array.isArray(payload?.entry_signals)
        || Array.isArray(payload?.exit_signals)
        || Array.isArray(payload?.fills)
        || Array.isArray(payload?.paper_fills)
        || payload?.summary
      );
      return Boolean(
        payload
        && !(payload === this.replay && this.replayInvalidatedByConfig)
        && recognizedShape
        && payload.success !== false
        && payload.stale !== true
        && evidence
        && evidence.stale !== true
      );
    }

    replayIsStale() {
      return !this.completedReplayAvailable();
    }

    accountIsStale() {
      return Boolean(
        this.accountLoading
        || this.errors.account
        || accountPayloadStale(this.account, this.wallNow(), ACCOUNT_FRESHNESS_MS),
      );
    }

    chartIsStale() {
      const responseInterval = validChartInterval(this.chartPayload?.interval);
      return Boolean(
        this.chartLoading
        || this.errors.chart
        || this.chartDataInterval !== this.interval
        || (responseInterval && responseInterval !== this.interval)
        || chartPayloadStale(this.chartPayload, this.bars, this.interval, this.wallNow()),
      );
    }

    elapsedReadinessMs() {
      if (this.readiness.startedAt === null) return null;
      const now = finiteNumber(this.elapsedNow()) ?? Date.now();
      return Math.max(0, Math.round(now - this.readiness.startedAt));
    }

    recordAccountReady() {
      if (this.readiness.accountMs !== null || !accountPayloadUsable(this.account) || this.accountIsStale()) return false;
      this.readiness.accountMs = this.elapsedReadinessMs();
      this.renderReadiness();
      return true;
    }

    recordChartReady() {
      const usable = this.chartRendered
        && !this.chartIsStale()
        && this.bars.length > 0
        && this.ma7.length > 0
        && this.ma24.length > 0;
      if (this.readiness.chartMs !== null || !usable) return false;
      this.readiness.chartMs = this.elapsedReadinessMs();
      this.renderReadiness();
      return true;
    }

    renderReadiness() {
      const account = this.readiness.accountMs;
      const chart = this.readiness.chartMs;
      this.setText("accountReadyTime", account === null ? "waiting / unavailable" : `${account} ms`);
      this.setText("chartReadyTime", chart === null ? "waiting / unavailable" : `${chart} ms`);
      if (this.refs.accountReadyTime?.dataset) this.refs.accountReadyTime.dataset.elapsedMs = account === null ? "" : String(account);
      if (this.refs.chartReadyTime?.dataset) this.refs.chartReadyTime.dataset.elapsedMs = chart === null ? "" : String(chart);
    }

    renderIntervalButtons() {
      this.host.querySelectorAll?.("[data-micro-interval]").forEach((button) => {
        const selected = button.getAttribute("data-micro-interval") === this.interval;
        button.setAttribute("aria-pressed", selected ? "true" : "false");
        button.classList?.toggle("active", selected);
      });
    }

    captureChartRange() {
      const range = this.chart?.timeScale?.().getVisibleLogicalRange?.();
      if (range && finiteNumber(range.from) !== null && finiteNumber(range.to) !== null) {
        this.chartRanges[this.interval] = {from: Number(range.from), to: Number(range.to)};
      }
    }

    resizeChart() {
      const host = this.refs.chartHost;
      if (!host || !this.chart) return;
      const width = Math.max(0, Number(host.clientWidth || host.parentElement?.clientWidth || 0));
      const height = Math.max(260, Number(host.clientHeight || 340));
      if (width > 0) this.chart.applyOptions?.({width, height});
    }

    ensureChart() {
      if (this.chart && this.priceSeries && this.ma7Series && this.ma24Series) return true;
      const host = this.refs.chartHost;
      const library = this.chartLibrary || root.LightweightCharts;
      if (!host || !library?.createChart) {
        this.errors.chart = "LightweightCharts renderer unavailable";
        return false;
      }
      try {
        const width = Math.max(320, Number(host.clientWidth || host.parentElement?.clientWidth || 720));
        const height = Math.max(260, Number(host.clientHeight || 340));
        this.chart = library.createChart(host, {
          width,
          height,
          layout: {background: {color: "#ffffff"}, textColor: "#475569"},
          grid: {vertLines: {color: "#f1f5f9"}, horzLines: {color: "#f1f5f9"}},
          rightPriceScale: {borderColor: "#e2e8f0"},
          timeScale: {borderColor: "#e2e8f0", timeVisible: true, secondsVisible: false},
          localization: {timeFormatter: (time) => formatKstDateTime(Number(time) * 1000)},
        });
        const addLine = (options) => {
          if (typeof this.chart.addLineSeries === "function") return this.chart.addLineSeries(options);
          if (typeof this.chart.addSeries === "function" && library.LineSeries) return this.chart.addSeries(library.LineSeries, options);
          return null;
        };
        this.priceSeries = addLine({color: "#0f172a", lineWidth: 2, title: "BTC"});
        this.ma7Series = addLine({color: "#00a6c7", lineWidth: 2, title: "MA7"});
        this.ma24Series = addLine({color: "#f59e0b", lineWidth: 2, title: "MA24"});
        if (!this.priceSeries || !this.ma7Series || !this.ma24Series) throw new Error("Line-series API unavailable");
        this.chart.timeScale?.().subscribeVisibleLogicalRangeChange?.((range) => {
          if (!range || finiteNumber(range.from) === null || finiteNumber(range.to) === null) return;
          this.chartRanges[this.chartDataInterval || this.interval] = {from: Number(range.from), to: Number(range.to)};
        });
        const ResizeObserverImpl = this.options.ResizeObserver || root.ResizeObserver;
        if (ResizeObserverImpl) {
          this.resizeObserver = new ResizeObserverImpl(() => this.resizeChart());
          this.resizeObserver.observe?.(host);
        }
        this.errors.chart = null;
        return true;
      } catch (error) {
        this.errors.chart = `Chart renderer unavailable: ${error?.message || error}`;
        this.chart = null;
        this.priceSeries = null;
        this.ma7Series = null;
        this.ma24Series = null;
        return false;
      }
    }

    applyEntryMarkers(markers) {
      const next = Array.isArray(markers) ? markers : [];
      this.entryMarkers = next;
      if (!this.priceSeries) return false;
      if (typeof this.priceSeries.setMarkers === "function") {
        this.priceSeries.setMarkers(next);
        return true;
      }
      const library = this.chartLibrary || root.LightweightCharts;
      if (this.entryMarkerPrimitive?.setMarkers) {
        this.entryMarkerPrimitive.setMarkers(next);
        return true;
      }
      if (typeof library?.createSeriesMarkers === "function") {
        this.entryMarkerPrimitive = library.createSeriesMarkers(this.priceSeries, next);
        return true;
      }
      return false;
    }

    renderEntrySignalMarkers() {
      const replayAvailable = !this.replayIsStale();
      const markers = replayAvailable
        ? replayEntrySignalMarkers(this.replay, this.bars, this.interval)
        : [];
      this.applyEntryMarkers(markers);
      return markers;
    }

    renderChartSeries(bars, ma7, ma24, interval) {
      if (!this.ensureChart()) return false;
      if (this.chartDataInterval === interval) this.captureChartRange();
      this.priceSeries.setData?.(bars.map((bar) => ({time: bar.time, value: bar.value})));
      this.ma7Series.setData?.(ma7);
      this.ma24Series.setData?.(ma24);
      const remembered = this.chartRanges[interval];
      this.chartDataInterval = interval;
      if (remembered) this.chart.timeScale?.().setVisibleLogicalRange?.(remembered);
      else this.chart.timeScale?.().fitContent?.();
      this.applyEntryMarkers(replayEntrySignalMarkers(
        !this.replayIsStale() ? this.replay : null,
        bars,
        interval,
      ));
      this.resizeChart();
      return true;
    }

    beginChartReadinessCycle() {
      const startedAt = finiteNumber(this.elapsedNow()) ?? Date.now();
      this.readiness = {
        cycle: this.readiness.cycle + 1,
        startedAt,
        accountMs: accountPayloadUsable(this.account) && !this.accountIsStale() ? 0 : null,
        chartMs: null,
      };
      this.renderReadiness();
    }

    markChartDataLoading(options = {}) {
      const clearSeries = options.clearSeries === true;
      this.chartRequest += 1;
      this.chartLoading = true;
      this.chartRendered = false;
      this.errors.chart = null;
      if (this.chartPayload) {
        this.chartPayload = {
          ...this.chartPayload,
          stale: true,
          refresh_pending: true,
          previous_interval: this.chartDataInterval,
        };
      }
      this.applyEntryMarkers([]);
      if (clearSeries) {
        this.bars = [];
        this.ma7 = [];
        this.ma24 = [];
        this.priceSeries?.setData?.([]);
        this.ma7Series?.setData?.([]);
        this.ma24Series?.setData?.([]);
        this.chartDataInterval = null;
      }
      this.renderChartMeta();
    }

    async setChartInterval(value) {
      const interval = validChartInterval(value);
      if (!interval) throw new Error("Unsupported chart interval");
      const changed = interval !== this.interval;
      this.captureChartRange();
      this.interval = interval;
      this.beginChartReadinessCycle();
      this.markChartDataLoading({clearSeries: changed});
      this.renderIntervalButtons();
      if (this.refreshPromise) {
        await this.refreshPromise.catch(() => false);
      }
      if (!this.active || interval !== this.interval) return false;
      if (!this.chartIsStale() && this.chartDataInterval === interval) {
        storageSet(this.storage, INTERVAL_STORAGE_KEY, interval);
        return true;
      }
      this.intervalChartController?.abort?.();
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      this.intervalChartController = controller;
      try {
        const refreshed = await this.refreshChart({signal: controller?.signal || null});
        if (refreshed && interval === this.interval) storageSet(this.storage, INTERVAL_STORAGE_KEY, interval);
        return refreshed;
      } finally {
        if (this.intervalChartController === controller) this.intervalChartController = null;
      }
    }

    async requestJson(path, options = {}) {
      if (typeof this.fetchImpl !== "function") throw new Error("Fetch API unavailable");
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const externalSignal = options.signal || null;
      const abortFromExternal = () => controller?.abort();
      if (controller && externalSignal) {
        if (externalSignal.aborted) controller.abort();
        else externalSignal.addEventListener?.("abort", abortFromExternal, {once: true});
      }
      const timeoutMs = Math.max(1000, finiteNumber(options.timeoutMs) ?? 15000);
      let timer = null;
      let timedOut = false;
      if (controller) timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const headers = {Accept: "application/json", ...(options.headers || {})};
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const requestOptions = {
        method: options.method || "GET",
        headers,
        signal: controller?.signal || externalSignal || undefined,
      };
      if (options.body !== undefined) requestOptions.body = JSON.stringify(options.body);
      try {
        const response = await this.fetchImpl(`${this.apiPrefix}${path}`, requestOptions);
        let payload = null;
        const contentType = response?.headers?.get?.("content-type") || "application/json";
        if (contentType.includes("application/json")) payload = await response.json().catch(() => null);
        if (!response?.ok) {
          throw new Error(payload?.error || payload?.message || payload?.detail || `HTTP ${response?.status ?? "error"}`);
        }
        if (!payload || typeof payload !== "object") throw new Error("Invalid JSON response");
        if (payload.success === false) throw new Error(payload.error || payload.message || "Request failed");
        return payload;
      } catch (error) {
        if (error?.name === "AbortError") {
          if (!timedOut && externalSignal?.aborted) throw new Error("Request cancelled");
          throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener?.("abort", abortFromExternal);
      }
    }

    replayRequest(options = {}) {
      const signal = options.signal || null;
      const common = root.TerminalCommon;
      if (common?.fetchReplay) {
        return common.fetchReplay(
          (path, fetchOptions = {}) => this.requestJson(path, {...fetchOptions, signal, timeoutMs: 30000}),
          this.endpoints.replay,
          30000,
        );
      }
      return this.requestJson(this.endpoints.replay, {signal, timeoutMs: 30000});
    }

    applyAccountPayload(payload) {
      this.accountLoading = false;
      const displayComplete = Boolean(
        payload
        && payload.success !== false
        && payload.authenticated === true
        && finiteNumber(payload.collateral) !== null
        && finiteNumber(payload.available_margin) !== null
        && Array.isArray(payload.positions)
        && accountUnrealizedPnl(payload) !== null
        && timestampMilliseconds(payload.account_updated_ms) !== null
      );
      if (displayComplete) {
        this.account = payload;
        const age = accountAgeMilliseconds(payload, this.wallNow());
        const locallyStale = accountPayloadStale(payload, this.wallNow(), ACCOUNT_FRESHNESS_MS);
        if (!locallyStale) this.accountLastFresh = payload;
        this.errors.account = locallyStale
          ? `Account snapshot source time is ${age === null ? "missing or in the future" : `${Math.round(age)} ms old`}; limit ${ACCOUNT_FRESHNESS_MS} ms`
          : null;
      } else {
        const message = payload?.error || (payload?.authenticated === true
          ? "Account response is incomplete"
          : "Authenticated account data unavailable");
        this.errors.account = message;
        this.account = this.accountLastFresh
          ? {...this.accountLastFresh, account_stale: true, refresh_error: message}
          : payload;
      }
      this.renderAccount();
    }

    applyAccountFailure(error) {
      this.accountLoading = false;
      const message = error?.message || String(error || "Account response unavailable");
      this.errors.account = message;
      this.account = this.accountLastFresh
        ? {...this.accountLastFresh, account_stale: true, refresh_error: message}
        : null;
      this.renderAccount();
    }

    async waitBeforeRetry(signal) {
      if (signal?.aborted || this.retryDelayMs <= 0) return !signal?.aborted;
      await this.delayImpl(this.retryDelayMs);
      return !signal?.aborted;
    }

    async retryCritical(operation, signal) {
      let result = false;
      for (let attempt = 0; attempt < this.criticalRetryAttempts; attempt += 1) {
        if (signal?.aborted) return false;
        result = await operation();
        if (result || signal?.aborted) return result;
        if (attempt + 1 < this.criticalRetryAttempts && !(await this.waitBeforeRetry(signal))) return false;
      }
      return result;
    }

    async refreshAccount(options = {}) {
      const signal = options.signal || null;
      try {
        const payload = await this.requestJson(this.endpoints.account, {
          signal,
          timeoutMs: this.accountRequestTimeoutMs,
        });
        if (signal?.aborted) return false;
        this.applyAccountPayload(payload);
        return !this.errors.account;
      } catch (error) {
        if (signal?.aborted) return false;
        this.applyAccountFailure(error);
        return false;
      }
    }

    renderAccount() {
      const account = this.account;
      const loading = this.accountLoading === true;
      const stale = this.accountIsStale();
      const fresh = accountPayloadUsable(account) && !stale;
      const unavailable = loading ? "UNAVAILABLE · STALE · LOADING" : stale ? "UNAVAILABLE · STALE" : "UNAVAILABLE";
      this.setText("accountCollateral", fresh ? usdDisplay(account.collateral) : unavailable);
      this.setText("accountAvailable", fresh ? usdDisplay(account.available_margin) : unavailable);
      const positions = fresh && Array.isArray(account.positions) ? account.positions : null;
      this.setText("accountPositionCount", positions ? String(positions.length) : unavailable);
      const unrealized = fresh ? accountUnrealizedPnl(account) : null;
      this.setText("accountUnrealized", unrealized === null ? unavailable : usdDisplay(unrealized));

      const body = this.refs.accountPositions;
      if (body) {
        if (!positions) {
          const unavailableDetail = loading
            ? "REFRESHING · CACHED VALUES MARKED STALE AND WITHHELD"
            : stale ? "STALE SNAPSHOT · VALUES WITHHELD" : "UNAVAILABLE";
          body.innerHTML = `<tr><td colspan="5" class="lm-unavailable">${unavailableDetail}</td></tr>`;
        } else if (!positions.length) {
          body.innerHTML = '<tr><td colspan="5" class="lm-unavailable">No open BTC positions · authenticated fresh snapshot</td></tr>';
        } else {
          body.innerHTML = positions.map((position) => {
            const amount = finiteNumber(position?.position_amt ?? position?.position ?? position?.size);
            const size = finiteNumber(position?.size) ?? (amount === null ? null : Math.abs(amount));
            const side = amount === null ? "UNAVAILABLE" : amount > 0 ? "LONG" : amount < 0 ? "SHORT" : "FLAT";
            const sideClass = side === "LONG" ? "long" : side === "SHORT" ? "short" : "";
            return `<tr>
              <td class="lm-position-side ${sideClass}">${side}</td>
              <td>${escapeHtml(displayValue(size, {digits: 8}))}</td>
              <td>${escapeHtml(finiteNumber(position?.entry_price) === null ? "UNAVAILABLE" : `$${Number(position.entry_price).toFixed(2)}`)}</td>
              <td>${escapeHtml(finiteNumber(position?.mark_price) === null ? "UNAVAILABLE" : `$${Number(position.mark_price).toFixed(2)}`)}</td>
              <td>${escapeHtml(usdDisplay(position?.unrealized_pnl))}</td>
            </tr>`;
          }).join("");
        }
      }
      const sourcePayload = account ? {
        source: account.account_source || account.venue || null,
        timestamp_ms: account.account_updated_ms,
      } : null;
      const age = accountAgeMilliseconds(account, this.wallNow());
      this.setText("accountSource", `${sourceLine("ACCOUNT", sourcePayload, {stale})}${age === null ? "" : ` · age ${Math.round(age)} ms`}${loading ? " · refresh pending" : ""}`);
      this.setText("accountError", loading
        ? "ACCOUNT REFRESHING · retained values are stale and withheld until a fresh authenticated response arrives"
        : this.errors.account ? `ACCOUNT ${stale ? "STALE/ERROR" : "ERROR"} · ${this.errors.account}`
          : stale ? `ACCOUNT STALE · source age exceeds ${ACCOUNT_FRESHNESS_MS} ms or timestamp is unavailable` : "");
      if (!fresh && this.readiness.accountMs !== null) {
        this.readiness.accountMs = null;
        this.renderReadiness();
      }
      if (fresh) this.recordAccountReady();
    }

    async refreshChart(options = {}) {
      this.mount();
      const signal = options.signal || null;
      const interval = this.interval;
      const request = ++this.chartRequest;
      const path = `${this.endpoints.candles}${this.endpoints.candles.includes("?") ? "&" : "?"}symbol=BTC&interval=${encodeURIComponent(interval)}&limit=180`;
      if (this.chartLoading) this.renderChartMeta();
      else {
        this.setText("chartSource", `CHART · loading Lighter BTC ${interval} candles`);
        this.setText("chartError", "");
      }
      try {
        const payload = await this.requestJson(path, {signal, timeoutMs: this.chartRequestTimeoutMs});
        if (signal?.aborted || request !== this.chartRequest || interval !== this.interval) return false;
        if (validChartInterval(payload?.interval) !== interval) {
          throw new Error(`Candle response interval mismatch: expected ${interval}`);
        }
        const bars = normalizeCandleBars(payload);
        if (!bars.length) throw new Error("No valid BTC candle prices returned");
        const ma7 = movingAverageSeries(bars, 7);
        const ma24 = movingAverageSeries(bars, 24);
        const stale = chartPayloadStale(payload, bars, interval, this.wallNow());
        const rendered = this.renderChartSeries(bars, ma7, ma24, interval);
        this.bars = bars;
        this.ma7 = ma7;
        this.ma24 = ma24;
        this.chartRendered = rendered;
        this.chartPayload = {...payload, stale, latest_candle_time: bars.at(-1).time};
        this.chartLoading = false;
        const missingSeries = !rendered ? "Chart renderer unavailable"
          : !ma7.length ? "MA7 unavailable: fewer than 7 valid candles"
          : !ma24.length ? "MA24 unavailable: fewer than 24 valid candles"
          : null;
        this.errors.chart = stale ? "BTC candle data is stale" : missingSeries;
        this.renderChartMeta();
        if (!this.errors.chart) this.recordChartReady();
        return !this.errors.chart;
      } catch (error) {
        if (request !== this.chartRequest || interval !== this.interval) return false;
        if (signal?.aborted) return false;
        this.chartLoading = false;
        this.errors.chart = error?.message || String(error);
        if (this.chartPayload) this.chartPayload = {...this.chartPayload, stale: true, refresh_pending: false};
        this.renderChartMeta();
        return false;
      }
    }

    renderChartMeta() {
      const payload = this.chartPayload;
      const loading = this.chartLoading === true;
      const stale = this.chartIsStale();
      const latest = payload?.latest_candle_time ?? this.bars.at(-1)?.time;
      const sourcePayload = latest ? {
        source: payload?.source || `Lighter BTC ${this.interval} candles`,
        timestamp_ms: Number(latest) * 1000,
      } : null;
      const ageMs = latest ? sourceAgeMilliseconds({timestamp_ms: Number(latest) * 1000}, this.wallNow()) : null;
      this.setText("chartSource", `${sourceLine("CHART", sourcePayload, {stale})} · interval ${this.interval} · latest market candle may be forming${ageMs === null ? "" : ` · age ${Math.round(ageMs)} ms`}${loading ? " · refresh pending" : ""}`);
      this.setText("chartError", loading
        ? "CHART REFRESHING · retained prices and moving averages are stale until fresh candles arrive"
        : this.errors.chart ? `CHART STALE/ERROR · ${this.errors.chart}`
          : stale ? `CHART STALE · latest ${this.interval} candle exceeds the three-interval freshness limit or timestamp is unavailable` : "");
      if (stale && this.readiness.chartMs !== null) {
        this.readiness.chartMs = null;
        this.renderReadiness();
      }
      this.renderIntervalButtons();
    }

    marketRequests(signal) {
      return [
        ["snapshot", () => this.requestJson(
          `${this.endpoints.snapshot}${this.endpoints.snapshot.includes("?") ? "&" : "?"}depth=${this.depth}`,
          {signal},
        )],
        ["status", () => this.requestJson(this.endpoints.status, {signal})],
      ];
    }

    applyMarketResponse(key, payload) {
      this[key] = payload;
      if (key === "status") this.statusReceivedAtMs = finiteNumber(this.wallNow()) ?? Date.now();
      this[`${key}Loading`] = false;
      this.errors[key] = null;
    }

    renderMarketLiveState(key) {
      if (!this.mounted) return;
      this.renderErrors();
      if (key === "snapshot") {
        this.renderMarket();
      } else if (key === "status") {
        this.renderMandatoryPrerequisites();
        this.renderConditions();
        this.renderFixedAssumptions();
        this.renderSafeguards();
        if (!this.liveUnlocked) this.renderLiveControls();
        this.syncLiveControlAccess();
      }
      this.lastFreshnessSignature = this.freshnessSignature();
    }

    async refreshMarket() {
      this.mount();
      if (!this.active || this.fullRefreshOwnsMarket) return false;
      if (this.marketRefreshPromise) return this.marketRefreshPromise;
      const generation = ++this.marketRefreshGeneration;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const signal = controller?.signal || null;
      this.marketRefreshController = controller;

      const task = (async () => {
        let succeeded = true;
        for (const [key, request] of this.marketRequests(signal)) {
          if (signal?.aborted || generation !== this.marketRefreshGeneration
              || !this.active || this.fullRefreshOwnsMarket) return false;
          try {
            const payload = await request();
            if (signal?.aborted || generation !== this.marketRefreshGeneration
                || !this.active || this.fullRefreshOwnsMarket) return false;
            this.applyMarketResponse(key, payload);
          } catch (error) {
            if (signal?.aborted || generation !== this.marketRefreshGeneration
                || !this.active || this.fullRefreshOwnsMarket) return false;
            if (this[key]) this[key] = {...this[key], stale: true, refresh_pending: false};
            this.errors[key] = error?.message || String(error || "Unavailable");
            succeeded = false;
          }
          this.renderMarketLiveState(key);
        }
        return succeeded;
      })();

      let trackedTask = null;
      trackedTask = task.finally(() => {
        if (this.marketRefreshPromise !== trackedTask) return;
        this.marketRefreshPromise = null;
        this.marketRefreshController = null;
      });
      this.marketRefreshPromise = trackedTask;
      return trackedTask;
    }

    cancelMarketRefresh() {
      this.marketRefreshGeneration += 1;
      this.marketRefreshController?.abort?.();
      return this.marketRefreshPromise;
    }

    beginReplayRefresh() {
      this.replayLoading = true;
      this.errors.replay = null;
      this.renderErrors();
      this.renderReplay();
      this.renderEntrySignalMarkers();
      this.renderMandatoryPrerequisites();
      this.renderConditions();
      this.lastFreshnessSignature = this.freshnessSignature();
    }

    async rerunReplay(options = {}) {
      const invalidateCurrent = options.invalidateCurrent === true;
      const activation = this.activationSequence;
      if (invalidateCurrent) {
        this.replayInvalidatedByConfig = true;
        if (this.refreshPromise) {
          this.cancelRefresh();
          await this.refreshPromise.catch(() => false);
        }
      }
      if (this.replayLoading) return this.refreshPromise || false;
      if (this.refreshPromise) await this.refreshPromise.catch(() => false);
      if (!this.active || activation !== this.activationSequence) return false;
      this.beginReplayRefresh();
      return this.refresh({
        includeReplay: true,
        includeAccount: false,
        includeChart: false,
        includeMarket: false,
        retryCritical: false,
      });
    }

    async refresh(options = {}) {
      this.mount();
      if (this.refreshPromise) return this.refreshPromise;
      this.refreshing = true;
      if (this.refs.refreshButton) this.refs.refreshButton.disabled = true;
      if (this.refs.rerunButton) this.refs.rerunButton.disabled = true;
      const includeReplay = options.includeReplay !== false;
      const includeAccount = options.includeAccount !== false;
      const includeChart = options.includeChart !== false;
      const includeMarket = options.includeMarket !== false;
      const retryCritical = options.retryCritical !== false;
      this.fullRefreshOwnsMarket = includeMarket;
      const pendingMarketRefresh = includeMarket ? this.cancelMarketRefresh() : null;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const signal = controller?.signal || null;
      this.refreshController = controller;

      const task = (async () => {
        const results = [];
        if (pendingMarketRefresh) await pendingMarketRefresh.catch(() => false);
        if (signal?.aborted) return false;
        const runCritical = (operation) => retryCritical
          ? this.retryCritical(operation, signal)
          : operation();

        // Price and account data are the critical path. Serialize these calls so
        // a loaded single-worker backend does not make both requests time out.
        // Candles go first because they tolerate a three-interval freshness
        // window; fetching the 15-second account snapshot second keeps both
        // datasets usable when a cold chart request is slow.
        if (includeChart && !signal?.aborted) {
          results.push(await runCritical(() => this.refreshChart({signal})));
        }
        if (includeAccount && !signal?.aborted) {
          results.push(await runCritical(() => this.refreshAccount({signal})));
        }

        const requests = includeMarket ? this.marketRequests(signal) : [];
        if (includeReplay) requests.push(["replay", () => this.replayRequest({signal})]);

        // Ancillary L2/status/replay reads are deliberately serialized behind
        // the critical path. Render each result as it arrives without inventing
        // replacement values for failed or stale responses.
        for (const [key, request] of requests) {
          if (signal?.aborted) {
            results.push(false);
            break;
          }
          try {
            const payload = await request();
            if (signal?.aborted) {
              results.push(false);
              break;
            }
            if (key === "replay" && !this.completedReplayAvailable(payload)) {
              throw new Error("Replay response did not contain a completed replay");
            }
            if (key === "snapshot" || key === "status") this.applyMarketResponse(key, payload);
            else this[key] = payload;
            if (key === "replay") {
              this.replayInvalidatedByConfig = false;
              this.replayLoading = false;
            }
            this.errors[key] = null;
            results.push(true);
          } catch (error) {
            if (!signal?.aborted) {
              this[`${key}Loading`] = false;
              if (key !== "replay" && this[key]) {
                this[key] = {...this[key], stale: true, refresh_pending: false};
              }
              this.errors[key] = error?.message || String(error || "Unavailable");
            }
            results.push(false);
          }
          this.renderAll();
        }
        return results.every(Boolean);
      })();

      let trackedTask = null;
      trackedTask = task.finally(() => {
        if (this.refreshPromise !== trackedTask) return;
        this.refreshing = false;
        this.refreshPromise = null;
        this.refreshController = null;
        this.fullRefreshOwnsMarket = false;
        if (includeReplay) this.replayLoading = false;
        if (this.refs.refreshButton) this.refs.refreshButton.disabled = false;
        if (this.refs.rerunButton) this.refs.rerunButton.disabled = false;
        this.renderAll();
      });
      this.refreshPromise = trackedTask;
      return trackedTask;
    }

    setText(ref, value) {
      if (this.refs[ref]) this.refs[ref].textContent = value;
    }

    renderAll() {
      if (!this.mounted) return;
      this.renderErrors();
      this.renderReadiness();
      this.renderAccount();
      this.renderChartMeta();
      this.renderEntrySignalMarkers();
      this.renderMarket();
      this.renderReplay();
      this.renderMandatoryPrerequisites();
      this.renderConditions();
      this.renderFixedAssumptions();
      this.renderSafeguards();
      if (!this.liveUnlocked) this.renderLiveControls();
      this.syncLiveControlAccess();
      this.lastFreshnessSignature = this.freshnessSignature();
    }

    renderErrors() {
      const messages = Object.entries(this.errors)
        .filter(([, message]) => message)
        .map(([key, message]) => `${key}: ${message}`);
      this.setText("error", messages.join(" · "));
    }

    renderMarket() {
      const loading = this.snapshotLoading === true;
      const stale = this.snapshotIsStale();
      const age = sourceAgeMilliseconds(this.snapshot, this.wallNow());
      this.setText(
        "marketSource",
        `${sourceLine("MARKET", this.snapshot, {stale})}${age === null ? "" : ` · age ${Math.round(age)} ms`}${loading ? " · UPDATING · retained L2 withheld" : ""}`,
      );
      const metrics = deriveBookMetrics(stale ? null : this.snapshot, this.depth);
      const depthLevels = Math.max(1, Math.floor(finiteNumber(
        this.snapshot?.metric_context?.depth_levels
          ?? this.status?.config?.raw?.entry?.depth_levels,
      ) ?? this.depth));
      const spreadAbsolute = displayValue(metrics.spread, {digits: 6});
      const spreadBps = displayValue(metrics.spreadBps, {digits: 2, suffix: " bps"});
      this.setText("spread", spreadAbsolute === "UNAVAILABLE" ? spreadBps : `${spreadAbsolute}${spreadBps === "UNAVAILABLE" ? "" : ` · ${spreadBps}`}`);
      const imbalanceValue = metricNumeric(metrics.imbalance);
      this.setText("imbalance", imbalanceValue === null ? displayValue(metrics.imbalance) : `${(imbalanceValue * 100).toFixed(2)}%`);
      this.setText("microprice", displayValue(metrics.microprice, {digits: 6}));
      this.setText("tradeFlow", displayValue(metrics.tradeFlow, {digits: 6}));
      this.setText("momentum", displayValue(metrics.momentum, {digits: 6}));
      this.setText("spreadSource", metrics.source.spread);
      this.setText("imbalanceLabel", `Top ${depthLevels} depth imbalance`);
      this.setText("imbalanceSource", `${metrics.source.imbalance} · top ${depthLevels} levels / side`);
      this.setText("micropriceSource", metrics.source.microprice);
      this.setText("tradeFlowSource", metrics.source.tradeFlow);
      this.setText("momentumSource", metrics.source.momentum);
      this.renderLadder("asks", metrics.book.asks, "ask");
      this.renderLadder("bids", metrics.book.bids, "bid");
    }

    renderLadder(ref, levels, side) {
      const target = this.refs[ref];
      if (!target) return;
      if (!Array.isArray(levels) || !levels.length) {
        target.innerHTML = '<tr><td colspan="4" class="lm-unavailable">UNAVAILABLE</td></tr>';
        return;
      }
      target.innerHTML = levels.map((level, index) => `<tr class="lm-${side}">
        <td>${index + 1}</td><td>${escapeHtml(displayValue(level.price, {digits: 8}))}</td>
        <td>${escapeHtml(displayValue(level.size, {digits: 8}))}</td><td>${escapeHtml(displayValue(level.cumulative, {digits: 8}))}</td>
      </tr>`).join("");
    }

    renderReplay() {
      const loading = this.replayLoading === true;
      const stale = this.replayIsStale();
      const counts = normalizeReplayCounts(stale ? null : this.replay);
      this.setText("entrySignals", displayValue(counts.entrySignals));
      this.setText("exitSignals", displayValue(counts.exitSignals));
      this.setText("fills", displayValue(counts.fills));
      this.setText("trades", displayValue(counts.trades));
      const latestEvaluation = Array.isArray(this.replay?.evaluations) ? this.replay.evaluations.at(-1) : null;
      const replaySourcePayload = this.replay?.source ? this.replay : (latestEvaluation || this.replay);
      const lifecycle = loading
        ? stale && this.replayInvalidatedByConfig
          ? " · UPDATING AFTER CONFIG CHANGE · prior replay withheld"
          : stale ? " · UPDATING · no completed replay available" : " · UPDATING · showing last completed replay"
        : this.replayInvalidatedByConfig
          ? this.errors.replay
            ? " · CONFIG CHANGED · RERUN FAILED · prior replay withheld"
            : " · CONFIG CHANGED · rerun required · prior replay withheld"
        : this.errors.replay && !stale ? " · RERUN FAILED · showing last completed replay" : "";
      this.setText(
        "replaySource",
        `${sourceLine("PAPER", replaySourcePayload, {stale})}${lifecycle}`,
      );
    }

    paperConditionPayload() {
      const latestEvaluation = Array.isArray(this.replay?.evaluations) ? this.replay.evaluations.at(-1) : null;
      return this.replay?.paper?.conditions
        || this.replay?.paper_conditions
        || latestEvaluation?.conditions
        || this.replay?.latest_evaluation
        || this.replay?.latest_conditions
        || this.snapshot?.paper?.conditions
        || this.snapshot?.paper_conditions
        || null;
    }

    liveConditionPayload() {
      return this.status?.live?.conditions
        || this.status?.live_conditions
        || this.status?.last_evaluation
        || null;
    }

    paperPrerequisitePayload() {
      const latestEvaluation = Array.isArray(this.replay?.evaluations) ? this.replay.evaluations.at(-1) : null;
      return this.replay?.paper?.prerequisites
        || this.replay?.paper_prerequisites
        || latestEvaluation?.prerequisites
        || this.snapshot?.paper?.prerequisites
        || this.snapshot?.paper_prerequisites
        || null;
    }

    livePrerequisitePayload() {
      return this.status?.live?.prerequisites
        || this.status?.live_prerequisites
        || this.status?.last_evaluation?.prerequisites
        || this.status?.mandatory_prerequisites?.live
        || null;
    }

    conditionMeta(kind) {
      const latestReplayEvaluation = Array.isArray(this.replay?.evaluations) ? this.replay.evaluations.at(-1) : null;
      const payload = kind === "paper"
        ? (this.replay?.paper || latestReplayEvaluation || this.replay)
        : (this.status?.live || this.status?.last_evaluation || this.status);
      const error = kind === "paper" ? this.errors.replay : this.errors.status;
      const stale = kind === "paper" ? this.replayIsStale() : this.statusIsStale();
      return {
        available: !(kind === "live" && error) && !stale && payload?.stale !== true,
        source: payload?.source || payload?.condition_source || null,
        timestamp: payload?.timestamp_ms ?? payload?.condition_timestamp_ms ?? payload?.latest_condition_time ?? payload?.time,
      };
    }

    renderMandatoryPrerequisites() {
      const target = this.refs.mandatoryPrerequisites;
      if (!target) return;
      const paperMeta = this.conditionMeta("paper");
      const liveMeta = this.conditionMeta("live");
      const rows = combineConditionStreams(
        this.paperPrerequisitePayload(),
        this.livePrerequisitePayload(),
        paperMeta,
        liveMeta,
      ).filter((row) => row.key === "entry_direction");
      if (!rows.length) {
        target.innerHTML = `<tr>
          <td>Directional edge available</td>
          <td><span class="lm-badge unavailable">PAPER · UNAVAILABLE</span></td>
          <td><span class="lm-badge unavailable">LIVE · UNAVAILABLE</span></td>
          <td>The fixed edge model must produce a non-zero direction; this prerequisite cannot be disabled</td>
        </tr>`;
        return;
      }
      target.innerHTML = rows.map((row) => {
        const cell = (kind, condition) => {
          const value = condition || {state: "UNAVAILABLE", source: null, timestamp: null};
          const line = sourceLine(kind, {source: value.source, timestamp_ms: value.timestamp}, {stale: value.state === "UNAVAILABLE"});
          return `<span class="lm-badge ${value.state.toLowerCase()}">${kind.toUpperCase()} · ${value.state}</span><small style="display:block;color:#64748b;margin-top:3px">${escapeHtml(line)}</small>`;
        };
        const requirement = row.paper?.requirement || row.live?.requirement
          || "The fixed edge model must produce a non-zero direction; this prerequisite cannot be disabled";
        return `<tr>
          <td>${escapeHtml(row.label || "Directional edge available")}</td>
          <td>${cell("paper", row.paper)}</td>
          <td>${cell("live", row.live)}</td>
          <td>${escapeHtml(requirement)}</td>
        </tr>`;
      }).join("");
    }

    renderConditions() {
      const target = this.refs.conditions;
      if (!target) return;
      const paperMeta = this.conditionMeta("paper");
      const liveMeta = this.conditionMeta("live");
      const rows = combineConditionStreams(
        this.paperConditionPayload(), this.liveConditionPayload(), paperMeta, liveMeta,
      ).filter((row) => row.key !== "entry_direction");
      if (!rows.length) {
        target.innerHTML = '<tr><td colspan="4" class="lm-unavailable">No backend condition verdicts available</td></tr>';
      } else {
        target.innerHTML = rows.map((row) => {
          const paper = row.paper || {state: "UNAVAILABLE"};
          const live = row.live || {state: "UNAVAILABLE"};
          const statusCell = (kind, condition) => {
            const line = sourceLine(kind, {source: condition.source, timestamp_ms: condition.timestamp}, {stale: condition.state === "UNAVAILABLE"});
            return `<span class="lm-badge ${condition.state.toLowerCase()}">${kind.toUpperCase()} · ${condition.state}</span><small style="display:block;color:#64748b;margin-top:3px">${escapeHtml(line)}</small>`;
          };
          const detail = (kind, condition) => {
            if (!condition || condition.state === "UNAVAILABLE") return null;
            const unit = condition.unit ? ` ${condition.unit}` : "";
            const parts = [];
            if (condition.measured !== undefined && condition.measured !== null && condition.measured !== "") {
              parts.push(`measured ${displayValue(condition.measured)}${unit}`);
            }
            if (condition.threshold !== undefined && condition.threshold !== null && condition.threshold !== "") {
              parts.push(`${condition.operator || "threshold"} ${displayValue(condition.threshold)}${unit}`);
            }
            return parts.length ? `${kind.toUpperCase()} ${parts.join(" · ")}` : null;
          };
          const details = [detail("paper", row.paper), detail("live", row.live)].filter(Boolean);
          return `<tr>
            <td>${escapeHtml(row.label)}</td>
            <td>${statusCell("paper", paper)}</td>
            <td>${statusCell("live", live)}</td>
            <td>${escapeHtml(details.join(" | ") || "UNAVAILABLE")}</td>
          </tr>`;
        }).join("");
      }
      const paperSourcePayload = this.replay?.paper
        || (Array.isArray(this.replay?.evaluations) ? this.replay.evaluations.at(-1) : null)
        || this.replay;
      const liveSourcePayload = this.status?.live || this.status?.last_evaluation || this.status;
      this.setText("paperConditionSource", sourceLine("PAPER", paperSourcePayload, {stale: !paperMeta.available}));
      this.setText("liveConditionSource", sourceLine("LIVE", liveSourcePayload, {stale: !liveMeta.available}));
    }

    renderFixedAssumptions() {
      const target = this.refs.fixedAssumptions;
      if (!target) return;
      const assumptions = this.status?.config?.fixed_assumptions;
      const groups = Array.isArray(assumptions?.groups) ? assumptions.groups : [];
      if (!groups.length) {
        target.innerHTML = '<div class="lm-unavailable">Fixed assumptions unavailable</div>';
        this.setText("fixedAssumptionSource", "FIXED ASSUMPTIONS · source unavailable");
        return;
      }
      const format = (item) => {
        const value = typeof item?.value === "boolean"
          ? (item.value ? "ENABLED" : "DISABLED")
          : displayValue(item?.value);
        return `${value}${item?.unit ? ` ${item.unit}` : ""}`;
      };
      target.innerHTML = `<div class="lm-assumption-groups">${groups.map((group) => `
        <section class="lm-assumption-group" data-assumption-group="${escapeHtml(group.key || "group")}">
          <h4>${escapeHtml(group.label || humanizeKey(group.key))}</h4>
          ${(Array.isArray(group.items) ? group.items : []).map((item) => `<div class="lm-assumption-row" data-assumption-key="${escapeHtml(item.key || "item")}">
            <span>${escapeHtml(item.label || humanizeKey(item.key))}</span>
            <strong>${escapeHtml(format(item))}${item.detail ? `<small class="lm-assumption-detail">${escapeHtml(item.detail)}</small>` : ""}</strong>
          </div>`).join("")}
        </section>`).join("")}</div>`;
      const stale = this.configEnvelopeIsStale();
      this.setText(
        "fixedAssumptionSource",
        `FIXED ASSUMPTIONS · ${stale ? "STALE · " : ""}${assumptions.source || "source unavailable"} · read-only`,
      );
    }

    renderSafeguards() {
      const target = this.refs.safeguards;
      if (!target) return;
      const statusStale = this.statusIsStale();
      const available = !statusStale
        && this.status?.authenticated === true
        && this.status?.safeguards_stale !== true
        && !this.accountIsStale();
      const rawSafeguards = this.status?.safeguards;
      const safeguards = !available ? [] : Array.isArray(rawSafeguards) ? rawSafeguards
        : rawSafeguards && typeof rawSafeguards === "object"
          ? Object.entries(rawSafeguards).map(([key, value]) => ({key, ...(value || {})}))
          : [];
      if (!safeguards.length) {
        target.innerHTML = '<div class="lm-unavailable">UNAVAILABLE</div>';
      } else {
        target.innerHTML = safeguards.map((safeguard, index) => {
          const raw = String(safeguard?.state || safeguard?.status || "UNAVAILABLE").toUpperCase();
          const state = ["PASS", "WAITING", "BLOCKED", "UNAVAILABLE"].includes(raw) ? raw : "UNAVAILABLE";
          const label = safeguard?.label || safeguard?.name || (safeguard?.key ? humanizeKey(safeguard.key) : `Safeguard ${index + 1}`);
          return `<div class="lm-safeguard"><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(safeguard?.detail || safeguard?.reason || "Detail unavailable")}</small></div><span class="lm-badge ${state.toLowerCase()}">${state}</span></div>`;
        }).join("");
      }
      this.setText(
        "safeguardSource",
        `${sourceLine("LIVE SAFEGUARDS", this.status?.safeguards_meta || this.status, {stale: !available})}${this.statusLoading ? " · UPDATING · retained safeguards withheld" : ""}`,
      );
    }

    renderLiveControls() {
      const target = this.refs.liveControls;
      const controls = configConditions(this.status);
      if (!target) return;
      if (!controls.length) {
        target.innerHTML = '<div class="lm-unavailable">Authenticated configuration unavailable</div>';
        return;
      }
      target.innerHTML = controls.map((condition) => {
        const key = String(condition.key || condition.id);
        const threshold = condition.threshold && typeof condition.threshold === "object"
          ? condition.threshold
          : {value: condition.threshold, min: condition.min, max: condition.max, step: condition.step, unit: condition.unit};
        const thresholdValue = finiteNumber(threshold.value);
        const editableThreshold = condition.editable_threshold === true && thresholdValue !== null;
        const attributes = [
          thresholdValue !== null ? `value="${escapeHtml(thresholdValue)}"` : "",
          finiteNumber(threshold.min) !== null ? `min="${escapeHtml(threshold.min)}"` : "",
          finiteNumber(threshold.max) !== null ? `max="${escapeHtml(threshold.max)}"` : "",
          finiteNumber(threshold.step) !== null ? `step="${escapeHtml(threshold.step)}"` : "",
        ].filter(Boolean).join(" ");
        return `<label class="lm-control-row" data-condition-key="${escapeHtml(key)}">
          <span>${escapeHtml(condition.label || condition.name || humanizeKey(key))}</span>
          <input type="checkbox" data-live-condition-enabled="${escapeHtml(key)}" ${condition.enabled === true ? "checked" : ""} disabled>
          <span class="lm-threshold">${editableThreshold
            ? `<input type="number" aria-label="${escapeHtml(condition.label || key)} threshold" data-live-condition-threshold="${escapeHtml(key)}" ${attributes} disabled> ${escapeHtml(threshold.unit || "")}`
            : escapeHtml(thresholdValue === null ? "Threshold unavailable" : `${thresholdValue}${threshold.unit ? ` ${threshold.unit}` : ""}`)}
          </span>
        </label>`;
      }).join("");
    }

    syncLiveControlAccess() {
      const statusAuthenticated = this.status?.authenticated === true;
      const statusStale = this.configEnvelopeIsStale();
      const authenticated = statusAuthenticated && !statusStale;
      const tokenAvailable = Boolean(this.tokenProvider());
      if ((!authenticated || !tokenAvailable) && this.liveUnlocked) {
        this.liveUnlocked = false;
        this.draftDirty = false;
        this.renderLiveControls();
      }
      const editable = authenticated && tokenAvailable && this.liveUnlocked;
      this.setText("executionLockStatus", "LOCKED");
      this.setText("executionLockHelp", "Shadow/paper only · no live order submitter or arm route");
      this.refs.liveControls?.querySelectorAll?.("input").forEach((input) => { input.disabled = !editable; });
      if (this.refs.saveLive) this.refs.saveLive.disabled = !editable;
      if (this.refs.unlockLive) {
        this.refs.unlockLive.disabled = !authenticated || !tokenAvailable;
        this.refs.unlockLive.checked = editable;
      }
      let badge = "READ-ONLY · NOT AUTHENTICATED";
      let message = "READ-ONLY · authenticated bot status unavailable";
      if (statusAuthenticated && statusStale) {
        badge = "READ-ONLY · STATUS STALE";
        message = this.statusLoading
          ? "READ-ONLY · authenticated status update in progress"
          : "READ-ONLY · authenticated status source is stale";
      } else if (authenticated && !tokenAvailable) {
        badge = "READ-ONLY · TERMINAL LOCKED";
        message = "READ-ONLY · unlock the authenticated terminal first";
      } else if (authenticated && tokenAvailable && !this.liveUnlocked) {
        badge = "READ-ONLY · UNLOCK TO EDIT";
        message = "READ-ONLY · unlock shared evaluator threshold/toggle edits";
      } else if (editable) {
        badge = "EVALUATOR SETTINGS EDITING";
        message = "Editing PAPER/LIVE shared evaluator settings · live execution remains locked";
      }
      this.setText("accessBadge", badge);
      this.setText("liveMessage", this.errors.config ? `SAVE FAILED · ${this.errors.config}` : message);
      if (this.refs.accessBadge?.classList) this.refs.accessBadge.classList.toggle("editing", editable);
    }

    collectLiveConfig() {
      const conditions = [];
      this.refs.liveControls?.querySelectorAll?.("[data-condition-key]").forEach((row) => {
        const key = row.getAttribute("data-condition-key");
        const toggle = row.querySelector(`[data-live-condition-enabled="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key}"]`);
        const input = row.querySelector(`[data-live-condition-threshold="${typeof CSS !== "undefined" && CSS.escape ? CSS.escape(key) : key}"]`);
        const condition = {key, enabled: toggle?.checked === true};
        if (input) {
          const threshold = finiteNumber(input.value);
          if (threshold === null) throw new Error(`${humanizeKey(key)} threshold is required`);
          const minimum = finiteNumber(input.min);
          const maximum = finiteNumber(input.max);
          if (minimum !== null && threshold < minimum) throw new Error(`${humanizeKey(key)} threshold is below ${minimum}`);
          if (maximum !== null && threshold > maximum) throw new Error(`${humanizeKey(key)} threshold exceeds ${maximum}`);
          condition.threshold = threshold;
        }
        conditions.push(condition);
      });
      return {conditions};
    }

    async saveLiveConfig() {
      this.errors.config = null;
      if (this.status?.authenticated !== true || this.configEnvelopeIsStale()) throw new Error("Authenticated Lighter status is required and must be fresh");
      const token = this.tokenProvider();
      if (!token) throw new Error("Unlock the authenticated terminal first");
      if (!this.liveUnlocked) throw new Error("Explicitly unlock evaluator setting edits first");
      const payload = this.collectLiveConfig();
      const confirmed = this.confirmImpl("Save these shared microstructure evaluator settings? This does not enable live execution or place an order.");
      if (!confirmed) return false;
      try {
        const result = await this.requestJson(this.endpoints.config, {
          method: "POST",
          headers: {Authorization: `Bearer ${token}`},
          body: payload,
          timeoutMs: 15000,
        });
        if (result.config && typeof result.config === "object") {
          this.status = {...(this.status || {}), config: result.config, authenticated: true};
        }
        this.liveUnlocked = false;
        this.draftDirty = false;
        if (this.refs.unlockLive) this.refs.unlockLive.checked = false;
        this.errors.config = null;
        this.renderLiveControls();
        this.syncLiveControlAccess();
        await this.rerunReplay({invalidateCurrent: true});
        return true;
      } catch (error) {
        this.errors.config = error?.message || String(error);
        this.renderErrors();
        this.syncLiveControlAccess();
        throw error;
      }
    }

    startPolling() {
      if (this.pollTimer) return;
      this.pollTimer = setInterval(() => {
        if (this.active && !this.refreshing && !this.intervalChartController) {
          this.refresh({
            includeReplay: false,
            includeChart: this.chartIsStale(),
            includeAccount: true,
            includeMarket: false,
            retryCritical: false,
          });
        }
      }, this.pollIntervalMs);
    }

    freshnessSignature() {
      return [
        this.accountLoading, this.accountIsStale(),
        this.chartLoading, this.chartIsStale(),
        this.snapshotLoading, this.snapshotIsStale(),
        this.statusLoading, this.statusIsStale(), this.configEnvelopeIsStale(),
        this.replayLoading, this.replayIsStale(),
        Boolean(this.tokenProvider()), this.liveUnlocked,
      ].map((value) => value ? "1" : "0").join("");
    }

    renderFreshnessState(options = {}) {
      if (!this.mounted) return false;
      const signature = this.freshnessSignature();
      if (options.force !== true && signature === this.lastFreshnessSignature) return false;
      this.renderAccount();
      this.renderChartMeta();
      this.renderMarket();
      this.renderReplay();
      this.renderEntrySignalMarkers();
      this.renderMandatoryPrerequisites();
      this.renderConditions();
      this.renderFixedAssumptions();
      this.renderSafeguards();
      this.syncLiveControlAccess();
      this.lastFreshnessSignature = this.freshnessSignature();
      return true;
    }

    startFreshnessTimer() {
      if (this.freshnessTimer || this.options.autoFreshness === false) return;
      this.freshnessTimer = setInterval(() => {
        if (this.active) this.renderFreshnessState();
      }, this.freshnessIntervalMs);
    }

    stopFreshnessTimer() {
      if (!this.freshnessTimer) return;
      clearInterval(this.freshnessTimer);
      this.freshnessTimer = null;
    }

    stopPolling() {
      if (!this.pollTimer) return;
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    startMarketPolling() {
      if (this.marketPollTimer) return;
      this.marketPollTimer = setInterval(() => {
        if (this.active && !this.fullRefreshOwnsMarket && !this.marketRefreshPromise) {
          this.refreshMarket().catch(() => false);
        }
      }, this.marketPollIntervalMs);
    }

    stopMarketPolling() {
      if (this.marketPollTimer) clearInterval(this.marketPollTimer);
      this.marketPollTimer = null;
      this.cancelMarketRefresh();
    }

    cancelRefresh() {
      this.refreshController?.abort?.();
      this.intervalChartController?.abort?.();
      this.cancelMarketRefresh();
      this.chartRequest += 1;
    }

    async onTabActivated() {
      this.mount();
      const activation = ++this.activationSequence;
      this.active = true;
      this.stopPolling();
      this.stopMarketPolling();
      const includeReplay = !this.completedReplayAvailable();
      this.beginReadinessCycle({includeReplay});
      this.startFreshnessTimer();
      if (this.refreshPromise) {
        this.cancelRefresh();
        await this.refreshPromise.catch(() => false);
        if (this.active && activation === this.activationSequence) this.markCriticalDataLoading({includeReplay});
      }
      if (!this.active || activation !== this.activationSequence) return false;
      root.TerminalCommon?.revealChartSection?.(this.refs.terminal);
      this.ensureChart();
      this.resizeChart();
      const result = await this.refresh({includeReplay, includeChart: true, includeAccount: true, includeMarket: true});
      if (this.active && activation === this.activationSequence) {
        if (this.options.autoPoll !== false) this.startPolling();
        const marketPollingEnabled = this.options.autoMarketPoll === true
          || (this.options.autoMarketPoll !== false && this.options.autoPoll !== false);
        if (marketPollingEnabled) this.startMarketPolling();
      }
      return result;
    }

    onTabDeactivated() {
      this.active = false;
      this.activationSequence += 1;
      this.captureChartRange();
      this.stopPolling();
      this.stopMarketPolling();
      this.stopFreshnessTimer();
      this.cancelRefresh();
    }

    destroy() {
      this.active = false;
      this.activationSequence += 1;
      this.stopPolling();
      this.stopMarketPolling();
      this.stopFreshnessTimer();
      this.cancelRefresh();
      this.resizeObserver?.disconnect?.();
      this.resizeObserver = null;
      this.chart?.remove?.();
      this.chart = null;
      this.entryMarkers = [];
      this.entryMarkerPrimitive = null;
      this.host.replaceChildren?.();
      this.mounted = false;
      this.refs = {};
    }
  }

  function createLighterMicroTab(host, options = {}) {
    const element = typeof host === "string" ? root.document?.querySelector?.(host) : host;
    if (!element) throw new Error("Lighter micro tab host not found");
    return new LighterMicroTab(element, options).mount();
  }

  function autoMount() {
    const document = root.document;
    if (!document?.querySelectorAll) return;
    const hosts = Array.from(document.querySelectorAll("[data-lighter-micro-tab]"));
    const fallback = document.getElementById?.("tabContentLighterMicro");
    if (fallback && !hosts.includes(fallback)) hosts.push(fallback);
    hosts.forEach((host) => {
      if (host.dataset?.lighterMicroMounted === "true") return;
      const instance = createLighterMicroTab(host);
      host.lighterMicroTab = instance;
      if (!root.lighterMicroEngine) root.lighterMicroEngine = instance;
      if (host.style?.display !== "none" && host.dataset?.microAutoActivate !== "false") {
        instance.onTabActivated().catch((error) => {
          instance.errors.snapshot = error?.message || String(error);
          instance.renderAll();
        });
      }
    });
  }

  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", autoMount);
    else autoMount();
  }

  return {
    LighterMicroTab,
    createLighterMicroTab,
    DEFAULT_ENDPOINTS,
    utils: {
      finiteNumber,
      timestampMilliseconds,
      formatKstDateTime,
      displayValue,
      normalizeBook,
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
      entrySignalTimestampSeconds,
      entrySignalSide,
      containingCandleTime,
      replayEntrySignalMarkers,
      usdDisplay,
      validChartInterval,
      sourceLine,
      apiPrefixFromLocation,
    },
  };
});
