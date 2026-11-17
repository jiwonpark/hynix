/**
 * HYPERION Multi-Span Synchronized Terminal (Tab 10)
 * 5-Span Synchronized Candlestick Charts: 1s · 5m · 15m · 1h · 1d
 * Real-time tick streaming, synchronized panning, zooming, and crosshair tracking.
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

  const formatKst = (dateOrSec) => {
    if (!dateOrSec && dateOrSec !== 0) return "--";
    const ms = typeof dateOrSec === "number" ? (dateOrSec < 1e11 ? dateOrSec * 1000 : dateOrSec) : Number(dateOrSec);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return "--";
    return d.toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " KST";
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

  class MultiSpanTab {
    constructor() {
      this.mounted = false;
      this.loaded = false;
      this.symbol = "BTCUSDT";
      this.syncEnabled = true;
      this.syncMode = "anchor"; // "anchor" (center-time + zoom ratio) or "range" (strict timestamp window)
      this.syncZoomRatio = true;
      this.activeLayout = "grid"; // "grid", "hero", "stack"
      this.chartsPerRow = (typeof localStorage !== "undefined" && localStorage.getItem("ms_charts_per_row")) || "auto"; // "1", "2", "3", "4", "5", "auto"
      this.heroSpan = "1s";
      
      this.charts = {}; // span -> chart
      this.series = {}; // span -> candlestickSeries
      this.ma20 = {};   // span -> lineSeries
      this.ma50 = {};   // span -> lineSeries
      this.volumeSeries = {}; // span -> histogramSeries
      this.candlesData = {}; // span -> array of { time, open, high, low, close, volume }
      this.lastVisibleRange = {}; // span -> { from, to }

      this.syncedCandleCount = 100; // Synchronized visible candle count across all 5 charts
      this.isSyncing = false;
      this.isLogicalSyncing = false;
      this.rafPending = false;
      this.logicalRafPending = false;
      this.reloadingSpans = {}; // spanId -> boolean
      this.isHistorical = {};   // spanId -> boolean
      this.activeRangeHighlight = null; // { navId, sourceSpan, sourceLabel, sourceColor, startTime, endTime, finerSpans, readySpans }
      this.loadMoreTimeout = {}; // spanId -> timeoutId
      this.animations = {};       // spanId -> active pan/zoom animation state
      this.animatingSpans = {};   // spanId -> boolean
      this.programmaticSpans = {}; // spanId -> boolean
      this.animRafId = null;
      this.animationDurationScale = 1.0;
      this.activeNavId = 0;
      this.spanNavIds = {};       // spanId -> latest navId
      this.fetchSeq = {};         // spanId -> fetch sequence counter
      this.ws = null;
      this.pollInterval = null;
      this.resizeObserver = null;
    }

    mount(containerId = "tabContentMultiSpan") {
      if (this.mounted) return;
      const container = document.getElementById(containerId);
      if (!container) return;

      this.renderSkeleton(container);
      this.initCharts();
      this.bindControls();
      this.mounted = true;
      this.fetchInitialData();
    }

    renderSkeleton(container) {
      container.innerHTML = `
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
              <button type="button" id="msToggleSync" style="background:#059669;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Toggle synchronized panning & zooming">🔗 ON</button>
              <button type="button" id="msToggleSyncMode" style="background:#ffffff;border:1px solid #cbd5e1;color:#0f172a;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Anchor mode keeps optimal zoom per span; Range mode forces identical time window">⚓ ANCHOR</button>
            </div>

            <!-- Zoom Level & Presets (Synchronized Candle Count) -->
            <div style="display:flex;align-items:center;gap:4px;background:#f8fafc;padding:3px 8px;border-radius:6px;border:1px solid #e2e8f0;">
              <span style="font-size:11px;color:#64748b;font-weight:700;">ZOOM:</span>
              <span id="msCandleCountBadge" style="background:#0284c7;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;" title="Visible candles per chart">100 BARS</span>
              <button type="button" class="msZoomPresetBtn" data-count="30" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 30 candles">30</button>
              <button type="button" class="msZoomPresetBtn" data-count="60" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 60 candles">60</button>
              <button type="button" class="msZoomPresetBtn active" data-count="100" style="background:#0284c7;color:#fff;border:1px solid #0284c7;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 100 candles">100</button>
              <button type="button" class="msZoomPresetBtn" data-count="200" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 200 candles">200</button>
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

        <!-- Integrated Synchronized Crosshair HUD -->
        <div id="msCrosshairHud" style="background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:8px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;font-variant-numeric:tabular-nums;color:#1e293b;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-weight:800;color:#0284c7;font-size:13px;" id="msHudSymbol">BTCUSDT</span>
            <span style="color:#cbd5e1;">|</span>
            <span style="color:#64748b;">TIME: <strong id="msHudTime" style="color:#0f172a;">--</strong></span>
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
                  <span id="msCardModeBadge_${s.id}" class="msCardModeBadge" data-span="${s.id}" style="display:none;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;cursor:pointer;"></span>
                </div>
                <div style="display:flex;align-items:center;gap:6px;font-size:11px;flex-wrap:wrap;">
                  <div style="color:#64748b;font-family:monospace;" id="msCardOhlc_${s.id}">O:-- H:-- L:-- C:--</div>
                  <span id="msCardPrice_${s.id}" style="font-weight:800;color:#059669;font-size:13px;">--</span>
                  <button type="button" class="msCardLoadMoreBtn" data-span="${s.id}" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Load older historical candles">+ LOAD MORE</button>
                  <button type="button" class="msCardHeroBtn" data-span="${s.id}" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Set as Hero focus">HERO</button>
                  <button type="button" class="msCardFitBtn" data-span="${s.id}" style="background:#ffffff;border:1px solid #cbd5e1;color:#475569;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Fit this chart">FIT</button>
                </div>
              </div>
              <div id="msChartHost_${s.id}" class="msChartHost" style="width:100%;height:320px;position:relative;">
                <div id="msRangeHighlight_${s.id}" class="msRangeHighlight" style="display:none;position:absolute;top:0;bottom:26px;pointer-events:none;z-index:3;">
                  <div id="msRangeBadge_${s.id}" style="position:absolute;top:4px;left:4px;font-size:10px;font-weight:700;padding:2px 6px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.15);pointer-events:none;color:#ffffff;"></div>
                </div>
              </div>
            </div>
          `).join("")}
        </div>
      `;

      this.applyLayoutStyles();
    }

    applyLayoutStyles() {
      const wrapper = document.getElementById("msChartsWrapper");
      if (!wrapper) return;

      if (this.activeLayout === "grid") {
        wrapper.style.display = "grid";
        wrapper.style.flexDirection = "";

        const cols = this.chartsPerRow || "auto";
        const winWidth = typeof window !== "undefined" ? window.innerWidth : 1200;

        if (cols === "auto") {
          wrapper.style.gridTemplateColumns = "repeat(auto-fit, minmax(420px, 1fr))";
        } else {
          let numCols = parseInt(cols, 10) || 3;
          if (winWidth <= 640 && numCols > 1) {
            numCols = 1;
          } else if (winWidth <= 1024 && numCols > 2) {
            numCols = 2;
          }
          wrapper.style.gridTemplateColumns = `repeat(${numCols}, minmax(0, 1fr))`;
        }

        const heightMap = {
          "1": "380px",
          "2": "340px",
          "3": "320px",
          "4": "300px",
          "5": "280px",
          "auto": "320px",
        };
        const targetHeight = heightMap[cols] || "320px";

        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          if (card) card.style.order = "0";
          if (host) host.style.height = targetHeight;
        });
      } else if (this.activeLayout === "hero") {
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        wrapper.style.gridTemplateColumns = "";
        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          if (s.id === this.heroSpan) {
            if (card) card.style.order = "-1";
            if (host) host.style.height = "460px";
          } else {
            if (card) card.style.order = "1";
            if (host) host.style.height = "260px";
          }
        });
      } else if (this.activeLayout === "stack") {
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        wrapper.style.gridTemplateColumns = "";
        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          if (card) card.style.order = "0";
          if (host) host.style.height = "360px";
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
          },
          timeScale: {
            borderColor: "#e2e8f0",
            timeVisible: true,
            secondsVisible: s.id === "1s",
            rightOffset: 6,
            minBarSpacing: 0.02,
            lockVisibleTimeRangeOnResize: true,
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
            this.cancelSpanAnimation(s.id);
            this.programmaticSpans[s.id] = false;
          }
        };
        if (typeof host.addEventListener === "function") {
          host.addEventListener("pointerdown", cancelOnInput, { passive: true });
          host.addEventListener("wheel", cancelOnInput, { passive: true });
          host.addEventListener("touchstart", cancelOnInput, { passive: true });
        }

        // Wire range & logical range synchronization
        chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
          this.handleRangeChange(s.id, range);
          this.updateRangeHighlight(s.id);
        });

        // Wire visible logical range change for synchronized candle count (zoom sync)
        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
          this.handleLogicalRangeChange(s.id, logicalRange);
          this.updateRangeHighlight(s.id);
          // Auto load more when user scrolls near earliest loaded candle
          if (
            logicalRange &&
            logicalRange.from < 25 &&
            !this.reloadingSpans[s.id] &&
            !this.animatingSpans[s.id] &&
            !this.programmaticSpans[s.id]
          ) {
            this.debouncedLoadMore(s.id);
          }
        });

        // Wire crosshair tracking
        chart.subscribeCrosshairMove((param) => {
          this.handleCrosshairMove(s.id, param);
        });

        // Wire click for drill-down / synchronization on coarser charts
        chart.subscribeClick((param) => {
          this.handleChartClick(s.id, param);
        });
      });

      // Handle window / element resizing smoothly
      if (typeof ResizeObserver !== "undefined") {
        this.resizeObserver = new ResizeObserver(() => this.resizeAll());
        const wrapper = document.getElementById("msChartsWrapper");
        if (wrapper) this.resizeObserver.observe(wrapper);
      }
    }

    resizeAll() {
      SPANS.forEach((s) => {
        const host = document.getElementById(`msChartHost_${s.id}`);
        const chart = this.charts[s.id];
        if (host && chart) {
          chart.applyOptions({
            width: host.clientWidth,
            height: host.clientHeight,
          });
        }
      });
      this.updateAllRangeHighlights();
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

    cancelSpanAnimation(spanId) {
      if (this.animations[spanId]) {
        delete this.animations[spanId];
      }
      this.animatingSpans[spanId] = false;
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
      // In default Anchor mode, logical range governs zoom level so all charts display the identical candle count
      if (this.syncMode !== "range") return;
      if (!range || !range.from || !range.to || range.from >= range.to) return;

      const prevRange = this.lastVisibleRange[sourceSpan];
      this.lastVisibleRange[sourceSpan] = { ...range };

      const centerTime = (range.from + range.to) / 2;
      const duration = range.to - range.from;

      const zoomFactor = prevRange && prevRange.to > prevRange.from
        ? duration / (prevRange.to - prevRange.from)
        : 1.0;

      SPANS.forEach((s) => {
        if (s.id === sourceSpan) return;
        const targetChart = this.charts[s.id];
        if (!targetChart) return;

        if (this.syncMode === "range") {
          // Strict Time Window Mode with continuous animation
          this.animateTimeRangeTo(s.id, range.from, range.to, { duration: 140 });
        } else {
          // Anchor Mode: Keep optimal resolution, sync center timestamp + proportional zoom
          const targetRange = targetChart.timeScale().getVisibleRange();
          if (targetRange && targetRange.to > targetRange.from) {
            let targetDuration = targetRange.to - targetRange.from;
            if (this.syncZoomRatio && zoomFactor > 0 && Math.abs(zoomFactor - 1.0) > 0.001) {
              targetDuration = Math.max(10, targetDuration * zoomFactor);
            }
            const targetFrom = Math.round(centerTime - targetDuration / 2);
            const targetTo = Math.round(centerTime + targetDuration / 2);
            this.animateTimeRangeTo(s.id, targetFrom, targetTo, { duration: 140 });
          }
        }
      });
    }

    // =========================================================================
    // SYNCHRONIZED ZOOM LEVEL (SAME NUMBER OF CANDLES ON EACH CHART)
    // =========================================================================

    handleLogicalRangeChange(sourceSpan, logicalRange) {
      if (
        !this.syncEnabled ||
        this.isLogicalSyncing ||
        this.isSyncing ||
        this.programmaticSpans[sourceSpan] ||
        this.animatingSpans[sourceSpan]
      ) {
        return;
      }
      if (!logicalRange || typeof logicalRange.from !== "number" || typeof logicalRange.to !== "number") return;

      const rawCount = logicalRange.to - logicalRange.from;
      if (rawCount <= 1 || isNaN(rawCount)) return;

      // Only sync if visible candle count changed by at least 1 bar (i.e. zoom event)
      if (Math.abs(rawCount - this.syncedCandleCount) < 1) return;

      const newBarCount = Math.max(10, Math.min(1000, Math.round(rawCount)));
      this.syncedCandleCount = newBarCount;
      this.updateCandleCountBadge(newBarCount);

      const sourceData = this.candlesData[sourceSpan] || [];
      const isSourceNearRight = sourceData.length > 0 && logicalRange.to >= (sourceData.length - 2);

      SPANS.forEach((s) => {
        if (s.id === sourceSpan) return;
        const targetChart = this.charts[s.id];
        if (!targetChart) return;
        const targetData = this.candlesData[s.id] || [];
        if (!targetData.length) return;

        const targetRange = targetChart.timeScale().getVisibleLogicalRange();
        let targetTo, targetFrom;

        if (isSourceNearRight || !targetRange || targetRange.to >= (targetData.length - 2)) {
          // Anchor target chart to its right edge (latest candle)
          targetTo = targetData.length - 0.5 + 6;
          targetFrom = targetTo - newBarCount;
        } else {
          // Anchor target chart around its current center logical index
          const center = (targetRange.from + targetRange.to) / 2;
          targetFrom = center - newBarCount / 2;
          targetTo = center + newBarCount / 2;
        }

        this.animateLogicalRangeTo(s.id, targetFrom, targetTo, { duration: 160 });
      });
    }

    setSyncedCandleCount(count) {
      const roundedBars = Math.max(10, Math.min(1000, Math.round(count)));
      this.syncedCandleCount = roundedBars;
      this.updateCandleCountBadge(roundedBars);

      SPANS.forEach((s) => {
        const targetChart = this.charts[s.id];
        if (!targetChart) return;
        const targetData = this.candlesData[s.id] || [];
        if (!targetData.length) return;

        const targetRange = targetChart.timeScale().getVisibleLogicalRange();
        let targetTo, targetFrom;

        if (!targetRange || targetRange.to >= (targetData.length - 2)) {
          targetTo = targetData.length - 0.5 + 6;
          targetFrom = targetTo - roundedBars;
        } else {
          const center = (targetRange.from + targetRange.to) / 2;
          targetFrom = center - roundedBars / 2;
          targetTo = center + roundedBars / 2;
        }
        this.animateLogicalRangeTo(s.id, targetFrom, targetTo, { duration: 320 });
      });
    }

    updateCandleCountBadge(count) {
      const badge = document.getElementById("msCandleCountBadge");
      if (badge) badge.textContent = `${count} BARS`;
      document.querySelectorAll(".msZoomPresetBtn").forEach((btn) => {
        const c = Number(btn.getAttribute("data-count"));
        const isActive = Math.abs(c - count) <= 2;
        btn.style.background = isActive ? "#0284c7" : "#ffffff";
        btn.style.color = isActive ? "#ffffff" : "#475569";
        btn.style.borderColor = isActive ? "#0284c7" : "#cbd5e1";
      });
    }

    // =========================================================================
    // SYNCHRONIZED CROSSHAIR & MULTI-SPAN HUD
    // =========================================================================

    handleCrosshairMove(sourceSpan, param) {
      if (!param || !param.time) {
        // Clear crosshairs on other charts only if leaving finest chart
        if (sourceSpan === "1s") {
          SPANS.forEach((s) => {
            if (s.id !== sourceSpan && this.charts[s.id]) {
              this.charts[s.id].clearCrosshairPosition();
            }
          });
        }
        return;
      }

      // If hovered on a COARSER chart: only update that local chart's own card OHLC, do NOT broadcast to other charts!
      if (sourceSpan !== "1s") {
        const series = this.series[sourceSpan];
        const hoveredCandle = (param.seriesData?.get(series)) || this.findCandleAtOrBefore(sourceSpan, param.time);
        if (hoveredCandle) {
          const cardOhlc = document.getElementById(`msCardOhlc_${sourceSpan}`);
          if (cardOhlc) {
            cardOhlc.textContent = `O:${formatPrice(hoveredCandle.open)} H:${formatPrice(hoveredCandle.high)} L:${formatPrice(hoveredCandle.low)} C:${formatPrice(hoveredCandle.close)}`;
          }
        }
        return;
      }

      // Hover on FINEST chart ("1s"): broadcast time point & crosshair across all charts in real time!
      this.broadcastTimePoint(param.time, sourceSpan, false);
    }

    handleChartClick(sourceSpan, param) {
      if (!param || !param.time) return;
      if (sourceSpan === "1s") {
        this.activeNavId += 1;
        this.activeRangeHighlight = null;
        this.updateAllRangeHighlights();
      }
      // Click on ANY chart (especially coarser charts) broadcasts time point, updates HUD, aligns crosshairs, and zooms/pans narrower charts
      this.broadcastTimePoint(param.time, sourceSpan, sourceSpan !== "1s");
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

    computeDrilldownLogicalRange(spanId, startTime, endTime) {
      const data = this.candlesData[spanId];
      if (!data || !data.length) return null;
      const lStart = this.getLogicalIndexForTime(spanId, startTime);
      const lEnd = this.getLogicalIndexForTime(spanId, endTime);
      if (lStart === null || lEnd === null) return null;

      // Visual bounds enclose whole candle bodies cleanly: [lStart - 0.5, lEnd - 0.5]
      const vStart = lStart - 0.5;
      const vEnd = Math.max(vStart + 1, lEnd - 0.5);

      const clampedStart = Math.max(-0.5, vStart);
      const clampedEnd = Math.min(data.length - 0.5, Math.max(clampedStart + 1, vEnd));
      const rangeBars = Math.max(1, clampedEnd - clampedStart);

      const baseBars = this.syncedCandleCount || 100;
      const targetBars = Math.min(
        Math.max(baseBars, Math.ceil(rangeBars * 1.25)),
        Math.max(baseBars, data.length + 12)
      );

      const center = (clampedStart + clampedEnd) / 2;
      let from = center - targetBars / 2;
      let to = center + targetBars / 2;

      if (data.length >= targetBars) {
        const padBars = Math.max(6, Math.round(targetBars * 0.08));
        const maxRight = data.length - 0.5 + padBars;
        const minLeft = -0.5 - padBars;
        if (to > maxRight) {
          to = maxRight;
          from = to - targetBars;
        }
        if (from < minLeft) {
          from = minLeft;
          to = from + targetBars;
        }
      }

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
          };
          this.updateAllRangeHighlights();
        }
      }

      const nowSec = Math.floor(Date.now() / 1000);

      // Update crosshairs, HUD & smoothly pan/zoom narrower charts
      SPANS.forEach((s, idx) => {
        const series = this.series[s.id];
        const chart = this.charts[s.id];
        const valEl = document.getElementById(`msHudVal_${s.id}`);
        const cardOhlc = document.getElementById(`msCardOhlc_${s.id}`);

        const candle = this.findCandleAtOrBefore(s.id, time);

        if (chart && series && s.id !== sourceSpan && !this.reloadingSpans[s.id]) {
          try {
            if (candle) {
              chart.setCrosshairPosition(candle.close, candle.time, series);
            }
          } catch (_) {}
        }

        if (candle) {
          const closeP = formatPrice(candle.close);
          if (valEl) valEl.textContent = closeP;
          if (cardOhlc) {
            cardOhlc.textContent = `O:${formatPrice(candle.open)} H:${formatPrice(candle.high)} L:${formatPrice(candle.low)} C:${closeP}`;
          }
        }

        // Drill-down: if clicking a coarser chart, pan/zoom or reload narrower charts first BEFORE revealing highlight
        if (shouldRecenter && chart && idx < sourceIdx) {
          this.spanNavIds[s.id] = navId;
          const data = this.candlesData[s.id] || [];
          const spanSec = s.sec || 60;
          const hasData = data.length > 0;
          const effectiveEnd = Math.min(targetRangeEnd, nowSec - Math.max(spanSec * 2, 10));
          const hasWholeRange =
            hasData &&
            data[0].time <= targetRangeStart &&
            (data[data.length - 1].time + spanSec) >= effectiveEnd;

          if (hasWholeRange) {
            // Invalidate any pending fetch sequence on this span
            this.fetchSeq[s.id] = (this.fetchSeq[s.id] || 0) + 1;
            this.reloadingSpans[s.id] = false;
            const targetRange = this.computeDrilldownLogicalRange(s.id, targetRangeStart, targetRangeEnd);
            if (targetRange) {
              this.animateLogicalRangeTo(s.id, targetRange.from, targetRange.to, {
                duration: 360,
                onComplete: () => {
                  if (
                    this.activeRangeHighlight &&
                    this.activeRangeHighlight.navId === navId &&
                    this.activeRangeHighlight.finerSpans?.includes(s.id)
                  ) {
                    if (!this.activeRangeHighlight.readySpans) this.activeRangeHighlight.readySpans = {};
                    this.activeRangeHighlight.readySpans[s.id] = true;
                    this.updateRangeHighlight(s.id);
                  }
                },
              });
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
      const badgeEl = document.getElementById(`msRangeBadge_${spanId}`);
      if (!highlightEl) return;

      const hl = this.activeRangeHighlight;
      if (
        !hl ||
        !hl.finerSpans ||
        !hl.finerSpans.includes(spanId) ||
        !hl.readySpans ||
        !hl.readySpans[spanId] ||
        this.reloadingSpans[spanId]
      ) {
        highlightEl.style.display = "none";
        return;
      }

      const chart = this.charts[spanId];
      if (!chart) return;

      const timeScale = chart.timeScale();
      const host = document.getElementById(`msChartHost_${spanId}`);
      const hostWidth = host ? host.clientWidth : 500;
      const chartWidth = (typeof timeScale.width === "function" && timeScale.width() > 0)
        ? timeScale.width()
        : Math.max(10, hostWidth - 60);

      const data = this.candlesData[spanId] || [];
      if (!data.length) {
        highlightEl.style.display = "none";
        return;
      }

      const lStart = this.getLogicalIndexForTime(spanId, hl.startTime);
      const lEnd = this.getLogicalIndexForTime(spanId, hl.endTime);
      if (lStart === null || lEnd === null) {
        highlightEl.style.display = "none";
        return;
      }

      const vStart = lStart - 0.5;
      const vEnd = Math.max(vStart + 1, lEnd - 0.5);
      const vis = typeof timeScale.getVisibleLogicalRange === "function"
        ? timeScale.getVisibleLogicalRange()
        : null;

      const resolveCoord = (logicalIdx) => {
        if (typeof timeScale.logicalToCoordinate === "function") {
          const c = timeScale.logicalToCoordinate(logicalIdx);
          if (c !== null && typeof c === "number" && !isNaN(c)) return c;
        }
        if (vis && vis.to > vis.from) {
          return ((logicalIdx - vis.from) / (vis.to - vis.from)) * chartWidth;
        }
        return null;
      };

      const x1 = resolveCoord(vStart);
      const x2 = resolveCoord(vEnd);

      if (x1 === null || x2 === null) {
        highlightEl.style.display = "none";
        return;
      }

      const rawLeft = Math.min(x1, x2);
      const rawRight = Math.max(x1, x2);

      if (rawRight <= 0 || rawLeft >= chartWidth) {
        highlightEl.style.display = "none";
        return;
      }

      const leftPx = Math.max(0, rawLeft);
      const rightPx = Math.min(chartWidth, rawRight);
      const widthPx = rightPx - leftPx;

      if (widthPx <= 0) {
        highlightEl.style.display = "none";
        return;
      }

      const color = hl.sourceColor || "#0284c7";
      highlightEl.style.display = "block";
      highlightEl.style.left = `${leftPx}px`;
      highlightEl.style.width = `${widthPx}px`;
      highlightEl.style.background = hexToRgba(hl.sourceColor, 0.12);
      highlightEl.style.borderLeft = rawLeft >= -1 ? `2px dashed ${color}` : "none";
      highlightEl.style.borderRight = rawRight <= chartWidth + 1 ? `2px dashed ${color}` : "none";

      if (badgeEl) {
        badgeEl.style.background = color;
        badgeEl.textContent = `${hl.sourceLabel} RANGE`;
      }
    }

    updateAllRangeHighlights() {
      SPANS.forEach((s) => {
        this.updateRangeHighlight(s.id);
      });
    }

    async reloadSpanToRange(spanId, startTime, endTime, navId = null) {
      const spanObj = SPANS.find((p) => p.id === spanId);
      if (!spanObj) return;
      const chart = this.charts[spanId];
      if (!chart) return;

      const reqNavId = navId !== null ? navId : (this.spanNavIds[spanId] || 0);
      const fetchSeq = (this.fetchSeq[spanId] || 0) + 1;
      this.fetchSeq[spanId] = fetchSeq;
      this.reloadingSpans[spanId] = true;
      this.cancelSpanAnimation(spanId);

      // Keep highlight hidden cleanly until fetch + pan/zoom complete
      const hlEl = document.getElementById(`msRangeHighlight_${spanId}`);
      if (hlEl) hlEl.style.display = "none";

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
        const rangeSec = Math.max(spanSec * 20, effectiveRangeEnd - startTime);
        const desiredBuffer = Math.round(rangeSec * 0.15);
        const bufferSec = Math.max(spanSec * 30, Math.min(desiredBuffer, 600 * spanSec));

        let targetStart = Math.max(0, startTime - bufferSec);
        let targetEnd = Math.min(nowSec, endTime + bufferSec);

        // If range + buffer fits comfortably in 1 batch, fetch ~900 candles around it for rich context
        const minWindowSec = 900 * spanSec;
        if (targetEnd - targetStart < minWindowSec) {
          const mid = Math.round((startTime + effectiveRangeEnd) / 2);
          targetStart = Math.max(0, mid - Math.round(minWindowSec / 2));
          targetEnd = Math.min(nowSec, targetStart + minWindowSec);
        }

        // Cap to 5000 candles to avoid excessive pagination/browser freeze
        const maxCandlesForSpan = 5000;
        if ((targetEnd - targetStart) / spanSec > maxCandlesForSpan) {
          targetEnd = Math.min(nowSec, targetStart + maxCandlesForSpan * spanSec);
        }

        const isHistorical = targetEnd < (nowSec - Math.max(300, spanSec * 5));
        if (isHistorical) this.isHistorical[spanId] = true;

        const raw = await this.fetchKlinesRange(this.symbol, spanId, targetStart, targetEnd, 6);

        // Discard stale response if a newer click/reload superseded this fetch
        if (this.fetchSeq[spanId] !== fetchSeq) return;
        if (navId !== null && this.activeRangeHighlight && this.activeRangeHighlight.navId !== reqNavId) return;

        if (Array.isArray(raw) && raw.length) {
          this.isHistorical[spanId] = isHistorical;

          const onAnimationDone = () => {
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

          this.setSpanData(spanId, raw, null, {
            animate: true,
            drilldownStart: startTime,
            drilldownEnd: endTime,
            oldTimeRange,
            onComplete: onAnimationDone,
          });

          const centerTime = Math.round((startTime + effectiveRangeEnd) / 2);
          const candle = this.findCandleAtOrBefore(spanId, centerTime);
          if (candle) {
            try {
              chart.setCrosshairPosition(candle.close, candle.time, this.series[spanId]);
            } catch (_) {}
            const pStr = formatPrice(candle.close);
            const valEl = document.getElementById(`msHudVal_${spanId}`);
            const cardOhlc = document.getElementById(`msCardOhlc_${spanId}`);
            if (valEl) valEl.textContent = pStr;
            if (cardOhlc) {
              cardOhlc.textContent = `O:${formatPrice(candle.open)} H:${formatPrice(candle.high)} L:${formatPrice(candle.low)} C:${pStr}`;
            }
          }

          if (badgeEl) {
            if (isHistorical) {
              badgeEl.style.display = "inline-block";
              badgeEl.textContent = "⏮️ HISTORICAL";
              badgeEl.style.background = "#fee2e2";
              badgeEl.style.color = "#dc2626";
              badgeEl.style.border = "1px solid #fca5a5";
              badgeEl.title = "Viewing historical window. Click to return to latest.";
            } else {
              badgeEl.style.display = "none";
            }
          }
        } else {
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
        }
        this.updateRangeHighlight(spanId);
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
      const fetchSeq = (this.fetchSeq[spanId] || 0) + 1;
      this.fetchSeq[spanId] = fetchSeq;
      this.reloadingSpans[spanId] = true;
      this.cancelSpanAnimation(spanId);
      this.isHistorical[spanId] = false;
      const badgeEl = document.getElementById(`msCardModeBadge_${spanId}`);
      if (badgeEl) badgeEl.style.display = "none";

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
        }
        this.updateRangeHighlight(spanId);
      }
    }

    debouncedLoadMore(spanId) {
      if (this.loadMoreTimeout[spanId]) clearTimeout(this.loadMoreTimeout[spanId]);
      this.loadMoreTimeout[spanId] = setTimeout(() => {
        this.loadMoreHistorical(spanId);
      }, 300);
    }

    async loadMoreHistorical(spanId) {
      if (this.reloadingSpans[spanId]) return;
      const data = this.candlesData[spanId];
      if (!data || !data.length) return;

      const btn = typeof document !== "undefined" && typeof document.querySelector === "function"
        ? document.querySelector(`.msCardLoadMoreBtn[data-span="${spanId}"]`)
        : null;
      if (btn) btn.textContent = "⏳...";

      this.reloadingSpans[spanId] = true;
      this.cancelSpanAnimation(spanId);
      try {
        const earliestTime = data[0].time;
        const endMs = earliestTime * 1000 - 1;
        const raw = await this.fetchKlinesForSpan(this.symbol, spanId, 1000, endMs);
        if (Array.isArray(raw) && raw.length) {
          const older = raw.filter((c) => c.time < earliestTime);
          if (older.length) {
            const merged = [...older, ...data].sort((a, b) => a.time - b.time);
            const addedCount = merged.length - data.length;
            this.candlesData[spanId] = merged;

            const series = this.series[spanId];
            if (series) series.setData(merged);

            const ma20Data = this.calculateSma(merged, 20);
            const ma50Data = this.calculateSma(merged, 50);
            if (this.ma20[spanId]) this.ma20[spanId].setData(ma20Data);
            if (this.ma50[spanId]) this.ma50[spanId].setData(ma50Data);

            const chart = this.charts[spanId];
            if (chart) {
              const currentLogical = chart.timeScale().getVisibleLogicalRange();
              if (currentLogical) {
                this.programmaticSpans[spanId] = true;
                try {
                  chart.timeScale().setVisibleLogicalRange({
                    from: currentLogical.from + addedCount,
                    to: currentLogical.to + addedCount,
                  });
                } finally {
                  const settleLoadMore = () => {
                    this.programmaticSpans[spanId] = false;
                    this.updateRangeHighlight(spanId);
                  };
                  if (typeof requestAnimationFrame === "function") {
                    requestAnimationFrame(settleLoadMore);
                  } else {
                    settleLoadMore();
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        console.error(`Failed to load more for span ${spanId}:`, err);
      } finally {
        this.reloadingSpans[spanId] = false;
        if (btn) btn.textContent = "+ LOAD MORE";
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
      const hudSym = document.getElementById("msHudSymbol");
      if (hudSym) hudSym.textContent = sym;

      try {
        const promises = SPANS.map(async (s) => {
          const raw = await this.fetchKlinesForSpan(sym, s.id, s.defaultLimit);
          return { span: s.id, data: raw };
        });

        const results = await Promise.all(promises);
        results.forEach(({ span, data }) => {
          if (Array.isArray(data) && data.length) {
            this.setSpanData(span, data);
          }
        });

        this.loaded = true;
        const container = document.getElementById("tabContentMultiSpan");
        if (container) {
          container.classList.remove("mainTabLoading");
          container.setAttribute("aria-busy", "false");
        }

        this.startRealtimeFeeds();
      } catch (err) {
        console.error("MultiSpanTab fetch error:", err);
      }
    }

    async fetchKlinesForSpan(symbol, span, limit, endTime = null) {
      const is1s = span === "1s";
      const proxyPath = window.location.pathname.startsWith("/skhynix") ? "/skhynix/api/klines" : "/api/klines";
      const endParam = endTime ? `&endTime=${endTime}` : "";
      const endpoints = [
        `${window.location.origin}${proxyPath}?symbol=${symbol}&interval=${span}&limit=${limit}${is1s ? "&market=spot" : ""}${endParam}`,
        is1s
          ? `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&limit=${limit}${endParam}`
          : `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${span}&limit=${limit}${endParam}`,
        is1s
          ? `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&limit=${limit}${endParam}`)}`
          : `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${span}&limit=${limit}${endParam}`)}`,
      ];

      for (const url of endpoints) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
          if (!res.ok) continue;
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length) {
            return rows.map((r) => ({
              time: Math.floor(Number(r[0]) / 1000),
              open: parseFloat(r[1]),
              high: parseFloat(r[2]),
              low: parseFloat(r[3]),
              close: parseFloat(r[4]),
              volume: parseFloat(r[5] || 0),
            })).sort((a, b) => a.time - b.time);
          }
        } catch (_) {}
      }
      return [];
    }

    async fetchKlinesRange(symbol, span, startTime, endTime, maxBatches = 6) {
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
      return allCandles;
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

      const series = this.series[spanId];
      if (series) series.setData(clean);

      // Compute simple moving averages (MA20 and MA50)
      const ma20Data = this.calculateSma(clean, 20);
      const ma50Data = this.calculateSma(clean, 50);
      if (this.ma20[spanId]) this.ma20[spanId].setData(ma20Data);
      if (this.ma50[spanId]) this.ma50[spanId].setData(ma50Data);

      const latest = clean[clean.length - 1];
      if (latest) {
        const priceEl = document.getElementById(`msCardPrice_${spanId}`);
        const hudVal = document.getElementById(`msHudVal_${spanId}`);
        const cardOhlc = document.getElementById(`msCardOhlc_${spanId}`);
        const pStr = formatPrice(latest.close);
        if (priceEl) priceEl.textContent = pStr;
        if (hudVal) hudVal.textContent = pStr;
        if (cardOhlc) {
          cardOhlc.textContent = `O:${formatPrice(latest.open)} H:${formatPrice(latest.high)} L:${formatPrice(latest.low)} C:${pStr}`;
        }
      }

      const chart = this.charts[spanId];
      if (chart) {
        const count = this.syncedCandleCount || 100;
        let from, to;

        if (options.drilldownStart !== undefined && options.drilldownEnd !== undefined) {
          const drill = this.computeDrilldownLogicalRange(spanId, options.drilldownStart, options.drilldownEnd);
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

        const shouldAnimate = Boolean(options.animate);
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
            const targetW = Math.max(10, to - from);
            const targetCenter = (from + to) / 2;
            const entryW = Math.max(10, Math.min(clean.length, Math.round(targetW * 0.55)));
            entryFrom = targetCenter + entryW * 0.15 - entryW / 2;
            entryTo = entryFrom + entryW;
          }
          this.programmaticSpans[spanId] = true;
          try {
            ts.setVisibleLogicalRange({ from: entryFrom, to: entryTo });
          } catch (_) {
          } finally {
            this.programmaticSpans[spanId] = false;
          }
          this.animateLogicalRangeTo(spanId, from, to, {
            duration: 360,
            onComplete: options.onComplete || null,
          });
        } else {
          this.animateLogicalRangeTo(spanId, from, to, {
            immediate: true,
            onComplete: options.onComplete || null,
          });
        }
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

      const priceEl = document.getElementById(`msCardPrice_${spanId}`);
      const hudVal = document.getElementById(`msHudVal_${spanId}`);
      const cardOhlc = document.getElementById(`msCardOhlc_${spanId}`);
      const pStr = formatPrice(candle.close);
      if (priceEl) priceEl.textContent = pStr;
      if (hudVal) hudVal.textContent = pStr;
      if (cardOhlc) {
        cardOhlc.textContent = `O:${formatPrice(candle.open)} H:${formatPrice(candle.high)} L:${formatPrice(candle.low)} C:${pStr}`;
      }
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

      // Zoom preset buttons
      document.querySelectorAll(".msZoomPresetBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const count = Number(btn.getAttribute("data-count"));
          if (count && count > 0) {
            this.setSyncedCandleCount(count);
          }
        });
      });

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

      // Load more historical candles button
      document.querySelectorAll(".msCardLoadMoreBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          if (span) {
            this.loadMoreHistorical(span);
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
      const count = this.syncedCandleCount || 100;
      const tasks = SPANS.map(async (s) => {
        if (this.isHistorical[s.id]) {
          await this.reloadSpanToLatest(s.id);
        } else {
          const chart = this.charts[s.id];
          const data = this.candlesData[s.id];
          if (chart && data && data.length) {
            const to = data.length - 0.5 + 6;
            const from = to - count;
            this.animateLogicalRangeTo(s.id, from, to, { duration: 360 });
          }
        }
      });
      await Promise.all(tasks);
    }

    setSymbol(sym) {
      if (sym === this.symbol) return;
      this.symbol = sym;
      this.loaded = false;
      const container = document.getElementById("tabContentMultiSpan");
      if (container) {
        container.classList.add("mainTabLoading");
        container.setAttribute("aria-busy", "true");
      }
      this.fetchInitialData();
    }

    onTabActivated() {
      this.mount();
      this.resizeAll();
      this.startRealtimeFeeds();
    }

    onTabDeactivated() {
      this.stopRealtimeFeeds();
    }
  }

  return new MultiSpanTab();
});
