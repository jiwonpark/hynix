/**
 * HYPERION Multi-Span Synchronized Terminal (Tab 10)
 * 5-Span Synchronized Candlestick Charts: 1s · 5m · 15m · 1h · 1d
 * Real-time tick streaming, synchronized panning, and crosshair tracking.
 */
(function (root, factory) {
  const MultiSpan = factory();
  if (typeof module === "object" && module.exports) module.exports = MultiSpan;
  if (root) root.multiSpanTab = MultiSpan;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const SPANS = [
    { id: "1s", label: "1-SECOND", sub: "Ultra HF Tick Momentum", color: "#0284c7", defaultLimit: 1000, sec: 1 },
    { id: "5m", label: "5-MINUTE", sub: "Micro Intraday Scalp", color: "#059669", defaultLimit: 500, sec: 300 },
    { id: "15m", label: "15-MINUTE", sub: "Intraday Swing Structure", color: "#d97706", defaultLimit: 500, sec: 900 },
    { id: "1h", label: "1-HOUR", sub: "Intermediate Trend Regime", color: "#7c3aed", defaultLimit: 500, sec: 3600 },
    { id: "1d", label: "1-DAY", sub: "Macro Daily Context", color: "#db2777", defaultLimit: 365, sec: 86400 },
  ];

  const MACD_RULES = [
    { id: "macd_h", label: "MACD-H", title: "MACD-H", key: "histogram", defaultEntrySign: "-", defaultExitSign: "+", desc: "Histogram zone" },
    { id: "macd_s", label: "MACD-S", title: "MACD-S", key: "signal", defaultEntrySign: "-", defaultExitSign: "+", desc: "Signal line zone" },
    { id: "macd_s_diff", label: "MACD-S diff", title: "MACD-S Δ", key: "signal_diff", defaultEntrySign: "+", defaultExitSign: "-", desc: "Signal 1st difference (slope)" },
    { id: "macd_s_diff2", label: "MACD-S 2nd diff", title: "MACD-S Δ²", key: "signal_diff2", defaultEntrySign: "+", defaultExitSign: "-", desc: "Signal 2nd difference (accel)" },
    { id: "macd_h_diff", label: "MACD-H diff", title: "MACD-H Δ", key: "hist_diff", defaultEntrySign: "+", defaultExitSign: "-", desc: "Histogram 1st difference (momentum turn)" },
  ];

  // Upper bound for full-range finer-chart loading; wider spans (e.g. 1d -> 1s = 86,400 bars)
  // load a focused readable slice instead of truncating blindly and zooming to <0.1px/bar.
  const MAX_FULL_DRILLDOWN_BARS = 4000;
  const PARTIAL_SLICE_CANDLES = 1800;
  const PARTIAL_SLICE_VISIBLE_BARS = 240;

  const KST_TIME_ZONE = "Asia/Seoul";
  const KST_FULL_SEC_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const KST_FULL_MIN_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const KST_SHORT_MDHM_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const KST_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const KST_MD_FMT = new Intl.DateTimeFormat("en-CA", {
    timeZone: KST_TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
  });
  const KST_HMS_FMT = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const KST_HM_FMT = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const formatKst = (dateOrSec, includeSeconds = true) => {
    if (!dateOrSec && dateOrSec !== 0) return "--";
    const ms = typeof dateOrSec === "number" ? (dateOrSec < 1e11 ? dateOrSec * 1000 : dateOrSec) : Number(dateOrSec);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "--";
    const fmt = includeSeconds ? KST_FULL_SEC_FMT : KST_FULL_MIN_FMT;
    return fmt.format(d).replace(",", "") + " KST";
  };

  const formatKstShort = (dateOrSec, spanId = null) => {
    if (!dateOrSec && dateOrSec !== 0) return "--";
    const ms = typeof dateOrSec === "number" ? (dateOrSec < 1e11 ? dateOrSec * 1000 : dateOrSec) : Number(dateOrSec);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "--";
    if (spanId === "1s") {
      return KST_HMS_FMT.format(d) + " KST";
    }
    if (spanId === "1d") {
      return KST_DATE_FMT.format(d) + " KST";
    }
    return KST_SHORT_MDHM_FMT.format(d).replace(",", "") + " KST";
  };

  const formatKstTick = (time, tickMarkType, spanId) => {
    const numTime = Number(time);
    const d = new Date(numTime * 1000);
    if (isNaN(d.getTime())) return "";
    if (spanId === "1s" || tickMarkType === 4) {
      return KST_HMS_FMT.format(d);
    }
    if (spanId === "1d") {
      return KST_DATE_FMT.format(d);
    }
    // Korea Standard Time is UTC+9 year-round (no DST): show date-only only on actual KST midnight.
    const kstSecOfDay = ((Math.floor(numTime) + 32400) % 86400 + 86400) % 86400;
    if (kstSecOfDay === 0) {
      return tickMarkType === 0 ? KST_DATE_FMT.format(d) : KST_MD_FMT.format(d);
    }
    if (tickMarkType === 0 || tickMarkType === 1 || tickMarkType === 2) {
      return `${KST_MD_FMT.format(d)} ${KST_HM_FMT.format(d)}`;
    }
    return KST_HM_FMT.format(d);
  };

  const formatPrice = (p) => {
    if (p === null || p === undefined || isNaN(p)) return "--";
    const num = Number(p);
    if (num >= 1000) return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (num >= 1) return num.toFixed(4);
    return num.toFixed(6);
  };

  const hexToRgba = (hex, alpha) => {
    if (!hex) return `rgba(2, 132, 199, ${alpha})`;
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  /**
   * High-performance in-memory candle cache.
   * Stores unified, deduplicated, sorted timelines per symbol and span.
   * Closed candles (historical) are immutable; forming candles are dynamically updated.
   */
  class CandleStore {
    constructor() {
      // Key: `${symbol}:${spanId}` -> Candle[] sorted by time ascending
      this.cache = new Map();
      this.maxBars = {
        "1s": 30000,
        "5m": 8000,
        "15m": 6000,
        "1h": 4000,
        "1d": 2000,
      };
    }

    _key(symbol, spanId) {
      return `${symbol || "BTCUSDT"}:${spanId}`;
    }

    put(symbol, spanId, candles) {
      if (!Array.isArray(candles) || !candles.length) return;
      const key = this._key(symbol, spanId);
      const existing = this.cache.get(key);
      if (!existing || !existing.length) {
        const sorted = [...candles].sort((a, b) => a.time - b.time);
        this._trimAndSet(key, spanId, sorted);
        return;
      }

      // Merge sorted timelines, deduplicating by time (incoming overwrites existing)
      const merged = [];
      let i = 0, j = 0;
      const n = existing.length;
      const incoming = [...candles].sort((a, b) => a.time - b.time);
      const m = incoming.length;

      while (i < n && j < m) {
        if (existing[i].time < incoming[j].time) {
          merged.push(existing[i++]);
        } else if (existing[i].time > incoming[j].time) {
          merged.push(incoming[j++]);
        } else {
          merged.push(incoming[j++]);
          i++;
        }
      }
      while (i < n) merged.push(existing[i++]);
      while (j < m) merged.push(incoming[j++]);

      this._trimAndSet(key, spanId, merged);
    }

    _trimAndSet(key, spanId, list) {
      const max = this.maxBars[spanId] || 6000;
      if (list.length > max) {
        list = list.slice(list.length - max);
      }
      this.cache.set(key, list);
    }

    getRange(symbol, spanId, startTime, endTime) {
      const key = this._key(symbol, spanId);
      const list = this.cache.get(key);
      if (!list || !list.length) return null;

      const spanObj = SPANS.find((p) => p.id === spanId);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;

      // Binary search for first candle with time >= startTime
      let low = 0, high = list.length - 1;
      let startIdx = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (list[mid].time >= startTime) {
          startIdx = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      }
      if (startIdx === -1) return null;

      // Binary search for last candle with time <= endTime
      low = 0; high = list.length - 1;
      let endIdx = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (list[mid].time <= endTime) {
          endIdx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (endIdx === -1 || endIdx < startIdx) return null;

      const firstC = list[startIdx];
      const lastC = list[endIdx];

      // Check boundary coverage (within 1 bar tolerance)
      const startCovered = firstC.time <= (startTime + spanSec);
      const endCovered = lastC.time >= (endTime - spanSec);
      if (!startCovered || !endCovered) return null;

      // Check continuity
      const barCount = endIdx - startIdx + 1;
      const expectedBars = Math.round((lastC.time - firstC.time) / spanSec);
      if (spanId !== "1d" && Math.abs(expectedBars - (barCount - 1)) > 6) {
        return null;
      }

      return list.slice(startIdx, endIdx + 1);
    }

    hasRange(symbol, spanId, startTime, endTime) {
      return Boolean(this.getRange(symbol, spanId, startTime, endTime));
    }

    getCandlesEndingAt(symbol, spanId, limit, endTime) {
      const key = this._key(symbol, spanId);
      const list = this.cache.get(key);
      if (!list || !list.length) return null;

      const spanObj = SPANS.find((p) => p.id === spanId);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;

      let low = 0, high = list.length - 1;
      let endIdx = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (list[mid].time <= endTime) {
          endIdx = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (endIdx === -1) return null;

      const lastC = list[endIdx];
      if (endTime - lastC.time > spanSec * 2) return null;

      const startIdx = Math.max(0, endIdx - limit + 1);
      const slice = list.slice(startIdx, endIdx + 1);
      if (slice.length >= Math.min(limit, 300)) {
        return slice;
      }
      return null;
    }

    clear() {
      this.cache.clear();
    }
  }

  class MultiSpanTab {
    constructor() {
      this.mounted = false;
      this.loaded = false;
      this.symbol = "BTCUSDT";
      this.syncEnabled = true;
      this.syncMode = "anchor"; // "anchor" (center-time) or "range" (strict timestamp window)
      this.syncZoomRatio = false;
      this.activeLayout = "grid"; // "grid", "hero", "stack"
      this.chartsPerRow = (typeof localStorage !== "undefined" && localStorage.getItem("ms_charts_per_row")) || "auto"; // "1", "2", "3", "4", "5", "auto"
      this.heroSpan = "1s";
      
      this.candleCache = new CandleStore();
      this.prefetchTimers = {}; // spanId -> timerId

      this.charts = {}; // span -> chart
      this.series = {}; // span -> candlestickSeries
      this.ma20 = {};   // span -> lineSeries
      this.ma50 = {};   // span -> lineSeries
      this.volumeSeries = {}; // span -> histogramSeries
      this.macdCharts = {};   // span -> macdChart
      this.macdHist = {};     // span -> histogramSeries
      this.macdLine = {};     // span -> lineSeries
      this.macdSignal = {};   // span -> lineSeries
      this.macdZero = {};     // span -> lineSeries
      this.macdData = {};     // span -> { macd, signal, histogram, byTime }
      this.candlesData = {}; // span -> array of { time, open, high, low, close, volume }
      this.strategyReplayResult = null; // completed-candle all-MACD-H paper replay
      this.entrySignals = []; // position-independent entry-condition matches
      this.strategyExecutionMarkers = []; // Tab 4/5-style entry/exit overlays on the strategy clock
      this.strategyExecutionFrame = null;
      this.showStrategyPaperMarkers = true;
      this.activeStrategyMarkerKey = null;
      this.selectedStrategyMarkerKey = null;
      this.strategyMarkerRenderRaf = null;
      this.strategyReplayTimer = null;
      this.lastVisibleRange = {}; // span -> { from, to }

      this.isSyncing = false;
      this.isLogicalSyncing = false;
      this.rafPending = false;
      this.logicalRafPending = false;
      this.reloadingSpans = {}; // spanId -> boolean (includes pagination + range reloads)
      this.rangeReloadingSpans = {}; // spanId -> boolean (full range jump/reset only)
      this.isHistorical = {};   // spanId -> boolean
      this.pinnedTime = null;   // active clicked timestamp
      this.pinnedSpan = null;   // source span of active click
      this.activeRangeHighlight = null; // { navId, sourceSpan, sourceLabel, sourceColor, startTime, endTime, finerSpans, readySpans }
      this.loadMoreTimeout = {}; // spanId -> timeoutId
      this.noOlderBefore = {};   // spanId -> cooldown epoch ms when left history exhausted/failed
      this.noNewerBefore = {};   // spanId -> cooldown epoch ms when right history failed/empty
      this.animations = {};       // spanId -> active pan/zoom animation state
      this.animatingSpans = {};   // spanId -> boolean
      this.programmaticSpans = {}; // spanId -> boolean
      this.animRafId = null;
      this.animationDurationScale = 1.0;
      this.activeNavId = 0;
      this.spanNavIds = {};       // spanId -> latest navId
      this.fetchSeq = {};         // spanId -> fetch sequence counter
      this.proxySlowUntil = 0;    // timestamp until which direct Binance is preferred over slow local proxy
      this.directFailUntil = 0;   // timestamp until which local proxy is preferred due to direct failure/CORS
      this.ws = null;
      this.pollInterval = null;
      this.resizeObserver = null;
    }

    mount(containerId = "tabContentMultiSpan") {
      if (this.mounted) return;
      const container = document.getElementById(containerId);
      if (!container) return;

      this.renderSkeleton(container);
      this.mountMacdStrategyFrame();
      this.initCharts();
      this.bindControls();
      this.mounted = true;
      this.fetchInitialData();
    }

    renderSkeleton(container) {
      container.innerHTML = `
        <style>
          #tabContentMultiSpan button {
            width: auto;
            height: auto;
            flex: 0 0 auto;
          }
          #tabContentMultiSpan .msRangeHighlight {
            transition: opacity 0.14s ease-out;
          }
        </style>
        <div class="multiSpanToolbar" style="background:#ffffff;border:1px solid #dbe2e7;border-radius:12px;padding:12px 18px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:20px;">🔭</span>
              <div>
                <strong style="font-size:15px;color:#0f172a;letter-spacing:-0.3px;display:block;">Multi-Span Synchronized Matrix</strong>
                <small style="color:#64748b;font-size:11px;">1s · 5m · 15m · 1h · 1d Multi-Timeframe Engine</small>
              </div>
            </div>
            <div style="height:28px;width:1px;background:#e2e8f0;margin:0 4px;"></div>
            <!-- Symbol Selector -->
            <div class="multiSpanSymbolGroup" style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:11px;color:#64748b;font-weight:700;">SYMBOL:</span>
              <div id="msSymbolButtons" style="display:inline-flex;background:#f1f5f9;padding:2px;border-radius:6px;gap:2px;border:1px solid #e2e8f0;">
                <button type="button" class="msSymBtn active" data-sym="BTCUSDT" style="background:#0284c7;color:#fff;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">BTC</button>
                <button type="button" class="msSymBtn" data-sym="ETHUSDT" style="background:transparent;color:#475569;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">ETH</button>
                <button type="button" class="msSymBtn" data-sym="SOLUSDT" style="background:transparent;color:#475569;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">SOL</button>
                <button type="button" class="msSymBtn" data-sym="DOGEUSDT" style="background:transparent;color:#475569;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">DOGE</button>
                <button type="button" class="msSymBtn" data-sym="XRPUSDT" style="background:transparent;color:#475569;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">XRP</button>
              </div>
              <input type="text" id="msCustomSymbolInput" placeholder="CUSTOM" style="background:#ffffff;border:1px solid #cbd5e1;color:#0f172a;padding:3px 8px;border-radius:4px;font-size:11px;width:70px;text-transform:uppercase;font-weight:700;margin-left:4px;" />
              <button type="button" id="msApplyCustomSym" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">GO</button>
            </div>
          </div>

          <!-- Controls: Sync & Layout -->
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <!-- Sync Toggle -->
            <div style="display:flex;align-items:center;gap:6px;background:#f8fafc;padding:3px 10px;border-radius:6px;border:1px solid #e2e8f0;">
              <span style="font-size:11px;color:#64748b;font-weight:700;">SYNC:</span>
              <button type="button" id="msToggleSync" style="background:#059669;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Toggle synchronized panning">🔗 ON</button>
              <button type="button" id="msToggleSyncMode" style="background:#ffffff;border:1px solid #cbd5e1;color:#0f172a;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Anchor mode keeps optimal zoom per span; Range mode forces identical time window">⚓ ANCHOR</button>
            </div>

            <!-- Quick Actions -->
            <button type="button" id="msAlignLatest" style="background:#f8fafc;border:1px solid #cbd5e1;color:#0284c7;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;" title="Align all 5 charts to the latest live candle">🎯 LATEST</button>
            <button type="button" id="msFitAll" style="background:#f8fafc;border:1px solid #cbd5e1;color:#475569;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;" title="Auto-fit all candles">📐 FIT ALL</button>

            <!-- Layout Selector -->
            <div style="display:inline-flex;background:#f1f5f9;padding:2px;border-radius:6px;gap:2px;border:1px solid #e2e8f0;">
              <button type="button" class="msLayoutBtn active" data-layout="grid" style="background:#0284c7;color:#fff;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Grid view">⊞ GRID</button>
              <button type="button" class="msLayoutBtn" data-layout="hero" style="background:transparent;color:#64748b;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Hero + Strip view">▣ HERO</button>
              <button type="button" class="msLayoutBtn" data-layout="stack" style="background:transparent;color:#64748b;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Full vertical stack">☰ STACK</button>
            </div>

            <!-- Charts Per Row Selector -->
            <div id="msPerRowGroup" style="display:inline-flex;align-items:center;background:#f1f5f9;padding:2px;border-radius:6px;gap:2px;border:1px solid #e2e8f0;">
              <span style="font-size:10px;font-weight:800;color:#64748b;padding:0 4px;" title="Adjust number of charts per row">PER ROW:</span>
              ${["1", "2", "3", "4", "5", "auto"].map((c) => {
                const isActive = (this.chartsPerRow === c) || (c === "auto" && (!this.chartsPerRow || this.chartsPerRow === "auto"));
                const label = c === "auto" ? "AUTO" : c;
                return `<button type="button" class="msColBtn${isActive ? " active" : ""}" data-cols="${c}" style="background:${isActive ? "#0284c7" : "transparent"};color:${isActive ? "#ffffff" : "#64748b"};border:none;padding:3px 7px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="${c === "auto" ? "Auto-responsive grid" : `${c} chart${c === "1" ? "" : "s"} per row`}">${label}</button>`;
              }).join("")}
            </div>
          </div>
        </div>

        <!-- Paper-only all-MACD-H strategy tester; mounted through the shared Tabs 3-5 execution frame. -->
        <section id="msStrategyPanel" class="shortTermExecutionSection" aria-label="Multi-chart paper replay">
          <div id="msStrategyExecutionFrame"></div>
        </section>

        <!-- Integrated Synchronized Crosshair HUD -->
        <div id="msCrosshairHud" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;font-variant-numeric:tabular-nums;color:#1e293b;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-weight:800;color:#0284c7;font-size:13px;" id="msHudSymbol">BTCUSDT</span>
            <span style="color:#cbd5e1;">|</span>
            <span style="color:#64748b;">TIME (KST): <strong id="msHudTime" style="color:#0f172a;">--</strong></span>
          </div>
          <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:11px;">
            ${SPANS.map((s) => `
              <span id="msHudSpan_${s.id}" style="color:${s.color};">
                <strong>${s.id}:</strong> <span id="msHudVal_${s.id}" style="color:#0f172a;font-weight:700;">--</span>
              </span>
            `).join("")}
          </div>
        </div>

        <!-- Charts Container (Switched via activeLayout class) -->
        <div id="msChartsWrapper" class="msLayoutGrid" style="display:grid;gap:12px;width:100%;">
          ${SPANS.map((s) => `
            <div id="msCard_${s.id}" class="msChartCard" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 1px 4px rgba(0,0,0,0.05);">
              <div class="msCardHeader" style="background:#f8fafc;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e2e8f0;flex-wrap:wrap;gap:6px;">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span style="background:${s.color};color:#ffffff;font-weight:900;font-size:11px;padding:2px 6px;border-radius:4px;letter-spacing:0.5px;">${s.id.toUpperCase()}</span>
                  <span style="color:#0f172a;font-weight:700;font-size:12px;">${s.label}</span>
                  <small style="color:#64748b;font-size:11px;">${s.sub}</small>
                  <span id="msCardTime_${s.id}" style="color:#475569;font-family:monospace;font-size:10px;background:#f1f5f9;padding:1px 5px;border-radius:3px;border:1px solid #e2e8f0;" title="Candle timestamp (KST)">--</span>
                  <span id="msCardModeBadge_${s.id}" class="msCardModeBadge" data-span="${s.id}" style="display:none;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;cursor:pointer;"></span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;flex-wrap:wrap;">
                  <div style="color:#64748b;font-family:monospace;" id="msCardOhlc_${s.id}">O:-- H:-- L:-- C:--</div>
                  <span id="msCardPrice_${s.id}" style="font-weight:800;color:#059669;font-size:13px;">--</span>
                  <button type="button" class="msCardLoadMoreBtn" data-span="${s.id}" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Load older historical candles">+ LOAD MORE</button>
                  <button type="button" class="msCardLoadNewerBtn" data-span="${s.id}" style="display:none;background:#ffffff;border:1px solid #cbd5e1;color:#0284c7;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;font-weight:700;" title="Load newer candles to the right">NEWER &gt;</button>
                  <button type="button" class="msCardHeroBtn" data-span="${s.id}" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Set as Hero focus">HERO</button>
                  <button type="button" class="msCardFitBtn" data-span="${s.id}" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Fit this chart">FIT</button>
                </div>
              </div>
              <div id="msChartHost_${s.id}" class="msChartHost" style="width:100%;height:240px;position:relative;">
                <div id="msRangeHighlight_${s.id}" class="msRangeHighlight" style="display:none;position:absolute;top:0;bottom:26px;pointer-events:none;z-index:3;">
                  <div id="msRangeBadge_${s.id}" style="position:absolute;top:4px;left:4px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.15);pointer-events:none;color:#ffffff;"></div>
                </div>
                <svg id="msTradeTriangles_${s.id}" aria-label="Paper trade entry-exit triangles" style="position:absolute;inset:0;width:100%;height:100%;z-index:6;pointer-events:none;overflow:hidden;"></svg>
                <div id="msTradeMarkerTargets_${s.id}" aria-label="Paper replay trade markers" style="position:absolute;inset:0;z-index:7;pointer-events:none;overflow:hidden;"></div>
                <div id="msTradeMarkerHover_${s.id}" role="status" aria-live="polite" style="display:none;position:absolute;z-index:8;top:8px;left:12px;max-width:min(420px,calc(100% - 24px));padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1;background:rgba(255,255,255,.97);box-shadow:0 2px 8px rgba(15,23,42,.12);font-size:11px;font-weight:800;line-height:1.35;color:#0f172a;pointer-events:none;white-space:normal;"></div>
              </div>
              <!-- MACD Sub-pane -->
              <div class="msMacdHeader" style="background:#f8fafc;padding:3px 12px;border-top:1px solid #e2e8f0;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;font-size:10px;line-height:1.4;flex-wrap:wrap;gap:4px;">
                <span style="font-weight:700;color:#64748b;">MACD (12, 26, 9)</span>
                <div id="msMacdLegend_${s.id}" style="display:flex;gap:6px 10px;font-family:monospace;font-size:10px;flex-wrap:wrap;align-items:center;">
                  <span style="color:#0284c7;font-weight:600;">MACD: <span id="msMacdVal_${s.id}">--</span></span>
                  <span style="color:#ea580c;font-weight:600;">SIG: <span id="msSigVal_${s.id}">--</span></span>
                  <span style="color:#475569;font-weight:600;">ΔS: <span id="msSigDiffVal_${s.id}">--</span></span>
                  <span style="color:#475569;font-weight:600;">Δ²S: <span id="msSigDiff2Val_${s.id}">--</span></span>
                  <span style="color:#475569;font-weight:600;">HIST: <span id="msHistVal_${s.id}">--</span></span>
                  <span style="color:#475569;font-weight:600;">ΔH: <span id="msHistDiffVal_${s.id}">--</span></span>
                </div>
              </div>
              <div id="msMacdHost_${s.id}" class="msMacdHost" style="width:100%;height:90px;position:relative;">
                <div id="msMacdRangeHighlight_${s.id}" class="msMacdRangeHighlight" style="display:none;position:absolute;top:0;bottom:26px;pointer-events:none;z-index:3;"></div>
              </div>
            </div>
          `).join("")}
        </div>
      `;

      this.applyLayoutStyles();
    }

    macdStrategyFrameBody() {
      return `
        <div class="strategyReplayPresetBar">
          <div class="executionChartGrouping" aria-label="Paper replay preset">
            <span>PRESET</span>
            <button type="button" id="msStrategyPresetQuick" class="isActive" aria-pressed="true" title="Use the 5-minute signal clock with 5m and 15m histogram rules">Quick 5m+15m</button>
            <button type="button" id="msStrategyPresetAll" aria-pressed="false" title="Require all five MACD histograms on the 1-second signal clock">All 5 strict</button>
            <button type="button" id="msStrategyPresetFullWave" aria-pressed="false" title="Enable all 5 MACD indicators across 5m and 15m">5m+15m Full Wave</button>
            <button type="button" id="msStrategyPresetAllFullWave" aria-pressed="false" title="Enable all 5 MACD indicators across all 5 timeframes">All 5 Full Wave</button>
          </div>
          <strong style="font-size:12px;color:#0f172a;">Multi-Span MACD Dynamics Strategy Test</strong>
          <span style="background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:4px;padding:2px 6px;font-size:10px;font-weight:800;">PAPER REPLAY ONLY</span>
        </div>
        <small style="display:block;color:#64748b;margin-bottom:var(--terminal-space-min);">BUY and SELL match when all enabled rules across configured timeframes pass on completed signal-clock candles. Toggle individual rules (MACD-H, MACD-S, ΔS, Δ²S, ΔH) and toggle sign (+/-) on any row. Quick uses 5m+15m MACD-H; Full Wave enables all 5 MACD dynamics. No orders are sent.</small>
        <div class="strategyReplaySetup" aria-label="Paper replay setup">
          <strong style="color:#475569;">Replay setup</strong>
          <label>Signal clock
            <select id="msStrategyClock">
              ${SPANS.map((s) => `<option value="${s.id}"${s.id === "5m" ? " selected" : ""}>${s.id}</option>`).join("")}
            </select>
          </label>
          <label>Capital $
            <input id="msStrategyCapital" type="number" value="10000" min="1" step="100" style="width:82px;">
          </label>
          <label>Fee
            <input id="msStrategyFeeBps" type="number" value="5" min="0" max="1000" step="0.1" style="width:58px;"> bps/side
          </label>
        </div>
        <div id="msStrategySummary" class="executionChartSecondaryStatus" style="height:auto;min-height:0;white-space:normal;margin:var(--terminal-space-min) 0 0;padding:6px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;">Awaiting completed chart data…</div>
        <div id="msStrategyConditionGroups" class="terminalConditionGroups" aria-label="Paper replay trading conditions">
          <section class="terminalConditionGroup" aria-labelledby="msStrategyEntryHeading">
            <h3 id="msStrategyEntryHeading" class="terminalConditionGroupTitle">Entry conditions</h3>
            <small class="terminalConditionGroupNote">Every enabled rule must pass on the same completed signal-clock candle. Entry signals remain independent of simulated position state.</small>
            <label style="display:flex;flex-direction:row;align-items:center;gap:6px;font-size:11px;font-weight:800;color:#166534;">BUY when enabled H &lt;
              <input id="msStrategyBuyThreshold" aria-label="Paper buy MACD histogram threshold" type="number" value="0" step="0.0001" style="width:78px;border:1px solid #86efac;border-radius:4px;padding:3px 5px;font-weight:800;">
            </label>
            <div id="msStrategyEntryConditions" class="condChecklist" aria-live="polite" style="max-height:420px;overflow-y:auto;padding-right:4px;">
              ${SPANS.map((s) => `
                <div class="msSpanSection" style="margin-bottom:8px;">
                  <div style="font-weight:800;font-size:10px;color:${s.color};padding:3px 6px;background:#f8fafc;border-top:1px solid #e2e8f0;border-bottom:1px solid #f1f5f9;margin-top:4px;display:flex;align-items:center;justify-content:space-between;border-radius:4px;">
                    <span>● ${s.id} · ${s.label}</span>
                    <button type="button" class="msSpanToggleAllBtn" data-span="${s.id}" data-kind="entry" style="border:1px solid #cbd5e1;background:#fff;border-radius:3px;padding:1px 6px;font-size:9.5px;font-weight:700;cursor:pointer;color:#334155;">Toggle ${s.id}</button>
                  </div>
                  ${MACD_RULES.map((rule) => {
                    const isDefault = ["5m", "15m"].includes(s.id) && rule.id === "macd_h";
                    const sign = rule.defaultEntrySign;
                    const op = sign === "+" ? ">" : "<";
                    return `
                      <div class="condRow${isDefault ? "" : " disabled-cond"}" data-span="${s.id}" data-rule="${rule.id}" data-kind="entry">
                        <label class="toggleSwitch" title="Turn ${s.id} ${rule.label} rule ON/OFF">
                          <input class="msStrategySpanToggle" data-span="${s.id}" data-rule="${rule.id}" data-kind="entry" aria-label="Use ${s.id} ${rule.label} for paper entry" type="checkbox"${isDefault ? " checked" : ""}>
                          <span class="toggleSlider"></span>
                        </label>
                        <span class="condLabel">
                          <strong style="color:${s.color};">${s.id} ${rule.label} ${op} 0</strong>
                          <button type="button" class="condSignToggle" data-span="${s.id}" data-rule="${rule.id}" data-kind="entry" data-sign="${sign}" title="Click to toggle condition between + (>0) and - (<0)" style="margin-left:6px;padding:1px 5px;font-size:10px;font-weight:800;border-radius:4px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;color:${sign === '+' ? '#166534' : '#991b1b'};">
                            ${sign === "+" ? "+ (>0)" : "− (<0)"}
                          </button>
                          <small style="display:block;color:#64748b;">PAPER · awaiting data</small>
                        </span>
                        <span class="condValue"><strong style="color:#64748b;">—</strong></span>
                        <span class="condBadge ${isDefault ? "wait" : "neutral"}">${isDefault ? "WAITING" : "OFF"}</span>
                      </div>
                    `;
                  }).join("")}
                </div>
              `).join("")}
            </div>
          </section>
          <section class="terminalConditionGroup" aria-labelledby="msStrategyExitHeading">
            <h3 id="msStrategyExitHeading" class="terminalConditionGroupTitle">Exit conditions</h3>
            <small class="terminalConditionGroupNote">Every enabled rule is evaluated on completed candles. A passing SELL setup closes the simulated long when one is open.</small>
            <label style="display:flex;flex-direction:row;align-items:center;gap:6px;font-size:11px;font-weight:800;color:#991b1b;">SELL when enabled H &gt;
              <input id="msStrategySellThreshold" aria-label="Paper sell MACD histogram threshold" type="number" value="0" step="0.0001" style="width:78px;border:1px solid #fca5a5;border-radius:4px;padding:3px 5px;font-weight:800;">
            </label>
            <div id="msStrategyExitConditions" class="condChecklist" aria-live="polite" style="max-height:420px;overflow-y:auto;padding-right:4px;">
              ${SPANS.map((s) => `
                <div class="msSpanSection" style="margin-bottom:8px;">
                  <div style="font-weight:800;font-size:10px;color:${s.color};padding:3px 6px;background:#f8fafc;border-top:1px solid #e2e8f0;border-bottom:1px solid #f1f5f9;margin-top:4px;display:flex;align-items:center;justify-content:space-between;border-radius:4px;">
                    <span>● ${s.id} · ${s.label}</span>
                    <button type="button" class="msSpanToggleAllBtn" data-span="${s.id}" data-kind="exit" style="border:1px solid #cbd5e1;background:#fff;border-radius:3px;padding:1px 6px;font-size:9.5px;font-weight:700;cursor:pointer;color:#334155;">Toggle ${s.id}</button>
                  </div>
                  ${MACD_RULES.map((rule) => {
                    const isDefault = ["5m", "15m"].includes(s.id) && rule.id === "macd_h";
                    const sign = rule.defaultExitSign;
                    const op = sign === "+" ? ">" : "<";
                    return `
                      <div class="condRow${isDefault ? "" : " disabled-cond"}" data-span="${s.id}" data-rule="${rule.id}" data-kind="exit">
                        <label class="toggleSwitch" title="Turn ${s.id} ${rule.label} rule ON/OFF">
                          <input class="msStrategySpanToggle" data-span="${s.id}" data-rule="${rule.id}" data-kind="exit" aria-label="Use ${s.id} ${rule.label} for paper exit" type="checkbox"${isDefault ? " checked" : ""}>
                          <span class="toggleSlider"></span>
                        </label>
                        <span class="condLabel">
                          <strong style="color:${s.color};">${s.id} ${rule.label} ${op} 0</strong>
                          <button type="button" class="condSignToggle" data-span="${s.id}" data-rule="${rule.id}" data-kind="exit" data-sign="${sign}" title="Click to toggle condition between + (>0) and - (<0)" style="margin-left:6px;padding:1px 5px;font-size:10px;font-weight:800;border-radius:4px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;color:${sign === '+' ? '#166534' : '#991b1b'};">
                            ${sign === "+" ? "+ (>0)" : "− (<0)"}
                          </button>
                          <small style="display:block;color:#64748b;">PAPER · awaiting data</small>
                        </span>
                        <span class="condValue"><strong style="color:#64748b;">—</strong></span>
                        <span class="condBadge ${isDefault ? "wait" : "neutral"}">${isDefault ? "WAITING" : "OFF"}</span>
                      </div>
                    `;
                  }).join("")}
                </div>
              `).join("")}
            </div>
          </section>
        </div>
        <small id="msStrategySource" style="display:block;color:#64748b;">Source: completed Binance candles · MACD-H(12,26,9) · loaded chart history only</small>
      `;
    }

    mountMacdStrategyFrame() {
      if (typeof document === "undefined") return;
      const container = document.getElementById("msStrategyExecutionFrame");
      if (!container) return;
      const Frame = typeof globalThis !== "undefined" ? globalThis.StrategyExecutionChartFrame : null;
      if (!Frame?.mount) {
        container.classList.add("executionChartFrame");
        container.innerHTML = this.macdStrategyFrameBody();
        return;
      }
      this.strategyExecutionFrame = Frame.mount({
        container,
        id: "msStrategyExecution",
        showHost: false,
        ids: {
          action: "msRunStrategyReplay",
          actual: "msStrategyActualMarkers",
          virtual: "msStrategyPaperMarkers",
          status: "msStrategyReplayStatus",
          legend: "msStrategyLegend",
          sync: "msStrategySync",
        },
        title: "PAPER REPLAY · INTERVAL-DEPENDENT · NOT LIVE EXECUTION",
        action: { label: "Rerun Paper", onClick: () => this.runMacdStrategyReplay() },
        actual: { label: "Actual (none)", enabled: false, visible: false },
        virtual: {
          label: "Paper",
          visible: this.showStrategyPaperMarkers,
          onToggle: () => {
            this.showStrategyPaperMarkers = !this.showStrategyPaperMarkers;
            this.strategyExecutionFrame?.setVisibility("virtual", this.showStrategyPaperMarkers);
            if (!this.showStrategyPaperMarkers) {
              this.activeStrategyMarkerKey = null;
              this.selectedStrategyMarkerKey = null;
              this.updateMacdStrategyMarkerHover(null);
            }
            this.renderMacdStrategyMarkers();
          },
        },
        status: "PAPER ONLY · Awaiting completed chart data",
        description: "Paper results intentionally change with the signal clock, enabled timeframe rules, thresholds, and loaded overlap. These controls never reconfigure a live bot.",
        body: this.macdStrategyFrameBody(),
        legendPosition: "top",
        legend: '<span><strong style="color:#16a34a">▷</strong> Entry signal</span><span><strong style="color:#16a34a">▶</strong> Simulated buy</span><span><strong style="color:#dc2626">◀</strong> Simulated sell</span><span>Hover or click a fill for paired P&amp;L</span>',
        syncText: "Completed candles · loaded history",
      });
    }

    getEffectiveGridCols(wrapper) {
      const cols = this.chartsPerRow || "auto";
      const winWidth = typeof window !== "undefined" ? window.innerWidth : 1200;
      if (cols === "auto") {
        const availW = (wrapper && wrapper.clientWidth > 0) ? wrapper.clientWidth : winWidth;
        const gapPx = 12;
        if (winWidth <= 460 || availW <= 460) {
          return {
            cols,
            effCols: 1,
            gridTemplateColumns: "repeat(1, minmax(0, 1fr))",
          };
        }
        return {
          cols,
          effCols: Math.max(1, Math.min(SPANS.length, Math.floor((availW + gapPx) / (420 + gapPx)))),
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
        };
      }
      let numCols = parseInt(cols, 10) || 3;
      if (winWidth <= 640 && numCols > 1) {
        numCols = 1;
      } else if (winWidth <= 1024 && numCols > 2) {
        numCols = 2;
      }
      return {
        cols,
        effCols: Math.max(1, Math.min(SPANS.length, numCols)),
        gridTemplateColumns: `repeat(${numCols}, minmax(0, 1fr))`,
      };
    }

    syncGridColumnsToWidth() {
      const wrapper = document.getElementById("msChartsWrapper");
      if (!wrapper) return "auto";
      if (this.activeLayout !== "grid") {
        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          if (card && card.style.gridColumn !== "") card.style.gridColumn = "";
        });
        return this.chartsPerRow || "auto";
      }

      const { cols, effCols, gridTemplateColumns } = this.getEffectiveGridCols(wrapper);
      if (wrapper.style.gridTemplateColumns !== gridTemplateColumns) {
        wrapper.style.gridTemplateColumns = gridTemplateColumns;
      }

      const rem = SPANS.length % effCols;
      const lastIdx = SPANS.length - 1;
      const lastSpanCols = rem > 0 ? (effCols - rem + 1) : 1;

      SPANS.forEach((s, idx) => {
        const card = document.getElementById(`msCard_${s.id}`);
        if (!card) return;
        const nextCol = (idx === lastIdx && lastSpanCols > 1) ? `span ${lastSpanCols}` : "";
        if (card.style.gridColumn !== nextCol) {
          card.style.gridColumn = nextCol;
        }
      });
      return cols;
    }

    applyLayoutStyles() {
      const wrapper = document.getElementById("msChartsWrapper");
      if (!wrapper) return;

      if (this.activeLayout === "grid") {
        wrapper.style.display = "grid";
        wrapper.style.flexDirection = "";

        const cols = this.syncGridColumnsToWidth();

        const heightMap = {
          "1": { chart: "320px", macd: "100px" },
          "2": { chart: "260px", macd: "90px" },
          "3": { chart: "240px", macd: "85px" },
          "4": { chart: "220px", macd: "80px" },
          "5": { chart: "200px", macd: "75px" },
          "auto": { chart: "240px", macd: "85px" },
        };
        const targetHeights = heightMap[cols] || heightMap["auto"];

        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          const macdHost = document.getElementById(`msMacdHost_${s.id}`);
          if (card) card.style.order = "0";
          if (host) host.style.height = targetHeights.chart;
          if (macdHost) macdHost.style.height = targetHeights.macd;
        });
      } else if (this.activeLayout === "hero") {
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        wrapper.style.gridTemplateColumns = "";
        this.syncGridColumnsToWidth();
        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          const macdHost = document.getElementById(`msMacdHost_${s.id}`);
          if (s.id === this.heroSpan) {
            if (card) card.style.order = "-1";
            if (host) host.style.height = "380px";
            if (macdHost) macdHost.style.height = "110px";
          } else {
            if (card) card.style.order = "1";
            if (host) host.style.height = "200px";
            if (macdHost) macdHost.style.height = "75px";
          }
        });
      } else if (this.activeLayout === "stack") {
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        wrapper.style.gridTemplateColumns = "";
        this.syncGridColumnsToWidth();
        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          const macdHost = document.getElementById(`msMacdHost_${s.id}`);
          if (card) card.style.order = "0";
          if (host) host.style.height = "260px";
          if (macdHost) macdHost.style.height = "90px";
        });
      }
      this.resizeAll();
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => this.resizeAll());
      }
    }

    initCharts() {
      if (typeof LightweightCharts === "undefined") return;

      SPANS.forEach((s) => {
        const host = document.getElementById(`msChartHost_${s.id}`);
        if (!host) return;

        const chart = LightweightCharts.createChart(host, {
          width: host.clientWidth || 500,
          height: host.clientHeight || 320,
          layout: {
            background: { type: "solid", color: "#f8fafc" },
            textColor: "#475569",
            fontSize: 11,
          },
          localization: {
            locale: "ko-KR",
            timeFormatter: (time) => formatKst(time),
          },
          grid: {
            vertLines: { color: "#f1f5f9" },
            horzLines: { color: "#f1f5f9" },
          },
          crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: s.color, width: 1, style: 2, labelBackgroundColor: "#0284c7" },
            horzLine: { color: s.color, width: 1, style: 2, labelBackgroundColor: "#0284c7" },
          },
          rightPriceScale: {
            borderColor: "#e2e8f0",
            scaleMargins: { top: 0.1, bottom: 0.15 },
            minimumWidth: 74,
          },
          timeScale: {
            borderColor: "#e2e8f0",
            timeVisible: true,
            secondsVisible: s.id === "1s",
            rightOffset: 6,
            minBarSpacing: 0.02,
            lockVisibleTimeRangeOnResize: true,
            tickMarkFormatter: (time, tickMarkType) => formatKstTick(time, tickMarkType, s.id),
          },
          kineticScroll: {
            touch: true,
            mouse: true,
          },
        });

        const candleSeries = chart.addCandlestickSeries({
          upColor: "#059669",
          downColor: "#dc2626",
          borderVisible: false,
          wickUpColor: "#059669",
          wickDownColor: "#dc2626",
        });

        const ma20 = chart.addLineSeries({
          color: s.color,
          lineWidth: 1.5,
          priceLineVisible: false,
          title: "MA20",
        });

        const ma50 = chart.addLineSeries({
          color: "#d97706",
          lineWidth: 1.5,
          priceLineVisible: false,
          title: "MA50",
        });

        this.charts[s.id] = chart;
        this.series[s.id] = candleSeries;
        this.ma20[s.id] = ma20;
        this.ma50[s.id] = ma50;

        // Cancel active animation on that span if user interacts directly
        const cancelOnInput = () => {
          if (this.animatingSpans[s.id]) {
            this.programmaticSpans[s.id] = false;
            this.cancelSpanAnimation(s.id, { runSettle: !this.rangeReloadingSpans?.[s.id] });
          }
        };
        if (typeof host.addEventListener === "function") {
          host.addEventListener("pointerdown", cancelOnInput, { passive: true });
          host.addEventListener("wheel", cancelOnInput, { passive: true });
          host.addEventListener("touchstart", cancelOnInput, { passive: true });
          host.addEventListener("pointerup", () => this.scheduleMacdStrategyMarkerRender(), { passive: true });
          host.addEventListener("wheel", () => this.scheduleMacdStrategyMarkerRender(), { passive: true });
        }

        // Initialize MACD Sub-Chart
        const macdHost = document.getElementById(`msMacdHost_${s.id}`);
        if (macdHost) {
          const macdChart = LightweightCharts.createChart(macdHost, {
            width: macdHost.clientWidth || 500,
            height: macdHost.clientHeight || 90,
            layout: {
              background: { type: "solid", color: "#f8fafc" },
              textColor: "#64748b",
              fontSize: 10,
            },
            localization: {
              locale: "ko-KR",
              timeFormatter: (time) => formatKst(time),
            },
            grid: {
              vertLines: { color: "#f1f5f9" },
              horzLines: { color: "#f1f5f9" },
            },
            crosshair: {
              mode: LightweightCharts.CrosshairMode.Normal,
              vertLine: { color: s.color, width: 1, style: 2, labelBackgroundColor: "#0284c7" },
              horzLine: { color: "#94a3b8", width: 1, style: 2, labelBackgroundColor: "#475569" },
            },
            rightPriceScale: {
              borderColor: "#e2e8f0",
              scaleMargins: { top: 0.12, bottom: 0.12 },
              autoScale: true,
              minimumWidth: 74,
            },
            timeScale: {
              borderColor: "#e2e8f0",
              timeVisible: s.id !== "1d",
              secondsVisible: s.id === "1s",
              rightOffset: 6,
              minBarSpacing: 0.02,
              lockVisibleTimeRangeOnResize: true,
              tickMarkFormatter: (time, tickMarkType) => formatKstTick(time, tickMarkType, s.id),
            },
            kineticScroll: { touch: true, mouse: true },
          });

          const macdHist = macdChart.addHistogramSeries({
            color: "#059669",
            priceLineVisible: false,
            lastValueVisible: false,
            priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
          });
          const macdZero = macdChart.addLineSeries({
            color: "#cbd5e1",
            lineWidth: 1,
            lineStyle: 1,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          const macdLine = macdChart.addLineSeries({
            color: "#0284c7",
            lineWidth: 1.5,
            priceLineVisible: false,
            lastValueVisible: false,
          });
          const macdSignal = macdChart.addLineSeries({
            color: "#ea580c",
            lineWidth: 1.5,
            priceLineVisible: false,
            lastValueVisible: false,
          });

          this.macdCharts[s.id] = macdChart;
          this.macdHist[s.id] = macdHist;
          this.macdZero[s.id] = macdZero;
          this.macdLine[s.id] = macdLine;
          this.macdSignal[s.id] = macdSignal;

          // Bidirectional timeScale synchronization between price chart and MACD chart
          let isSyncingMacd = false;
          chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
            if (isSyncingMacd || !logicalRange) return;
            isSyncingMacd = true;
            try {
              macdChart.timeScale().setVisibleLogicalRange(logicalRange);
            } catch (_) {}
            isSyncingMacd = false;
          });

          macdChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
            if (isSyncingMacd || !logicalRange) return;
            isSyncingMacd = true;
            try {
              chart.timeScale().setVisibleLogicalRange(logicalRange);
            } catch (_) {}
            isSyncingMacd = false;
          });

          if (typeof macdHost.addEventListener === "function") {
            macdHost.addEventListener("pointerdown", cancelOnInput, { passive: true });
            macdHost.addEventListener("wheel", cancelOnInput, { passive: true });
            macdHost.addEventListener("touchstart", cancelOnInput, { passive: true });
          }

          macdChart.subscribeCrosshairMove((param) => {
            this.handleCrosshairMove(s.id, param, "macd");
          });
          macdChart.subscribeClick((param) => {
            this.handleChartClick(s.id, param);
          });
        }

        // Wire range & logical range synchronization
        chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
          this.handleRangeChange(s.id, range);
          this.updateRangeHighlight(s.id);
          this.scheduleMacdStrategyMarkerRender();
        });

        // Wire visible logical range change for range highlight update & auto load more (left/older & right/newer)
        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
          this.updateRangeHighlight(s.id);
          if (
            !logicalRange ||
            this.reloadingSpans[s.id] ||
            this.animatingSpans[s.id] ||
            this.programmaticSpans[s.id]
          ) {
            return;
          }
          const data = this.candlesData?.[s.id];
          const dataLen = data ? data.length : 0;
          if (!dataLen) return;
          const nowMs = Date.now();
          const leftNeed = logicalRange.from < 25 && nowMs >= (this.noOlderBefore?.[s.id] || 0);
          const latestTime = data[dataLen - 1].time;
          const spanSec = s.sec || 60;
          const nowSec = Math.floor(nowMs / 1000);
          const canLoadRight =
            Boolean(this.isHistorical?.[s.id]) ||
            (nowSec - latestTime) > Math.max(spanSec * 5, 300);
          const rightNeed =
            canLoadRight &&
            logicalRange.to > (dataLen - 25) &&
            nowMs >= (this.noNewerBefore?.[s.id] || 0);

          if (leftNeed && rightNeed) {
            const leftOvershoot = 25 - logicalRange.from;
            const rightOvershoot = logicalRange.to - (dataLen - 25);
            this.debouncedLoadMore(s.id, rightOvershoot >= leftOvershoot ? "newer" : "older");
          } else if (rightNeed) {
            this.debouncedLoadMore(s.id, "newer");
          } else if (leftNeed) {
            this.debouncedLoadMore(s.id, "older");
          }
        });

        // Wire crosshair tracking
        chart.subscribeCrosshairMove((param) => {
          this.handleCrosshairMove(s.id, param, "main");
        });

        // Wire click for drill-down / synchronization on coarser charts
        chart.subscribeClick((param) => {
          this.clearMacdStrategyMarkerSelection(s.id);
          this.handleChartClick(s.id, param);
        });
      });

      // Handle window / element resizing smoothly
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => {
          this.syncGridColumnsToWidth();
          this.resizeAll();
        });
        const wrapper = document.getElementById("msChartsWrapper");
        if (wrapper) this.resizeObserver.observe(wrapper);
      }
    }

    resizeAll() {
      SPANS.forEach((s) => {
        const host = document.getElementById(`msChartHost_${s.id}`);
        const chart = this.charts[s.id];
        let savedRange = null;
        if (host && chart && host.clientWidth > 0 && host.clientHeight > 0) {
          this.programmaticSpans[s.id] = true;
          try {
            savedRange = chart.timeScale().getVisibleLogicalRange();
          } catch (_) {}
          try {
            chart.applyOptions({
              width: host.clientWidth,
              height: host.clientHeight,
            });
            if (savedRange && savedRange.to > savedRange.from && !this.animatingSpans[s.id]) {
              chart.timeScale().setVisibleLogicalRange(savedRange);
            }
          } catch (_) {
          } finally {
            const settleResize = () => {
              if (!this.animatingSpans[s.id]) {
                this.programmaticSpans[s.id] = false;
              }
              this.updateRangeHighlight(s.id);
            };
            if (typeof requestAnimationFrame === "function") {
              requestAnimationFrame(settleResize);
            } else {
              settleResize();
            }
          }
        }
        const macdHost = document.getElementById(`msMacdHost_${s.id}`);
        const macdChart = this.macdCharts[s.id];
        if (macdHost && macdChart && macdHost.clientWidth > 0 && macdHost.clientHeight > 0) {
          try {
            macdChart.applyOptions({
              width: macdHost.clientWidth,
              height: macdHost.clientHeight,
            });
            if (savedRange && savedRange.to > savedRange.from && !this.animatingSpans[s.id]) {
              macdChart.timeScale().setVisibleLogicalRange(savedRange);
            }
          } catch (_) {}
        }
      });
      this.updateAllRangeHighlights();
      this.scheduleMacdStrategyMarkerRender();
    }

    // =========================================================================
    // CONTINUOUS PAN & ZOOM ANIMATION ENGINE
    // =========================================================================

    nowMs() {
      return typeof performance !== "undefined" && typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    }

    easeOutCubic(t) {
      const clamped = Math.max(0, Math.min(1, t));
      return 1 - Math.pow(1 - clamped, 3);
    }

    cancelSpanAnimation(spanId, options = {}) {
      const { runSettle = false } = options;
      const existing = this.animations?.[spanId];
      if (existing) {
        delete this.animations[spanId];
      }
      this.animatingSpans[spanId] = false;
      if (runSettle && existing && typeof existing.onComplete === "function") {
        existing.onComplete();
      }
    }

    ensureAnimationLoop() {
      if (this.animRafId !== null) return;
      const step = () => {
        this.animRafId = null;
        this.tickAnimations();
      };
      if (typeof requestAnimationFrame === "function") {
        this.animRafId = requestAnimationFrame(step);
      } else {
        this.animRafId = setTimeout(step, 16);
      }
    }

    tickAnimations() {
      const now = this.nowMs();
      const spanIds = Object.keys(this.animations);
      if (!spanIds.length) return;

      for (const spanId of spanIds) {
        const anim = this.animations[spanId];
        if (!anim) continue;
        const chart = this.charts[spanId];
        if (!chart) {
          this.cancelSpanAnimation(spanId);
          continue;
        }
        const ts = chart.timeScale();
        const dur = Math.max(1, anim.duration * (this.animationDurationScale || 1));
        const rawT = (now - anim.startTime) / dur;

        if (rawT >= 1) {
          delete this.animations[spanId];
          this.animatingSpans[spanId] = false;
          this.programmaticSpans[spanId] = true;
          try {
            if (anim.type === "logical") {
              ts.setVisibleLogicalRange({ from: anim.targetFrom, to: anim.targetTo });
            } else {
              ts.setVisibleRange({ from: anim.targetFrom, to: anim.targetTo });
            }
          } catch (_) {
          } finally {
            const finishSettle = () => {
              // Only finalize if no newer animation started on this span
              if (!this.animations[spanId] && !this.animatingSpans[spanId]) {
                this.programmaticSpans[spanId] = false;
                if (anim.onComplete) anim.onComplete();
                if (this.activeRangeHighlight?.readySpans?.[spanId]) {
                  this.updateRangeHighlight(spanId);
                }
              }
            };
            if (typeof requestAnimationFrame === "function") {
              requestAnimationFrame(finishSettle);
            } else {
              setTimeout(finishSettle, 0);
            }
          }
          continue;
        }

        const p = this.easeOutCubic(rawT);
        const c0 = (anim.startFrom + anim.startTo) / 2;
        const c1 = (anim.targetFrom + anim.targetTo) / 2;
        const w0 = Math.max(1e-6, anim.startTo - anim.startFrom);
        const w1 = Math.max(1e-6, anim.targetTo - anim.targetFrom);
        const center = c0 + (c1 - c0) * p;
        // Log-space zoom interpolation produces constant perceptual zoom speed
        const width = w0 * Math.pow(w1 / w0, p);
        const nextFrom = center - width / 2;
        const nextTo = center + width / 2;

        anim.currentFrom = nextFrom;
        anim.currentTo = nextTo;

        this.programmaticSpans[spanId] = true;
        try {
          if (anim.type === "logical") {
            ts.setVisibleLogicalRange({ from: nextFrom, to: nextTo });
          } else {
            ts.setVisibleRange({ from: Math.round(nextFrom), to: Math.round(nextTo) });
          }
        } catch (_) {
        } finally {
          this.programmaticSpans[spanId] = false;
        }

        if (this.activeRangeHighlight?.readySpans?.[spanId]) {
          this.updateRangeHighlight(spanId);
        }
      }

      if (Object.keys(this.animations).length > 0) {
        this.ensureAnimationLoop();
      }
    }

    animateLogicalRangeTo(spanId, targetFrom, targetTo, options = {}) {
      const chart = this.charts[spanId];
      if (!chart) return;
      const { duration = 340, immediate = false, onComplete = null } = options;

      if (
        typeof targetFrom !== "number" ||
        typeof targetTo !== "number" ||
        isNaN(targetFrom) ||
        isNaN(targetTo) ||
        targetTo <= targetFrom
      ) {
        if (onComplete) onComplete();
        return;
      }

      const ts = chart.timeScale();
      const curr = ts && typeof ts.getVisibleLogicalRange === "function" ? ts.getVisibleLogicalRange() : null;
      const scaledDuration = duration * (this.animationDurationScale || 1);

      const hasDelta = curr &&
        typeof curr.from === "number" &&
        typeof curr.to === "number" &&
        curr.to > curr.from &&
        (Math.abs(curr.from - targetFrom) > 0.05 || Math.abs(curr.to - targetTo) > 0.05);

      if (immediate || scaledDuration <= 0 || !curr || !hasDelta) {
        this.cancelSpanAnimation(spanId);
        this.programmaticSpans[spanId] = true;
        try {
          ts.setVisibleLogicalRange({ from: targetFrom, to: targetTo });
        } catch (_) {
        } finally {
          const finishImmediate = () => {
            if (!this.animations[spanId] && !this.animatingSpans[spanId]) {
              this.programmaticSpans[spanId] = false;
              if (onComplete) onComplete();
              if (this.activeRangeHighlight?.readySpans?.[spanId]) {
                this.updateRangeHighlight(spanId);
              }
            }
          };
          if (immediate) {
            this.programmaticSpans[spanId] = false;
            if (onComplete) onComplete();
          } else if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(finishImmediate);
          } else {
            setTimeout(finishImmediate, 0);
          }
        }
        return;
      }

      const existing = this.animations[spanId];
      if (
        existing &&
        existing.type === "logical" &&
        Math.abs(existing.targetFrom - targetFrom) < 0.05 &&
        Math.abs(existing.targetTo - targetTo) < 0.05
      ) {
        if (onComplete) {
          const prevCb = existing.onComplete;
          existing.onComplete = () => {
            if (prevCb) prevCb();
            onComplete();
          };
        }
        return;
      }

      const startFrom = existing && existing.currentFrom !== undefined ? existing.currentFrom : curr.from;
      const startTo = existing && existing.currentTo !== undefined ? existing.currentTo : curr.to;

      this.animatingSpans[spanId] = true;
      this.animations[spanId] = {
        type: "logical",
        startFrom,
        startTo,
        currentFrom: startFrom,
        currentTo: startTo,
        targetFrom,
        targetTo,
        startTime: this.nowMs(),
        duration,
        onComplete,
      };
      this.ensureAnimationLoop();
    }

    animateTimeRangeTo(spanId, targetFrom, targetTo, options = {}) {
      const chart = this.charts[spanId];
      if (!chart) return;
      const { duration = 150, immediate = false, onComplete = null } = options;

      if (
        typeof targetFrom !== "number" ||
        typeof targetTo !== "number" ||
        isNaN(targetFrom) ||
        isNaN(targetTo) ||
        targetTo <= targetFrom
      ) {
        if (onComplete) onComplete();
        return;
      }

      const ts = chart.timeScale();
      const curr = ts && typeof ts.getVisibleRange === "function" ? ts.getVisibleRange() : null;
      const scaledDuration = duration * (this.animationDurationScale || 1);

      const hasDelta = curr &&
        typeof curr.from === "number" &&
        typeof curr.to === "number" &&
        curr.to > curr.from &&
        (Math.abs(curr.from - targetFrom) > 0.5 || Math.abs(curr.to - targetTo) > 0.5);

      if (immediate || scaledDuration <= 0 || !curr || !hasDelta) {
        this.cancelSpanAnimation(spanId);
        this.programmaticSpans[spanId] = true;
        try {
          ts.setVisibleRange({ from: targetFrom, to: targetTo });
        } catch (_) {
        } finally {
          this.programmaticSpans[spanId] = false;
          if (onComplete) onComplete();
        }
        return;
      }

      const existing = this.animations[spanId];
      if (
        existing &&
        existing.type === "time" &&
        Math.abs(existing.targetFrom - targetFrom) < 0.5 &&
        Math.abs(existing.targetTo - targetTo) < 0.5
      ) {
        if (onComplete) {
          const prevCb = existing.onComplete;
          existing.onComplete = () => {
            if (prevCb) prevCb();
            onComplete();
          };
        }
        return;
      }

      const startFrom = existing && existing.currentFrom !== undefined ? existing.currentFrom : curr.from;
      const startTo = existing && existing.currentTo !== undefined ? existing.currentTo : curr.to;

      this.animatingSpans[spanId] = true;
      this.animations[spanId] = {
        type: "time",
        startFrom,
        startTo,
        currentFrom: startFrom,
        currentTo: startTo,
        targetFrom,
        targetTo,
        startTime: this.nowMs(),
        duration,
        onComplete,
      };
      this.ensureAnimationLoop();
    }

    // =========================================================================
    // SYNCHRONIZED PANNING & ZOOMING ENGINE
    // =========================================================================

    handleRangeChange(sourceSpan, range) {
      if (
        !this.syncEnabled ||
        this.isSyncing ||
        this.isLogicalSyncing ||
        this.programmaticSpans[sourceSpan] ||
        this.animatingSpans[sourceSpan]
      ) {
        return;
      }
      if (this.syncMode !== "range") return;
      if (!range || !range.from || !range.to || range.from >= range.to) return;

      const prevRange = this.lastVisibleRange[sourceSpan];
      this.lastVisibleRange[sourceSpan] = { ...range };

      const centerTime = (range.from + range.to) / 2;

      SPANS.forEach((s) => {
        if (s.id === sourceSpan) return;
        const targetChart = this.charts[s.id];
        if (!targetChart) return;

        if (this.syncMode === "range") {
          // Strict Time Window Mode with continuous animation
          this.animateTimeRangeTo(s.id, range.from, range.to, { duration: 140 });
        } else {
          // Anchor Mode: Keep optimal resolution, sync center timestamp without changing target zoom
          const targetRange = targetChart.timeScale().getVisibleRange();
          if (targetRange && targetRange.to > targetRange.from) {
            const targetDuration = targetRange.to - targetRange.from;
            const targetFrom = Math.round(centerTime - targetDuration / 2);
            const targetTo = Math.round(centerTime + targetDuration / 2);
            this.animateTimeRangeTo(s.id, targetFrom, targetTo, { duration: 140 });
          }
        }
      });
    }

    // =========================================================================
    // LOGICAL RANGE / ZOOM (INDEPENDENT PER CHART)
    // =========================================================================

    handleLogicalRangeChange(sourceSpan, logicalRange) {
      // Zoom sync removed: each chart maintains independent zoom level
      return;
    }

    setSyncedCandleCount(count) {
      // No-op when zoom sync is disabled
      return;
    }

    updateCandleCountBadge(count) {
      // No-op when zoom sync is disabled
      return;
    }

    // =========================================================================
    // SYNCHRONIZED CROSSHAIR & MULTI-SPAN HUD
    // =========================================================================

    applySpanCrosshairState(spanId, targetTime, options = {}) {
      const { updateHudVal = false } = options;
      const chart = this.charts[spanId];
      const series = this.series[spanId];
      const macdChart = this.macdCharts[spanId];
      const macdHist = this.macdHist[spanId];
      const cardOhlc = document.getElementById(`msCardOhlc_${spanId}`);
      const cardTime = document.getElementById(`msCardTime_${spanId}`);
      const valEl = document.getElementById(`msHudVal_${spanId}`);

      const candle = this.findCandleAtOrBefore(spanId, targetTime);
      const syncTime = candle ? candle.time : targetTime;

      if (candle) {
        const closeP = formatPrice(candle.close);
        if (updateHudVal && valEl) valEl.textContent = closeP;
        if (cardOhlc) {
          cardOhlc.textContent = `O:${formatPrice(candle.open)} H:${formatPrice(candle.high)} L:${formatPrice(candle.low)} C:${closeP}`;
        }
        if (cardTime) {
          cardTime.textContent = formatKstShort(candle.time, spanId);
        }
      }

      const macdPoint = this.findMacdAtOrBefore(spanId, targetTime);
      if (macdPoint) {
        this.updateMacdLegend(spanId, macdPoint.macd, macdPoint.signal, macdPoint.hist ?? macdPoint.histogram, macdPoint.signal_diff, macdPoint.signal_diff2, macdPoint.hist_diff);
      } else {
        this.updateMacdLegend(spanId, null, null, null);
      }

      if (this.reloadingSpans[spanId]) return { candle, macdPoint };

      this._syncingCardCrosshair = true;
      try {
        if (chart && series && candle) {
          try {
            chart.setCrosshairPosition(candle.close, candle.time, series);
          } catch (_) {}
        }
        if (macdChart && macdHist) {
          try {
            if (macdPoint) {
              macdChart.setCrosshairPosition(macdPoint.hist ?? macdPoint.histogram ?? 0, syncTime, macdHist);
            } else if (typeof macdChart.clearCrosshairPosition === "function") {
              macdChart.clearCrosshairPosition();
            }
          } catch (_) {}
        }
      } finally {
        this._syncingCardCrosshair = false;
      }

      return { candle, macdPoint };
    }

    handleCrosshairMove(sourceSpan, param, origin = "main") {
      if (this._syncingCardCrosshair) return;
      const cardOhlc = document.getElementById(`msCardOhlc_${sourceSpan}`);
      const cardTime = document.getElementById(`msCardTime_${sourceSpan}`);
      const series = this.series[sourceSpan];
      const chart = this.charts[sourceSpan];
      const macdChart = this.macdCharts[sourceSpan];
      const macdHist = this.macdHist[sourceSpan];

      // Hover is purely separate and local for all charts (including 1s): never broadcast to other charts!
      if (!param || !param.time) {
        // Mouse left this chart: restore to pinned clicked candle if active, otherwise latest candle
        if (this.pinnedTime !== null) {
          this.applySpanCrosshairState(sourceSpan, this.pinnedTime, { updateHudVal: false });
        } else {
          // No pinned candle: restore to latest loaded candle
          const list = this.candlesData[sourceSpan] || [];
          if (list.length) {
            const latest = list[list.length - 1];
            if (cardOhlc) {
              cardOhlc.textContent = `O:${formatPrice(latest.open)} H:${formatPrice(latest.high)} L:${formatPrice(latest.low)} C:${formatPrice(latest.close)}`;
            }
            if (cardTime) {
              cardTime.textContent = formatKstShort(latest.time, sourceSpan);
            }
          }
          if (chart) {
            try {
              chart.clearCrosshairPosition();
            } catch (_) {}
          }
          if (macdChart) {
            try {
              macdChart.clearCrosshairPosition();
            } catch (_) {}
          }
          const macdList = this.macdData[sourceSpan]?.macd || [];
          if (macdList.length) {
            const lastM = macdList[macdList.length - 1];
            const sigList = this.macdData[sourceSpan]?.signal || [];
            const lastS = sigList.length ? sigList[sigList.length - 1] : null;
            const histList = this.macdData[sourceSpan]?.histogram || [];
            const lastH = histList.length ? histList[histList.length - 1] : null;
            const lastPt = this.findMacdAtOrBefore(sourceSpan, latest.time);
            this.updateMacdLegend(sourceSpan, lastPt?.macd ?? lastM?.value, lastPt?.signal ?? lastS?.value, lastPt?.hist ?? lastH?.value, lastPt?.signal_diff, lastPt?.signal_diff2, lastPt?.hist_diff);
          }
        }
        return;
      }

      // Cursor over a candle on sourceSpan: show this candle's OHLC and MACD locally only
      const hoveredCandle = (param.seriesData?.get(series)) || this.findCandleAtOrBefore(sourceSpan, param.time);
      if (hoveredCandle) {
        if (cardOhlc) {
          cardOhlc.textContent = `O:${formatPrice(hoveredCandle.open)} H:${formatPrice(hoveredCandle.high)} L:${formatPrice(hoveredCandle.low)} C:${formatPrice(hoveredCandle.close)}`;
        }
        if (cardTime) {
          cardTime.textContent = formatKstShort(hoveredCandle.time, sourceSpan);
        }
      }

      const hoveredMacd = this.findMacdAtOrBefore(sourceSpan, param.time);
      if (hoveredMacd) {
        this.updateMacdLegend(sourceSpan, hoveredMacd.macd, hoveredMacd.signal, hoveredMacd.hist ?? hoveredMacd.histogram, hoveredMacd.signal_diff, hoveredMacd.signal_diff2, hoveredMacd.hist_diff);
      }

      // Synchronize vertical crosshair line between price chart and MACD chart within this card
      this._syncingCardCrosshair = true;
      try {
        if (origin === "main") {
          if (macdChart && macdHist && hoveredMacd) {
            macdChart.setCrosshairPosition(hoveredMacd.hist ?? hoveredMacd.histogram ?? 0, param.time, macdHist);
          }
        } else if (origin === "macd") {
          if (chart && series && hoveredCandle) {
            chart.setCrosshairPosition(hoveredCandle.close, param.time, series);
          }
        }
      } catch (_) {
      } finally {
        this._syncingCardCrosshair = false;
      }
    }

    handleChartClick(sourceSpan, param) {
      if (!param || !param.time) return;

      this.pinnedTime = param.time;
      this.pinnedSpan = sourceSpan;

      if (sourceSpan === "1s") {
        this.activeNavId += 1;
        this.activeRangeHighlight = null;
        this.updateAllRangeHighlights();
        this.broadcastTimePoint(param.time, sourceSpan, false);
      } else {
        // Click on coarser charts broadcasts time point, updates HUD, aligns crosshairs, and frames narrower charts
        this.broadcastTimePoint(param.time, sourceSpan, true);
      }
    }

    getLogicalIndexForTime(spanId, time) {
      const data = this.candlesData[spanId];
      if (!data || !data.length) return null;
      const spanObj = SPANS.find((p) => p.id === spanId);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;
      const idx = this.findCandleIndexAtOrBefore(spanId, time);
      if (idx === -1) {
        return (time - data[0].time) / spanSec;
      }
      if (idx === data.length - 1) {
        return idx + (time - data[idx].time) / spanSec;
      }
      const t0 = data[idx].time;
      const t1 = data[idx + 1].time;
      const dt = t1 - t0;
      return idx + (dt > 0 ? (time - t0) / dt : 0);
    }

    computeDrilldownLogicalRange(spanId, startTime, endTime, options = {}) {
      const { isPartialSlice = false } = options;
      const data = this.candlesData[spanId];
      if (!data || !data.length) return null;
      const lStart = this.getLogicalIndexForTime(spanId, startTime);
      const lEnd = this.getLogicalIndexForTime(spanId, endTime);
      if (lStart === null || lEnd === null) return null;

      const spanObj = SPANS.find((p) => p.id === spanId);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;
      const estSpanBars = (endTime - startTime) / spanSec;

      if (isPartialSlice || estSpanBars > MAX_FULL_DRILLDOWN_BARS) {
        const visBars = Math.min(PARTIAL_SLICE_VISIBLE_BARS, Math.max(100, data.length + 6));
        const clampedStart = Math.max(-0.5, lStart - 0.5);
        const padLeft = Math.round(visBars * 0.1);
        let from = clampedStart - padLeft;
        let to = from + visBars;
        if (data.length >= visBars) {
          const minLeft = -0.5 - 6;
          const maxRight = data.length - 0.5 + 6;
          if (to > maxRight) {
            to = maxRight;
            from = to - visBars;
          }
          if (from < minLeft) {
            from = minLeft;
            to = from + visBars;
          }
        }
        return { from, to };
      }

      // Visual bounds enclose whole candle bodies cleanly: [lStart - 0.5, lEnd - 0.5]
      const vStart = lStart - 0.5;
      const vEnd = Math.max(vStart + 1, lEnd - 0.5);
      const rangeBars = Math.max(1, vEnd - vStart);

      // Range occupies exactly 80% of the visible chart width, centered:
      // targetBars = rangeBars / 0.80 = rangeBars * 1.25 (10% left margin, 80% range, 10% right margin)
      const targetBars = rangeBars * 1.25;
      const center = (vStart + vEnd) / 2;
      const from = center - targetBars / 2;
      const to = center + targetBars / 2;

      return { from, to };
    }

    broadcastTimePoint(time, sourceSpan = null, recenterNarrower = false) {
      if (!time) return;
      const timeStr = formatKst(time);
      const hudTime = document.getElementById("msHudTime");
      if (hudTime) hudTime.textContent = timeStr;

      // Source index to determine which charts are narrower
      const sourceIdx = sourceSpan ? SPANS.findIndex((p) => p.id === sourceSpan) : -1;
      const sourceSpanObj = sourceIdx >= 0 ? SPANS[sourceIdx] : null;
      const shouldRecenter = recenterNarrower && sourceIdx > 0;

      // Calculate target range if clicked on a coarser chart
      let targetRangeStart = time;
      let targetRangeEnd = time;
      let navId = this.activeNavId || 0;

      if (shouldRecenter && sourceSpanObj) {
        navId = ++this.activeNavId;
        const sourceCandle = this.findCandleAtOrBefore(sourceSpan, time);
        if (sourceCandle) {
          targetRangeStart = sourceCandle.time;
          targetRangeEnd = sourceCandle.time + (sourceSpanObj.sec || 60);
          const finerSpans = SPANS.slice(0, sourceIdx).map((p) => p.id);
          // Initialize highlight with empty readySpans so highlights stay hidden until zoom & pan complete cleanly
          this.activeRangeHighlight = {
            navId,
            sourceSpan,
            sourceLabel: sourceSpanObj.label,
            sourceColor: sourceSpanObj.color,
            startTime: targetRangeStart,
            endTime: targetRangeEnd,
            finerSpans,
            readySpans: {},
            sliceSpans: {},
          };
          this.updateAllRangeHighlights();
        }
      }

      const nowSec = Math.floor(Date.now() / 1000);

      // Update crosshairs, HUD & smoothly pan/zoom narrower charts
      SPANS.forEach((s, idx) => {
        const chart = this.charts[s.id];
        this.applySpanCrosshairState(s.id, time, { updateHudVal: true });

        // Drill-down: if clicking a coarser chart, pan/zoom or reload narrower charts first BEFORE revealing highlight
        if (shouldRecenter && chart && idx < sourceIdx) {
          this.spanNavIds[s.id] = navId;
          const data = this.candlesData[s.id] || [];
          const spanSec = s.sec || 60;
          const hasData = data.length > 0;
          const effectiveEnd = Math.min(targetRangeEnd, nowSec - Math.max(spanSec * 2, 10));
          const fullRangeBarsEst = Math.max(0, effectiveEnd - targetRangeStart) / spanSec;
          const isLiveTodayForming = targetRangeEnd > (nowSec - Math.max(spanSec * 2, 10));
          const isWideLiveWindow = isLiveTodayForming && fullRangeBarsEst > MAX_FULL_DRILLDOWN_BARS;

          const markReadyOnSettle = () => {
            this.applySpanCrosshairState(s.id, time, { updateHudVal: false });
            if (
              this.activeRangeHighlight &&
              this.activeRangeHighlight.navId === navId &&
              this.activeRangeHighlight.finerSpans?.includes(s.id)
            ) {
              if (!this.activeRangeHighlight.readySpans) this.activeRangeHighlight.readySpans = {};
              this.activeRangeHighlight.readySpans[s.id] = true;
              this.updateRangeHighlight(s.id);
            }
          };

          if (isWideLiveWindow) {
            // Clicked today's wide candle (e.g. 1d -> 1s mid-day): keep finer chart live instead of rewinding/freezing
            const hasLiveTail =
              hasData &&
              !this.isHistorical[s.id] &&
              (nowSec - data[data.length - 1].time) <= Math.max(spanSec * 30, 120);
            if (hasLiveTail) {
              this.fetchSeq[s.id] = (this.fetchSeq[s.id] || 0) + 1;
              this.reloadingSpans[s.id] = false;
              if (this.rangeReloadingSpans) this.rangeReloadingSpans[s.id] = false;
              if (this.activeRangeHighlight?.navId === navId) {
                if (!this.activeRangeHighlight.sliceSpans) this.activeRangeHighlight.sliceSpans = {};
                this.activeRangeHighlight.sliceSpans[s.id] = "live";
              }
              const tailBars = Math.min(PARTIAL_SLICE_VISIBLE_BARS, Math.max(100, data.length + 6));
              const to = data.length - 0.5 + 6;
              const from = to - tailBars;
              this.animateLogicalRangeTo(s.id, from, to, { duration: 360, onComplete: markReadyOnSettle });
            } else {
              this.reloadSpanToRange(
                s.id,
                Math.max(targetRangeStart, nowSec - PARTIAL_SLICE_CANDLES * spanSec),
                nowSec,
                navId,
                { liveTail: true }
              );
            }
            return;
          }

          if (fullRangeBarsEst > MAX_FULL_DRILLDOWN_BARS) {
            const minSliceEnd = targetRangeStart + PARTIAL_SLICE_CANDLES * 0.7 * spanSec;
            const hasSliceAlready =
              hasData &&
              data[0].time <= targetRangeStart &&
              (data[data.length - 1].time + spanSec) >= Math.min(effectiveEnd, minSliceEnd);
            if (hasSliceAlready) {
              this.fetchSeq[s.id] = (this.fetchSeq[s.id] || 0) + 1;
              this.reloadingSpans[s.id] = false;
              if (this.rangeReloadingSpans) this.rangeReloadingSpans[s.id] = false;
              if (this.activeRangeHighlight?.navId === navId) {
                if (!this.activeRangeHighlight.sliceSpans) this.activeRangeHighlight.sliceSpans = {};
                this.activeRangeHighlight.sliceSpans[s.id] = "slice";
              }
              const sliceRange = this.computeDrilldownLogicalRange(s.id, targetRangeStart, targetRangeEnd, { isPartialSlice: true });
              if (sliceRange) {
                this.animateLogicalRangeTo(s.id, sliceRange.from, sliceRange.to, { duration: 360, onComplete: markReadyOnSettle });
              } else {
                markReadyOnSettle();
              }
            } else {
              this.reloadSpanToRange(s.id, targetRangeStart, targetRangeEnd, navId);
            }
            return;
          }

          const hasWholeRange =
            hasData &&
            data[0].time <= targetRangeStart &&
            (data[data.length - 1].time + spanSec) >= effectiveEnd;

          if (hasWholeRange) {
            // Invalidate any pending fetch sequence on this span
            this.fetchSeq[s.id] = (this.fetchSeq[s.id] || 0) + 1;
            this.reloadingSpans[s.id] = false;
            if (this.rangeReloadingSpans) this.rangeReloadingSpans[s.id] = false;
            const targetRange = this.computeDrilldownLogicalRange(s.id, targetRangeStart, targetRangeEnd);
            if (targetRange) {
              this.animateLogicalRangeTo(s.id, targetRange.from, targetRange.to, {
                duration: 360,
                onComplete: markReadyOnSettle,
              });
            } else {
              markReadyOnSettle();
            }
          } else {
            // Not enough loaded to show the whole range: batch-fetch, animate to target range, then highlight
            this.reloadSpanToRange(s.id, targetRangeStart, targetRangeEnd, navId);
          }
        }
      });

      this.updateAllRangeHighlights();
    }

    updateRangeHighlight(spanId) {
      const highlightEl = document.getElementById(`msRangeHighlight_${spanId}`);
      const macdHighlightEl = document.getElementById(`msMacdRangeHighlight_${spanId}`);
      const badgeEl = document.getElementById(`msRangeBadge_${spanId}`);
      if (!highlightEl) return;

      const hideAll = () => {
        highlightEl.style.display = "none";
        if (macdHighlightEl) macdHighlightEl.style.display = "none";
      };

      const hl = this.activeRangeHighlight;
      if (
        !hl ||
        !hl.finerSpans ||
        !hl.finerSpans.includes(spanId) ||
        !hl.readySpans ||
        !hl.readySpans[spanId] ||
        this.rangeReloadingSpans?.[spanId]
      ) {
        hideAll();
        return;
      }

      const chart = this.charts[spanId];
      if (!chart) return;

      const data = this.candlesData[spanId] || [];
      if (!data.length) {
        hideAll();
        return;
      }

      const lStart = this.getLogicalIndexForTime(spanId, hl.startTime);
      const lEnd = this.getLogicalIndexForTime(spanId, hl.endTime);
      if (lStart === null || lEnd === null) {
        hideAll();
        return;
      }

      const vStart = lStart - 0.5;
      const vEnd = Math.max(vStart + 1, lEnd - 0.5);
      const color = hl.sourceColor || "#0284c7";

      const computeBoxForScale = (ts, fallbackWidth) => {
        if (!ts) return null;
        const chartWidth = (typeof ts.width === "function" && ts.width() > 0)
          ? ts.width()
          : fallbackWidth;
        const vis = typeof ts.getVisibleLogicalRange === "function" ? ts.getVisibleLogicalRange() : null;
        const resolveCoord = (logicalIdx) => {
          if (typeof ts.logicalToCoordinate === "function") {
            const baseIdx = Math.floor(logicalIdx);
            const frac = logicalIdx - baseIdx;
            const c0 = ts.logicalToCoordinate(baseIdx);
            const c1 = ts.logicalToCoordinate(baseIdx + 1);
            if (
              Number.isFinite(c0) &&
              Number.isFinite(c1) &&
              c1 !== c0
            ) {
              return c0 + frac * (c1 - c0);
            }
          }
          if (vis && vis.to > vis.from) {
            return ((logicalIdx - vis.from) / (vis.to - vis.from)) * chartWidth;
          }
          return null;
        };

        const x1 = resolveCoord(vStart);
        const x2 = resolveCoord(vEnd);
        if (x1 === null || x2 === null) return null;
        const rawLeft = Math.min(x1, x2);
        const rawRight = Math.max(x1, x2);
        if (rawRight <= 0 || rawLeft >= chartWidth) return null;
        const leftPx = Math.max(0, rawLeft);
        const rightPx = Math.min(chartWidth, rawRight);
        const widthPx = rightPx - leftPx;
        if (widthPx <= 0) return null;
        return { leftPx, widthPx, rawLeft, rawRight, chartWidth };
      };

      const host = document.getElementById(`msChartHost_${spanId}`);
      const mainBox = computeBoxForScale(chart.timeScale?.(), Math.max(10, (host ? host.clientWidth : 500) - 74));
      if (!mainBox) {
        hideAll();
        return;
      }

      const paintBox = (el, box) => {
        el.style.display = "block";
        el.style.left = `${box.leftPx}px`;
        el.style.width = `${box.widthPx}px`;
        el.style.background = hexToRgba(hl.sourceColor, 0.12);
        el.style.borderLeft = box.rawLeft >= -1 ? `2px dashed ${color}` : "none";
        el.style.borderRight = box.rawRight <= box.chartWidth + 1 ? `2px dashed ${color}` : "none";
      };

      paintBox(highlightEl, mainBox);

      if (macdHighlightEl) {
        const macdChart = this.macdCharts[spanId];
        const macdHost = document.getElementById(`msMacdHost_${spanId}`);
        const macdBox = macdChart && typeof macdChart.timeScale === "function"
          ? computeBoxForScale(macdChart.timeScale(), Math.max(10, (macdHost ? macdHost.clientWidth : 500) - 74))
          : null;
        paintBox(macdHighlightEl, macdBox || mainBox);
      }

      if (badgeEl) {
        const spanObj = SPANS.find((s) => s.id === spanId);
        const spanSec = spanObj ? spanObj.sec : 60;
        const nowSec = Math.floor(Date.now() / 1000);
        const targetCoveredEnd = Math.min(hl.endTime, nowSec - Math.max(spanSec * 2, 10));
        const coversWholeRange =
          data.length > 0 &&
          data[0].time <= hl.startTime &&
          (data[data.length - 1].time + spanSec) >= targetCoveredEnd;
        const sliceKind = hl.sliceSpans?.[spanId];
        const suffix = coversWholeRange
          ? ""
          : sliceKind === "live"
            ? " (LIVE TAIL)"
            : sliceKind === "slice"
              ? " (30M SLICE)"
              : "";
        badgeEl.style.background = color;
        badgeEl.textContent = `${hl.sourceLabel} RANGE${suffix}`;
      }
    }

    updateAllRangeHighlights() {
      SPANS.forEach((s) => {
        this.updateRangeHighlight(s.id);
      });
    }

    async reloadSpanToRange(spanId, startTime, endTime, navId = null, options = {}) {
      const spanObj = SPANS.find((p) => p.id === spanId);
      if (!spanObj) return;
      const chart = this.charts[spanId];
      if (!chart) return;

      const reqNavId = navId !== null ? navId : (this.spanNavIds[spanId] || 0);
      if (this.loadMoreTimeout?.[spanId]) {
        clearTimeout(this.loadMoreTimeout[spanId]);
        this.loadMoreTimeout[spanId] = null;
      }
      if (this.noOlderBefore) delete this.noOlderBefore[spanId];
      if (this.noNewerBefore) delete this.noNewerBefore[spanId];
      const fetchSeq = (this.fetchSeq[spanId] || 0) + 1;
      this.fetchSeq[spanId] = fetchSeq;
      this.reloadingSpans[spanId] = true;
      if (!this.rangeReloadingSpans) this.rangeReloadingSpans = {};
      this.rangeReloadingSpans[spanId] = true;
      this.cancelSpanAnimation(spanId);

      // Keep highlights hidden cleanly until fetch + pan/zoom complete
      const hlEl = document.getElementById(`msRangeHighlight_${spanId}`);
      if (hlEl) hlEl.style.display = "none";
      const macdHlEl = document.getElementById(`msMacdRangeHighlight_${spanId}`);
      if (macdHlEl) macdHlEl.style.display = "none";

      this.syncCardHistoricalUI(spanId, { isHistorical: false });
      const badgeEl = document.getElementById(`msCardModeBadge_${spanId}`);
      if (badgeEl) {
        badgeEl.style.display = "inline-block";
        badgeEl.textContent = "⏳ RELOADING...";
        badgeEl.style.background = "#fef3c7";
        badgeEl.style.color = "#d97706";
        badgeEl.style.border = "1px solid #fde68a";
      }

      let oldTimeRange = null;
      try {
        oldTimeRange = chart.timeScale().getVisibleRange();
      } catch (_) {}

      try {
        const spanSec = spanObj.sec || 60;
        const nowSec = Math.floor(Date.now() / 1000);
        const effectiveRangeEnd = Math.min(endTime, nowSec);
        const rangeBarsEst = Math.max(0, effectiveRangeEnd - startTime) / spanSec;
        const isLiveTail = Boolean(options.liveTail);
        const isPartialSlice = !isLiveTail && rangeBarsEst > MAX_FULL_DRILLDOWN_BARS;

        let targetStart;
        let targetEnd;
        let maxBatches = 6;

        if (isLiveTail) {
          targetEnd = nowSec;
          targetStart = Math.max(0, nowSec - PARTIAL_SLICE_CANDLES * spanSec);
          maxBatches = 2;
        } else if (isPartialSlice) {
          // Wide coarser range (e.g. 1d -> 1s = 86,400 bars): load a focused 30m slice around startTime
          const leadPad = Math.round(PARTIAL_SLICE_CANDLES * 0.25) * spanSec;
          targetStart = Math.max(0, startTime - leadPad);
          targetEnd = Math.min(nowSec, targetStart + PARTIAL_SLICE_CANDLES * spanSec);
          maxBatches = 2;
        } else {
          const rangeSec = Math.max(spanSec * 20, effectiveRangeEnd - startTime);
          const desiredBuffer = Math.round(rangeSec * 0.15);
          const bufferSec = Math.max(spanSec * 30, Math.min(desiredBuffer, 600 * spanSec));

          targetStart = Math.max(0, startTime - bufferSec);
          targetEnd = Math.min(nowSec, endTime + bufferSec);

          // If range + buffer fits comfortably in 1 batch, fetch ~900 candles around it for rich context
          const minWindowSec = 900 * spanSec;
          if (targetEnd - targetStart < minWindowSec) {
            const mid = Math.round((startTime + effectiveRangeEnd) / 2);
            targetStart = Math.max(0, mid - Math.round(minWindowSec / 2));
            targetEnd = Math.min(nowSec, targetStart + minWindowSec);
          }

          const maxCandlesForSpan = MAX_FULL_DRILLDOWN_BARS + 800;
          if ((targetEnd - targetStart) / spanSec > maxCandlesForSpan) {
            targetEnd = Math.min(nowSec, targetStart + maxCandlesForSpan * spanSec);
          }
        }

        const isHistorical = !isLiveTail && targetEnd < (nowSec - Math.max(300, spanSec * 5));
        const raw = await this.fetchKlinesRange(this.symbol, spanId, targetStart, targetEnd, maxBatches);

        // Discard stale response if a newer click/reload superseded this fetch
        if (this.fetchSeq[spanId] !== fetchSeq) return;
        if (navId !== null && this.activeRangeHighlight && this.activeRangeHighlight.navId !== reqNavId) return;

        if (Array.isArray(raw) && raw.length) {
          this.isHistorical[spanId] = isHistorical;
          this.reloadingSpans[spanId] = false;
          if (this.rangeReloadingSpans) this.rangeReloadingSpans[spanId] = false;

          if (this.activeRangeHighlight && this.activeRangeHighlight.navId === reqNavId) {
            if (!this.activeRangeHighlight.sliceSpans) this.activeRangeHighlight.sliceSpans = {};
            if (isLiveTail) {
              this.activeRangeHighlight.sliceSpans[spanId] = "live";
            } else if (isPartialSlice) {
              this.activeRangeHighlight.sliceSpans[spanId] = "slice";
            }
          }

          const preferredTime = isLiveTail
            ? raw[raw.length - 1].time
            : (this.pinnedTime !== null
              ? Math.max(raw[0].time, Math.min(raw[raw.length - 1].time, this.pinnedTime))
              : Math.round((startTime + Math.min(targetEnd, effectiveRangeEnd)) / 2));

          const onAnimationDone = () => {
            this.applySpanCrosshairState(spanId, preferredTime, { updateHudVal: false });
            if (
              this.activeRangeHighlight &&
              this.activeRangeHighlight.navId === reqNavId &&
              this.activeRangeHighlight.finerSpans?.includes(spanId)
            ) {
              if (!this.activeRangeHighlight.readySpans) this.activeRangeHighlight.readySpans = {};
              this.activeRangeHighlight.readySpans[spanId] = true;
              this.updateRangeHighlight(spanId);
            }
          };

          const setOpts = {
            animate: true,
            oldTimeRange,
            onComplete: onAnimationDone,
          };
          if (isLiveTail) {
            setOpts.visibleBars = PARTIAL_SLICE_VISIBLE_BARS;
          } else {
            setOpts.drilldownStart = startTime;
            setOpts.drilldownEnd = endTime;
            setOpts.isPartialSlice = isPartialSlice;
          }

          this.setSpanData(spanId, raw, null, setOpts);
          this.applySpanCrosshairState(spanId, preferredTime, { updateHudVal: true });
          this.syncCardHistoricalUI(spanId, { isHistorical, isPartialSlice });
          this.scheduleAdjacentPrefetch(this.symbol, spanId, targetStart, targetEnd);
        } else {
          this.syncCardHistoricalUI(spanId, { isHistorical: false });
          if (badgeEl) {
            badgeEl.style.display = "inline-block";
            badgeEl.textContent = "⚠️ NO DATA";
            badgeEl.style.background = "#f1f5f9";
            badgeEl.style.color = "#64748b";
            badgeEl.style.border = "1px solid #cbd5e1";
            badgeEl.title = "No candles available for this timestamp range.";
          }
        }
      } catch (err) {
        console.error(`Failed to reload span ${spanId} to range [${startTime}, ${endTime}]:`, err);
      } finally {
        if (this.fetchSeq[spanId] === fetchSeq) {
          this.reloadingSpans[spanId] = false;
          if (this.rangeReloadingSpans) this.rangeReloadingSpans[spanId] = false;
        }
        this.updateRangeHighlight(spanId);
      }
    }

    syncCardHistoricalUI(spanId, options = {}) {
      const { isHistorical = Boolean(this.isHistorical?.[spanId]), isPartialSlice = false } = options;
      if (typeof document === "undefined") return;
      const badgeEl = document.getElementById(`msCardModeBadge_${spanId}`);
      if (badgeEl) {
        if (isHistorical) {
          badgeEl.style.display = "inline-block";
          badgeEl.textContent = isPartialSlice ? "⏮️ HISTORICAL · 30M SLICE" : "⏮️ HISTORICAL";
          badgeEl.style.background = "#fee2e2";
          badgeEl.style.color = "#dc2626";
          badgeEl.style.border = "1px solid #fca5a5";
          badgeEl.title = isPartialSlice
            ? "Showing focused 30m historical slice around clicked period. Pan right or use NEWER > to load forward, or click badge to return to latest."
            : "Viewing historical window. Pan right or use NEWER > to load forward, or click badge to return to latest.";
        } else {
          badgeEl.style.display = "none";
        }
      }
      if (typeof document.querySelector === "function") {
        const newerBtn = document.querySelector(`.msCardLoadNewerBtn[data-span="${spanId}"]`);
        if (newerBtn) {
          newerBtn.style.display = isHistorical ? "inline-block" : "none";
        }
      }
    }

    async reloadSpanToTime(spanId, time) {
      const spanObj = SPANS.find((p) => p.id === spanId);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;
      const halfSpan = spanSec * 250;
      return this.reloadSpanToRange(spanId, time - halfSpan, time + halfSpan);
    }

    async reloadSpanToLatest(spanId) {
      const s = SPANS.find((p) => p.id === spanId);
      if (!s) return;
      if (this.loadMoreTimeout?.[spanId]) {
        clearTimeout(this.loadMoreTimeout[spanId]);
        this.loadMoreTimeout[spanId] = null;
      }
      const fetchSeq = (this.fetchSeq[spanId] || 0) + 1;
      this.fetchSeq[spanId] = fetchSeq;
      this.reloadingSpans[spanId] = true;
      if (!this.rangeReloadingSpans) this.rangeReloadingSpans = {};
      this.rangeReloadingSpans[spanId] = true;
      this.cancelSpanAnimation(spanId);
      this.isHistorical[spanId] = false;
      if (this.noNewerBefore) delete this.noNewerBefore[spanId];
      if (this.noOlderBefore) delete this.noOlderBefore[spanId];
      this.syncCardHistoricalUI(spanId, { isHistorical: false });

      let oldTimeRange = null;
      try {
        oldTimeRange = this.charts[spanId]?.timeScale()?.getVisibleRange() || null;
      } catch (_) {}

      try {
        const raw = await this.fetchKlinesForSpan(this.symbol, spanId, s.defaultLimit);
        if (this.fetchSeq[spanId] !== fetchSeq) return;
        if (raw && raw.length) {
          this.setSpanData(spanId, raw, null, { animate: true, oldTimeRange });
        }
      } finally {
        if (this.fetchSeq[spanId] === fetchSeq) {
          this.reloadingSpans[spanId] = false;
          if (this.rangeReloadingSpans) this.rangeReloadingSpans[spanId] = false;
        }
        this.updateRangeHighlight(spanId);
      }
    }

    debouncedLoadMore(spanId, direction = "older") {
      if (!this.loadMoreTimeout) this.loadMoreTimeout = {};
      if (this.loadMoreTimeout[spanId]) clearTimeout(this.loadMoreTimeout[spanId]);
      this.loadMoreTimeout[spanId] = setTimeout(() => {
        this.loadMoreTimeout[spanId] = null;
        this.loadMoreSpanData(spanId, direction);
      }, 300);
    }

    async loadMoreHistorical(spanId) {
      return this.loadMoreSpanData(spanId, "older");
    }

    async loadMoreNewer(spanId) {
      return this.loadMoreSpanData(spanId, "newer");
    }

    async loadMoreSpanData(spanId, direction = "older") {
      const isNewer = direction === "newer";
      if (this.reloadingSpans[spanId]) return;
      const data = this.candlesData?.[spanId];
      if (!data || !data.length) return;

      if (this.loadMoreTimeout?.[spanId]) {
        clearTimeout(this.loadMoreTimeout[spanId]);
        this.loadMoreTimeout[spanId] = null;
      }

      const spanObj = SPANS.find((p) => p.id === spanId);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;
      const nowSec = Math.floor(Date.now() / 1000);
      const latestTime = data[data.length - 1].time;

      if (isNewer && !this.isHistorical?.[spanId] && (nowSec - latestTime) <= Math.max(spanSec * 5, 300)) {
        return;
      }

      const btnSelector = isNewer
        ? `.msCardLoadNewerBtn[data-span="${spanId}"]`
        : `.msCardLoadMoreBtn[data-span="${spanId}"]`;
      const idleBtnText = isNewer ? "NEWER >" : "+ LOAD MORE";
      const btn = typeof document !== "undefined" && typeof document.querySelector === "function"
        ? document.querySelector(btnSelector)
        : null;
      if (btn) btn.textContent = "⏳...";

      const reqSymbol = this.symbol;
      const reqSeq = this.fetchSeq?.[spanId] || 0;
      this.reloadingSpans[spanId] = true;
      this.cancelSpanAnimation(spanId, { runSettle: !this.rangeReloadingSpans?.[spanId] });
      try {
        let raw;
        let additions;
        const existingTimes = new Set(data.map((c) => c.time));

        if (!isNewer) {
          const earliestTime = data[0].time;
          const cachedOlder = this.candleCache?.getCandlesEndingAt(reqSymbol, spanId, 1000, earliestTime - 1);
          if (cachedOlder && cachedOlder.length) {
            raw = cachedOlder;
          } else {
            raw = await this.fetchKlinesForSpan(reqSymbol, spanId, 1000, earliestTime * 1000 - 1);
          }
          if (this.symbol !== reqSymbol || (this.fetchSeq?.[spanId] || 0) !== reqSeq) return;
          additions = Array.isArray(raw)
            ? raw.filter((c) => c.time < earliestTime && !existingTimes.has(c.time))
            : [];
          if (!additions.length) {
            if (!this.noOlderBefore) this.noOlderBefore = {};
            this.noOlderBefore[spanId] = Date.now() + 4000;
            return;
          }
          if (this.noOlderBefore) delete this.noOlderBefore[spanId];
          const newEarliest = Math.min(...additions.map((c) => c.time));
          this.scheduleAdjacentPrefetch(reqSymbol, spanId, newEarliest, data[data.length - 1].time);
        } else {
          const stepSec = 950 * spanSec;
          const targetEndSec = latestTime + stepSec;
          const nearLive = targetEndSec >= nowSec - Math.max(spanSec * 2, 30);
          const cachedNewer = this.candleCache?.getRange(reqSymbol, spanId, latestTime + 1, targetEndSec);
          if (cachedNewer && cachedNewer.length) {
            raw = cachedNewer;
          } else {
            raw = await this.fetchKlinesForSpan(
              reqSymbol,
              spanId,
              1000,
              nearLive ? null : targetEndSec * 1000
            );
          }
          if (this.symbol !== reqSymbol || (this.fetchSeq?.[spanId] || 0) !== reqSeq) return;
          additions = Array.isArray(raw)
            ? raw.filter((c) => c.time > latestTime && !existingTimes.has(c.time))
            : [];

          // Bridge rare exchange maintenance gaps larger than one forward window
          if (!additions.length && !nearLive && targetEndSec < nowSec - spanSec) {
            const probeEndSec = latestTime + 4000 * spanSec;
            const probeNearLive = probeEndSec >= nowSec - Math.max(spanSec * 2, 30);
            raw = await this.fetchKlinesForSpan(
              reqSymbol,
              spanId,
              1000,
              probeNearLive ? null : probeEndSec * 1000
            );
            if (this.symbol !== reqSymbol || (this.fetchSeq?.[spanId] || 0) !== reqSeq) return;
            additions = Array.isArray(raw)
              ? raw.filter((c) => c.time > latestTime && !existingTimes.has(c.time))
              : [];
          }

          if (additions.length && !nearLive) {
            const newLatest = Math.max(...additions.map((c) => c.time));
            this.scheduleAdjacentPrefetch(reqSymbol, spanId, data[0].time, newLatest);
          }

          const refreshNowSec = Math.floor(Date.now() / 1000);
          if (!additions.length) {
            if (
              (nearLive && Array.isArray(raw) && raw.length) ||
              latestTime >= refreshNowSec - Math.max(spanSec * 5, 300)
            ) {
              this.isHistorical[spanId] = false;
              this.syncCardHistoricalUI(spanId, { isHistorical: false });
            } else {
              if (!this.noNewerBefore) this.noNewerBefore = {};
              this.noNewerBefore[spanId] = Date.now() + 4000;
            }
            return;
          }
          if (this.noNewerBefore) delete this.noNewerBefore[spanId];
        }

        const chart = this.charts?.[spanId];
        const prevLogical = chart ? chart.timeScale().getVisibleLogicalRange() : null;

        additions.sort((a, b) => a.time - b.time);
        let merged = isNewer ? [...data, ...additions] : [...additions, ...data];
        merged.sort((a, b) => a.time - b.time);
        const seenMerged = new Set();
        merged = merged.filter((c) => {
          if (seenMerged.has(c.time)) return false;
          seenMerged.add(c.time);
          return true;
        });

        const MAX_LOADED_BARS = 12000;
        let logicalShift = 0;
        let trimmedBack = false;
        if (!isNewer) {
          const prependedCount = merged.length - data.length;
          logicalShift = prependedCount;
          if (merged.length > MAX_LOADED_BARS) {
            const maxRightSafeTrim = prevLogical
              ? Math.max(0, Math.floor(merged.length - 1 - (prevLogical.to + prependedCount) - 30))
              : (merged.length - MAX_LOADED_BARS);
            const trimRight = Math.min(merged.length - MAX_LOADED_BARS, maxRightSafeTrim);
            if (trimRight > 0) {
              merged = merged.slice(0, merged.length - trimRight);
              trimmedBack = true;
            }
          }
        } else if (merged.length > MAX_LOADED_BARS) {
          const maxLeftSafeTrim = prevLogical
            ? Math.max(0, Math.floor(prevLogical.from) - 30)
            : (merged.length - MAX_LOADED_BARS);
          const trimFront = Math.min(merged.length - MAX_LOADED_BARS, maxLeftSafeTrim);
          if (trimFront > 0) {
            merged = merged.slice(trimFront);
            logicalShift = -trimFront;
          }
        }

        this.candlesData[spanId] = merged;

        this.programmaticSpans[spanId] = true;
        try {
          const series = this.series?.[spanId];
          if (series) series.setData(merged);

          const ma20Data = this.calculateSma(merged, 20);
          const ma50Data = this.calculateSma(merged, 50);
          if (this.ma20?.[spanId]) this.ma20[spanId].setData(ma20Data);
          if (this.ma50?.[spanId]) this.ma50[spanId].setData(ma50Data);
          this.updateMacdForSpan(spanId, merged, { updateLatestOnly: false });

          if (chart && prevLogical) {
            chart.timeScale().setVisibleLogicalRange({
              from: prevLogical.from + logicalShift,
              to: prevLogical.to + logicalShift,
            });
          }

          if (isNewer) {
            const refreshNowSec = Math.floor(Date.now() / 1000);
            const reachedLive = merged[merged.length - 1].time >= refreshNowSec - Math.max(spanSec * 5, 300);
            if (reachedLive) {
              this.isHistorical[spanId] = false;
              this.syncCardHistoricalUI(spanId, { isHistorical: false });
              if (this.pinnedTime === null) {
                this.applySpanCrosshairState(spanId, merged[merged.length - 1].time, { updateHudVal: true });
              }
            }
          } else if (trimmedBack) {
            this.isHistorical[spanId] = true;
            this.syncCardHistoricalUI(spanId, { isHistorical: true });
          }
        } finally {
          const settleLoadMore = () => {
            this.programmaticSpans[spanId] = false;
            if (this.pinnedTime !== null) {
              this.applySpanCrosshairState(spanId, this.pinnedTime, { updateHudVal: false });
            }
            this.updateRangeHighlight(spanId);
          };
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(settleLoadMore);
          } else {
            settleLoadMore();
          }
        }
      } catch (err) {
        console.error(`Failed to load ${direction} candles for span ${spanId}:`, err);
      } finally {
        if (this.fetchSeq?.[spanId] === reqSeq || this.symbol === reqSymbol) {
          this.reloadingSpans[spanId] = false;
        }
        if (btn) btn.textContent = idleBtnText;
        this.updateRangeHighlight(spanId);
      }
    }

    findCandleAtOrBefore(spanId, time) {
      const data = this.candlesData[spanId];
      if (!data || !data.length) return null;
      let low = 0;
      let high = data.length - 1;
      let best = null;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (data[mid].time <= time) {
          best = data[mid];
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return best || data[0];
    }

    findCandleIndexAtOrBefore(spanId, time) {
      const data = this.candlesData[spanId];
      if (!data || !data.length) return -1;
      let low = 0;
      let high = data.length - 1;
      let best = -1;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (data[mid].time <= time) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return best;
    }

    // =========================================================================
    // DATA FETCHING & WEBSOCKET STREAMING
    // =========================================================================

    async fetchInitialData() {
      const sym = this.symbol;
      if (this._initialRetryTimer) {
        clearTimeout(this._initialRetryTimer);
        this._initialRetryTimer = null;
      }
      const hudSym = document.getElementById("msHudSymbol");
      if (hudSym) hudSym.textContent = sym;

      try {
        const missingSpans = [];
        const promises = SPANS.map(async (s) => {
          const startedAt = Date.now();
          let raw = await this.fetchKlinesForSpan(sym, s.id, s.defaultLimit);
          if (sym !== this.symbol) return { span: s.id, data: [] };
          if (!Array.isArray(raw) || !raw.length) {
            if (Date.now() - startedAt < 5000) {
              raw = await this.fetchKlinesForSpan(sym, s.id, s.defaultLimit);
            }
          }
          if (sym === this.symbol && Array.isArray(raw) && raw.length) {
            this.setSpanData(s.id, raw);
          } else if (sym === this.symbol) {
            missingSpans.push(s);
          }
          return { span: s.id, data: raw };
        });

        await Promise.all(promises);
        if (sym !== this.symbol) return;

        this.loaded = true;
        const container = document.getElementById("tabContentMultiSpan");
        if (container) {
          container.classList.remove("mainTabLoading");
          container.setAttribute("aria-busy", "false");
        }

        this.startRealtimeFeeds();
        this.runMacdStrategyReplay();

        if (missingSpans.length) {
          const seqSnapshot = Object.fromEntries(
            missingSpans.map((s) => [s.id, this.fetchSeq?.[s.id] || 0])
          );
          this._initialRetryTimer = setTimeout(async () => {
            this._initialRetryTimer = null;
            if (this.symbol !== sym) return;
            await Promise.all(
              missingSpans.map(async (s) => {
                if (
                  this.symbol !== sym ||
                  (this.fetchSeq?.[s.id] || 0) !== seqSnapshot[s.id] ||
                  this.candlesData?.[s.id]?.length
                ) {
                  return;
                }
                const retryRaw = await this.fetchKlinesForSpan(sym, s.id, s.defaultLimit);
                if (
                  this.symbol === sym &&
                  (this.fetchSeq?.[s.id] || 0) === seqSnapshot[s.id] &&
                  Array.isArray(retryRaw) &&
                  retryRaw.length &&
                  !this.candlesData?.[s.id]?.length
                ) {
                  this.setSpanData(s.id, retryRaw);
                }
              })
            );
          }, 1200);
        }
      } catch (err) {
        console.error("MultiSpanTab fetch error:", err);
      }
    }

    async fetchKlinesForSpan(symbol, span, limit, endTime = null) {
      // Return immediately if historical chunk ending at endTime is already cached
      if (endTime && this.candleCache) {
        const cached = this.candleCache.getCandlesEndingAt(symbol, span, limit, Math.floor(Number(endTime) / 1000));
        if (cached && cached.length) {
          return cached;
        }
      }

      const is1s = span === "1s";
      const loc = typeof window !== "undefined" ? window.location : null;
      const pathname = loc && typeof loc.pathname === "string" ? loc.pathname : "";
      const origin = loc && typeof loc.origin === "string" && loc.origin !== "null" ? loc.origin : "";
      const proxyPath = pathname.startsWith("/skhynix") ? "/skhynix/api/klines" : "/api/klines";
      const endParam = endTime ? `&endTime=${endTime}` : "";
      const directUrl = is1s
        ? `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&limit=${limit}${endParam}`
        : `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${span}&limit=${limit}${endParam}`;
      const proxyUrl = origin
        ? `${origin}${proxyPath}?symbol=${symbol}&interval=${span}&limit=${limit}${is1s ? "&market=spot" : ""}${endParam}`
        : "";
      const fallbackUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(directUrl)}`;

      const parseRows = (rows) => {
        const parsed = rows.map((r) => ({
          time: Math.floor(Number(r[0]) / 1000),
          open: parseFloat(r[1]),
          high: parseFloat(r[2]),
          low: parseFloat(r[3]),
          close: parseFloat(r[4]),
          volume: parseFloat(r[5] || 0),
        })).sort((a, b) => a.time - b.time);
        if (parsed.length && this.candleCache) {
          this.candleCache.put(symbol, span, parsed);
        }
        return parsed;
      };

      const timeoutFor = (url) => (url === proxyUrl ? 15000 : 2500);

      const fetchUrl = async (url, timeoutMs, ctrl = null) => {
        if (!url || typeof fetch !== "function") throw new Error("fetch unavailable");
        const ownCtrl = ctrl || (typeof AbortController !== "undefined" ? new AbortController() : null);
        const timer = ownCtrl ? setTimeout(() => ownCtrl.abort(), timeoutMs) : null;
        try {
          const res = await fetch(url, ownCtrl ? { signal: ownCtrl.signal } : undefined);
          if (!res || !res.ok) throw new Error(`HTTP ${res?.status || 0}`);
          const rows = await res.json();
          if (!Array.isArray(rows)) throw new Error("Invalid klines payload");
          if (!rows.length) {
            if (!endTime) throw new Error("Empty latest klines payload");
            return [];
          }
          return parseRows(rows);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const now = Date.now();
      const directFirst = now >= (this.directFailUntil || 0);
      const primaryUrl = directFirst ? directUrl : (proxyUrl || directUrl);
      const secondaryUrl = directFirst ? proxyUrl : directUrl;
      const hedgeDelayMs = (directFirst && now < (this.proxySlowUntil || 0)) ? 2000 : 650;

      // Primary attempt with quick fallback hedge if primary is slow or fails immediately
      if (secondaryUrl && secondaryUrl !== primaryUrl) {
        const primaryCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const secondaryCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        let settled = false;
        let secondaryStarted = false;
        let primaryFailed = false;
        let hedgeTimer = null;
        let resolveSec;
        let rejectSec;
        const secondaryPromise = new Promise((res, rej) => {
          resolveSec = res;
          rejectSec = rej;
        });
        secondaryPromise.catch(() => {});

        const startSecondary = () => {
          if (secondaryStarted || settled) return;
          secondaryStarted = true;
          fetchUrl(secondaryUrl, timeoutFor(secondaryUrl), secondaryCtrl)
            .then((data) => resolveSec({ source: "secondary", data }))
            .catch(rejectSec);
        };

        try {
          const primaryPromise = fetchUrl(primaryUrl, timeoutFor(primaryUrl), primaryCtrl)
            .then((data) => ({ source: "primary", data }))
            .catch((err) => {
              primaryFailed = true;
              startSecondary();
              throw err;
            });

          hedgeTimer = setTimeout(startSecondary, hedgeDelayMs);

          const winner = await Promise.any([primaryPromise, secondaryPromise]);
          settled = true;
          if (hedgeTimer) clearTimeout(hedgeTimer);
          if (!secondaryStarted) rejectSec(new Error("primary won"));
          if (winner.source === "primary") {
            if (secondaryCtrl) secondaryCtrl.abort();
            if (!directFirst) this.proxySlowUntil = 0;
          } else {
            if (primaryCtrl) primaryCtrl.abort();
            if (directFirst) this.directFailUntil = Date.now() + 60000;
            else this.proxySlowUntil = Date.now() + 60000;
          }
          return winner.data;
        } catch (_) {
          settled = true;
          if (hedgeTimer) clearTimeout(hedgeTimer);
          if (!secondaryStarted) rejectSec(new Error("aborted"));
          if (primaryCtrl) primaryCtrl.abort();
          if (secondaryCtrl) secondaryCtrl.abort();
          if (directFirst && primaryFailed) {
            this.directFailUntil = Date.now() + 60000;
          }
          if (directFirst && !secondaryStarted && proxyUrl) {
            try {
              const proxyData = await fetchUrl(proxyUrl, timeoutFor(proxyUrl));
              this.directFailUntil = Date.now() + 60000;
              return proxyData;
            } catch (_) {}
          }
        }
      } else {
        try {
          return await fetchUrl(primaryUrl, timeoutFor(primaryUrl));
        } catch (_) {
          if (primaryUrl === directUrl) {
            this.directFailUntil = Date.now() + 60000;
            if (proxyUrl) {
              try {
                return await fetchUrl(proxyUrl, timeoutFor(proxyUrl));
              } catch (_) {}
            }
          }
        }
      }

      if (Date.now() < (this.fallbackFailUntil || 0)) {
        return [];
      }
      try {
        return await fetchUrl(fallbackUrl, 3500);
      } catch (_) {
        this.fallbackFailUntil = Date.now() + 120000;
        return [];
      }
    }

    async fetchKlinesRange(symbol, span, startTime, endTime, maxBatches = 6) {
      // 1. Instant cache hit: return immediately with 0 network latency if covered
      if (this.candleCache) {
        const cached = this.candleCache.getRange(symbol, span, startTime, endTime);
        if (cached && cached.length) {
          return cached;
        }
      }

      const spanObj = SPANS.find((p) => p.id === span);
      const spanSec = spanObj ? (spanObj.sec || 60) : 60;
      const allCandles = [];
      const seenTimes = new Set();

      const addBatch = (raw) => {
        if (!Array.isArray(raw) || !raw.length) return false;
        let addedAny = false;
        for (let i = raw.length - 1; i >= 0; i--) {
          const c = raw[i];
          if (!seenTimes.has(c.time)) {
            seenTimes.add(c.time);
            allCandles.push(c);
            addedAny = true;
          }
        }
        return addedAny;
      };

      const firstRaw = await this.fetchKlinesForSpan(symbol, span, 1000, endTime * 1000);
      const firstAdded = addBatch(firstRaw);
      if (!firstAdded || !firstRaw.length) {
        return [];
      }

      let earliestTime = firstRaw[0].time;
      let usedBatches = 1;

      if (earliestTime > startTime && usedBatches < maxBatches) {
        if (firstRaw.length >= 900) {
          const batchWidth = Math.max(spanSec, firstRaw[firstRaw.length - 1].time - earliestTime);
          const remainingSpan = earliestTime - startTime;
          const stepWidth = Math.max(spanSec * 980, batchWidth);
          const estRemaining = Math.min(maxBatches - usedBatches, Math.max(1, Math.ceil(remainingSpan / stepWidth)));

          const endMsList = [];
          for (let b = 0; b < estRemaining; b++) {
            endMsList.push((earliestTime - b * stepWidth) * 1000 - 1);
          }
          const batchResults = await Promise.all(
            endMsList.map((endMs) => this.fetchKlinesForSpan(symbol, span, 1000, endMs))
          );
          batchResults.forEach((raw) => addBatch(raw));
          usedBatches += estRemaining;
          allCandles.sort((a, b) => a.time - b.time);
          earliestTime = allCandles.length ? allCandles[0].time : earliestTime;
        }

        // Sequential loop for remainder or sparse/small mock responses
        while (earliestTime > startTime && usedBatches < maxBatches) {
          const extraRaw = await this.fetchKlinesForSpan(symbol, span, 1000, earliestTime * 1000 - 1);
          const addedExtra = addBatch(extraRaw);
          usedBatches += 1;
          if (!addedExtra || !extraRaw.length) break;
          allCandles.sort((a, b) => a.time - b.time);
          earliestTime = allCandles[0].time;
        }
      }

      allCandles.sort((a, b) => a.time - b.time);
      if (allCandles.length && this.candleCache) {
        this.candleCache.put(symbol, span, allCandles);
      }
      return allCandles;
    }

    /**
     * Background prefetcher for adjacent left (older) and right (newer) windows.
     * Keeps neighboring time slices warm in client-side RAM cache so panning left/right
     * or drilling into adjacent candles completes with 0ms delay.
     */
    scheduleAdjacentPrefetch(symbol, spanId, targetStart, targetEnd) {
      if (!symbol || !spanId || !this.candleCache) return;
      const spanObj = SPANS.find((p) => p.id === spanId);
      if (!spanObj) return;
      const spanSec = spanObj.sec || 60;
      const nowSec = Math.floor(Date.now() / 1000);

      if (this.prefetchTimers[spanId]) {
        clearTimeout(this.prefetchTimers[spanId]);
        this.prefetchTimers[spanId] = null;
      }

      this.prefetchTimers[spanId] = setTimeout(async () => {
        this.prefetchTimers[spanId] = null;
        if (this.symbol !== symbol) return;

        // Size the adjacent prefetch slice: at least 400 bars, up to 950 bars per side
        const windowSec = Math.max(spanSec * 400, Math.min(spanSec * 950, (targetEnd - targetStart)));

        // 1. Left (older) adjacent window: [targetStart - windowSec, targetStart]
        const leftStart = Math.max(0, targetStart - windowSec);
        const leftEnd = targetStart;
        if (leftStart < leftEnd && !this.candleCache.hasRange(symbol, spanId, leftStart, leftEnd)) {
          try {
            await this.fetchKlinesRange(symbol, spanId, leftStart, leftEnd, 2);
          } catch (_) {}
        }

        if (this.symbol !== symbol) return;

        // 2. Right (newer) adjacent window: [targetEnd, min(nowSec, targetEnd + windowSec)]
        const rightStart = targetEnd;
        const rightEnd = Math.min(nowSec, targetEnd + windowSec);
        if (rightStart < (rightEnd - spanSec) && !this.candleCache.hasRange(symbol, spanId, rightStart, rightEnd)) {
          try {
            await this.fetchKlinesRange(symbol, spanId, rightStart, rightEnd, 2);
          } catch (_) {}
        }
      }, 250);
    }

    updateMacdForSpan(spanId, candles, options = {}) {
      const { updateLatestOnly = false } = options;
      if (!Array.isArray(candles) || candles.length < 34) return null;

      const macdRes = this.calculateMacd(candles, 12, 26, 9);
      const sigByTime = new Map(macdRes.signal.map((p) => [p.time, p]));
      const histByTime = new Map(macdRes.histogram.map((p) => [p.time, p]));
      const byTime = new Map();
      for (const m of macdRes.macd) {
        const sPoint = sigByTime.get(m.time);
        const hPoint = histByTime.get(m.time);
        const hVal = hPoint ? hPoint.value : null;
        byTime.set(m.time, {
          time: m.time,
          macd: m.value,
          signal: sPoint ? sPoint.value : null,
          signal_diff: sPoint ? (sPoint.diff ?? null) : null,
          signal_diff2: sPoint ? (sPoint.diff2 ?? null) : null,
          hist: hVal,
          histogram: hVal,
          hist_diff: hPoint ? (hPoint.diff ?? null) : null,
        });
      }
      this.macdData[spanId] = { ...macdRes, byTime };

      const lastM = macdRes.macd[macdRes.macd.length - 1];
      const lastS = macdRes.signal[macdRes.signal.length - 1];
      const lastH = macdRes.histogram[macdRes.histogram.length - 1];
      const latestTime = candles[candles.length - 1].time;
      const lastPt = byTime.get(latestTime) || byTime.get(lastM?.time);

      if (updateLatestOnly) {
        if (this.macdHist[spanId] && lastH) this.macdHist[spanId].update(lastH);
        if (this.macdLine[spanId] && lastM) this.macdLine[spanId].update(lastM);
        if (this.macdSignal[spanId] && lastS) this.macdSignal[spanId].update(lastS);
        if (this.macdZero[spanId]) this.macdZero[spanId].update({ time: latestTime, value: 0 });
        if (this.pinnedTime === null) {
          this.updateMacdLegend(spanId, lastM?.value, lastS?.value, lastH?.value, lastPt?.signal_diff, lastPt?.signal_diff2, lastPt?.hist_diff);
        }
      } else {
        if (this.macdCharts[spanId] || this.macdHist[spanId] || this.macdLine[spanId] || this.macdSignal[spanId] || this.macdZero[spanId]) {
          if (this.macdHist[spanId]) this.macdHist[spanId].setData(macdRes.histogram);
          if (this.macdLine[spanId]) this.macdLine[spanId].setData(macdRes.macd);
          if (this.macdSignal[spanId]) this.macdSignal[spanId].setData(macdRes.signal);
          if (this.macdZero[spanId]) {
            this.macdZero[spanId].setData(candles.map((c) => ({ time: c.time, value: 0 })));
          }
          if (macdRes.macd.length && this.pinnedTime === null) {
            this.updateMacdLegend(spanId, lastM?.value, lastS?.value, lastH?.value, lastPt?.signal_diff, lastPt?.signal_diff2, lastPt?.hist_diff);
          }
        }
      }
      this.scheduleMacdStrategyReplay();
      return macdRes;
    }

    setSpanData(spanId, rawCandles, centerTime = null, options = {}) {
      if (!rawCandles || !rawCandles.length) return;
      // Deduplicate by time
      const clean = [];
      const seen = new Set();
      for (const c of rawCandles) {
        if (!seen.has(c.time)) {
          seen.add(c.time);
          clean.push(c);
        }
      }
      clean.sort((a, b) => a.time - b.time);
      this.candlesData[spanId] = clean;
      if (this.candleCache) {
        this.candleCache.put(this.symbol, spanId, clean);
      }

      if (this.loadMoreTimeout?.[spanId] && (options.animate || options.drilldownStart !== undefined)) {
        clearTimeout(this.loadMoreTimeout[spanId]);
        this.loadMoreTimeout[spanId] = null;
      }

      const series = this.series[spanId];
      const chart = this.charts[spanId];
      if (!this.programmaticSpans) this.programmaticSpans = {};
      const wasProgrammatic = Boolean(this.programmaticSpans[spanId]);
      this.programmaticSpans[spanId] = true;
      let from;
      let to;
      let shouldAnimate = false;
      try {
        if (series) series.setData(clean);

        // Compute simple moving averages (MA20 and MA50)
        const ma20Data = this.calculateSma(clean, 20);
        const ma50Data = this.calculateSma(clean, 50);
        if (this.ma20[spanId]) this.ma20[spanId].setData(ma20Data);
        if (this.ma50[spanId]) this.ma50[spanId].setData(ma50Data);

        // Compute MACD (12, 26, 9)
        this.updateMacdForSpan(spanId, clean, { updateLatestOnly: false });

        const latest = clean[clean.length - 1];
        if (latest) {
          const priceEl = document.getElementById(`msCardPrice_${spanId}`);
          const hudVal = document.getElementById(`msHudVal_${spanId}`);
          const cardOhlc = document.getElementById(`msCardOhlc_${spanId}`);
          const cardTime = document.getElementById(`msCardTime_${spanId}`);
          const pStr = formatPrice(latest.close);
          if (priceEl) priceEl.textContent = pStr;
          if (hudVal) hudVal.textContent = pStr;
          if (cardOhlc) {
            cardOhlc.textContent = `O:${formatPrice(latest.open)} H:${formatPrice(latest.high)} L:${formatPrice(latest.low)} C:${pStr}`;
          }
          if (cardTime && this.pinnedTime === null) {
            cardTime.textContent = formatKstShort(latest.time, spanId);
          }
          if (spanId === "1s" && this.pinnedTime === null) {
            const hudTime = document.getElementById("msHudTime");
            if (hudTime) hudTime.textContent = formatKst(latest.time);
          }
        }

        if (chart) {
          const count = options.visibleBars || 100;

          if (options.drilldownStart !== undefined && options.drilldownEnd !== undefined) {
            const drill = this.computeDrilldownLogicalRange(spanId, options.drilldownStart, options.drilldownEnd, {
              isPartialSlice: Boolean(options.isPartialSlice),
            });
            if (drill) {
              from = drill.from;
              to = drill.to;
            }
          }
          if (from === undefined && centerTime !== null) {
            const candleIdx = this.findCandleIndexAtOrBefore(spanId, centerTime);
            if (candleIdx !== -1) {
              from = Math.round(candleIdx - count / 2);
              to = from + count;
            }
          }
          if (from === undefined) {
            to = clean.length - 0.5 + 6;
            from = to - count;
          }

          shouldAnimate = Boolean(options.animate);
          if (shouldAnimate) {
            const ts = chart.timeScale();
            const oldTR = options.oldTimeRange;
            let entryFrom = null;
            let entryTo = null;
            if (oldTR && oldTR.from < oldTR.to && oldTR.to >= clean[0].time && oldTR.from <= clean[clean.length - 1].time) {
              const mFrom = this.getLogicalIndexForTime(spanId, oldTR.from);
              const mTo = this.getLogicalIndexForTime(spanId, oldTR.to);
              if (mFrom !== null && mTo !== null && mTo - mFrom >= 2) {
                entryFrom = mFrom;
                entryTo = mTo;
              }
            }
            if (entryFrom === null || entryTo === null) {
              const targetW = Math.max(1, to - from);
              const targetCenter = (from + to) / 2;
              const entryW = Math.max(1, Math.min(clean.length, targetW * 0.75));
              entryFrom = targetCenter - entryW / 2;
              entryTo = targetCenter + entryW / 2;
            }
            try {
              ts.setVisibleLogicalRange({ from: entryFrom, to: entryTo });
            } catch (_) {}
          }
        }
      } finally {
        this.programmaticSpans[spanId] = wasProgrammatic;
      }

      if (chart) {
        this.animateLogicalRangeTo(
          spanId,
          from,
          to,
          shouldAnimate
            ? { duration: 360, onComplete: options.onComplete || null }
            : { immediate: true, onComplete: options.onComplete || null }
        );
        this.lastVisibleRange[spanId] = chart.timeScale().getVisibleRange();
        this.updateRangeHighlight(spanId);
      }
    }

    calculateSma(data, period) {
      const res = [];
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        sum += data[i].close;
        if (i >= period) sum -= data[i - period].close;
        if (i >= period - 1) {
          res.push({ time: data[i].time, value: +(sum / period).toFixed(4) });
        }
      }
      return res;
    }

    calculateMacd(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
      if (!Array.isArray(data) || data.length < slowPeriod) {
        return { macd: [], signal: [], histogram: [] };
      }

      const calcEma = (period) => {
        const k = 2 / (period + 1);
        let ema = 0;
        for (let i = 0; i < period; i++) ema += data[i].close;
        ema /= period;
        const res = [{ time: data[period - 1].time, value: ema }];
        for (let i = period; i < data.length; i++) {
          ema = (data[i].close - ema) * k + ema;
          res.push({ time: data[i].time, value: ema });
        }
        return res;
      };

      const fastEma = calcEma(fastPeriod);
      const slowEma = calcEma(slowPeriod);

      const fastMap = new Map(fastEma.map((p) => [p.time, p.value]));
      const macdLine = [];
      for (const p of slowEma) {
        const fVal = fastMap.get(p.time);
        if (fVal !== undefined) {
          macdLine.push({ time: p.time, value: +(fVal - p.value).toFixed(4) });
        }
      }

      if (macdLine.length < signalPeriod) {
        return { macd: macdLine, signal: [], histogram: [] };
      }

      const sigK = 2 / (signalPeriod + 1);
      let sigEma = 0;
      for (let i = 0; i < signalPeriod; i++) sigEma += macdLine[i].value;
      sigEma /= signalPeriod;
      const signalLine = [{ time: macdLine[signalPeriod - 1].time, value: +sigEma.toFixed(4) }];
      for (let i = signalPeriod; i < macdLine.length; i++) {
        sigEma = (macdLine[i].value - sigEma) * sigK + sigEma;
        signalLine.push({ time: macdLine[i].time, value: +sigEma.toFixed(4) });
      }

      for (let i = 0; i < signalLine.length; i++) {
        const curr = signalLine[i].value;
        const prev = i >= 1 ? signalLine[i - 1].value : null;
        const prior = i >= 2 ? signalLine[i - 2].value : null;
        const diff = prev !== null ? +(curr - prev).toFixed(4) : null;
        const prevDiff = (prev !== null && prior !== null) ? +(prev - prior).toFixed(4) : null;
        const diff2 = (diff !== null && prevDiff !== null) ? +(diff - prevDiff).toFixed(4) : null;
        signalLine[i].diff = diff;
        signalLine[i].diff2 = diff2;
      }

      const sigMap = new Map(signalLine.map((p) => [p.time, p]));
      const histogram = [];
      for (const p of macdLine) {
        const sPoint = sigMap.get(p.time);
        if (sPoint !== undefined) {
          const diff = +(p.value - sPoint.value).toFixed(4);
          histogram.push({
            time: p.time,
            value: diff,
            color: diff >= 0 ? "rgba(5, 150, 105, 0.75)" : "rgba(220, 38, 38, 0.75)",
          });
        }
      }

      for (let i = 0; i < histogram.length; i++) {
        const curr = histogram[i].value;
        const prev = i >= 1 ? histogram[i - 1].value : null;
        histogram[i].diff = prev !== null ? +(curr - prev).toFixed(4) : null;
      }

      return { macd: macdLine, signal: signalLine, histogram };
    }

    macdStrategySettings() {
      const validSpans = new Set(SPANS.map((s) => s.id));
      const readNumber = (id, fallback, min, max) => {
        if (typeof document === "undefined") return fallback;
        const value = Number(document.getElementById(id)?.value);
        if (!Number.isFinite(value)) return fallback;
        return Math.max(min, Math.min(max, value));
      };
      const clockValue = typeof document !== "undefined"
        ? document.getElementById("msStrategyClock")?.value
        : "5m";

      const entryRules = [];
      const exitRules = [];
      const enabledSpansSet = new Set();

      if (typeof document !== "undefined" && typeof document.querySelectorAll === "function") {
        const toggles = [...document.querySelectorAll(".msStrategySpanToggle")];
        if (toggles.length) {
          toggles.forEach((input) => {
            const spanId = input.getAttribute("data-span");
            const ruleId = input.getAttribute("data-rule") || "macd_h";
            const kind = input.getAttribute("data-kind") || "entry";
            const row = input.closest(".condRow");
            const signBtn = row?.querySelector(".condSignToggle");
            const sign = signBtn?.getAttribute("data-sign")
              || (kind === "entry"
                ? (ruleId === "macd_h" || ruleId === "macd_s" ? "-" : "+")
                : (ruleId === "macd_h" || ruleId === "macd_s" ? "+" : "-"));
            if (input.checked && validSpans.has(spanId)) {
              enabledSpansSet.add(spanId);
              const item = { span: spanId, rule: ruleId, sign };
              if (kind === "entry") entryRules.push(item);
              else exitRules.push(item);
            }
          });
        }
      }

      if (!entryRules.length && !exitRules.length && enabledSpansSet.size === 0) {
        ["5m", "15m"].forEach((spanId) => {
          enabledSpansSet.add(spanId);
          entryRules.push({ span: spanId, rule: "macd_h", sign: "-" });
          exitRules.push({ span: spanId, rule: "macd_h", sign: "+" });
        });
      }

      return {
        strategy_mode: "all_macd_histogram_contrarian",
        clock_span: validSpans.has(clockValue) ? clockValue : "5m",
        enabled_spans: Array.from(enabledSpansSet),
        entry_rules: entryRules,
        exit_rules: exitRules,
        buy_threshold: readNumber("msStrategyBuyThreshold", 0, -1e9, 1e9),
        sell_threshold: readNumber("msStrategySellThreshold", 0, -1e9, 1e9),
        initial_capital: readNumber("msStrategyCapital", 10000, 1, 1e12),
        fee_bps: readNumber("msStrategyFeeBps", 5, 0, 1000),
      };
    }

    macdStrategyPreset(name) {
      if (name === "all") {
        return { clock_span: "1s", enabled_spans: SPANS.map((span) => span.id) };
      }
      if (name === "full_wave") {
        return { clock_span: "5m", enabled_spans: ["5m", "15m"] };
      }
      if (name === "all_full_wave") {
        return { clock_span: "1s", enabled_spans: SPANS.map((span) => span.id) };
      }
      return { clock_span: "5m", enabled_spans: ["5m", "15m"] };
    }

    applyMacdStrategyPreset(name) {
      if (typeof document === "undefined") return null;
      const preset = this.macdStrategyPreset(name);
      const clock = document.getElementById("msStrategyClock");
      if (clock && preset.clock_span) clock.value = preset.clock_span;
      const enabled = new Set(preset.enabled_spans);
      const isFullWave = name === "full_wave" || name === "all_full_wave";
      document.querySelectorAll(".msStrategySpanToggle").forEach((input) => {
        const spanId = input.getAttribute("data-span");
        const ruleId = input.getAttribute("data-rule") || "macd_h";
        if (isFullWave) {
          input.checked = enabled.has(spanId);
        } else {
          input.checked = enabled.has(spanId) && ruleId === "macd_h";
        }
      });
      return this.runMacdStrategyReplay();
    }

    updateMacdStrategyPresetButtons(settings) {
      if (typeof document === "undefined") return;
      const enabled = [...(settings?.enabled_spans || [])].sort().join(",");
      const hasFullWave = (settings?.entry_rules || []).some((r) => r.rule !== "macd_h");
      const setState = (id, active) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.setAttribute("aria-pressed", active ? "true" : "false");
        button.classList.toggle("isActive", active);
      };
      setState("msStrategyPresetQuick", !hasFullWave && settings?.clock_span === "5m" && enabled === "15m,5m");
      setState("msStrategyPresetAll", !hasFullWave && settings?.clock_span === "1s" && enabled === "15m,1d,1h,1s,5m");
      setState("msStrategyPresetFullWave", hasFullWave && settings?.clock_span === "5m" && enabled === "15m,5m");
      setState("msStrategyPresetAllFullWave", hasFullWave && settings?.clock_span === "1s" && enabled === "15m,1d,1h,1s,5m");
    }

    findCompletedHistogramAt(spanId, decisionTime) {
      const histogram = this.macdData?.[spanId]?.histogram || [];
      const spanSec = SPANS.find((s) => s.id === spanId)?.sec || 1;
      let low = 0;
      let high = histogram.length - 1;
      let best = null;
      while (low <= high) {
        const mid = (low + high) >> 1;
        const point = histogram[mid];
        if (Number(point.time) + spanSec <= decisionTime) {
          best = point;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (!best || !Number.isFinite(Number(best.value))) return null;
      const byPoint = this.macdData?.[spanId]?.byTime?.get(best.time);
      return {
        time: Number(best.time),
        completed_time: Number(best.time) + spanSec,
        value: Number(best.value),
        histogram: Number(best.value),
        hist_diff: byPoint?.hist_diff ?? (best.diff ?? null),
        signal: byPoint?.signal ?? null,
        signal_diff: byPoint?.signal_diff ?? null,
        signal_diff2: byPoint?.signal_diff2 ?? null,
      };
    }

    evaluateMacdStrategyReplay(rawSettings = {}, nowSec = Math.floor(Date.now() / 1000)) {
      const validSpanIds = SPANS.map((s) => s.id);
      const clockSpan = validSpanIds.includes(rawSettings.clock_span) ? rawSettings.clock_span : "1s";
      const buyThreshold = Number.isFinite(Number(rawSettings.buy_threshold)) ? Number(rawSettings.buy_threshold) : 0;
      const sellThreshold = Number.isFinite(Number(rawSettings.sell_threshold)) ? Number(rawSettings.sell_threshold) : 0;
      const initialCapital = Math.max(1, Number(rawSettings.initial_capital) || 10000);
      const feeBps = Math.max(0, Math.min(1000, Number(rawSettings.fee_bps) || 0));

      let entryRules = Array.isArray(rawSettings.entry_rules) ? [...rawSettings.entry_rules] : null;
      let exitRules = Array.isArray(rawSettings.exit_rules) ? [...rawSettings.exit_rules] : null;

      // Legacy fallback: if entry_rules/exit_rules omitted, derive from enabled_spans (MACD-H contrarian)
      if (!entryRules || !exitRules) {
        const rawSpans = Array.isArray(rawSettings.enabled_spans)
          ? rawSettings.enabled_spans.filter((s) => validSpanIds.includes(s))
          : validSpanIds;
        entryRules = rawSpans.map((spanId) => ({ span: spanId, rule: "macd_h", sign: "-" }));
        exitRules = rawSpans.map((spanId) => ({ span: spanId, rule: "macd_h", sign: "+" }));
      }

      const activeSpans = [...new Set([...entryRules.map((r) => r.span), ...exitRules.map((r) => r.span)])];
      const settings = {
        strategy_mode: "all_macd_histogram_contrarian",
        clock_span: clockSpan,
        enabled_spans: activeSpans,
        entry_rules: entryRules,
        exit_rules: exitRules,
        buy_threshold: buyThreshold,
        sell_threshold: sellThreshold,
        initial_capital: initialCapital,
        fee_bps: feeBps,
      };
      const emptyResult = (error) => ({
        settings,
        error,
        entry_signals: [],
        exit_signals: [],
        fills: [],
        trades: [],
        latest_evaluation: null,
        metrics: {
          evaluated_candles: 0,
          skipped_unaligned: 0,
          entry_signal_count: 0,
          simulated_entry_fills: 0,
          closed_trades: 0,
          win_rate_pct: 0,
          net_return_pct: 0,
          max_drawdown_pct: 0,
          final_equity: initialCapital,
        },
      });

      if (!entryRules.length && !exitRules.length) return emptyResult("Enable at least one MACD condition.");
      if (buyThreshold > sellThreshold) {
        return emptyResult("BUY threshold must be less than or equal to the SELL threshold.");
      }

      const clockSec = SPANS.find((s) => s.id === clockSpan)?.sec || 1;
      const clockCandles = (this.candlesData?.[clockSpan] || [])
        .filter((c) => Number.isFinite(Number(c.time)) && Number.isFinite(Number(c.close)))
        .filter((c) => Number(c.time) + clockSec <= nowSec)
        .sort((a, b) => Number(a.time) - Number(b.time));
      if (!clockCandles.length) return emptyResult(`No completed ${clockSpan} candles are loaded.`);

      const entrySignals = [];
      const exitSignals = [];
      const fills = [];
      const trades = [];
      const feeRate = feeBps / 10000;
      let cash = initialCapital;
      let quantity = 0;
      let openTrade = null;
      let peakEquity = initialCapital;
      let maxDrawdown = 0;
      let evaluatedCandles = 0;
      let skippedUnaligned = 0;
      let latestEvaluation = null;
      let lastEvaluatedPrice = null;

      for (const candle of clockCandles) {
        const candleTime = Number(candle.time);
        const decisionTime = candleTime + clockSec;
        const price = Number(candle.close);
        const histograms = {};
        let aligned = true;
        for (const spanId of activeSpans) {
          const point = this.findCompletedHistogramAt(spanId, decisionTime);
          if (!point) {
            aligned = false;
            break;
          }
          histograms[spanId] = point;
        }
        if (!aligned) {
          skippedUnaligned += 1;
          continue;
        }

        evaluatedCandles += 1;
        lastEvaluatedPrice = price;

        const evalRule = (rule, isEntry) => {
          const point = histograms[rule.span];
          if (!point) return false;
          let val = null;
          if (rule.rule === "macd_h") val = point.histogram;
          else if (rule.rule === "macd_s") val = point.signal;
          else if (rule.rule === "macd_s_diff") val = point.signal_diff;
          else if (rule.rule === "macd_s_diff2") val = point.signal_diff2;
          else if (rule.rule === "macd_h_diff") val = point.hist_diff;
          if (val === null || !Number.isFinite(Number(val))) return false;

          const numVal = Number(val);
          if (rule.rule === "macd_h") {
            const thresh = isEntry ? buyThreshold : sellThreshold;
            return rule.sign === "+" ? numVal > thresh : numVal < thresh;
          }
          return rule.sign === "+" ? numVal > 0 : numVal < 0;
        };

        const buyPass = entryRules.length > 0 && entryRules.every((r) => evalRule(r, true));
        const sellPass = exitRules.length > 0 && exitRules.every((r) => evalRule(r, false));
        latestEvaluation = {
          time: candleTime,
          decision_time: decisionTime,
          price,
          histograms,
          condition_pass: {
            entry_pass: buyPass,
            exit_pass: sellPass,
            entry_all_histograms_below: buyPass,
            exit_all_histograms_above: sellPass,
          },
        };

        // Entry-condition matches are deliberately evaluated without consulting position state.
        if (buyPass) {
          entrySignals.push({
            time: candleTime,
            decision_time: decisionTime,
            price,
            side: 1,
            histograms,
            source: "all_macd_rules",
          });
        }
        if (sellPass) {
          exitSignals.push({
            time: candleTime,
            decision_time: decisionTime,
            price,
            side: -1,
            histograms,
            source: "all_macd_rules",
          });
        }

        if (quantity > 0 && sellPass) {
          const grossProceeds = quantity * price;
          const exitFee = grossProceeds * feeRate;
          cash = grossProceeds - exitFee;
          const pnl = cash - openTrade.total_cost;
          const trade = {
            entry_time: openTrade.time,
            entry_price: openTrade.price,
            exit_time: candleTime,
            exit_price: price,
            quantity,
            entry_fee: openTrade.fee,
            exit_fee: exitFee,
            pnl,
            pnl_pct: openTrade.total_cost > 0 ? (pnl / openTrade.total_cost) * 100 : 0,
          };
          trades.push(trade);
          fills.push({ time: candleTime, price, side: -1, fee: exitFee, source: "simulated_fill" });
          quantity = 0;
          openTrade = null;
        } else if (quantity === 0 && buyPass) {
          const totalCost = cash;
          const entryNotional = totalCost / (1 + feeRate);
          const entryFee = entryNotional * feeRate;
          quantity = entryNotional / price;
          cash = 0;
          openTrade = { time: candleTime, price, fee: entryFee, total_cost: totalCost };
          fills.push({ time: candleTime, price, side: 1, fee: entryFee, source: "simulated_fill" });
        }

        const equity = quantity > 0 ? quantity * price : cash;
        peakEquity = Math.max(peakEquity, equity);
        if (peakEquity > 0) maxDrawdown = Math.max(maxDrawdown, (peakEquity - equity) / peakEquity);
      }

      const finalEquity = quantity > 0 && lastEvaluatedPrice !== null ? quantity * lastEvaluatedPrice : cash;
      const winningTrades = trades.filter((trade) => trade.pnl > 0).length;
      return {
        settings,
        error: evaluatedCandles ? null : "No clock candle has completed MACD-H data for every enabled span.",
        entry_signals: entrySignals,
        exit_signals: exitSignals,
        fills,
        trades,
        open_position: openTrade && quantity > 0
          ? { ...openTrade, quantity, mark_price: lastEvaluatedPrice, equity: finalEquity }
          : null,
        latest_evaluation: latestEvaluation,
        metrics: {
          evaluated_candles: evaluatedCandles,
          skipped_unaligned: skippedUnaligned,
          entry_signal_count: entrySignals.length,
          simulated_entry_fills: fills.filter((fill) => fill.side === 1).length,
          closed_trades: trades.length,
          win_rate_pct: trades.length ? (winningTrades / trades.length) * 100 : 0,
          net_return_pct: ((finalEquity / initialCapital) - 1) * 100,
          max_drawdown_pct: maxDrawdown * 100,
          final_equity: finalEquity,
        },
      };
    }

    buildMacdStrategyExecutionMarkers(result) {
      if (!result || result.error) return [];
      const trades = Array.isArray(result.trades) ? result.trades : [];
      const fills = Array.isArray(result.fills) ? result.fills : [];
      const entryFillTimes = new Set(fills.filter((fill) => Number(fill.side) > 0).map((fill) => Number(fill.time)));
      const exitConditions = new Map((result.exit_signals || []).map((signal) => [Number(signal.time), signal.histograms]));
      const tradeByEntryTime = new Map();
      const tradeByExitTime = new Map();
      trades.forEach((trade, index) => {
        const pairKey = `paper:${index}`;
        tradeByEntryTime.set(Number(trade.entry_time), { trade, pairKey });
        tradeByExitTime.set(Number(trade.exit_time), { trade, pairKey });
      });

      const entries = (result.entry_signals || []).map((signal, index) => {
        const paired = tradeByEntryTime.get(Number(signal.time));
        const isFill = entryFillTimes.has(Number(signal.time));
        return {
          markerKey: `entry-signal:${Number(signal.time)}:${index}`,
          pairKey: paired?.pairKey || (isFill ? `paper:open:${Number(signal.time)}` : null),
          time: Number(signal.time),
          price: Number(signal.price),
          is_entry: true,
          is_exit: false,
          is_fill: isFill,
          signal_only: !isFill,
          source: isFill ? "simulated_fill" : "entry_signal",
          histograms: signal.histograms || {},
          trade: paired?.trade || null,
        };
      });
      const exits = fills.filter((fill) => Number(fill.side) < 0).map((fill, index) => {
        const paired = tradeByExitTime.get(Number(fill.time));
        return {
          markerKey: `exit-fill:${Number(fill.time)}:${index}`,
          pairKey: paired?.pairKey || null,
          time: Number(fill.time),
          price: Number(fill.price),
          is_entry: false,
          is_exit: true,
          is_fill: true,
          signal_only: false,
          source: "simulated_fill",
          histograms: exitConditions.get(Number(fill.time)) || {},
          trade: paired?.trade || null,
        };
      });
      return [...entries, ...exits]
        .filter((marker) => Number.isFinite(marker.time) && Number.isFinite(marker.price))
        .sort((a, b) => a.time - b.time || (a.is_entry ? -1 : 1));
    }

    scheduleMacdStrategyMarkerRender() {
      if (typeof document === "undefined") return;
      if (this.strategyMarkerRenderRaf !== null) return;
      const render = () => {
        this.strategyMarkerRenderRaf = null;
        this.renderMacdStrategyMarkers();
      };
      this.strategyMarkerRenderRaf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(render)
        : setTimeout(render, 0);
    }

    clearMacdStrategyMarkerSelection(spanId = null) {
      if (spanId && spanId !== this.strategyReplayResult?.settings?.clock_span) return;
      if (!this.selectedStrategyMarkerKey) return;
      this.selectedStrategyMarkerKey = null;
      this.updateMacdStrategyMarkerHover(null);
      this.renderMacdStrategyPairTriangle();
    }

    macdStrategyMarkerPair(marker) {
      if (!marker?.pairKey) return null;
      const paired = (this.strategyExecutionMarkers || []).filter((candidate) =>
        candidate.pairKey === marker.pairKey && candidate.is_fill
      );
      const entry = paired.find((candidate) => candidate.is_entry);
      const exit = paired.find((candidate) => candidate.is_exit);
      return entry && exit ? { entry, exit } : null;
    }

    updateMacdStrategyMarkerHover(marker) {
      if (typeof document === "undefined") return;
      SPANS.forEach((span) => {
        const overlay = document.getElementById(`msTradeMarkerHover_${span.id}`);
        if (!overlay) return;
        if (!marker || span.id !== this.strategyReplayResult?.settings?.clock_span) {
          overlay.style.display = "none";
          overlay.textContent = "";
          return;
        }
        const histText = Object.entries(marker.histograms || {})
          .map(([spanId, point]) => `${spanId} H ${Number(point?.value) >= 0 ? "+" : ""}${Number(point?.value).toFixed(4)}`)
          .join(" · ");
        let title;
        if (marker.is_exit) {
          const pnl = Number(marker.trade?.pnl);
          const pnlText = Number.isFinite(pnl) ? ` · net P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : "";
          title = `PAPER SELL FILL · closed long${pnlText} · configured fees included`;
        } else if (marker.is_fill) {
          title = "ENTRY SIGNAL · PAPER BUY FILL · configured fee included";
        } else {
          title = "ENTRY SIGNAL ONLY · no simulated fill because the paper long was already open";
        }
        overlay.textContent = `${title} · ${formatPrice(marker.price)} · ${formatKst(marker.time)}${histText ? ` · ${histText}` : ""}`;
        overlay.style.display = "block";
        overlay.style.borderColor = marker.is_exit ? "#fca5a5" : "#86efac";
        overlay.style.color = marker.is_exit ? "#991b1b" : "#166534";
      });
    }

    renderMacdStrategyPairTriangle(spanId = this.strategyReplayResult?.settings?.clock_span) {
      if (typeof document === "undefined") return;
      SPANS.forEach((span) => {
        const layer = document.getElementById(`msTradeTriangles_${span.id}`);
        if (layer) layer.innerHTML = "";
      });
      if (!spanId) return;
      const layer = document.getElementById(`msTradeTriangles_${spanId}`);
      const chart = this.charts?.[spanId];
      const series = this.series?.[spanId];
      if (!layer || !chart || !series) return;
      const markerKey = this.activeStrategyMarkerKey || this.selectedStrategyMarkerKey;
      const marker = (this.strategyExecutionMarkers || []).find((candidate) => candidate.markerKey === markerKey);
      const pair = this.macdStrategyMarkerPair(marker);
      if (!pair) return;

      const x1 = Number(pair.entry._targetX ?? chart.timeScale().timeToCoordinate(pair.entry.time));
      const x2 = Number(pair.exit._targetX ?? chart.timeScale().timeToCoordinate(pair.exit.time));
      const y1 = Number(pair.entry._targetY ?? series.priceToCoordinate(pair.entry.price));
      const y2 = Number(pair.exit._targetY ?? series.priceToCoordinate(pair.exit.price));
      if (![x1, x2, y1, y2].every(Number.isFinite) || Math.abs(x1 - x2) < 1) return;

      const profit = Number(pair.exit.trade?.pnl) > 0;
      const cornerX = y1 <= y2 ? x1 : x2;
      const cornerY = y1 <= y2 ? y2 : y1;
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", `${x1.toFixed(1)},${y1.toFixed(1)} ${cornerX.toFixed(1)},${cornerY.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`);
      polygon.setAttribute("fill", profit ? "rgba(34,197,94,.12)" : "rgba(239,68,68,.12)");
      polygon.setAttribute("stroke", profit ? "rgba(22,163,74,.65)" : "rgba(220,38,38,.65)");
      polygon.setAttribute("stroke-width", "1");
      layer.appendChild(polygon);

      const diagonal = document.createElementNS("http://www.w3.org/2000/svg", "line");
      diagonal.setAttribute("x1", x1.toFixed(1));
      diagonal.setAttribute("y1", y1.toFixed(1));
      diagonal.setAttribute("x2", x2.toFixed(1));
      diagonal.setAttribute("y2", y2.toFixed(1));
      diagonal.setAttribute("stroke", profit ? "#16a34a" : "#dc2626");
      diagonal.setAttribute("stroke-width", "1");
      layer.appendChild(diagonal);
    }

    renderMacdStrategyMarkers() {
      if (typeof document === "undefined") return;
      SPANS.forEach((span) => {
        const targets = document.getElementById(`msTradeMarkerTargets_${span.id}`);
        const triangles = document.getElementById(`msTradeTriangles_${span.id}`);
        const hover = document.getElementById(`msTradeMarkerHover_${span.id}`);
        if (targets) targets.textContent = "";
        if (triangles) triangles.innerHTML = "";
        if (hover) { hover.style.display = "none"; hover.textContent = ""; }
      });
      if (!this.showStrategyPaperMarkers) return;

      const spanId = this.strategyReplayResult?.settings?.clock_span;
      const markers = this.strategyExecutionMarkers || [];
      const host = document.getElementById(`msChartHost_${spanId}`);
      const layer = document.getElementById(`msTradeMarkerTargets_${spanId}`);
      const svg = document.getElementById(`msTradeTriangles_${spanId}`);
      const chart = this.charts?.[spanId];
      const series = this.series?.[spanId];
      if (!spanId || !markers.length || !host || !layer || !svg || !chart || !series) return;

      const plotWidth = Number(chart.timeScale().width?.()) || host.clientWidth || 0;
      const plotHeight = host.clientHeight || 0;
      [layer, svg].forEach((overlay) => {
        overlay.style.left = "0px";
        overlay.style.right = "auto";
        overlay.style.width = `${plotWidth}px`;
      });
      const fragment = document.createDocumentFragment();
      const targetsByMarkerKey = new Map();
      const blink = (target, enabled) => {
        if (!target) return;
        target._blinkAnimation?.cancel?.();
        target._blinkAnimation = null;
        if (enabled && typeof target.animate === "function") {
          target._blinkAnimation = target.animate(
            [{ opacity: 1 }, { opacity: 0.12 }, { opacity: 1 }],
            { duration: 650, iterations: Infinity, easing: "ease-in-out" }
          );
        }
      };

      markers.forEach((marker) => {
        const x = Number(chart.timeScale().timeToCoordinate(marker.time));
        const y = Number(series.priceToCoordinate(marker.price));
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < -12 || x > plotWidth + 12 || y < 0 || y > plotHeight) return;
        marker._targetX = x;
        marker._targetY = y;
        const size = marker.signal_only ? 6 : 8;
        const opacity = marker.signal_only ? 0.48 : 0.92;
        const color = marker.is_exit ? "#dc2626" : "#16a34a";
        const target = document.createElement("button");
        target.type = "button";
        target.dataset.markerKey = marker.markerKey;
        if (marker.pairKey) target.dataset.pairKey = marker.pairKey;
        target.setAttribute("aria-label", marker.is_exit
          ? `Paper sell fill at ${formatPrice(marker.price)}`
          : `${marker.signal_only ? "Entry signal" : "Paper buy fill"} at ${formatPrice(marker.price)}`);
        const points = marker.is_entry
          ? `0.5,0.5 ${size - 0.5},${size / 2} 0.5,${size - 0.5}`
          : `${size - 0.5},0.5 0.5,${size / 2} ${size - 0.5},${size - 0.5}`;
        const dash = marker.signal_only ? ' stroke-dasharray="1.5 1"' : "";
        target.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block;overflow:visible;pointer-events:none;"><polygon points="${points}" fill="none" stroke="${color}" stroke-width="${marker.signal_only ? 1 : 1.25}" stroke-linejoin="round"${dash}/></svg>`;
        const translate = marker.is_entry ? "translate(-100%,-50%)" : "translate(0,-50%)";
        target.style.cssText = `appearance:none;position:absolute;left:${x}px;top:${y}px;transform:${translate};width:${size}px;height:${size}px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;opacity:${opacity};cursor:pointer;pointer-events:auto`;
        targetsByMarkerKey.set(marker.markerKey, target);

        const pairedTargets = () => {
          const pair = this.macdStrategyMarkerPair(marker);
          if (!pair) return [target];
          return [...new Set([target, targetsByMarkerKey.get(pair.entry.markerKey), targetsByMarkerKey.get(pair.exit.markerKey)].filter(Boolean))];
        };
        target.addEventListener("mouseenter", () => {
          pairedTargets().forEach((candidate) => blink(candidate, true));
          this.activeStrategyMarkerKey = marker.markerKey;
          this.updateMacdStrategyMarkerHover(marker);
          this.renderMacdStrategyPairTriangle(spanId);
        });
        target.addEventListener("mouseleave", () => {
          pairedTargets().forEach((candidate) => blink(candidate, false));
          this.activeStrategyMarkerKey = null;
          const selected = markers.find((candidate) => candidate.markerKey === this.selectedStrategyMarkerKey) || null;
          this.updateMacdStrategyMarkerHover(selected);
          this.renderMacdStrategyPairTriangle(spanId);
        });
        target.addEventListener("click", (event) => {
          event.stopPropagation();
          this.selectedStrategyMarkerKey = marker.markerKey;
          this.updateMacdStrategyMarkerHover(marker);
          this.renderMacdStrategyPairTriangle(spanId);
        });
        fragment.appendChild(target);
      });
      layer.appendChild(fragment);
      const active = markers.find((marker) => marker.markerKey === this.activeStrategyMarkerKey) || null;
      const selected = markers.find((marker) => marker.markerKey === this.selectedStrategyMarkerKey) || null;
      this.updateMacdStrategyMarkerHover(active || selected);
      this.renderMacdStrategyPairTriangle(spanId);
    }

    applyMacdStrategyMarkers(result) {
      // Native Lightweight Charts markers are deliberately cleared. Tabs 4/5
      // use exact-price DOM triangles, which also preserve signal/fill identity.
      for (const span of SPANS) {
        const series = this.series?.[span.id];
        if (series && typeof series.setMarkers === "function") series.setMarkers([]);
      }
      this.strategyExecutionMarkers = this.buildMacdStrategyExecutionMarkers(result);
      if (this.activeStrategyMarkerKey && !this.strategyExecutionMarkers.some((marker) => marker.markerKey === this.activeStrategyMarkerKey)) {
        this.activeStrategyMarkerKey = null;
      }
      if (this.selectedStrategyMarkerKey && !this.strategyExecutionMarkers.some((marker) => marker.markerKey === this.selectedStrategyMarkerKey)) {
        this.selectedStrategyMarkerKey = null;
      }
      this.scheduleMacdStrategyMarkerRender();
    }

    renderMacdStrategyReplay(result) {
      if (typeof document === "undefined") return;
      const summary = document.getElementById("msStrategySummary");
      const entryConditions = document.getElementById("msStrategyEntryConditions");
      const exitConditions = document.getElementById("msStrategyExitConditions");
      const source = document.getElementById("msStrategySource");
      if (!summary || !entryConditions || !exitConditions) return;

      const settings = result?.settings || this.macdStrategySettings();
      const metrics = result?.metrics || {};
      const latest = result?.latest_evaluation;
      let frameStatus = "PAPER ONLY · Awaiting completed chart data";
      this.updateMacdStrategyPresetButtons(settings);
      if (result?.error) {
        summary.innerHTML = `<strong style="color:#b45309;">WAITING</strong> · ${result.error}`;
        frameStatus = `PAPER · WAITING · ${result.error}`;
      } else if (!(metrics.entry_signal_count > 0) && !(metrics.simulated_entry_fills > 0)) {
        summary.innerHTML = `<strong style="color:#b45309;">NO TRADES IN LOADED OVERLAP</strong> · ${(settings.enabled_spans || []).join(" + ")} enabled · ${metrics.evaluated_candles || 0} completed-candle evaluations · this is a real zero-result, not hidden markers · choose <strong>QUICK 5m+15m</strong> to inspect actual trades or adjust the enabled conditions.`;
        frameStatus = `PAPER · 0 entry signals · 0 simulated fills · ${metrics.evaluated_candles || 0} completed-candle evaluations`;
      } else {
        const state = latest?.condition_pass?.entry_all_histograms_below
          ? '<strong style="color:#16a34a;">BUY MATCH</strong>'
          : latest?.condition_pass?.exit_all_histograms_above
            ? '<strong style="color:#dc2626;">SELL MATCH</strong>'
            : '<strong style="color:#64748b;">WAITING</strong>';
        const openLabel = result.open_position ? "LONG OPEN" : "FLAT";
        summary.innerHTML = `${state} · ${openLabel} · return <strong>${Number(metrics.net_return_pct || 0).toFixed(2)}%</strong> · equity <strong>$${Number(metrics.final_equity || 0).toFixed(2)}</strong> · max DD ${Number(metrics.max_drawdown_pct || 0).toFixed(2)}% · entry signals ${metrics.entry_signal_count || 0} · simulated buys ${metrics.simulated_entry_fills || 0} · closed trades ${metrics.closed_trades || 0} · win rate ${Number(metrics.win_rate_pct || 0).toFixed(1)}%`;
        frameStatus = `✓ ${metrics.entry_signal_count || 0} entry signals · ${metrics.simulated_entry_fills || 0} simulated buys · ${metrics.closed_trades || 0} closed trades (${Number(metrics.win_rate_pct || 0).toFixed(1)}% win)`;
      }

      const renderConditionGroup = (kind) => {
        const isEntry = kind === "entry";
        const rules = isEntry ? (settings.entry_rules || []) : (settings.exit_rules || []);
        const rulesMap = new Map(rules.map((r) => [`${r.span}:${r.rule}`, r]));

        return SPANS.map((span) => {
          const point = latest?.histograms?.[span.id];
          const rowsHtml = MACD_RULES.map((rule) => {
            const ruleKey = `${span.id}:${rule.id}`;
            const activeRule = rulesMap.get(ruleKey);
            const isEnabled = Boolean(activeRule);
            const sign = activeRule?.sign || (isEntry ? rule.defaultEntrySign : rule.defaultExitSign);
            const threshold = isEntry ? Number(settings.buy_threshold) : Number(settings.sell_threshold);

            let val = null;
            if (point) {
              if (rule.id === "macd_h") val = point.histogram;
              else if (rule.id === "macd_s") val = point.signal;
              else if (rule.id === "macd_s_diff") val = point.signal_diff;
              else if (rule.id === "macd_s_diff2") val = point.signal_diff2;
              else if (rule.id === "macd_h_diff") val = point.hist_diff;
            }

            const signLabel = sign === "+" ? "+ (>0)" : "− (<0)";
            const operator = sign === "+" ? ">" : "<";
            const ruleThreshold = rule.id === "macd_h" ? threshold : 0;
            const titleText = `${span.id} ${rule.label} ${operator} ${ruleThreshold}`;

            const switchHtml = `
              <label class="toggleSwitch" title="Turn ${span.id} ${rule.label} rule ON/OFF">
                <input class="msStrategySpanToggle" data-span="${span.id}" data-rule="${rule.id}" data-kind="${kind}" aria-label="Use ${span.id} ${rule.label} for paper ${kind}" type="checkbox"${isEnabled ? " checked" : ""}>
                <span class="toggleSlider"></span>
              </label>
            `;

            const signBtnHtml = `
              <button type="button" class="condSignToggle" data-span="${span.id}" data-rule="${rule.id}" data-kind="${kind}" data-sign="${sign}" title="Click to toggle condition between + (>0) and - (<0)" style="margin-left:6px;padding:1px 5px;font-size:10px;font-weight:800;border-radius:4px;border:1px solid #cbd5e1;background:#fff;cursor:pointer;color:${sign === '+' ? '#166534' : '#991b1b'};">
                ${signLabel}
              </button>
            `;

            if (!isEnabled) {
              return `<div class="condRow disabled-cond" data-span="${span.id}" data-rule="${rule.id}" data-kind="${kind}">${switchHtml}<span class="condLabel"><strong style="color:${span.color};">${titleText}</strong>${signBtnHtml}<small style="display:block;color:#64748b;">PAPER · condition disabled</small></span><span class="condValue"><strong style="color:#64748b;">—</strong></span><span class="condBadge neutral">OFF</span></div>`;
            }

            if (!point || val === null || !Number.isFinite(Number(val))) {
              return `<div class="condRow" data-span="${span.id}" data-rule="${rule.id}" data-kind="${kind}">${switchHtml}<span class="condLabel"><strong style="color:${span.color};">${titleText}</strong>${signBtnHtml}<small style="display:block;color:#64748b;">PAPER · source unavailable</small></span><span class="condValue"><strong style="color:#64748b;">—</strong></span><span class="condBadge neutral">UNAVAILABLE</span></div>`;
            }

            const numVal = Number(val);
            const pass = sign === "+" ? numVal > ruleThreshold : numVal < ruleThreshold;
            const measured = `${numVal > 0 ? "+" : ""}${numVal.toFixed(4)}`;
            const valColor = pass ? "#16a34a" : (numVal < 0 ? "#dc2626" : "#64748b");
            const badgeTitle = `${isEntry ? "BUY" : "SELL"} ${pass ? "passes" : "waits"}: ${span.id} ${rule.label} ${measured} ${operator} ${ruleThreshold}`;

            return `<div class="condRow" data-span="${span.id}" data-rule="${rule.id}" data-kind="${kind}">${switchHtml}<span class="condLabel"><strong style="color:${span.color};">${titleText}</strong>${signBtnHtml}<small style="display:block;color:#64748b;">PAPER · ${measured} · ${formatKst(point.completed_time)} completed</small></span><span class="condValue"><strong style="color:${valColor};">${measured}</strong></span><span class="condBadge ${pass ? "pass" : "wait"}" title="${badgeTitle}">${pass ? "PASS" : "WAITING"}</span></div>`;
          }).join("");

          return `
            <div class="msSpanSection" style="margin-bottom:8px;">
              <div style="font-weight:800;font-size:10px;color:${span.color};padding:3px 6px;background:#f8fafc;border-top:1px solid #e2e8f0;border-bottom:1px solid #f1f5f9;margin-top:4px;display:flex;align-items:center;justify-content:space-between;border-radius:4px;">
                <span>● ${span.id} · ${span.label}</span>
                <button type="button" class="msSpanToggleAllBtn" data-span="${span.id}" data-kind="${kind}" style="border:1px solid #cbd5e1;background:#fff;border-radius:3px;padding:1px 6px;font-size:9.5px;font-weight:700;cursor:pointer;color:#334155;">Toggle ${span.id}</button>
              </div>
              ${rowsHtml}
            </div>
          `;
        }).join("");
      };
      entryConditions.innerHTML = renderConditionGroup("entry");
      exitConditions.innerHTML = renderConditionGroup("exit");
      this.strategyExecutionFrame?.setStatus(frameStatus);
      this.strategyExecutionFrame?.setSync(latest?.decision_time
        ? `${settings.clock_span} completed ${formatKst(latest.decision_time)} · loaded history`
        : `${settings.clock_span} completed candles · source unavailable`);
      if (source) {
        source.textContent = `Source: completed Binance candles · MACD(12,26,9) [H, S, ΔS, Δ²S, ΔH] · enabled ${(settings.enabled_spans || []).join("+") || "none"} · ${settings.clock_span} decision clock · ${metrics.evaluated_candles || 0} aligned evaluations · faint dashed ▷ are entry_signals without fills; bold ▷/◁ are simulated BUY/SELL fills · hover or click a marker for the paired trade · loaded chart history only`;
      }
    }

    runMacdStrategyReplay(settings = null, nowSec = Math.floor(Date.now() / 1000)) {
      const result = this.evaluateMacdStrategyReplay(settings || this.macdStrategySettings(), nowSec);
      this.strategyReplayResult = result;
      this.entrySignals = result.entry_signals;
      this.renderMacdStrategyReplay(result);
      this.applyMacdStrategyMarkers(result);
      return result;
    }

    scheduleMacdStrategyReplay(delayMs = 180) {
      if (!this.mounted || typeof document === "undefined") return;
      if (this.strategyReplayTimer) clearTimeout(this.strategyReplayTimer);
      this.strategyReplayTimer = setTimeout(() => {
        this.strategyReplayTimer = null;
        this.runMacdStrategyReplay();
      }, delayMs);
    }

    findMacdAtOrBefore(spanId, time) {
      const data = this.macdData[spanId]?.macd || [];
      if (!data.length) return null;
      let low = 0;
      let high = data.length - 1;
      let best = null;
      while (low <= high) {
        const mid = (low + high) >> 1;
        if (data[mid].time <= time) {
          best = data[mid];
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      if (!best) return null;
      const byTime = this.macdData[spanId]?.byTime;
      return byTime?.get(best.time) || {
        macd: best.value,
        signal: null,
        signal_diff: null,
        signal_diff2: null,
        hist: null,
        histogram: null,
        hist_diff: null,
      };
    }

    updateMacdLegend(spanId, macdVal, sigVal, histVal, sigDiffVal = null, sigDiff2Val = null, histDiffVal = null) {
      const mEl = document.getElementById(`msMacdVal_${spanId}`);
      const sEl = document.getElementById(`msSigVal_${spanId}`);
      const sdEl = document.getElementById(`msSigDiffVal_${spanId}`);
      const sd2El = document.getElementById(`msSigDiff2Val_${spanId}`);
      const hEl = document.getElementById(`msHistVal_${spanId}`);
      const hdEl = document.getElementById(`msHistDiffVal_${spanId}`);

      if (mEl) mEl.textContent = macdVal != null && !isNaN(macdVal) ? Number(macdVal).toFixed(4) : "--";
      if (sEl) sEl.textContent = sigVal != null && !isNaN(sigVal) ? Number(sigVal).toFixed(4) : "--";
      if (hEl) {
        if (histVal != null && !isNaN(histVal)) {
          const num = Number(histVal);
          hEl.textContent = (num >= 0 ? "+" : "") + num.toFixed(4);
          hEl.style.color = num >= 0 ? "#059669" : "#dc2626";
        } else {
          hEl.textContent = "--";
          hEl.style.color = "#475569";
        }
      }

      const updateDiffEl = (el, val) => {
        if (!el) return;
        if (val != null && !isNaN(val)) {
          const num = Number(val);
          el.textContent = (num > 0 ? "+" : "") + num.toFixed(4);
          el.style.color = num > 0 ? "#059669" : num < 0 ? "#dc2626" : "#64748b";
        } else {
          el.textContent = "--";
          el.style.color = "#64748b";
        }
      };

      if ((sigDiffVal === null || sigDiff2Val === null || histDiffVal === null) && this.macdData?.[spanId]?.byTime) {
        const histList = this.macdData[spanId].histogram || [];
        const lastH = histList[histList.length - 1];
        if (lastH) {
          const pt = this.macdData[spanId].byTime.get(lastH.time);
          if (pt) {
            if (sigDiffVal === null) sigDiffVal = pt.signal_diff;
            if (sigDiff2Val === null) sigDiff2Val = pt.signal_diff2;
            if (histDiffVal === null) histDiffVal = pt.hist_diff;
          }
        }
      }

      updateDiffEl(sdEl, sigDiffVal);
      updateDiffEl(sd2El, sigDiff2Val);
      updateDiffEl(hdEl, histDiffVal);
    }

    updateCandle(spanId, candle) {
      if (this.isHistorical[spanId] || this.reloadingSpans[spanId]) {
        return;
      }
      const list = this.candlesData[spanId] || [];
      if (!list.length) return;
      const last = list[list.length - 1];
      if (last && last.time === candle.time) {
        list[list.length - 1] = candle;
      } else if (last && candle.time > last.time) {
        list.push(candle);
        if (list.length > 10000) list.shift();
      }
      const s = this.series[spanId];
      if (s) s.update(candle);
      if (this.candleCache) {
        this.candleCache.put(this.symbol, spanId, [candle]);
      }

      const priceEl = document.getElementById(`msCardPrice_${spanId}`);
      const hudVal = document.getElementById(`msHudVal_${spanId}`);
      const cardOhlc = document.getElementById(`msCardOhlc_${spanId}`);
      const pStr = formatPrice(candle.close);
      if (priceEl) priceEl.textContent = pStr;
      // If a user has clicked a candle, keep card OHLC and HUD locked to the clicked selection
      if (this.pinnedTime === null) {
        if (hudVal) hudVal.textContent = pStr;
        if (cardOhlc) {
          cardOhlc.textContent = `O:${formatPrice(candle.open)} H:${formatPrice(candle.high)} L:${formatPrice(candle.low)} C:${pStr}`;
        }
        const cardTime = document.getElementById(`msCardTime_${spanId}`);
        if (cardTime) {
          cardTime.textContent = formatKstShort(candle.time, spanId);
        }
        if (spanId === "1s") {
          const hudTime = document.getElementById("msHudTime");
          if (hudTime) hudTime.textContent = formatKst(candle.time);
        }
      }

      // Update MACD dynamically on candle update
      this.updateMacdForSpan(spanId, list, { updateLatestOnly: true });
    }

    startRealtimeFeeds() {
      this.stopRealtimeFeeds();
      const sym = this.symbol.toLowerCase();

      // 1. WebSocket for 1-second candles
      try {
        const wsUrl = `wss://stream.binance.com:9443/ws/${sym}@kline_1s`;
        this.ws = new WebSocket(wsUrl);
        this.ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.e === "kline" && msg.k) {
              const k = msg.k;
              const candle = {
                time: Math.floor(k.t / 1000),
                open: parseFloat(k.o),
                high: parseFloat(k.h),
                low: parseFloat(k.l),
                close: parseFloat(k.c),
                volume: parseFloat(k.v || 0),
              };
              this.updateCandle("1s", candle);
            }
          } catch (_) {}
        };
        this.ws.onerror = () => {};
      } catch (_) {}

      // 2. Periodic polling for higher spans (5m, 15m, 1h, 1d)
      this.pollInterval = setInterval(async () => {
        for (const s of ["5m", "15m", "1h", "1d"]) {
          try {
            const raw = await this.fetchKlinesForSpan(this.symbol, s, 3);
            if (raw && raw.length) {
              const latest = raw[raw.length - 1];
              this.updateCandle(s, latest);
            }
          } catch (_) {}
        }
      }, 4000);
    }

    stopRealtimeFeeds() {
      if (this.ws) {
        try { this.ws.close(); } catch (_) {}
        this.ws = null;
      }
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }
    }

    // =========================================================================
    // CONTROLS & EVENT BINDINGS
    // =========================================================================

    bindControls() {
      const runStrategy = () => this.runMacdStrategyReplay();
      const runStrategyButton = document.getElementById("msRunStrategyReplay");
      if (runStrategyButton && !this.strategyExecutionFrame) runStrategyButton.addEventListener("click", runStrategy);
      const quickPresetButton = document.getElementById("msStrategyPresetQuick");
      const allPresetButton = document.getElementById("msStrategyPresetAll");
      const fullWaveButton = document.getElementById("msStrategyPresetFullWave");
      const allFullWaveButton = document.getElementById("msStrategyPresetAllFullWave");
      if (quickPresetButton) quickPresetButton.addEventListener("click", () => this.applyMacdStrategyPreset("quick"));
      if (allPresetButton) allPresetButton.addEventListener("click", () => this.applyMacdStrategyPreset("all"));
      if (fullWaveButton) fullWaveButton.addEventListener("click", () => this.applyMacdStrategyPreset("full_wave"));
      if (allFullWaveButton) allFullWaveButton.addEventListener("click", () => this.applyMacdStrategyPreset("all_full_wave"));
      [
        "msStrategyClock",
        "msStrategyBuyThreshold",
        "msStrategySellThreshold",
        "msStrategyCapital",
        "msStrategyFeeBps",
      ].forEach((id) => {
        const control = document.getElementById(id);
        if (control) control.addEventListener("change", runStrategy);
      });
      const condGroups = document.getElementById("msStrategyConditionGroups");
      if (condGroups) {
        condGroups.addEventListener("change", (e) => {
          const toggle = e.target.closest(".msStrategySpanToggle");
          if (!toggle) return;
          runStrategy();
        });

        condGroups.addEventListener("click", (e) => {
          const signBtn = e.target.closest(".condSignToggle");
          if (signBtn) {
            e.preventDefault();
            const currSign = signBtn.getAttribute("data-sign") || "+";
            const nextSign = currSign === "+" ? "-" : "+";
            signBtn.setAttribute("data-sign", nextSign);
            signBtn.textContent = nextSign === "+" ? "+ (>0)" : "− (<0)";
            signBtn.style.color = nextSign === "+" ? "#166534" : "#991b1b";
            runStrategy();
            return;
          }

          const spanAllBtn = e.target.closest(".msSpanToggleAllBtn");
          if (spanAllBtn) {
            e.preventDefault();
            const spanId = spanAllBtn.getAttribute("data-span");
            const kind = spanAllBtn.getAttribute("data-kind");
            const checkboxes = Array.from(document.querySelectorAll(`.msStrategySpanToggle[data-span="${spanId}"][data-kind="${kind}"]`));
            const someUnchecked = checkboxes.some((cb) => !cb.checked);
            checkboxes.forEach((cb) => { cb.checked = someUnchecked; });
            runStrategy();
            return;
          }
        });
      }

      // Symbol buttons
      const symBtns = document.querySelectorAll(".msSymBtn");
      symBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const sym = btn.getAttribute("data-sym");
          if (sym && sym !== this.symbol) {
            symBtns.forEach((b) => {
              b.classList.toggle("active", b === btn);
              b.style.background = b === btn ? "#0284c7" : "transparent";
              b.style.color = b === btn ? "#ffffff" : "#64748b";
            });
            this.setSymbol(sym);
          }
        });
      });

      // Custom symbol input
      const applyBtn = document.getElementById("msApplyCustomSym");
      const customInput = document.getElementById("msCustomSymbolInput");
      const applyCustom = () => {
        let val = (customInput?.value || "").trim().toUpperCase();
        if (val) {
          if (!val.endsWith("USDT")) val += "USDT";
          symBtns.forEach((b) => {
            b.classList.remove("active");
            b.style.background = "transparent";
            b.style.color = "#64748b";
          });
          this.setSymbol(val);
        }
      };
      if (applyBtn) applyBtn.addEventListener("click", applyCustom);
      if (customInput) customInput.addEventListener("keydown", (e) => { if (e.key === "Enter") applyCustom(); });

      // Sync toggle
      const syncToggle = document.getElementById("msToggleSync");
      if (syncToggle) {
        syncToggle.addEventListener("click", () => {
          this.syncEnabled = !this.syncEnabled;
          syncToggle.textContent = this.syncEnabled ? "🔗 ON" : "🔓 OFF";
          syncToggle.style.background = this.syncEnabled ? "#059669" : "#ffffff";
          syncToggle.style.color = this.syncEnabled ? "#ffffff" : "#64748b";
        });
      }

      // Sync mode toggle (Anchor vs Range)
      const modeToggle = document.getElementById("msToggleSyncMode");
      if (modeToggle) {
        modeToggle.addEventListener("click", () => {
          this.syncMode = this.syncMode === "anchor" ? "range" : "anchor";
          modeToggle.textContent = this.syncMode === "anchor" ? "⚓ ANCHOR" : "⏱️ RANGE";
          modeToggle.style.color = this.syncMode === "anchor" ? "#0284c7" : "#d97706";
        });
      }

      // Align all to latest
      const alignBtn = document.getElementById("msAlignLatest");
      if (alignBtn) {
        alignBtn.addEventListener("click", () => {
          this.alignAllToLatest();
        });
      }

      // Fit all
      const fitBtn = document.getElementById("msFitAll");
      if (fitBtn) {
        fitBtn.addEventListener("click", () => {
          SPANS.forEach((s) => this.fitSpan(s.id));
        });
      }

      // Individual Card Fit & Hero buttons
      document.querySelectorAll(".msCardFitBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          if (span) this.fitSpan(span);
        });
      });

      document.querySelectorAll(".msCardHeroBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          this.heroSpan = span;
          this.setLayout("hero");
        });
      });

      // Layout selector buttons
      const layoutBtns = document.querySelectorAll(".msLayoutBtn");
      layoutBtns.forEach((btn) => {
        btn.addEventListener("click", () => {
          const l = btn.getAttribute("data-layout");
          layoutBtns.forEach((b) => {
            b.classList.toggle("active", b === btn);
            b.style.background = b === btn ? "#0284c7" : "transparent";
            b.style.color = b === btn ? "#ffffff" : "#64748b";
          });
          this.setLayout(l);
        });
      });

      // Historical mode badges click to return to latest
      document.querySelectorAll(".msCardModeBadge").forEach((badge) => {
        badge.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          if (span && this.isHistorical[span]) {
            this.reloadSpanToLatest(span);
          }
        });
      });

      // Load more older/newer historical candles buttons
      document.querySelectorAll(".msCardLoadMoreBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          if (span) {
            this.loadMoreHistorical(span);
          }
        });
      });

      document.querySelectorAll(".msCardLoadNewerBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          if (span) {
            this.loadMoreNewer(span);
          }
        });
      });

      // Charts per row buttons
      document.querySelectorAll(".msColBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const cols = btn.getAttribute("data-cols");
          if (cols) {
            this.setChartsPerRow(cols);
          }
        });
      });
    }

    setChartsPerRow(cols) {
      this.chartsPerRow = String(cols);
      try {
        localStorage.setItem("ms_charts_per_row", this.chartsPerRow);
      } catch (_) {}

      // Selecting a column count activates grid layout mode
      this.activeLayout = "grid";

      // Update layout selector buttons
      document.querySelectorAll(".msLayoutBtn").forEach((btn) => {
        const l = btn.getAttribute("data-layout");
        const isActive = l === "grid";
        btn.classList.toggle("active", isActive);
        btn.style.background = isActive ? "#0284c7" : "transparent";
        btn.style.color = isActive ? "#ffffff" : "#64748b";
      });

      // Update per-row buttons
      document.querySelectorAll(".msColBtn").forEach((btn) => {
        const c = btn.getAttribute("data-cols");
        const isActive = c === this.chartsPerRow;
        btn.classList.toggle("active", isActive);
        btn.style.background = isActive ? "#0284c7" : "transparent";
        btn.style.color = isActive ? "#ffffff" : "#64748b";
      });

      this.applyLayoutStyles();
    }

    setLayout(layout) {
      this.activeLayout = layout;
      if (layout === "stack") {
        this.chartsPerRow = "1";
      }

      // Update layout buttons
      document.querySelectorAll(".msLayoutBtn").forEach((btn) => {
        const l = btn.getAttribute("data-layout");
        const isActive = l === layout;
        btn.classList.toggle("active", isActive);
        btn.style.background = isActive ? "#0284c7" : "transparent";
        btn.style.color = isActive ? "#ffffff" : "#64748b";
      });

      // Update col buttons
      document.querySelectorAll(".msColBtn").forEach((btn) => {
        const c = btn.getAttribute("data-cols");
        const isActive = this.activeLayout === "grid" && c === this.chartsPerRow;
        btn.classList.toggle("active", isActive);
        btn.style.background = isActive ? "#0284c7" : "transparent";
        btn.style.color = isActive ? "#ffffff" : "#64748b";
      });

      this.applyLayoutStyles();
    }

    fitSpan(spanId) {
      const data = this.candlesData[spanId];
      const chart = this.charts[spanId];
      if (!chart) return;
      if (data && data.length) {
        const from = -0.5;
        const to = data.length - 0.5 + 6;
        this.animateLogicalRangeTo(spanId, from, to, { duration: 360 });
      } else {
        chart.timeScale().fitContent();
      }
    }

    async alignAllToLatest() {
      this.pinnedTime = null;
      this.pinnedSpan = null;
      this.activeRangeHighlight = null;
      this.updateAllRangeHighlights();
      const hudTime = document.getElementById("msHudTime");
      const latest1s = this.candlesData["1s"]?.slice(-1)[0];
      if (hudTime) hudTime.textContent = latest1s ? formatKst(latest1s.time) : "--";
      SPANS.forEach((s) => {
        try {
          this.charts[s.id]?.clearCrosshairPosition();
          this.macdCharts[s.id]?.clearCrosshairPosition();
        } catch (_) {}
        const lastCandle = this.candlesData[s.id]?.slice(-1)[0];
        const cardTime = document.getElementById(`msCardTime_${s.id}`);
        if (cardTime && lastCandle) {
          cardTime.textContent = formatKstShort(lastCandle.time, s.id);
        }
        const macdList = this.macdData[s.id]?.macd || [];
        if (macdList.length) {
          const lastM = macdList[macdList.length - 1];
          const sigList = this.macdData[s.id]?.signal || [];
          const lastS = sigList.length ? sigList[sigList.length - 1] : null;
          const histList = this.macdData[s.id]?.histogram || [];
          const lastH = histList.length ? histList[histList.length - 1] : null;
          this.updateMacdLegend(s.id, lastM?.value, lastS?.value, lastH?.value);
        }
      });

      const tasks = SPANS.map(async (s) => {
        if (this.isHistorical[s.id]) {
          await this.reloadSpanToLatest(s.id);
        } else {
          const chart = this.charts[s.id];
          const data = this.candlesData[s.id];
          if (chart && data && data.length) {
            const curLogical = chart.timeScale().getVisibleLogicalRange();
            const count = (curLogical && typeof curLogical.from === "number" && typeof curLogical.to === "number")
              ? Math.max(10, Math.round(curLogical.to - curLogical.from))
              : 100;
            const to = data.length - 0.5 + 6;
            const from = to - count;
            this.animateLogicalRangeTo(s.id, from, to, { duration: 360 });
          }
        }
      });
      await Promise.all(tasks);
    }

    clearPendingLoadTimers() {
      if (this.strategyReplayTimer) {
        clearTimeout(this.strategyReplayTimer);
        this.strategyReplayTimer = null;
      }
      if (this._initialRetryTimer) {
        clearTimeout(this._initialRetryTimer);
        this._initialRetryTimer = null;
      }
      if (this.loadMoreTimeout) {
        Object.keys(this.loadMoreTimeout).forEach((k) => {
          if (this.loadMoreTimeout[k]) {
            clearTimeout(this.loadMoreTimeout[k]);
            this.loadMoreTimeout[k] = null;
          }
        });
      }
      if (this.prefetchTimers) {
        Object.keys(this.prefetchTimers).forEach((k) => {
          if (this.prefetchTimers[k]) {
            clearTimeout(this.prefetchTimers[k]);
            this.prefetchTimers[k] = null;
          }
        });
      }
    }

    setSymbol(sym) {
      if (sym === this.symbol) return;
      this.clearPendingLoadTimers();
      this.symbol = sym;
      this.loaded = false;
      this.pinnedTime = null;
      this.pinnedSpan = null;
      this.activeNavId += 1;
      this.activeRangeHighlight = null;
      this.isHistorical = {};
      this.reloadingSpans = {};
      this.rangeReloadingSpans = {};
      this.noOlderBefore = {};
      this.noNewerBefore = {};
      this.strategyReplayResult = null;
      this.entrySignals = [];
      this.candlesData = {};
      this.macdData = {};
      this.stopRealtimeFeeds();

      SPANS.forEach((s) => {
        this.cancelSpanAnimation(s.id);
        this.fetchSeq[s.id] = (this.fetchSeq[s.id] || 0) + 1;
        this.syncCardHistoricalUI(s.id, { isHistorical: false });
        try {
          this.charts[s.id]?.clearCrosshairPosition();
          this.macdCharts[s.id]?.clearCrosshairPosition();
          if (typeof this.series[s.id]?.setMarkers === "function") this.series[s.id].setMarkers([]);
        } catch (_) {}
      });
      this.updateAllRangeHighlights();
      const hudTime = document.getElementById("msHudTime");
      if (hudTime) hudTime.textContent = "--";

      const container = document.getElementById("tabContentMultiSpan");
      if (container) {
        container.classList.add("mainTabLoading");
        container.setAttribute("aria-busy", "true");
      }
      this.fetchInitialData();
    }

    formatKstTick(time, tickMarkType, spanId) {
      return formatKstTick(time, tickMarkType, spanId);
    }

    onTabActivated() {
      this.mount();
      this.resizeAll();
      this.startRealtimeFeeds();
    }

    onTabDeactivated() {
      this.clearPendingLoadTimers();
      this.stopRealtimeFeeds();
    }
  }

  const instance = new MultiSpanTab();
  instance.SPANS = SPANS;
  instance.MACD_RULES = MACD_RULES;
  return instance;
});
