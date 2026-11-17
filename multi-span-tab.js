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
    { id: "1s", label: "1-SECOND", sub: "Ultra HF Tick Momentum", color: "#38bdf8", defaultLimit: 1000 },
    { id: "5m", label: "5-MINUTE", sub: "Micro Intraday Scalp", color: "#34d399", defaultLimit: 500 },
    { id: "15m", label: "15-MINUTE", sub: "Intraday Swing Structure", color: "#fbbf24", defaultLimit: 500 },
    { id: "1h", label: "1-HOUR", sub: "Intermediate Trend Regime", color: "#a78bfa", defaultLimit: 500 },
    { id: "1d", label: "1-DAY", sub: "Macro Daily Context", color: "#f472b6", defaultLimit: 365 },
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

  class MultiSpanTab {
    constructor() {
      this.mounted = false;
      this.loaded = false;
      this.symbol = "BTCUSDT";
      this.syncEnabled = true;
      this.syncMode = "anchor"; // "anchor" (center-time + zoom ratio) or "range" (strict timestamp window)
      this.syncZoomRatio = true;
      this.activeLayout = "grid"; // "grid", "hero", "stack"
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
        <div class="multiSpanToolbar" style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:12px 18px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;box-shadow:0 4px 16px rgba(0,0,0,0.3);">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:20px;">🔭</span>
              <div>
                <strong style="font-size:15px;color:#f8fafc;letter-spacing:-0.3px;display:block;">Multi-Span Synchronized Matrix</strong>
                <small style="color:#64748b;font-size:11px;">1s · 5m · 15m · 1h · 1d Multi-Timeframe Engine</small>
              </div>
            </div>
            <div style="height:28px;width:1px;background:#334155;margin:0 4px;"></div>
            <!-- Symbol Selector -->
            <div class="multiSpanSymbolGroup" style="display:flex;align-items:center;gap:4px;">
              <span style="font-size:11px;color:#94a3b8;font-weight:700;">SYMBOL:</span>
              <div id="msSymbolButtons" style="display:inline-flex;background:#1e293b;padding:2px;border-radius:6px;gap:2px;">
                <button type="button" class="msSymBtn active" data-sym="BTCUSDT" style="background:#0284c7;color:#fff;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">BTC</button>
                <button type="button" class="msSymBtn" data-sym="ETHUSDT" style="background:transparent;color:#94a3b8;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">ETH</button>
                <button type="button" class="msSymBtn" data-sym="SOLUSDT" style="background:transparent;color:#94a3b8;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">SOL</button>
                <button type="button" class="msSymBtn" data-sym="DOGEUSDT" style="background:transparent;color:#94a3b8;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">DOGE</button>
                <button type="button" class="msSymBtn" data-sym="XRPUSDT" style="background:transparent;color:#94a3b8;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">XRP</button>
              </div>
              <input type="text" id="msCustomSymbolInput" placeholder="CUSTOM" style="background:#1e293b;border:1px solid #334155;color:#f8fafc;padding:3px 8px;border-radius:4px;font-size:11px;width:70px;text-transform:uppercase;font-weight:700;margin-left:4px;" />
              <button type="button" id="msApplyCustomSym" style="background:#334155;color:#e2e8f0;border:none;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;">GO</button>
            </div>
          </div>

          <!-- Controls: Sync & Layout -->
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <!-- Sync Toggle -->
            <div style="display:flex;align-items:center;gap:6px;background:#1e293b;padding:3px 10px;border-radius:6px;border:1px solid #334155;">
              <span style="font-size:11px;color:#94a3b8;font-weight:700;">SYNC:</span>
              <button type="button" id="msToggleSync" style="background:#10b981;color:#fff;border:none;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Toggle synchronized panning & zooming">🔗 ON</button>
              <button type="button" id="msToggleSyncMode" style="background:#334155;color:#f8fafc;border:none;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Anchor mode keeps optimal zoom per span; Range mode forces identical time window">⚓ ANCHOR</button>
            </div>

            <!-- Zoom Level & Presets (Synchronized Candle Count) -->
            <div style="display:flex;align-items:center;gap:4px;background:#1e293b;padding:3px 8px;border-radius:6px;border:1px solid #334155;">
              <span style="font-size:11px;color:#94a3b8;font-weight:700;">ZOOM:</span>
              <span id="msCandleCountBadge" style="background:#0284c7;color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:800;font-variant-numeric:tabular-nums;" title="Visible candles per chart">100 BARS</span>
              <button type="button" class="msZoomPresetBtn" data-count="30" style="background:#334155;color:#94a3b8;border:none;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 30 candles">30</button>
              <button type="button" class="msZoomPresetBtn" data-count="60" style="background:#334155;color:#94a3b8;border:none;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 60 candles">60</button>
              <button type="button" class="msZoomPresetBtn" data-count="100" style="background:#0284c7;color:#fff;border:none;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 100 candles">100</button>
              <button type="button" class="msZoomPresetBtn" data-count="200" style="background:#334155;color:#94a3b8;border:none;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:700;cursor:pointer;" title="Zoom to 200 candles">200</button>
            </div>

            <!-- Quick Actions -->
            <button type="button" id="msAlignLatest" style="background:#1e293b;border:1px solid #334155;color:#38bdf8;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:4px;" title="Align all 5 charts to the latest live candle">🎯 LATEST</button>
            <button type="button" id="msFitAll" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer;" title="Auto-fit all candles">📐 FIT ALL</button>

            <!-- Layout Selector -->
            <div style="display:inline-flex;background:#1e293b;padding:2px;border-radius:6px;gap:2px;">
              <button type="button" class="msLayoutBtn active" data-layout="grid" style="background:#0284c7;color:#fff;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Grid view">⊞ GRID</button>
              <button type="button" class="msLayoutBtn" data-layout="hero" style="background:transparent;color:#94a3b8;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Hero + Strip view">▣ HERO</button>
              <button type="button" class="msLayoutBtn" data-layout="stack" style="background:transparent;color:#94a3b8;border:none;padding:3px 9px;border-radius:4px;font-size:11px;font-weight:700;cursor:pointer;" title="Full vertical stack">☰ STACK</button>
            </div>
          </div>
        </div>

        <!-- Integrated Synchronized Crosshair HUD -->
        <div id="msCrosshairHud" style="background:rgba(15,23,42,0.85);backdrop-filter:blur(6px);border:1px solid #1e293b;border-radius:8px;padding:8px 14px;margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;font-size:12px;font-variant-numeric:tabular-nums;color:#e2e8f0;">
          <div style="display:flex;align-items:center;gap:12px;">
            <span style="font-weight:800;color:#38bdf8;font-size:13px;" id="msHudSymbol">BTCUSDT</span>
            <span style="color:#64748b;">|</span>
            <span style="color:#94a3b8;">TIME: <strong id="msHudTime" style="color:#f8fafc;">--</strong></span>
          </div>
          <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:11px;">
            ${SPANS.map((s) => `
              <span id="msHudSpan_${s.id}" style="color:${s.color};">
                <strong>${s.id}:</strong> <span id="msHudVal_${s.id}" style="color:#f8fafc;">--</span>
              </span>
            `).join("")}
          </div>
        </div>

        <!-- Charts Container (Switched via activeLayout class) -->
        <div id="msChartsWrapper" class="msLayoutGrid" style="display:grid;gap:12px;width:100%;">
          ${SPANS.map((s) => `
            <div id="msCard_${s.id}" class="msChartCard" style="background:#0b1329;border:1px solid #1e293b;border-radius:10px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 4px 12px rgba(0,0,0,0.25);">
              <div class="msCardHeader" style="background:#0f172a;padding:8px 12px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e293b;">
                <div style="display:flex;align-items:center;gap:8px;">
                  <span style="background:${s.color};color:#0b1329;font-weight:900;font-size:11px;padding:2px 6px;border-radius:4px;letter-spacing:0.5px;">${s.id.toUpperCase()}</span>
                  <span style="color:#f8fafc;font-weight:700;font-size:12px;">${s.label}</span>
                  <small style="color:#64748b;font-size:11px;">${s.sub}</small>
                </div>
                <div style="display:flex;align-items:center;gap:10px;font-size:11px;">
                  <div style="color:#94a3b8;font-family:monospace;" id="msCardOhlc_${s.id}">O:-- H:-- L:-- C:--</div>
                  <span id="msCardPrice_${s.id}" style="font-weight:800;color:#10b981;font-size:13px;">--</span>
                  <button type="button" class="msCardHeroBtn" data-span="${s.id}" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Set as Hero focus">HERO</button>
                  <button type="button" class="msCardFitBtn" data-span="${s.id}" style="background:#1e293b;border:1px solid #334155;color:#94a3b8;font-size:10px;padding:2px 6px;border-radius:4px;cursor:pointer;" title="Fit this chart">FIT</button>
                </div>
              </div>
              <div id="msChartHost_${s.id}" class="msChartHost" style="width:100%;height:320px;position:relative;"></div>
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
        wrapper.style.gridTemplateColumns = "repeat(auto-fit, minmax(460px, 1fr))";
        SPANS.forEach((s) => {
          const host = document.getElementById(`msChartHost_${s.id}`);
          if (host) host.style.height = "320px";
        });
      } else if (this.activeLayout === "hero") {
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
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
        SPANS.forEach((s) => {
          const card = document.getElementById(`msCard_${s.id}`);
          const host = document.getElementById(`msChartHost_${s.id}`);
          if (card) card.style.order = "0";
          if (host) host.style.height = "340px";
        });
      }
      this.resizeAll();
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
            background: { type: "solid", color: "#0b1329" },
            textColor: "#94a3b8",
            fontSize: 11,
          },
          grid: {
            vertLines: { color: "rgba(255, 255, 255, 0.04)" },
            horzLines: { color: "rgba(255, 255, 255, 0.04)" },
          },
          crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
            vertLine: { color: s.color, width: 1, style: 2, labelBackgroundColor: "#0284c7" },
            horzLine: { color: s.color, width: 1, style: 2, labelBackgroundColor: "#0284c7" },
          },
          rightPriceScale: {
            borderColor: "#1e293b",
            scaleMargins: { top: 0.1, bottom: 0.15 },
          },
          timeScale: {
            borderColor: "#1e293b",
            timeVisible: true,
            secondsVisible: s.id === "1s",
            rightOffset: 6,
            minBarSpacing: 1.0,
            lockVisibleTimeRangeOnResize: true,
          },
        });

        const candleSeries = chart.addCandlestickSeries({
          upColor: "#10b981",
          downColor: "#ef4444",
          borderVisible: false,
          wickUpColor: "#10b981",
          wickDownColor: "#ef4444",
        });

        const ma20 = chart.addLineSeries({
          color: s.color,
          lineWidth: 1,
          priceLineVisible: false,
          title: "MA20",
        });

        const ma50 = chart.addLineSeries({
          color: "#f59e0b",
          lineWidth: 1,
          priceLineVisible: false,
          title: "MA50",
        });

        this.charts[s.id] = chart;
        this.series[s.id] = candleSeries;
        this.ma20[s.id] = ma20;
        this.ma50[s.id] = ma50;

        // Wire range & logical range synchronization
        chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
          this.handleRangeChange(s.id, range);
        });

        // Wire visible logical range change for synchronized candle count (zoom sync)
        chart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
          this.handleLogicalRangeChange(s.id, logicalRange);
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
    }

    // =========================================================================
    // SYNCHRONIZED PANNING & ZOOMING ENGINE
    // =========================================================================

    handleRangeChange(sourceSpan, range) {
      if (!this.syncEnabled || this.isSyncing || this.isLogicalSyncing) return;
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

      this.isSyncing = true;
      try {
        SPANS.forEach((s) => {
          if (s.id === sourceSpan) return;
          const targetChart = this.charts[s.id];
          if (!targetChart) return;

          if (this.syncMode === "range") {
            // Strict Time Window Mode
            targetChart.timeScale().setVisibleRange({ from: range.from, to: range.to });
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
              targetChart.timeScale().setVisibleRange({ from: targetFrom, to: targetTo });
            }
          }
        });
      } catch (_) {
      } finally {
        // Debounce releasing sync lock using requestAnimationFrame to prevent feedback loops
        if (!this.rafPending) {
          this.rafPending = true;
          requestAnimationFrame(() => {
            this.isSyncing = false;
            this.rafPending = false;
          });
        }
      }
    }

    // =========================================================================
    // SYNCHRONIZED ZOOM LEVEL (SAME NUMBER OF CANDLES ON EACH CHART)
    // =========================================================================

    handleLogicalRangeChange(sourceSpan, logicalRange) {
      if (!this.syncEnabled || this.isLogicalSyncing || this.isSyncing) return;
      if (!logicalRange || typeof logicalRange.from !== "number" || typeof logicalRange.to !== "number") return;

      const rawCount = logicalRange.to - logicalRange.from;
      if (rawCount <= 1 || isNaN(rawCount)) return;

      // Only sync if visible candle count changed by at least 1 bar (i.e. zoom event)
      if (Math.abs(rawCount - this.syncedCandleCount) < 1) return;

      const newBarCount = Math.max(10, Math.min(1000, Math.round(rawCount)));
      this.syncedCandleCount = newBarCount;
      this.updateCandleCountBadge(newBarCount);

      this.isLogicalSyncing = true;
      try {
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

          targetChart.timeScale().setVisibleLogicalRange({ from: targetFrom, to: targetTo });
        });
      } catch (_) {
      } finally {
        if (!this.logicalRafPending) {
          this.logicalRafPending = true;
          requestAnimationFrame(() => {
            this.isLogicalSyncing = false;
            this.logicalRafPending = false;
          });
        }
      }
    }

    setSyncedCandleCount(count) {
      const roundedBars = Math.max(10, Math.min(1000, Math.round(count)));
      this.syncedCandleCount = roundedBars;
      this.updateCandleCountBadge(roundedBars);

      this.isLogicalSyncing = true;
      try {
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
          targetChart.timeScale().setVisibleLogicalRange({ from: targetFrom, to: targetTo });
        });
      } catch (_) {
      } finally {
        if (!this.logicalRafPending) {
          this.logicalRafPending = true;
          requestAnimationFrame(() => {
            this.isLogicalSyncing = false;
            this.logicalRafPending = false;
          });
        }
      }
    }

    updateCandleCountBadge(count) {
      const badge = document.getElementById("msCandleCountBadge");
      if (badge) badge.textContent = `${count} BARS`;
      document.querySelectorAll(".msZoomPresetBtn").forEach((btn) => {
        const c = Number(btn.getAttribute("data-count"));
        const isActive = Math.abs(c - count) <= 2;
        btn.style.background = isActive ? "#0284c7" : "#334155";
        btn.style.color = isActive ? "#fff" : "#94a3b8";
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
      // Click on ANY chart (especially coarser charts) broadcasts time point, updates HUD, aligns crosshairs, and centers narrower charts
      this.broadcastTimePoint(param.time, sourceSpan, sourceSpan !== "1s");
    }

    broadcastTimePoint(time, sourceSpan = null, recenterNarrower = false) {
      if (!time) return;
      const timeStr = formatKst(time);
      const hudTime = document.getElementById("msHudTime");
      if (hudTime) hudTime.textContent = timeStr;

      // Source index to determine which charts are narrower
      const sourceIdx = sourceSpan ? SPANS.findIndex((p) => p.id === sourceSpan) : -1;

      // Update crosshairs across all other charts & update HUD
      SPANS.forEach((s, idx) => {
        const series = this.series[s.id];
        const chart = this.charts[s.id];
        const valEl = document.getElementById(`msHudVal_${s.id}`);
        const cardOhlc = document.getElementById(`msCardOhlc_${s.id}`);

        const candle = this.findCandleAtOrBefore(s.id, time);

        if (chart && series && s.id !== sourceSpan) {
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

        // Drill-down: if clicking a coarser chart, center narrower charts on the clicked timestamp
        if (recenterNarrower && chart && candle && sourceIdx > 0 && idx < sourceIdx) {
          try {
            const candleIdx = this.findCandleIndexAtOrBefore(s.id, time);
            const count = this.syncedCandleCount || 100;
            if (candleIdx !== -1) {
              chart.timeScale().setVisibleLogicalRange({ from: candleIdx - count / 2, to: candleIdx + count / 2 });
            } else {
              const range = chart.timeScale().getVisibleRange();
              if (range && range.to > range.from) {
                const duration = range.to - range.from;
                const targetFrom = Math.round(time - duration / 2);
                const targetTo = Math.round(time + duration / 2);
                chart.timeScale().setVisibleRange({ from: targetFrom, to: targetTo });
              }
            }
          } catch (_) {}
        }
      });
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

    async fetchKlinesForSpan(symbol, span, limit) {
      const is1s = span === "1s";
      const proxyPath = window.location.pathname.startsWith("/skhynix") ? "/skhynix/api/klines" : "/api/klines";
      const endpoints = [
        `${window.location.origin}${proxyPath}?symbol=${symbol}&interval=${span}&limit=${limit}${is1s ? "&market=spot" : ""}`,
        is1s
          ? `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&limit=${limit}`
          : `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${span}&limit=${limit}`,
        is1s
          ? `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&limit=${limit}`)}`
          : `https://api.allorigins.win/raw?url=${encodeURIComponent(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${span}&limit=${limit}`)}`,
      ];

      for (const url of endpoints) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
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

    setSpanData(spanId, rawCandles) {
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
        const to = clean.length - 0.5 + 6;
        const from = to - count;
        try {
          chart.timeScale().setVisibleLogicalRange({ from, to });
        } catch (_) {
          chart.timeScale().fitContent();
        }
        this.lastVisibleRange[spanId] = chart.timeScale().getVisibleRange();
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
      const list = this.candlesData[spanId] || [];
      if (!list.length) return;
      const last = list[list.length - 1];
      if (last && last.time === candle.time) {
        list[list.length - 1] = candle;
      } else if (last && candle.time > last.time) {
        list.push(candle);
        if (list.length > 2000) list.shift();
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
              b.style.color = b === btn ? "#fff" : "#94a3b8";
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
            b.style.color = "#94a3b8";
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
          syncToggle.style.background = this.syncEnabled ? "#10b981" : "#475569";
        });
      }

      // Sync mode toggle (Anchor vs Range)
      const modeToggle = document.getElementById("msToggleSyncMode");
      if (modeToggle) {
        modeToggle.addEventListener("click", () => {
          this.syncMode = this.syncMode === "anchor" ? "range" : "anchor";
          modeToggle.textContent = this.syncMode === "anchor" ? "⚓ ANCHOR" : "⏱️ RANGE";
          modeToggle.style.color = this.syncMode === "anchor" ? "#f8fafc" : "#38bdf8";
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
          SPANS.forEach((s) => {
            const chart = this.charts[s.id];
            if (chart) chart.timeScale().fitContent();
          });
        });
      }

      // Individual Card Fit & Hero buttons
      document.querySelectorAll(".msCardFitBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const span = e.currentTarget.getAttribute("data-span");
          if (this.charts[span]) this.charts[span].timeScale().fitContent();
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
            b.style.color = b === btn ? "#fff" : "#94a3b8";
          });
          this.setLayout(l);
        });
      });
    }

    setLayout(layout) {
      this.activeLayout = layout;
      this.applyLayoutStyles();
    }

    alignAllToLatest() {
      const count = this.syncedCandleCount || 100;
      SPANS.forEach((s) => {
        const chart = this.charts[s.id];
        const data = this.candlesData[s.id];
        if (chart && data && data.length) {
          const to = data.length - 0.5 + 6;
          const from = to - count;
          try {
            chart.timeScale().setVisibleLogicalRange({ from, to });
          } catch (_) {
            chart.timeScale().scrollToRealTime();
          }
        }
      });
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
