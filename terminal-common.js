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
    for (const suffix of ["macdStatusSource", "ouStatusSource", "maDiffStatusSource", "hourlyHistPaperSource", "takeProfitPaperStatus", "stopLossPaperStatus"]) {
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

  function previousLocalExtremumSegment(points, targetTime) {
    if (!Array.isArray(points) || points.length < 3 || targetTime == null) return [];
    const numericTarget = Number(targetTime?.timestamp ?? targetTime);
    if (!Number.isFinite(numericTarget)) return [];
    let endIndex = -1;
    for (let index = 0; index < points.length; index += 1) {
      const time = Number(points[index]?.time?.timestamp ?? points[index]?.time);
      if (!Number.isFinite(time)) continue;
      if (time <= numericTarget) endIndex = index;
      else break;
    }
    if (endIndex < 2) return [];
    const end = points[endIndex];
    if (end?.value == null || !Number.isFinite(Number(end.value))) return [];
    let direction = 0;
    let pivotIndex = -1;
    for (let index = 1; index <= endIndex; index += 1) {
      const previous = points[index - 1]?.value;
      const current = points[index]?.value;
      if (previous == null || current == null || ![previous, current].every(Number.isFinite)) {
        direction = 0;
        pivotIndex = -1;
        continue;
      }
      const nextDirection = Math.sign(current - previous);
      if (nextDirection && direction && nextDirection !== direction) pivotIndex = index - 1;
      if (nextDirection) direction = nextDirection;
    }
    return pivotIndex < 0 ? [] : [
      {time: points[pivotIndex].time, value: points[pivotIndex].value},
      {time: end.time, value: Number(end.value)},
    ];
  }

  function segmentCurveIntersections(segment, curve) {
    if (segment?.length !== 2 || !Array.isArray(curve)) return [];
    const valid = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    const [a, b] = segment;
    if (!valid(a) || !valid(b) || a.x === b.x) return [];
    const epsilon = 1e-7;
    const low = Math.min(a.x, b.x), high = Math.max(a.x, b.x);
    const lineY = x => a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x);
    const delta = p => p.y - lineY(p.x);
    const result = [];
    const add = (x, before, after) => {
      if (x <= low + epsilon || x >= high - epsilon) return;
      if (result.some(p => Math.abs(p.x - x) <= epsilon)) return;
      // Canvas y grows downwards. A negative→positive curve-minus-guide
      // difference means the guide crosses from below the curve to above it.
      const direction = (after - before) * Math.sign(b.x - a.x) > 0 ? 'up' : 'down';
      result.push({x, y: lineY(x), direction});
    };
    curve.forEach((point, i) => {
      if (!valid(point)) return;
      const d = delta(point), previous = curve[i - 1], next = curve[i + 1];
      if (Math.abs(d) <= epsilon) {
        // An exact vertex can cross once; a tangency or coincident run has no
        // crossing direction. Endpoints already have pivot/crosshair dots.
        if (valid(previous) && valid(next)) {
          const before = delta(previous), after = delta(next);
          if (Math.abs(before) > epsilon && Math.abs(after) > epsilon && Math.sign(before) !== Math.sign(after)) add(point.x, before, after);
        }
      } else if (valid(previous)) {
        const before = delta(previous);
        if (Math.abs(before) > epsilon && Math.sign(before) !== Math.sign(d)) {
          add(previous.x + (point.x - previous.x) * before / (before - d), before, d);
        }
      }
    });
    return result;
  }

  const maPivotRuleVersion = "last_arrow_v2";
  const maPriceSideRuleVersion = "price_side_v1";

  function maPivotAnalysis(points, targetTime, lookback=120) {
    const empty = {ready:false,long_pass:false,short_pass:false,up_count:0,down_count:0,crossings:[],segment:[],last_arrow:null,rule:maPivotRuleVersion};
    const source = (points || []).filter(p => Number(p.time?.timestamp ?? p.time) <= Number(targetTime?.timestamp ?? targetTime)).slice(-lookback);
    if (source.length < lookback || source.some(p => !Number.isFinite(p.value))) return empty;
    const segment = previousLocalExtremumSegment(source,targetTime);
    if (segment.length !== 2) return empty;
    const pivot = source.findIndex(p => p.time === segment[0].time), end=source.length-1;
    const slope = (source[end].value-source[pivot].value)/(end-pivot);
    const scale = Math.max(1e-12,...source.map(p=>Math.abs(p.value)));
    // Normalize exactly as the engine, using its relative tolerance (1e-10).
    const delta = source.map((p,i)=>(source[pivot].value+slope*(i-pivot)-p.value)/scale);
    const crossings=[], epsilon=1e-10;
    const add=(x,before,after)=>{
      if(x<=pivot+epsilon || x>=end-epsilon || crossings.some(c=>Math.abs(c.index-x)<=epsilon)) return;
      const left=Math.floor(x), right=Math.min(end,left+1);
      crossings.push({index:x,left_index:left,right_index:right,fraction:x-left,value:source[pivot].value+slope*(x-pivot),direction:after>before?"up":"down",left_time:source[left].time,right_time:source[right].time});
    };
    for(let i=pivot;i<=end;i++) {
      const d=delta[i];
      if(Math.abs(d)<=epsilon) {
        if(i>pivot && i<end && Math.abs(delta[i-1])>epsilon && Math.abs(delta[i+1])>epsilon && Math.sign(delta[i-1])!==Math.sign(delta[i+1])) add(i,delta[i-1],delta[i+1]);
      } else if(i>pivot && Math.abs(delta[i-1])>epsilon && Math.sign(delta[i-1])!==Math.sign(d)) add(i-1+delta[i-1]/(delta[i-1]-d),delta[i-1],d);
    }
    const up=crossings.filter(c=>c.direction==="up").length, down=crossings.length-up;
    const lastArrow=crossings.at(-1)?.direction ?? null;
    return {ready:true,segment,crossings,slope,pivot_index:pivot,up_count:up,down_count:down,last_arrow:lastArrow,rule:maPivotRuleVersion,long_pass:lastArrow === null ? slope > 0 : lastArrow === "up",
      short_pass:lastArrow === null ? slope < 0 : lastArrow === "down"};
  }

  function createMaExtremumHoverSeries(chart, colors, lineStyle, priceSeries) {
    if (!priceSeries?.attachPrimitive) return {};
    const states = Object.entries(colors || {}).map(([period, color]) => ({period, color, visible: true, points: [], curve: [], intersections: []}));
    let requestUpdate = null;
    const renderer = {
      draw(target) {
        target.useMediaCoordinateSpace(({context: ctx}) => {
          for (const state of states) {
            state.intersections = [];
            if (!state.visible || state.points.length !== 2) continue;
            const coords = state.points.map(point => ({
              x: chart.timeScale().timeToCoordinate(point.time),
              y: priceSeries.priceToCoordinate(point.value),
            }));
            if (!coords.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
            ctx.save();
            ctx.strokeStyle = state.color;
            ctx.fillStyle = state.color;
            ctx.lineWidth = 1.5;
            ctx.setLineDash(lineStyle === 0 ? [] : [5, 4]);
            ctx.beginPath();
            ctx.moveTo(coords[0].x, coords[0].y);
            ctx.lineTo(coords[1].x, coords[1].y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(coords[0].x, coords[0].y, 3, 0, Math.PI * 2);
            ctx.fill();
            const start = Number(state.points[0].time?.timestamp ?? state.points[0].time);
            const end = Number(state.points[1].time?.timestamp ?? state.points[1].time);
            const curve = state.curve.filter(p => {
              const time = Number(p.time?.timestamp ?? p.time);
              return time >= start && time <= end;
            }).map(p => !Number.isFinite(p.value) ? null : ({
              x: chart.timeScale().timeToCoordinate(p.time), y: priceSeries.priceToCoordinate(p.value),
            }));
            state.intersections = state.pivotAnalysis?.ready ? state.pivotAnalysis.crossings.map(c => {
              const left=chart.timeScale().timeToCoordinate(c.left_time), right=chart.timeScale().timeToCoordinate(c.right_time);
              return {x:left+(right-left)*c.fraction,y:priceSeries.priceToCoordinate(c.value),direction:c.direction};
            }).filter(p=>Number.isFinite(p.x) && Number.isFinite(p.y)) : segmentCurveIntersections(coords, curve);
            for (const crossing of state.intersections) {
              const tail = crossing.direction === 'up' ? 1 : -1;
              ctx.beginPath();
              ctx.moveTo(crossing.x, crossing.y + tail * 11);
              ctx.lineTo(crossing.x, crossing.y);
              ctx.moveTo(crossing.x - 4, crossing.y + tail * 5);
              ctx.lineTo(crossing.x, crossing.y);
              ctx.lineTo(crossing.x + 4, crossing.y + tail * 5);
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.strokeStyle = '#ffffff';
              ctx.lineWidth = 4;
              ctx.stroke();
              ctx.strokeStyle = state.color;
              ctx.lineWidth = 1.8;
              ctx.stroke();
            }
            ctx.restore();
          }
        });
      },
    };
    // A primitive draws in the price pane but owns no data, autoscale range or
    // hit targets. Calling real-series setData/applyOptions during a crosshair
    // callback re-enters that callback in Lightweight Charts 4.2.
    priceSeries.attachPrimitive({
      attached(params) { requestUpdate = params.requestUpdate; },
      detached() { requestUpdate = null; },
      paneViews: () => [{zOrder: () => 'top', renderer: () => renderer}],
    });
    return Object.fromEntries(states.map(state => [state.period, {
      applyOptions(options) {
        if (options.visible !== undefined && state.visible !== options.visible) {
          state.visible = options.visible;
          if (!state.visible) state.intersections = [];
          requestUpdate?.();
        }
      },
      setData(points) {
        if (state.points.length === points.length && state.points.every((p, i) => p.time === points[i].time && p.value === points[i].value)) return;
        state.points = points;
        state.intersections = [];
        requestUpdate?.();
      },
      setPivotAnalysis(analysis) {
        if (JSON.stringify(state.pivotAnalysis ?? null) === JSON.stringify(analysis)) return;
        state.pivotAnalysis=analysis; requestUpdate?.();
      },
      setCurveData(points) {
        if (state.curve === points) return;
        state.curve = points;
        state.intersections = [];
        if (state.points.length) requestUpdate?.();
      },
      data: () => state.points.slice(),
      intersections: () => state.intersections.map(p => ({...p})),
    }]));
  }

  function renderMaExtremumHover(seriesByPeriod, dataByPeriod, targetTime, visibility = {}, pivotSettings = null) {
    for (const [period, series] of Object.entries(seriesByPeriod || {})) {
      if (!series?.setData) continue;
      const visible = visibility[period] !== false && visibility[`ma${period}`] !== false;
      series.applyOptions?.({visible});
      series.setCurveData?.(dataByPeriod?.[period] || []);
      const canonical = Boolean(pivotSettings?.[`use_ma_pivot_${period}`]
        || (pivotSettings?.use_ma_pivot_direction && Number(period) === Number(pivotSettings.ma_pivot_period)));
      const completedTarget = Math.min(Number(targetTime?.timestamp ?? targetTime), pivotSettings?.completedBefore ?? Infinity);
      const analysis = canonical && visible && targetTime != null ? maPivotAnalysis(dataByPeriod?.[period],completedTarget,pivotSettings.ma_pivot_lookback) : null;
      series.setPivotAnalysis?.(analysis);
      series.setData(visible && targetTime != null
        ? canonical ? analysis?.segment || [] : previousLocalExtremumSegment(dataByPeriod?.[period], targetTime)
        : []);
    }
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

  function syncLiveToggleAvailability(prefix, venue = {}, bot = {}, options = {}) {
    const toggle = document.getElementById(`${prefix}chkAutoPeriodic48h`);
    const locked = options.locked ?? (window.terminalLockManager?.isLocked !== false);
    const enabled = Boolean(bot?.enabled);
    const halted = Boolean(options.halted ?? (bot?.recovery_required || bot?.pending_order));
    const snapshotReady = venue?.execution_enabled === true;
    const reason = venue?.execution_message || venue?.refresh_error || venue?.error || "";
    const stale = venue?.account_stale === true;
    const detail = locked
      ? "Unlock the execution terminal to change Full-Auto."
      : halted && !enabled
        ? (bot?.blocked_reason || bot?.last_error || "Resolve execution recovery before enabling Full-Auto.")
        : enabled
          ? "Disable the 24/7 EC2 bot."
          : snapshotReady
            ? "Enable Full-Auto. EC2 will revalidate account, position, margin, market, and executable quote before arming."
            : `${stale ? "The displayed account snapshot is stale" : "The displayed account snapshot cannot authorize execution"}${reason ? `: ${reason}` : ""}. You may still request Full-Auto; EC2 performs a fresh safety validation before arming.`;
    if (toggle) {
      // A stale browser snapshot is informational. The authenticated backend
      // remains the authority and performs fresh safety checks on every start.
      // Recovery/pending-order state is different and remains a hard block.
      toggle.disabled = Boolean(locked || (!enabled && halted));
      toggle.title = detail;
      toggle.setAttribute?.("aria-description", detail);
    }
    return { locked: Boolean(locked), enabled, halted, snapshotReady, stale, reason, detail };
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
    if (mode === "ma_proximity") return [
      rule("EntryMaStretch", "use_ma_slope", "entry_ma_direction_accel", "Direction SMA acceleration · positive long, negative short"),
      rule("EntryPeak", "use_ma_pullback", "entry_ma_pullback", "Price vs SMA · long below, short above"),
      rule("ExitConvergence", "use_ma_cross_exit", "exit_ma_cross", "Exit · price crosses the MA against the position"),
    ];
    if (mode === "ma_acceleration") return [
      rule("EntryMaStretch", "use_ma_slope", "entry_ma_slope", "MA direction / minimum velocity · long rising, short falling"),
      rule("EntryBase", "use_ma_accel", "entry_ma_accel", "MA acceleration threshold · long accelerating, short decelerating"),
      rule("EntryPeak", "use_ma_pullback", "entry_ma_pullback", "Price pullback · use max MA distance when set, otherwise long below MA / short above MA"), macro,
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

  const maPivotPeriods = [7,24,60];
  const maPivotDefaults = {use_ma_pivot_direction:false, use_ma_pivot_7:false, use_ma_pivot_24:false, use_ma_pivot_60:false, use_ma_price_7:false, use_ma_price_24:false, use_ma_price_60:false, ma_pivot_period:24, ma_pivot_lookback:120};
  const maPivotInputs = {use_ma_pivot_7:"useMaPivot7", use_ma_pivot_24:"useMaPivot24", use_ma_pivot_60:"useMaPivot60", use_ma_price_7:"useMaPrice7", use_ma_price_24:"useMaPrice24", use_ma_price_60:"useMaPrice60", ma_pivot_lookback:"maPivotLookback"};
  function normalizeMaPivotSettings(source={}) {
    const settings = {...maPivotDefaults,...source};
    const enabled = maPivotPeriods.filter(period => settings[`use_ma_pivot_${period}`] === true);
    if (!enabled.length && settings.use_ma_pivot_direction === true && maPivotPeriods.includes(Number(settings.ma_pivot_period))) {
      settings[`use_ma_pivot_${Number(settings.ma_pivot_period)}`] = true;
    }
    const normalizedEnabled = maPivotPeriods.filter(period => settings[`use_ma_pivot_${period}`] === true);
    settings.use_ma_pivot_direction = normalizedEnabled.length > 0;
    settings.ma_pivot_period = normalizedEnabled[0] ?? Number(settings.ma_pivot_period ?? 24);
    return settings;
  }
  function maPivotDraft(prefix) {
    try { return JSON.parse(localStorage.getItem(prefix + "maPivotDraft") || "null"); } catch (_) { return null; }
  }
  function maPivotSettings(prefix) {
    const settings = Object.fromEntries(Object.entries(maPivotInputs).map(([key,id]) => {
      const input = document.getElementById(prefix + id);
      return [key, key.startsWith("use_ma_") ? input?.checked === true : Number(input?.value ?? maPivotDefaults[key])];
    }));
    return normalizeMaPivotSettings(settings);
  }
  function maPivotGuideSettings(prefix, interval) {
    const seconds = {"1m":60,"5m":300,"15m":900,"1h":3600,"4h":14400,"1d":86400}[interval] || 300;
    return {...maPivotSettings(prefix), completedBefore:Date.now()/1000-seconds};
  }
  function bindMaPivotControls(prefix) {
    for (const id of Object.values(maPivotInputs)) {
      const input = document.getElementById(prefix + id);
      input?.addEventListener("input", () => {
        input.dataset.unsaved = "true";
        try { localStorage.setItem(prefix + "maPivotDraft", JSON.stringify(maPivotSettings(prefix))); } catch (_) {}
      });
    }
  }
  function syncMaPivotControls(prefix, bot, force=false) {
    if (bot?.strategy_mode !== "ma_proximity" || (!force && maPivotDraft(prefix))) return;
    const settings = normalizeMaPivotSettings({...bot,...bot?.strategy_params});
    for (const [key,id] of Object.entries(maPivotInputs)) {
      const input = document.getElementById(prefix + id);
      if (!input || (!force && (input._userModified || input.dataset.unsaved === "true" || document.activeElement === input))) continue;
      if (key.startsWith("use_ma_")) input.checked = settings[key];
      else input.value = String(settings[key]);
      if (force) { input._userModified = false; delete input.dataset.unsaved; }
    }
    if (force) try { localStorage.removeItem(prefix + "maPivotDraft"); } catch (_) {}
  }
  function renderMaPivotStatus(prefix, kind, evaluation, settings, time, available=true) {
    const normalized = normalizeMaPivotSettings(settings);
    const pivots = evaluation?.ma_pivots || (evaluation?.ma_pivot ? {[String(evaluation.ma_pivot.period ?? normalized.ma_pivot_period)]:evaluation.ma_pivot} : {});
    const priceSides = evaluation?.ma_price_sides || {};
    for (const period of maPivotPeriods) {
      const pivot = pivots[String(period)];
      const matching = pivot?.rule === maPivotRuleVersion && Number(pivot?.period) === period
        && Number(pivot?.lookback) === Number(normalized.ma_pivot_lookback);
      const usable = available && matching;
      const enabled = normalized[`use_ma_pivot_${period}`];
      for (const [dir,key] of [["Long","long_pass"],["Short","short_pass"]]) {
        const node = document.getElementById(prefix + `maPivot${period}${dir}${kind}`);
        if (!node) continue;
        const state = !enabled ? "OFF" : !usable || !pivot?.ready ? "UNAVAILABLE" : pivot[key] ? "PASS" : "WAITING";
        node.textContent = kind.toUpperCase() + " · " + state;
        node.className = `condBadge ${state === "PASS" ? "pass" : state === "WAITING" ? "wait" : "neutral"}`;
      }
      const source = document.getElementById(prefix + `maPivot${period}${kind}Source`);
      if (source) {
        const stamp = time && usable ? new Date(time*1000).toLocaleString("en-GB", {timeZone:"Asia/Seoul"}) + " KST" : "source unavailable";
        source.textContent = `${kind.toUpperCase()} · MA${period} · ${normalized.ma_pivot_lookback} MA points · completed candle ${stamp}`
          + (usable && pivot?.ready ? ` · slope ${Number(pivot.slope).toPrecision(5)} · last arrow ${pivot.last_arrow === "up" ? "↑" : pivot.last_arrow === "down" ? "↓" : "none"} · ↑${pivot.up_count} ↓${pivot.down_count}` : ` · ${!matching && pivot ? "Rule or parameters changed; awaiting matching evaluation" : pivot?.reason || "Awaiting completed-candle evaluation"}`);
      }
      const priceSide = priceSides[String(period)];
      const priceMatching = priceSide?.rule === maPriceSideRuleVersion && Number(priceSide?.period) === period;
      const priceUsable = available && priceMatching;
      const priceEnabled = normalized[`use_ma_price_${period}`];
      for (const [dir,key] of [["Long","long_pass"],["Short","short_pass"]]) {
        const node = document.getElementById(prefix + `maPrice${period}${dir}${kind}`);
        if (!node) continue;
        const state = !priceEnabled ? "OFF" : !priceUsable || !priceSide?.ready ? "UNAVAILABLE" : priceSide[key] ? "PASS" : "WAITING";
        node.textContent = kind.toUpperCase() + " · " + state;
        node.className = `condBadge ${state === "PASS" ? "pass" : state === "WAITING" ? "wait" : "neutral"}`;
      }
      const priceSource = document.getElementById(prefix + `maPrice${period}${kind}Source`);
      if (priceSource) {
        const stamp = time && priceUsable ? new Date(time*1000).toLocaleString("en-GB", {timeZone:"Asia/Seoul"}) + " KST" : "source unavailable";
        priceSource.textContent = `${kind.toUpperCase()} · completed close ${priceSide?.ready ? Number(priceSide.price).toPrecision(7) : "—"} vs MA${period} ${priceSide?.ready ? Number(priceSide.ma).toPrecision(7) : "—"} · ${stamp}`
          + (!priceMatching && priceSide ? " · Rule changed; awaiting matching evaluation" : priceSide?.reason ? ` · ${priceSide.reason}` : "");
      }
    }
  }

  function renderMaProximityControls(prefix, saved) {
    const pivot = normalizeMaPivotSettings({...saved,...maPivotDraft(prefix)});
    const periodOptions = (selected, allowInherited = false) => {
      const value = Number(selected);
      const periods = allowInherited ? [0, 7, 24, 60] : [7, 24, 60];
      if (Number.isFinite(value) && !periods.includes(value)) periods.push(value);
      return periods.map((period) => `<option value="${period}"${period === value ? " selected" : ""}>${period === 0 ? "Use Pullback SMA" : `MA${period}${[7,24,60].includes(period) ? " · chart line" : " · saved custom"}`}</option>`).join("");
    };
    return `
      <p>Long requires a close below the Pullback SMA. Short requires a close above it. The Direction SMA uses the change in slope across three completed candles.</p>
      <div data-terminal-rule-group="entry" data-after-condition="EntryMaStretch" style="display:flex;gap:12px;flex-wrap:wrap;">
        <label>Direction SMA period <select id="${prefix}inpMaDirectionPeriod" required style="width:150px;">${periodOptions(saved?.ma_direction_period ?? 0, true)}</select></label>
        <label>Minimum SMA acceleration <input id="${prefix}inpMaAccelMinAccel" type="number" min="0" step="0.0001" value="${Number(saved?.ma_accel_min_accel ?? 0)}"></label>
      </div>
      <div data-terminal-rule-group="entry" data-after-condition="EntryPeak" style="display:flex;gap:12px;flex-wrap:wrap;">
        <label>Pullback SMA period <select id="${prefix}inpMaAccelPeriod" required style="width:150px;">${periodOptions(saved?.ma_accel_period ?? 24)}</select></label>
      </div>
      <div data-terminal-rule-group="entry" id="${prefix}maPivotControls" style="display:grid;gap:8px;padding:10px;border:1px solid #cbd5e1;border-radius:6px;">
        <strong>MA pivot guide + price side · enabled MA rules are AND</strong>
        <div style="display:flex;gap:12px;flex-wrap:wrap;">
          <label>Lookback (MA points) <input id="${prefix}maPivotLookback" type="number" min="3" max="440" step="1" required value="${Number(pivot.ma_pivot_lookback)}" style="width:72px;"></label>
        </div>
        ${maPivotPeriods.map(period=>`<div style="display:grid;gap:5px;padding:7px;border-top:1px solid #e2e8f0;">
          <label style="display:flex;flex-direction:row;align-items:center;gap:8px;"><input style="width:16px;height:16px;flex:0 0 auto;margin:0;" id="${prefix}useMaPivot${period}" type="checkbox" ${pivot[`use_ma_pivot_${period}`] ? "checked" : ""}> MA${period} last crossing arrow</label>
          ${["Long","Short"].map(dir=>`<div>${dir}: last arrow ${dir==="Long"?"↑":"↓"}, or guide ${dir==="Long"?"rising":"falling"} if no arrows · <span id="${prefix}maPivot${period}${dir}Paper" class="condBadge neutral">PAPER · UNAVAILABLE</span> · <span id="${prefix}maPivot${period}${dir}Live" data-live-condition class="condBadge neutral">LIVE · UNAVAILABLE</span></div>`).join("")}
          <small id="${prefix}maPivot${period}PaperSource">PAPER · source unavailable</small>
          <small id="${prefix}maPivot${period}LiveSource" data-live-condition>LIVE · source unavailable</small>
          <label style="display:flex;flex-direction:row;align-items:center;gap:8px;"><input style="width:16px;height:16px;flex:0 0 auto;margin:0;" id="${prefix}useMaPrice${period}" type="checkbox" ${pivot[`use_ma_price_${period}`] ? "checked" : ""}> Price side of MA${period}</label>
          <div>Long: completed close below MA${period} · <span id="${prefix}maPrice${period}LongPaper" class="condBadge neutral">PAPER · UNAVAILABLE</span> · <span id="${prefix}maPrice${period}LongLive" data-live-condition class="condBadge neutral">LIVE · UNAVAILABLE</span></div>
          <div>Short: completed close above MA${period} · <span id="${prefix}maPrice${period}ShortPaper" class="condBadge neutral">PAPER · UNAVAILABLE</span> · <span id="${prefix}maPrice${period}ShortLive" data-live-condition class="condBadge neutral">LIVE · UNAVAILABLE</span></div>
          <small id="${prefix}maPrice${period}PaperSource">PAPER · source unavailable</small>
          <small id="${prefix}maPrice${period}LiveSource" data-live-condition>LIVE · source unavailable</small>
        </div>`).join("")}
        <small>Every enabled rule is AND. Pivot rules use the latest confirmed pivot within the shared lookback: ↑ permits long, ↓ permits short; guide slope is used only when that MA has no crossing arrows. Price-side rules require the completed close below each enabled MA for long or above each enabled MA for short. Any unavailable or disagreeing rule blocks entry. Exits are unaffected. Replay changes immediately; unlock, pause and deploy to save live.</small>
      </div>`;
  }

  function invalidMaProximityInput(prefix) {
    const direction = document.getElementById(prefix + "inpMaDirectionPeriod");
    if (direction?.setCustomValidity) {
      const period = Number(direction.value);
      direction.setCustomValidity(period === 1 || period === 2 ? "Enter 0 or a period from 3 to 498" : "");
    }
    return ["inpMaDirectionPeriod", "inpMaAccelPeriod", "maPivotLookback"]
      .map(id => document.getElementById(prefix + id))
      .find(input => input?.checkValidity?.() === false);
  }

  function syncInheritedConditionControls(prefix, mode, bot) {
    for (const rule of inheritedStrategyConditions(mode, prefix)) {
      const input = document.getElementById(`${prefix}chkCond${rule.suffix}`);
      const saved = bot.strategy_params?.[rule.toggle] ?? bot[rule.toggle];
      if (input && input.dataset.unsaved !== "true" && typeof saved === "boolean") {
        input.checked = saved;
      }
    }
  }

  function inheritedConditionValue(rule, settings, mode) {
    const value = key => settings[key] == null ? "—" : String(settings[key]);
    const descriptions = {
      entry_z:`|Z| ≥ ${value("entry_z")}`,
      entry_spacing:`Minimum spacing ${value("base_spacing_pct")}%`,
      entry_rollover:"Completed-bar Z rollover",
      entry_ma_stack:["ma_stack", "adaptive_tranche"].includes(mode) ? "Price / MA7 / MA24 / MA60" : "Price / MA7 / rolling mean",
      entry_stretch:`Distance from MA60 ≥ ${value("ma_stretch_min")}%`,
      entry_ma_direction_accel: `SMA${settings.ma_direction_period || settings.ma_accel_period} acceleration · min ${value("ma_accel_min_accel")}`,
      entry_ma_slope: `Minimum velocity ${value("ma_accel_min_slope")}`,
      entry_ma_accel:`Minimum acceleration ${value("ma_accel_min_accel")}`,
      entry_ma_pullback: mode === "ma_proximity"
        ? `Below SMA${value("ma_accel_period")} long / above short`
        : Number(settings.ma_max_distance_pct) > 0
          ? `Within ${value("ma_max_distance_pct")}% of MA${value("ma_accel_period")}`
          : `Pullback to MA${value("ma_accel_period")}`,
      entry_golden_cross:`MA${value("fast_ma_period")} crosses above MA${value("slow_ma_period")}`,
      entry_death_cross:`MA${value("fast_ma_period")} crosses below MA${value("slow_ma_period")}`,
      entry_cross_spread:`MA spread ≥ ${value("min_cross_spread_bps")} bps`,
      exit_convergence:`|Z| ≤ ${value("exit_z")}`,
      exit_dwell:`Minimum ${value("min_dwell_bars")} completed bars`,
      exit_max_dwell:"16 completed bars",
      exit_bottoming:"Z convergence stalls",
      exit_ma_cross: mode === "ma_stack" ? "Opposite MA7 / MA24 alignment"
        : mode === "ma_proximity" ? `Adverse cross of MA${value("ma_accel_period")}`
        : `Price reaches MA${value("ma_accel_period")}`,
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
    for (const suffix of ["hourlyHistControls", "takeProfitControls", "stopLossControls", "nativeProtectionControls"]) {
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
      const after = node.dataset.afterCondition
        && bucket?.querySelector(`#${prefix}rowCond${node.dataset.afterCondition}`);
      if (after && after.parentNode === bucket) bucket.insertBefore(node, after.nextSibling);
      else if (bucket) bucket.append(node);
    }
    for (const [suffix, key] of [["hourlyHistControls", "entry"], ["takeProfitControls", "exit"], ["stopLossControls", "exit"], ["nativeProtectionControls", "exit"]]) {
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
      entry_signal_slope_5m:"macdStatusSignalSlope5m",entry_signal_zone:"macdStatusSignalZone",exit_histogram_delta_turn:"macdStatusExitCross",exit_histogram_zone:"macdStatusExitZone",
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
      <b>Hourly MACD histogram regime · entry direction</b></label>
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0;">${[["fast","Fast",2,100],["slow","Slow",3,200],["signal","Signal",2,100]].map(([key,label,min,max])=>`<label>1h ${label} <input id="${prefix}hourlyHist${label}" aria-label="Hourly MACD ${key} period" type="number" min="${min}" max="${max}" step="1" value="${settings[`hourly_hist_${key}`]}" style="width:65px;"></label>`).join("")}</div>
      <div>Long entries: completed 1h histogram H &gt; 0 · <span id="${prefix}hourlyHistLongPaper">PAPER · waiting</span> · <span id="${prefix}hourlyHistLongLive">LIVE · waiting</span></div>
      <div>Short entries: completed 1h histogram H &lt; 0 · <span id="${prefix}hourlyHistShortPaper">PAPER · waiting</span> · <span id="${prefix}hourlyHistShortLive">LIVE · waiting</span></div>
      <small>H = MACD − signal on the latest completed hourly candle. A completed zero-cross changes the permitted entry direction: above zero is long-only; below zero is short-only. Exactly zero or unavailable blocks both directions. This never gates exits. Changes affect replay; unlock, pause and deploy to save live.</small>
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
    const currentRule=point?.source === "COMPLETED_1H_MACD_HISTOGRAM_REGIME" && Number.isFinite(point?.histogram);
    const stale=kind==="Live" && point?.available_time && Date.now()/1000-point.available_time>3600;
    for(const [name,key] of [["Long","long_ok"],["Short","short_ok"]]) {
      const node=document.getElementById(`${prefix}hourlyHist${name}${kind}`);
      if(node) node.textContent=`${kind.toUpperCase()} · ${enabled===false?"OFF":!point?.ready||!currentRule||stale?"UNAVAILABLE":point[key]?"PASS":"WAITING"}`;
    }
    const source=document.getElementById(`${prefix}hourlyHist${kind}Source`);
    if(source) source.textContent=`${kind.toUpperCase()} · completed 1h${point?.periods?` MACD (${point.periods.join(", ")})`:""} · ${point?.source_time?new Date(point.source_time*1000).toLocaleString("en-GB",{timeZone:"Asia/Seoul"})+" KST (candle open)":"source unavailable"}${currentRule?` · H ${point.previous_histogram.toFixed(5)} → ${point.histogram.toFixed(5)} · ${point.histogram_cross||"NONE"} · permits ${point.long_ok?"LONG":point.short_ok?"SHORT":"NEITHER"}`:""}${point?.error?" · "+point.error:""}`;
  }

  const netExitFields = {
    take_profit: {id: "takeProfit", toggle: "useTakeProfit", label: "Net take profit", enabled: true},
    stop_loss: {id: "stopLoss", toggle: "useStopLoss", label: "Net stop loss", enabled: false},
  };

  function takeProfitSettings(prefix, bot = {}, rule = "take_profit") {
    const {id, toggle, enabled: defaultEnabled} = netExitFields[rule];
    const enabledKey = `use_${rule}`;
    const pctKey = `${rule}_pct`;
    let draft = {};
    try { draft = JSON.parse(localStorage.getItem(`${prefix}${rule}_draft`) || "{}"); } catch (_) {}
    const enabled = document.getElementById(prefix + toggle);
    const threshold = document.getElementById(`${prefix}${id}Pct`);
    const saved = {...bot, ...(bot?.strategy_params || {}), ...draft};
    const raw = Number(threshold?.value ?? saved[pctKey] ?? 0.2);
    const result = {[enabledKey]: enabled ? Boolean(enabled.checked) : saved[enabledKey] ?? defaultEnabled,
      [pctKey]: Number.isFinite(raw) && raw >= 0.01 && raw <= 100 ? raw : 0.2};
    if (rule === "stop_loss" && prefix === "lighterCrypto_") {
      const number = (name, fallback) => {
        const value = Number(document.getElementById(prefix + name)?.value ?? saved[name] ?? fallback);
        return Number.isFinite(value) && value >= 0.01 && value <= 100 ? value : fallback;
      };
      result.stop_loss_mode = document.getElementById(prefix + "stopLossMode")?.value || saved.stop_loss_mode || "fixed";
      result.stop_trail_activation_pct = number("stop_trail_activation_pct", 0.3);
      result.stop_trail_distance_pct = number("stop_trail_distance_pct", 0.2);
      result.stop_trail_min_step_pct = number("stop_trail_min_step_pct", 0.05);
    }
    return result;
  }

  function singleLegNetTargetPrice({entry, isLong, targetPct, exitFeeRate = 0, evaluation = null} = {}) {
    const target = Number(targetPct);
    const evaluatedRate = Number(evaluation?.exit_fee_rate);
    const rate = Number.isFinite(evaluatedRate) ? evaluatedRate : Number(exitFeeRate);
    if (!Number.isFinite(target) || !Number.isFinite(rate) || rate < 0 || rate >= 1) return null;
    const quantity = Number(evaluation?.quantity);
    const basis = Number(evaluation?.entry_notional_usd);
    const entryFee = Number(evaluation?.entry_fee_usd);
    const side = Number(evaluation?.side);
    if (quantity > 0 && basis > 0 && entryFee >= 0 && (side === 1 || side === -1)) {
      const price = side > 0
        ? (basis * (1 + target / 100) + entryFee) / (quantity * (1 - rate))
        : (basis * (1 - target / 100) - entryFee) / (quantity * (1 + rate));
      return Number.isFinite(price) && price > 0 ? price : null;
    }
    const basisPrice = Number(entry);
    if (!(basisPrice > 0)) return null;
    const price = isLong
      ? basisPrice * (1 + rate + target / 100) / (1 - rate)
      : basisPrice * (1 - rate - target / 100) / (1 + rate);
    return Number.isFinite(price) && price > 0 ? price : null;
  }

  function singleLegStopLossLevel(prefix, bot, replay, entry, isLong, exitFeeRate = 0, source = "paper") {
    const saved = {...(bot || {}), ...((bot || {}).strategy_params || {})};
    const settings = source === "live" ? saved : takeProfitSettings(prefix, bot, "stop_loss");
    if (settings.use_stop_loss !== true) return null;
    const evaluation = source === "live" ? bot?.stop_loss_evaluation : replay?.stop_loss_evaluation;
    const configuredTarget = -Math.abs(Number(settings.stop_loss_pct ?? 0.2));
    const mode = prefix === "lighterCrypto_" ? String(settings.stop_loss_mode || "fixed") : "fixed";
    const evaluatedTarget = Number(evaluation?.target_pct);
    const targetPct = source === "live" && mode === "trailing" && Number.isFinite(evaluatedTarget)
      ? evaluatedTarget : configuredTarget;
    const price = singleLegNetTargetPrice({
      entry, isLong, targetPct, exitFeeRate,
      evaluation: source === "live" && Number.isFinite(evaluatedTarget) ? evaluation : null,
    });
    if (!(price > 0)) return null;
    const signed = `${targetPct > 0 ? "+" : ""}${Number(targetPct.toFixed(4))}%`;
    const trailing = source === "live" && mode === "trailing" && evaluation?.trail_active === true;
    return {
      price,
      netProfitPct: targetPct,
      axisTitle: `${trailing ? "TRAIL" : "STOP"} ${signed}`,
      title: `${trailing ? "TRAILING NET STOP" : "NET STOP"} ${signed} · ${source.toUpperCase()} · fees included; funding excluded`,
      color: "rgba(220, 38, 38, 0.82)",
      lineWidth: 1,
      stopLoss: true,
    };
  }

  function saveTakeProfitDraft(prefix, settings, rule = "take_profit") {
    try { localStorage.setItem(`${prefix}${rule}_draft`, JSON.stringify(settings)); } catch (_) {}
  }

  function alignNetExitControls(prefix, params) {
    for (const [rule, fields] of Object.entries(netExitFields)) {
      const enabledKey = `use_${rule}`, pctKey = `${rule}_pct`;
      const settings = {[enabledKey]: params[enabledKey] ?? fields.enabled, [pctKey]: Number(params[pctKey] ?? 0.2)};
      if (rule === "stop_loss" && prefix === "lighterCrypto_") Object.assign(settings, {
        stop_loss_mode: params.stop_loss_mode || "fixed",
        stop_trail_activation_pct: Number(params.stop_trail_activation_pct ?? 0.3),
        stop_trail_distance_pct: Number(params.stop_trail_distance_pct ?? 0.2),
        stop_trail_min_step_pct: Number(params.stop_trail_min_step_pct ?? 0.05),
      });
      const enabled = document.getElementById(prefix + fields.toggle);
      const pct = document.getElementById(`${prefix}${fields.id}Pct`);
      if (enabled) enabled.checked = settings[enabledKey];
      if (pct) pct.value = String(settings[pctKey]);
      if (rule === "stop_loss" && prefix === "lighterCrypto_") {
        for (const [name, fallback] of [["stopLossMode", "fixed"], ["stop_trail_activation_pct", 0.3], ["stop_trail_distance_pct", 0.2], ["stop_trail_min_step_pct", 0.05]]) {
          const control = document.getElementById(prefix + name);
          if (control) control.value = String(params[name === "stopLossMode" ? "stop_loss_mode" : name] ?? fallback);
        }
        const trail = document.getElementById(prefix + "stopTrailFields");
        if (trail) trail.hidden = (params.stop_loss_mode || "fixed") !== "trailing";
      }
      saveTakeProfitDraft(prefix, settings, rule);
    }
  }

  function mountTakeProfitControls(prefix, anchor, engine, rule = "take_profit") {
    const {id, toggle, label} = netExitFields[rule];
    if (!anchor?.parentNode || document.getElementById(`${prefix}${id}Controls`)) return;
    const settings = takeProfitSettings(prefix, engine.botState, rule);
    const panel = document.createElement("div");
    panel.id = `${prefix}${id}Controls`;
    panel.style.cssText = "margin:14px 0;padding:12px;border:1px solid #cbd5e1;border-radius:8px;background:#fff;";
    const trailing = rule === "stop_loss" && prefix === "lighterCrypto_" ? `<div style="margin-top:9px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><label>Behavior <select id="${prefix}stopLossMode"><option value="fixed" ${settings.stop_loss_mode !== "trailing" ? "selected" : ""}>Fixed</option><option value="trailing" ${settings.stop_loss_mode === "trailing" ? "selected" : ""}>Trail</option></select></label><span id="${prefix}stopTrailFields" ${settings.stop_loss_mode === "trailing" ? "" : "hidden"} style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;"><label>Activate at <input id="${prefix}stop_trail_activation_pct" type="number" min="0.01" max="100" step="0.01" value="${settings.stop_trail_activation_pct}" style="width:70px;">% net profit</label><label>Trail by <input id="${prefix}stop_trail_distance_pct" type="number" min="0.01" max="100" step="0.01" value="${settings.stop_trail_distance_pct}" style="width:70px;">%</label><label>Minimum ratchet <input id="${prefix}stop_trail_min_step_pct" type="number" min="0.01" max="100" step="0.01" value="${settings.stop_trail_min_step_pct}" style="width:70px;">%</label></span></div>` : "";
    panel.innerHTML = `<label style="display:flex;flex-direction:row !important;justify-content:flex-start;align-items:center;gap:8px;flex-wrap:wrap;">
      <input id="${prefix}${toggle}" type="checkbox" ${settings[`use_${rule}`] ? "checked" : ""} style="appearance:auto;width:16px;height:16px;">
      <b>${label}</b><input id="${prefix}${id}Pct" aria-label="${label} percent" type="number" min="0.01" max="100" step="0.01" value="${settings[`${rule}_pct`]}" style="width:75px;">% of entry notional</label>
      ${trailing}<small>${rule === "stop_loss" ? "Enter the initial maximum loss as a positive number. Trail activates only after the configured net profit, then raises the net-P&L floor behind the best observed value. " : ""}Newest tranche first · entry + exit trading fees deducted · funding excluded. Live: executable bid/ask each bot tick. Paper: completed closes with current account fees; no intrabar fills. Existing signal exits remain active. Unlock, pause and deploy to save live settings.</small>
      <div id="${prefix}${id}PaperStatus" style="margin-top:6px;font-size:11px;">PAPER · Awaiting replay</div>
      <div id="${prefix}${id}LiveStatus" style="margin-top:6px;font-size:11px;">LIVE · Awaiting bot status</div>`;
    anchor.parentNode.insertBefore(panel, anchor);
    panel.querySelectorAll("input").forEach(input => {
      input.addEventListener("input", () => {
        saveTakeProfitDraft(prefix, takeProfitSettings(prefix, engine.botState, rule), rule);
        engine.updateRulesMatchStatus();
        engine.renderCurrentPositionReferenceLines?.();
      });
      input.addEventListener("change", () => engine.runBacktest());
    });
    const mode = document.getElementById(prefix + "stopLossMode");
    if (mode) mode.addEventListener("change", () => {
      document.getElementById(prefix + "stopTrailFields").hidden = mode.value !== "trailing";
      saveTakeProfitDraft(prefix, takeProfitSettings(prefix, engine.botState, rule), rule);
      engine.renderCurrentPositionReferenceLines?.();
    });
  }

  function renderTakeProfitStatus(prefix, kind, evaluation, enabled, rule = "take_profit") {
    const node = document.getElementById(`${prefix}${netExitFields[rule].id}${kind}Status`);
    if (!node) return;
    const stale = kind === "Live" && evaluation?.time && Date.now() / 1000 - evaluation.time > 30;
    const state = enabled === false ? "OFF" : stale ? "UNAVAILABLE (STALE)" : evaluation?.state || (evaluation?.pass == null ? "UNAVAILABLE" : evaluation.pass ? "PASS" : "WAITING");
    const time = evaluation?.time ? new Date(evaluation.time * 1000).toLocaleString("en-GB", {timeZone:"Asia/Seoul"}) + " KST" : "source unavailable";
    node.textContent = `${kind.toUpperCase()} · ${state} · ${evaluation?.net_pct != null ? evaluation.net_pct.toFixed(4) + "% net / " + evaluation.target_pct + "% target · " : ""}${time}${evaluation?.error ? " · " + evaluation.error : ""}`;
  }

  const TerminalCommon = { maPivotSettings, maPivotGuideSettings, bindMaPivotControls, syncMaPivotControls, renderMaPivotStatus, maPivotAnalysis, alignNetExitControls, renderMaProximityControls, invalidMaProximityInput, syncInheritedConditionControls, inheritedConditionValue, inheritedStrategyConditions, settleReplayPlaceholders, replayProgressPart, fetchReplay, renderReplayFailure, resetGroupedLiveConditions, groupedLiveCondition, prepareConditionGroups, groupConditionControls, syncHourlyHistogram, hourlyHistogramSettings, alignHourlyHistogram, mountHourlyHistogram, renderHourlyHistogram, terminalLoadingMarkup, takeProfitSettings, singleLegNetTargetPrice, singleLegStopLossLevel, saveTakeProfitDraft, mountTakeProfitControls, renderTakeProfitStatus, revealChartSection, setTerminalAccountLoading, setTerminalLoading, alignTime, movingAverage, previousLocalExtremumSegment, segmentCurveIntersections, createMaExtremumHoverSeries, renderMaExtremumHover, movingAverageDiff, exponentialMovingAverage, macd, replaySignalLinks, namespaceFragment, renderTerminal, getCachedCandles, setCachedCandles, singleLegPositionReference, bindSingleLegDirectionControl, syncSingleLegDirectionControl, syncLiveToggleAvailability };
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
