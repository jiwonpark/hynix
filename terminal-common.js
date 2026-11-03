(function () {
  "use strict";

  function namespaceFragment(fragment, prefix, stripHandlers) {
    if (prefix) {
      fragment.querySelectorAll("[id]").forEach((element) => {
        element.id = `${prefix}${element.id}`;
      });
      fragment.querySelectorAll("[for]").forEach((element) => {
        element.setAttribute("for", `${prefix}${element.getAttribute("for")}`);
      });
      fragment.querySelectorAll("[aria-controls]").forEach((element) => {
        element.setAttribute("aria-controls", `${prefix}${element.getAttribute("aria-controls")}`);
      });
    }
    if (stripHandlers) {
      fragment.querySelectorAll("[onclick],[onchange],[oninput]").forEach((element) => {
        ["onclick", "onchange", "oninput"].forEach((attribute) => element.removeAttribute(attribute));
      });
    }
    return fragment;
  }

  function renderTerminal(template, target, options) {
    const fragment = namespaceFragment(
      template.content.cloneNode(true), options.prefix || "", Boolean(options.stripHandlers)
    );
    if (options.venue && options.venue.toLowerCase().includes("lighter")) {
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        walker.currentNode.nodeValue = walker.currentNode.nodeValue
          .replace(/Binance Total Equity/g, "Lighter Account Equity")
          .replace(/Binance Wallet Split/g, "Lighter Collateral Breakdown")
          .replace(/BINANCE FUTURES LIVE ENGINE/g, "LIGHTER DEX LIVE ENGINE")
          .replace(/Syncing with Binance Futures\.\.\./g, "Syncing with Lighter DEX...")
          .replace(/LIVE BINANCE EXECUTION/g, "LIGHTER DEX LIVE ENGINE")
          .replace(/Binance Collateral/g, "Lighter Collateral")
          .replace(/Binance/g, "Lighter")
          .replace(/BINANCE/g, "LIGHTER");
      }
    }
    target.replaceChildren(fragment);
    target.dataset.terminalInstance = options.venue;
  }

  function revealChartSection(section) {
    // Chart visibility is a viewing preference, never an execution permission.
    for (let node = section; node; node = node.parentElement) {
      if (!node.classList?.contains("collapsible-section")) continue;
      node.classList.remove("is-collapsed");
      const button = node.querySelector(":scope > .collapsible-header .section-collapse-btn");
      if (button) {
        button.disabled = false;
        button.setAttribute("aria-expanded", "true");
      }
      if (node.id) {
        try { localStorage.setItem(`hynix_collapse_${node.id}`, "0"); } catch (_) {}
      }
    }
  }

  function terminalRoot(prefix = "") {
    if (!prefix) return document.getElementById("tabContentTrading");
    const name = prefix.slice(0, -1);
    return document.getElementById(name === "lighterCrypto"
      ? "tabContentLighterCrypto"
      : name === "crypto" ? "tabContentCrypto" : "tabContentLighter");
  }

  const terminalLoadingMarkup = '<span class="terminalLoadingDots" role="status" aria-label="Loading"><i aria-hidden="true"></i><i aria-hidden="true"></i><i aria-hidden="true"></i></span>';

  function setTerminalAccountLoading(prefix = "", message = "Loading authenticated account…") {
    const byId = (id) => document.getElementById(`${prefix}${id}`);
    const setLoading = (id) => {
      const element = byId(id);
      if (element) element.innerHTML = terminalLoadingMarkup;
    };
    [
      "valAccountEquity", "valAvailMargin", "valUnrealizedPnl", "valActivePairs",
      "valMarginRisk", "valUpbitEquity", "valHedgedTranches",
      "valHedgedQuantities", "valHedgedLeverage", "valHedgedNotional",
      "valHedgedDelta", "valHedgedCombinedPnl", "valHedgedLoss10",
      "valHedgedMaxDiv",
    ].forEach(setLoading);
    setLoading("badgeEquitySource");
    setLoading("badgeUpbitSource");
    const syncBadge = byId("lblHedgedSyncBadge");
    if (syncBadge) syncBadge.textContent = message;
    setLoading("countPositions");
    setLoading("countAssets");
    setLoading("countUpbitAssets");
    const collateral = byId("valCollateralPills");
    if (collateral) collateral.innerHTML = terminalLoadingMarkup;
    const summary = byId("activePositionsSummary");
    if (summary) summary.textContent = message;
    const body = byId("activePositionsBody");
    if (body) body.innerHTML = `<tr><td colspan="8" style="text-align:center;color:#64748b;padding:24px 16px;">${message}</td></tr>`;
  }

  function setTerminalLoading(prefix = "") {
    const byId = (id) => document.getElementById(`${prefix}${id}`);
    const setLoading = (id) => {
      const element = byId(id);
      if (element) element.innerHTML = terminalLoadingMarkup;
    };
    setTerminalAccountLoading(prefix);
    [
      "valShortTermCurrentParity", "valShortTermCurrentPrice", "valAutoCurrentEdge",
      "valCritScaleInThreshold", "valCritMa24", "valCritCurrentSpread",
      "valCritGapScaleIn", "valCritOutTargetSpread", "valCritLatestInSpread",
      "valCritConvergencePts", "valCritTpCurrentSpread", "valCritGapTP",
      "valCritCombinedPnl",
    ].forEach(setLoading);
    setLoading("badgeCriteriaScaleIn");
    setLoading("badgeCriteriaTP");
    const root = terminalRoot(prefix);
    root?.querySelectorAll(".condValue").forEach((element) => {
      const valueNode = element.querySelector("[id]") || element;
      valueNode.innerHTML = terminalLoadingMarkup;
    });
    root?.querySelectorAll(".condBadge").forEach((element) => {
      element.innerHTML = terminalLoadingMarkup;
      element.className = "condBadge neutral";
    });
    ["barCritScaleInProgress", "barCritTPProgress"].forEach((id) => {
      const element = byId(id);
      if (element) element.style.width = "0%";
    });
  }

  function replayProgressPart(engine) {
    const key = engine?.replayRefreshKey?.();
    const result = engine?.latestReplayConditionResult;
    const current = Boolean(result?.latest_conditions && result?.latest_condition_time && (!key || engine.replayConditionSignature === key));
    const error = engine?.replayError || "";
    return {label:"Conditions + signals", ready:current && !engine?.replayLoading,
      detail:error, error:Boolean(error)};
  }

  async function fetchReplay(api, path, timeoutMs = 30000) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        api(path, {signal:controller.signal}),
        new Promise((_, reject) => { timer = setTimeout(() => {
          reject(new Error("Condition replay timed out after 30s. Use Rerun Paper to retry."));
          controller.abort();
        }, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function settleReplayPlaceholders(prefix) {
    const groups = document.getElementById(`${prefix}conditionGroups`);
    if (!groups) return;
    for (const dots of groups.querySelectorAll(".terminalLoadingDots")) {
      const host = dots.closest(".condValue, .condBadge");
      if (!host || host.closest("[data-live-condition]")) continue;
      host.textContent = host.classList.contains("condBadge") ? "UNAVAILABLE" : "Not reported";
      host.title = "PAPER · Replay settled; this separate value was not returned. See the condition verdict and source time.";
    }
  }

  function renderReplayFailure(prefix, message) {
    const groups = document.getElementById(`${prefix}conditionGroups`);
    if (groups) for (const badge of groups.querySelectorAll(".condBadge[id]")) {
      if (badge.textContent === "OFF") continue;
      badge.textContent = "UNAVAILABLE";
      badge.className = "condBadge neutral";
      badge.title = `PAPER · ${message}`;
    }
    for (const suffix of ["hourlyHistLongPaper", "hourlyHistShortPaper"]) {
      const status = document.getElementById(`${prefix}${suffix}`);
      if (status && !status.textContent.includes("OFF")) status.textContent = "PAPER · UNAVAILABLE";
    }
    for (const suffix of ["macdStatusSource", "ouStatusSource", "maDiffStatusSource", "hourlyHistPaperSource", "takeProfitPaperStatus"]) {
      const source = document.getElementById(`${prefix}${suffix}`);
      if (source) source.textContent = `PAPER · ${message}`;
    }
  }

  function movingAverage(bars, windowSize) {
    if (!Array.isArray(bars) || windowSize < 1) return [];
    let rolling = 0;
    return bars.map((bar, index) => {
      rolling += Number(bar.value);
      if (index >= windowSize) rolling -= Number(bars[index - windowSize].value);
      if (index < windowSize - 1) return null;
      return { time: bar.time, value: rolling / windowSize };
    }).filter(Boolean);
  }

  function movingAverageDiff(maFast, maSlow) {
    if (!Array.isArray(maFast) || !Array.isArray(maSlow)) return [];
    const slowMap = new Map();
    for (let i = 0; i < maSlow.length; i++) {
      const item = maSlow[i];
      if (item && item.time !== undefined) {
        slowMap.set(item.time, item.value);
      }
    }
    const result = [];
    for (let i = 0; i < maFast.length; i++) {
      const fast = maFast[i];
      if (!fast || fast.time === undefined) continue;
      const slowVal = slowMap.get(fast.time);
      if (slowVal !== undefined && Number.isFinite(fast.value) && Number.isFinite(slowVal)) {
        const diff = fast.value - slowVal;
        result.push({
          time: fast.time,
          value: diff,
          color: diff >= 0 ? "rgba(22, 163, 74, 0.75)" : "rgba(220, 38, 38, 0.75)",
        });
      }
    }
    return result;
  }

  function exponentialMovingAverage(bars, period) {
    if (!Array.isArray(bars) || period < 1 || bars.length < period) return [];
    const values = bars.map((bar) => Number(bar?.value));
    if (values.some((value) => !Number.isFinite(value))) return [];
    const multiplier = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    const result = [{ time: bars[period - 1].time, value: ema }];
    for (let index = period; index < bars.length; index += 1) {
      ema = (values[index] - ema) * multiplier + ema;
      result.push({ time: bars[index].time, value: ema });
    }
    return result;
  }

  function macd(bars, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    if (!Array.isArray(bars) || fastPeriod < 1 || slowPeriod <= fastPeriod || signalPeriod < 1) {
      return { macd: [], signal: [], histogram: [] };
    }
    const fast = exponentialMovingAverage(bars, fastPeriod);
    const slow = exponentialMovingAverage(bars, slowPeriod);
    const fastByTime = new Map(fast.map((point) => [point.time, point.value]));
    const macdLine = slow.flatMap((point) => {
      const fastValue = fastByTime.get(point.time);
      return Number.isFinite(fastValue)
        ? [{ time: point.time, value: fastValue - point.value }]
        : [];
    });
    const signalLine = exponentialMovingAverage(macdLine, signalPeriod);
    const signalByTime = new Map(signalLine.map((point) => [point.time, point.value]));
    const histogram = macdLine.flatMap((point) => {
      const signalValue = signalByTime.get(point.time);
      if (!Number.isFinite(signalValue)) return [];
      const value = point.value - signalValue;
      return [{
        time: point.time,
        value,
        color: value >= 0 ? "rgba(22, 163, 74, 0.75)" : "rgba(220, 38, 38, 0.75)",
      }];
    });
    return { macd: macdLine, signal: signalLine, histogram };
  }

  // Only signals that actually produced simulated inventory may link to exits.
  // Other qualifying candles remain standalone condition markers.
  function replaySignalLinks(data) {
    const links = new Map();
    (data.trades || []).forEach((trade, index) => {
      links.set(`${Number(trade.entry_time)}:${Number(trade.side)}`, {
        pairKey: `backtest:${index}`, is_simulated_fill: true,
        exit_price: trade.exit, pnl_pct: trade.pnl_pct,
      });
    });
    (data.open_positions || []).forEach((entry, index) => {
      links.set(`${Number(entry.entry_time)}:${Number(entry.side)}`, {
        pairKey: `backtest:open:${entry.entry_time}:${index}`, is_simulated_fill: true,
        is_open: true, unrealized_pnl_pct: entry.unrealized_pnl_pct,
      });
    });
    return links;
  }

  function alignTime(bars, timestampSeconds) {
    if (!Array.isArray(bars) || !bars.length) return timestampSeconds;
    return bars.reduce((best, bar) => (
      Math.abs(bar.time - timestampSeconds) < Math.abs(best.time - timestampSeconds) ? bar : best
    )).time;
  }

  function getCachedCandles(key) {
    try {
      const raw = localStorage.getItem(`skhynix_candles_${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.bars) && parsed.bars.length > 0) return parsed.bars;
    } catch (_) {}
    return null;
  }

  function setCachedCandles(key, bars) {
    try {
      if (!Array.isArray(bars) || !bars.length) return;
      const slice = bars.slice(-500);
      localStorage.setItem(`skhynix_candles_${key}`, JSON.stringify({
        saved_at: Date.now(),
        bars: slice
      }));
    } catch (_) {}
  }

  function singleLegPositionReference(positions, options = {}) {
    const symbol = String(options.symbol || "");
    const marketId = options.marketId == null ? null : String(options.marketId);
    const position = (Array.isArray(positions) ? positions : []).find((candidate) => {
      const matchesSymbol = symbol && String(candidate?.symbol || "") === symbol;
      const matchesMarket = marketId !== null && String(candidate?.market_id ?? "") === marketId;
      if (!matchesSymbol && !matchesMarket) return false;
      const raw = Number(candidate?.position_amt ?? candidate?.position ?? candidate?.size ?? 0);
      return Number.isFinite(raw) && Math.abs(raw) > 1e-12;
    });
    if (!position) return null;
    const raw = Number(position.position_amt ?? position.position ?? position.size ?? 0);
    const sign = Number(position.sign);
    const signedQty = Number.isFinite(sign) && sign !== 0
      ? Math.sign(sign) * Math.abs(raw) : raw;
    const entry = Number(position.avg_entry_price ?? position.entry_price ?? position.price ?? 0);
    if (!Number.isFinite(signedQty) || signedQty === 0 || !(entry > 0)) return null;
    return {
      position,
      signedQty,
      entry,
      direction: signedQty < 0 ? "short" : "long",
      isLong: signedQty > 0,
    };
  }

  function renderAll() {
    const trading = document.getElementById("tabContentTrading");
    const lighter = document.getElementById("tabContentLighter");
    const crypto = document.getElementById("tabContentCrypto");
    const lighterCrypto = document.getElementById("tabContentLighterCrypto");
    const template = document.getElementById("tradingTerminalTemplate");
    if (!trading || !lighter || !template) throw new Error("Trading terminal template hosts are missing");

    renderTerminal(template, trading, { venue: "binance", prefix: "", stripHandlers: false });
    renderTerminal(template, lighter, { venue: "lighter", prefix: "lighter_", stripHandlers: true });
    if (crypto) {
      renderTerminal(template, crypto, { venue: "crypto", prefix: "crypto_", stripHandlers: true });
    }
    if (lighterCrypto) {
      renderTerminal(template, lighterCrypto, { venue: "lighterCrypto", prefix: "lighterCrypto_", stripHandlers: true });
    }
  }

  function bindSingleLegDirectionControl(prefix, onChange) {
    const select = document.getElementById(`${prefix}selLighterSpreadDirectionMode`);
    if (!select) return null;
    const label = select.parentElement?.querySelector("span");
    if (label) label.textContent = "Auto-entry direction:";
    select.title = "Saved live-bot condition for future automatic entries; exits and manual orders remain available";
    const current = ["two_way", "long_only", "short_only"].includes(select.dataset.serverValue)
      ? select.dataset.serverValue : "two_way";
    select.innerHTML = '<option value="two_way">Two-way (Long + Short)</option><option value="long_only">Long only</option><option value="short_only">Short only</option>';
    select.value = current;
    let status = document.getElementById(`${prefix}entryDirectionStatus`);
    if (!status) {
      status = document.createElement("span");
      status.id = `${prefix}entryDirectionStatus`;
      status.style.cssText = "font-size:9px;font-weight:800;color:#64748b;background:#f1f5f9;padding:2px 5px;border-radius:4px";
      status.textContent = "LIVE BOT · LOADING";
      select.parentElement?.appendChild(status);
    }
    if (!select.dataset.singleLegDirectionBound) {
      select.dataset.singleLegDirectionBound = "true";
      select.addEventListener("change", async () => {
        const requested = select.value;
        select.disabled = true;
        status.textContent = "LIVE BOT · SAVING…";
        const saved = await onChange(requested);
        select.disabled = false;
        if (saved === false) {
          select.value = select.dataset.serverValue || "two_way";
          status.textContent = "LIVE BOT · SAVE FAILED";
        }
      });
    }
    return select;
  }

  function syncSingleLegDirectionControl(prefix, mode) {
    const select = document.getElementById(`${prefix}selLighterSpreadDirectionMode`);
    const normalized = ["two_way", "long_only", "short_only"].includes(mode) ? mode : "two_way";
    if (!select) return;
    select.dataset.serverValue = normalized;
    if (document.activeElement !== select) select.value = normalized;
    const label = {two_way: "TWO-WAY", long_only: "LONG ONLY", short_only: "SHORT ONLY"}[normalized];
    const status = document.getElementById(`${prefix}entryDirectionStatus`);
    if (status) {
      const time = new Date().toLocaleTimeString("en-GB", {timeZone: "Asia/Seoul", hour12: false});
      status.textContent = `LIVE BOT · ${label} · ${time} KST`;
      status.title = "Authenticated bot configuration returned by the latest status response";
    }
  }

  function hourlyHistogramSettings(prefix, bot = {}) {
    let draft = {};
    try { draft = JSON.parse(localStorage.getItem(`${prefix}hourly_hist_draft`) || "{}"); } catch (_) {}
    const saved = {...bot, ...(bot?.strategy_params || {}), ...draft};
    const settings = {use_hourly_hist: document.getElementById(`${prefix}useHourlyHist`)?.checked ?? saved.use_hourly_hist ?? true};
    for (const [key, suffix, fallback] of [["fast","Fast",20],["slow","Slow",60],["signal","Signal",9]]) {
      const value = Number(document.getElementById(`${prefix}hourlyHist${suffix}`)?.value ?? saved[`hourly_hist_${key}`] ?? fallback);
      settings[`hourly_hist_${key}`] = Number.isFinite(value) ? Math.trunc(value) : fallback;
    }
    return settings;
  }

  function alignHourlyHistogram(prefix, bot) {
    const saved = {...bot, ...(bot?.strategy_params || {})};
    const settings = {use_hourly_hist:saved.use_hourly_hist !== false};
    const enabled = document.getElementById(`${prefix}useHourlyHist`);
    if (enabled) enabled.checked = settings.use_hourly_hist;
    for (const [key,suffix,fallback] of [["fast","Fast",20],["slow","Slow",60],["signal","Signal",9]]) {
      settings[`hourly_hist_${key}`]=saved[`hourly_hist_${key}`] ?? fallback;
      const input=document.getElementById(`${prefix}hourlyHist${suffix}`);
      if(input) input.value=String(settings[`hourly_hist_${key}`]);
    }
    try {localStorage.setItem(`${prefix}hourly_hist_draft`,JSON.stringify(settings));} catch (_) {}
  }

  function syncHourlyHistogram(prefix, bot) {
    try {if(localStorage.getItem(`${prefix}hourly_hist_draft`)) return;} catch (_) {}
    const saved={...bot,...(bot?.strategy_params || {})};
    const enabled=document.getElementById(`${prefix}useHourlyHist`);
    if(enabled && !enabled._userModified) enabled.checked=saved.use_hourly_hist !== false;
    for(const [key,suffix,fallback] of [["fast","Fast",20],["slow","Slow",60],["signal","Signal",9]]) {
      const input=document.getElementById(`${prefix}hourlyHist${suffix}`);
      if(input && !input._userModified) input.value=String(saved[`hourly_hist_${key}`] ?? fallback);
    }
  }

  // The same inventory drives visibility, labels and PAPER verdict mappings.
  // Only predicates actually consumed by the selected evaluator belong here.
  function inheritedStrategyConditions(mode, prefix) {
    const rule = (suffix, toggle, condition, label) => ({suffix, toggle, condition, label});
    const macro = rule("EntryMaStack1h", "use_ma_stack_1h", "entry_ma_stack_1h", "Wider trend filter · configured completed-candle regime");
    if (["ou_quant", "macd_zero_cross", "macd_hist_turn"].includes(mode) || (mode === "ma_stack" && prefix === "lighterCrypto_")) return [];
    if (mode === "ma_acceleration") return [
      rule("EntryMaStretch", "use_ma_slope", "entry_ma_slope", "MA direction / minimum velocity · long rising, short falling"),
      rule("EntryBase", "use_ma_accel", "entry_ma_accel", "MA acceleration threshold · long accelerating, short decelerating"),
      rule("EntryPeak", "use_ma_pullback", "entry_ma_pullback", "Price pullback · long below MA, short above MA"), macro,
      rule("ExitConvergence", "use_ma_cross_exit", "exit_ma_cross", "Exit · price reaches the strategy MA"),
    ];
    if (mode === "golden_death_cross") return [
      rule("EntryMaStretch", "use_golden_cross", "entry_golden_cross", "Long entry · fast MA crosses above slow MA (Golden Cross)"),
      rule("EntryBase", "use_death_cross", "entry_death_cross", "Short entry · fast MA crosses below slow MA (Death Cross)"),
      rule("EntryPeak", "use_cross_spread", "entry_cross_spread", "Minimum MA spread · configured bps threshold"), macro,
      rule("ExitConvergence", "use_cross_exit", "exit_cross", "Exit · opposite MA cross / alignment"),
      rule("ExitDwell", "use_dwell", "exit_dwell", "Minimum holding bars before opposite-cross exit"),
    ];
    if (mode === "ma_stack") return [
      rule("EntryMaStretch", "use_ma_stretch", "entry_stretch", "Minimum distance from MA60 · configured stretch %"),
      rule("EntryMaStack5m", "use_ma_stack", "entry_ma_stack", "Entry · Price / MA7 / MA24 / MA60 stack"), macro,
      rule("ExitConvergence", "use_convergence", "exit_ma_cross", "Exit · opposite MA7 / MA24 alignment"),
      rule("ExitDwell", "use_dwell", "exit_max_dwell", "Exit · 16 completed bars held"),
      rule("ExitBottoming", "use_bottoming", "exit_trailing_stop", "Exit · configured trailing-stop retracement"),
    ];
    if (["grid", "custom", "adaptive_tranche"].includes(mode)) return [
      rule("EntryMaStretch", "use_ma_stretch", "entry_z", "Entry · Z-score stretch (Entry Z setting)"),
      rule("EntryBase", "use_base_spacing", "entry_spacing", "Entry · minimum spacing from prior same-side entry"),
      rule("EntryPeak", "use_peak", "entry_rollover", "Entry · completed-bar Z-score rollover"),
      rule("EntryMaStack5m", "use_ma_stack", "entry_ma_stack", mode === "adaptive_tranche" ? "Entry · Price / MA7 / MA24 / MA60 stack" : "Entry · price / MA7 / mean alignment"), macro,
      rule("ExitConvergence", "use_convergence", "exit_convergence", "Exit · Z-score convergence (Exit Z setting)"),
      rule("ExitDwell", "use_dwell", "exit_dwell", "Exit · minimum configured completed bars"),
      rule("ExitBottoming", "use_bottoming", "exit_bottoming", "Exit · Z-score no longer converging"),
    ];
    return [macro];
  }

  function inheritedConditionValue(rule, settings, mode) {
    const value = key => settings[key] == null ? "—" : String(settings[key]);
    const descriptions = {
      entry_z:`|Z| ≥ ${value("entry_z")}`,
      entry_spacing:`Minimum spacing ${value("base_spacing_pct")}%`,
      entry_rollover:"Completed-bar Z rollover",
      entry_ma_stack:["ma_stack", "adaptive_tranche"].includes(mode) ? "Price / MA7 / MA24 / MA60" : "Price / MA7 / rolling mean",
      entry_stretch:`Distance from MA60 ≥ ${value("ma_stretch_min")}%`,
      entry_ma_slope:`Minimum velocity ${value("ma_accel_min_slope")}`,
      entry_ma_accel:`Minimum acceleration ${value("ma_accel_min_accel")}`,
      entry_ma_pullback:`Pullback to MA${value("ma_accel_period")}`,
      entry_golden_cross:`MA${value("fast_ma_period")} crosses above MA${value("slow_ma_period")}`,
      entry_death_cross:`MA${value("fast_ma_period")} crosses below MA${value("slow_ma_period")}`,
      entry_cross_spread:`MA spread ≥ ${value("min_cross_spread_bps")} bps`,
      exit_convergence:`|Z| ≤ ${value("exit_z")}`,
      exit_dwell:`Minimum ${value("min_dwell_bars")} completed bars`,
      exit_max_dwell:"16 completed bars",
      exit_bottoming:"Z convergence stalls",
      exit_ma_cross:mode === "ma_stack" ? "Opposite MA7 / MA24 alignment" : `Price reaches MA${value("ma_accel_period")}`,
      exit_cross:`Opposite MA${value("fast_ma_period")} / MA${value("slow_ma_period")} alignment`,
      exit_trailing_stop:`Retracement ≥ ${value("ma_trailing_stop")}%`,
    };
    return descriptions[rule.condition] || "Completed-candle rule";
  }

  // Move the existing controls, never clone them: drafts, listeners and live
  // authentication keep using the same inputs across strategy rerenders.
  function persistentConditionNodes(prefix) {
    const rows = typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll(`[id^="${prefix}rowCondEntry"], [id^="${prefix}rowCondExit"]`)) : [];
    return [
      [document.getElementById(`${prefix}lblCritScaleInTitle`)?.parentNode?.parentNode, "entry"],
      [document.getElementById(`${prefix}lblCritTPTitle`)?.parentNode?.parentNode, "exit"],
      [document.getElementById(`${prefix.replace(/_$/, "")}LiveGridEntryRule`), "entry"],
      [document.getElementById(`${prefix.replace(/_$/, "")}LiveGridExitRule`), "exit"],
      ...rows.map(node => [node, node.id.startsWith(`${prefix}rowCondExit`) ? "exit" : "entry"]),
    ].filter(([node]) => node?.parentNode);
  }

  function prepareConditionGroups(prefix, anchor) {
    if (!anchor?.parentNode) return;
    for (const suffix of ["hourlyHistControls", "takeProfitControls"]) {
      const node = document.getElementById(`${prefix}${suffix}`);
      if (node) anchor.parentNode.insertBefore(node, anchor);
    }
    for (const [node] of persistentConditionNodes(prefix)) {
      if (node._conditionHome) node._conditionHome.append(node);
    }
    document.getElementById(`${prefix}conditionGroups`)?.remove();
  }

  function groupConditionControls(prefix, anchor, mode) {
    if (!anchor?.parentNode || typeof anchor.querySelectorAll !== "function") return;
    const groups = document.createElement("section");
    groups.id = `${prefix}conditionGroups`;
    groups.setAttribute("aria-label", "Trading conditions");
    groups.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;margin:14px 0;";
    const buckets = {};
    const liveSources = {};
    for (const [key, title, note] of [
      ["entry", "Entry conditions", "Entry rules apply to their indicated direction or setup. Entry signals are independent of positions and account limits."],
      ["exit", "Exit conditions", "Any enabled exit path can reduce a position. Entry filters do not block exits."],
    ]) {
      const section = document.createElement("section");
      section.id = `${prefix}${key}ConditionGroup`;
      section.style.cssText = "min-width:0;padding:14px;border:1px solid #cbd5e1;border-radius:10px;background:#fff;display:flex;flex-direction:column;gap:10px;";
      const heading = document.createElement("h3");
      heading.textContent = title;
      heading.style.cssText = "margin:0;font-size:14px;color:#0f172a;";
      const description = document.createElement("small");
      description.textContent = note;
      description.style.color = "#64748b";
      section.append(heading, description);
      groups.append(section);
      buckets[key] = section;
      const live = document.createElement("div");
      live.id = `${prefix}${key}LiveConditions`;
      live.style.cssText = "display:grid;gap:6px;font-size:11px;";
      section.append(live);
      liveSources[key] = live;
    }
    for (const [node, key] of persistentConditionNodes(prefix)) {
      node._conditionHome ||= node.parentNode;
      if (node.id.startsWith(`${prefix}rowCond`)) {
        // Dedicated strategies still share some real switches (e.g. wider
        // trend). Extract selected rows before hiding their legacy card.
        // Unselected rows stay in that hidden card even if polling updates
        // their inline display later.
        if (!["grid", "custom", "adaptive_tranche"].includes(mode) && node.dataset.terminalRuleSelected === "true")
          buckets[key].append(node);
        continue;
      }
      // Legacy status refreshes may re-show their individual rows. Hide the
      // whole legacy card when a strategy has its own dedicated controls.
      if (node.contains(document.getElementById(`${prefix}lblCritScaleInTitle`))
          || node.contains(document.getElementById(`${prefix}lblCritTPTitle`)))
        node.style.display = ["grid", "custom", "adaptive_tranche"].includes(mode) ? "flex" : "none";
      buckets[key].append(node);
    }
    for (const node of anchor.querySelectorAll("[data-terminal-rule-group]")) {
      const bucket = buckets[node.dataset.terminalRuleGroup];
      if (bucket) bucket.append(node);
    }
    for (const [suffix, key] of [["hourlyHistControls", "entry"], ["takeProfitControls", "exit"]]) {
      const node = document.getElementById(`${prefix}${suffix}`);
      if (node) { node.style.margin = "0"; buckets[key].append(node); }
    }
    for (const key of ["entry", "exit"]) {
      buckets[key].append(liveSources[key]);
    }
    anchor.parentNode.insertBefore(groups, anchor.nextSibling);
  }

  function resetGroupedLiveConditions(prefix, source, matching) {
    for (const key of ["entry", "exit"]) {
      const group = document.getElementById(`${prefix}${key}LiveConditions`);
      if (!group) continue;
      const heading = document.createElement("small");
      heading.textContent = matching ? source : "LIVE · saved strategy differs from selected replay strategy";
      group.replaceChildren(heading);
      for (const host of group.parentNode.querySelectorAll("[data-live-condition]"))
        host.textContent = matching ? "LIVE · UNAVAILABLE" : "LIVE · DIFFERENT STRATEGY";
    }
  }

  function groupedLiveCondition(prefix, key, badge, mode, selectedMode) {
    if (mode !== selectedMode) return false;
    const group = document.getElementById(`${prefix}${key.startsWith("exit_") ? "exit" : "entry"}LiveConditions`);
    if (!group) return false;
    const ids = mode === "macd_hist_turn" ? {
      entry_histogram_delta_turn:"macdStatusDeltaTurn",entry_histogram_zone:"macdStatusHistogramZone",
      entry_signal_zone:"macdStatusSignalZone",exit_histogram_zero_cross:"macdStatusExitCross",
    } : mode === "macd_zero_cross" ? {
      entry_histogram_zero_cross:"macdStatusZeroCross", entry_signal_zone:"macdStatusSignalZone",
      exit_histogram_zero_cross:"macdStatusExitCross",
    } : mode === "ou_quant" ? {
      entry_z:"ouStatusEntryZ",entry_halflife:"ouStatusHalflife",entry_min_deviation:"ouStatusMinDeviation",
      entry_macro_trend:"ouStatusMacroTrend",entry_stop_zone:"ouStatusStopZone",exit_z:"ouStatusExitZ",
      exit_emergency_stop:"ouStatusEmergencyStop",
    } : mode === "ma_stack" ? {entry_ma_diff_hook:"maStatusDiffHook",exit_ma_diff_hook:"maStatusDiffExit"} : {};
    const inherited = inheritedStrategyConditions(mode, prefix).find(rule => rule.condition === key);
    const badgeId = ids[key] || (inherited && `badgeCond${inherited.suffix}`);
    const paper = badgeId && document.getElementById(`${prefix}${badgeId}`);
    if (!paper?.parentNode) return false;
    let host = document.getElementById(`${prefix}liveRule_${key}`);
    if (!host) {
      const label = document.createElement("small");
      label.textContent = "PAPER";
      paper.parentNode.insertBefore(label, paper);
      host = document.createElement("span");
      host.id = `${prefix}liveRule_${key}`;
      host.setAttribute("data-live-condition", key);
      paper.parentNode.append(host);
    }
    badge.textContent = `LIVE · ${badge.textContent}`;
    host.replaceChildren(badge);
    return true;
  }

  function mountHourlyHistogram(prefix, anchor, engine) {
    if (!anchor?.parentNode || document.getElementById(`${prefix}hourlyHistControls`)) return;
    const settings=hourlyHistogramSettings(prefix,engine.botState);
    const panel=document.createElement("div");
    panel.id=`${prefix}hourlyHistControls`;
    panel.style.cssText="padding:12px;margin:14px 0;border:1px solid #c4b5fd;border-radius:8px;background:#faf5ff;";
    panel.innerHTML=`<label style="display:flex;flex-direction:row !important;gap:8px;align-items:center;flex-wrap:wrap;">
      <input id="${prefix}useHourlyHist" type="checkbox" ${settings.use_hourly_hist?"checked":""} style="appearance:auto;width:16px;height:16px;">
      <b>Hourly MACD histogram direction · entry only</b></label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0;">${[["fast","Fast",2,100],["slow","Slow",3,200],["signal","Signal",2,100]].map(([key,label,min,max])=>`<label>1h ${label} <input id="${prefix}hourlyHist${label}" aria-label="Hourly MACD ${key} period" type="number" min="${min}" max="${max}" step="1" value="${settings[`hourly_hist_${key}`]}" style="width:65px;"></label>`).join("")}</div>
      <div>Long entries: hourly histogram rising · <span id="${prefix}hourlyHistLongPaper">PAPER · waiting</span> · <span id="${prefix}hourlyHistLongLive">LIVE · waiting</span></div>
      <div>Short entries: hourly histogram falling · <span id="${prefix}hourlyHistShortPaper">PAPER · waiting</span> · <span id="${prefix}hourlyHistShortLive">LIVE · waiting</span></div>
      <small>Latest two completed hourly candles, independent of chart interval and histogram sign. Flat or unavailable blocks both directions. Includes every live campaign piece; exits remain active. Changes affect replay; unlock, pause and deploy to save live.</small>
      <div id="${prefix}hourlyHistPaperSource" style="font-size:11px;margin-top:6px;">PAPER · awaiting completed hourly candles</div>
      <div id="${prefix}hourlyHistLiveSource" style="font-size:11px;">LIVE · awaiting status</div>`;
    anchor.parentNode.insertBefore(panel,anchor);
    panel.querySelectorAll("input").forEach(input=>{
      input.addEventListener("input",()=>{
        input._userModified=true;
        try {localStorage.setItem(`${prefix}hourly_hist_draft`,JSON.stringify(hourlyHistogramSettings(prefix,engine.botState)));} catch (_) {}
        engine.updateRulesMatchStatus();
      });
      input.addEventListener("change",()=>engine.runBacktest());
    });
  }

  function renderHourlyHistogram(prefix, kind, point, enabled) {
    const stale=kind==="Live" && point?.available_time && Date.now()/1000-point.available_time>3600;
    for(const [name,key] of [["Long","long_ok"],["Short","short_ok"]]) {
      const node=document.getElementById(`${prefix}hourlyHist${name}${kind}`);
      if(node) node.textContent=`${kind.toUpperCase()} · ${enabled===false?"OFF":!point?.ready||stale?"UNAVAILABLE":point[key]?"PASS":"WAITING"}`;
    }
    const source=document.getElementById(`${prefix}hourlyHist${kind}Source`);
    if(source) source.textContent=`${kind.toUpperCase()} · completed 1h${point?.periods?` MACD (${point.periods.join(", ")})`:""} · ${point?.source_time?new Date(point.source_time*1000).toLocaleString("en-GB",{timeZone:"Asia/Seoul"})+" KST (candle open)":"source unavailable"}${point?.slope!=null?` · H ${point.previous_histogram.toFixed(5)} → ${point.histogram.toFixed(5)} · Δ ${point.slope.toFixed(5)}`:""}${point?.error?" · "+point.error:""}`;
  }

  function takeProfitSettings(prefix, bot = {}) {
    let draft = {};
    try { draft = JSON.parse(localStorage.getItem(`${prefix}take_profit_draft`) || "{}"); } catch (_) {}
    const enabled = document.getElementById(`${prefix}useTakeProfit`);
    const threshold = document.getElementById(`${prefix}takeProfitPct`);
    const saved = {...bot, ...(bot?.strategy_params || {}), ...draft};
    const raw = Number(threshold?.value ?? saved.take_profit_pct ?? 0.2);
    return {use_take_profit: enabled ? enabled.checked : saved.use_take_profit !== false,
      take_profit_pct: Number.isFinite(raw) && raw >= 0.01 && raw <= 100 ? raw : 0.2};
  }

  function saveTakeProfitDraft(prefix, settings) {
    try { localStorage.setItem(`${prefix}take_profit_draft`, JSON.stringify(settings)); } catch (_) {}
  }

  function mountTakeProfitControls(prefix, anchor, engine) {
    if (!anchor?.parentNode || document.getElementById(`${prefix}takeProfitControls`)) return;
    const settings = takeProfitSettings(prefix, engine.botState);
    const panel = document.createElement("div");
    panel.id = `${prefix}takeProfitControls`;
    panel.style.cssText = "margin:14px 0;padding:12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;";
    panel.innerHTML = `<label style="display:flex;flex-direction:row !important;justify-content:flex-start;align-items:center;gap:8px;flex-wrap:wrap;">
      <input id="${prefix}useTakeProfit" type="checkbox" ${settings.use_take_profit ? "checked" : ""} style="appearance:auto;width:16px;height:16px;">
      <b>Net take profit</b><input id="${prefix}takeProfitPct" aria-label="Net take-profit percent" type="number" min="0.01" max="100" step="0.01" value="${settings.take_profit_pct}" style="width:75px;">% of entry notional</label>
      <small>Newest tranche first · entry + exit trading fees deducted · funding excluded. Live: executable bid/ask each bot tick. Paper: completed closes with current account fees; no intrabar fills. Existing signal exits remain active. Unlock, pause and deploy to save live settings.</small>
      <div id="${prefix}takeProfitPaperStatus" style="margin-top:6px;font-size:11px;">PAPER · Awaiting replay</div>
      <div id="${prefix}takeProfitLiveStatus" style="margin-top:6px;font-size:11px;">LIVE · Awaiting bot status</div>`;
    anchor.parentNode.insertBefore(panel, anchor);
    panel.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", () => {
        saveTakeProfitDraft(prefix, takeProfitSettings(prefix, engine.botState));
        engine.updateRulesMatchStatus();
      });
      input.addEventListener("change", () => engine.runBacktest());
    });
  }

  function renderTakeProfitStatus(prefix, kind, evaluation, enabled) {
    const node = document.getElementById(`${prefix}takeProfit${kind}Status`);
    if (!node) return;
    const stale = kind === "Live" && evaluation?.time && Date.now() / 1000 - evaluation.time > 30;
    const state = enabled === false ? "OFF" : stale ? "UNAVAILABLE (STALE)" : evaluation?.state || (evaluation?.pass == null ? "UNAVAILABLE" : evaluation.pass ? "PASS" : "WAITING");
    const time = evaluation?.time ? new Date(evaluation.time * 1000).toLocaleString("en-GB", {timeZone:"Asia/Seoul"}) + " KST" : "source unavailable";
    node.textContent = `${kind.toUpperCase()} · ${state} · ${evaluation?.net_pct != null ? evaluation.net_pct.toFixed(4) + "% net / " + evaluation.target_pct + "% target · " : ""}${time}${evaluation?.error ? " · " + evaluation.error : ""}`;
  }

  const TerminalCommon = { inheritedConditionValue, inheritedStrategyConditions, settleReplayPlaceholders, replayProgressPart, fetchReplay, renderReplayFailure, resetGroupedLiveConditions, groupedLiveCondition, prepareConditionGroups, groupConditionControls, syncHourlyHistogram, hourlyHistogramSettings, alignHourlyHistogram, mountHourlyHistogram, renderHourlyHistogram, terminalLoadingMarkup, takeProfitSettings, saveTakeProfitDraft, mountTakeProfitControls, renderTakeProfitStatus, revealChartSection, setTerminalAccountLoading, setTerminalLoading, alignTime, movingAverage, movingAverageDiff, exponentialMovingAverage, macd, replaySignalLinks, namespaceFragment, renderTerminal, getCachedCandles, setCachedCandles, singleLegPositionReference, bindSingleLegDirectionControl, syncSingleLegDirectionControl };
  if (typeof window !== "undefined") {
    window.TerminalCommon = TerminalCommon;
    if (typeof document !== "undefined" && document.getElementById("tradingTerminalTemplate")) {
      renderAll();
    }
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = TerminalCommon;
  }
})();
