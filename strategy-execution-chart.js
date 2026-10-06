(function (root, factory) {
  const Controller = factory();
  if (typeof module === "object" && module.exports) module.exports = Controller;
  if (root) {
    Controller.installCompactCrosshairMarkers(root.LightweightCharts);
    root.StrategyExecutionChartController = Controller;
    root.StrategyExecutionChartFrame = Controller.Frame;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class StrategyExecutionChartFrame {
    static mount(options = {}) {
      const container = typeof options.container === "string"
        ? document.getElementById(options.container)
        : options.container;
      if (!container) throw new Error("Execution chart frame container not found");
      const id = options.id || "executionChart";
      const ids = Object.assign({
        action: `${id}Action`, actual: `${id}Actual`, virtual: `${id}Virtual`,
        status: `${id}Status`, secondaryStatus: `${id}SecondaryStatus`,
        host: `${id}Host`, legend: `${id}Legend`, sync: `${id}Sync`,
        assetPaneShell: `${id}AssetPaneShell`, assetHost: `${id}AssetHost`, assetDetails: `${id}AssetDetails`,
      }, options.ids || {});
      const actual = options.actual || {};
      const virtual = options.virtual || {};
      const action = options.action || {};
      const grouping = options.grouping || null;
      if (grouping) {
        ids.individualTrades = ids.individualTrades || `${id}IndividualTrades`;
        ids.rangeTrades = ids.rangeTrades || `${id}RangeTrades`;
      }
      container.classList.add("executionChartFrame");
      container.innerHTML = `
        <div class="executionChartToolbar">
          <strong class="executionChartTitle">${options.title || "PRICE-SIGNAL REPLAY"}</strong>
          ${action.label ? `<button id="${ids.action}" class="executionChartAction ${action.className || ""}" type="button">${action.label}</button>` : ""}
          <div class="executionChartVisibility" aria-label="Trade marker visibility">
            <span>SHOW</span>
            <button id="${ids.actual}" type="button" aria-pressed="true" title="Show or hide actual entry and exit fills">✓ ${actual.label || "Actual"}</button>
            <button id="${ids.virtual}" type="button" aria-pressed="true" title="Show or hide virtual backtest entries and exits">✓ ${virtual.label || "Virtual"}</button>
          </div>
          ${grouping ? `
          <div class="executionChartGrouping" aria-label="Trade marker display style">
            <span>TRADES</span>
            <button id="${ids.individualTrades}" type="button" class="${!grouping.asRange ? "isActive" : ""}" aria-pressed="${!grouping.asRange ? "true" : "false"}" title="Show each trade fill individually at its exact price">📍 Individual</button>
            <button id="${ids.rangeTrades}" type="button" class="${grouping.asRange ? "isActive" : ""}" aria-pressed="${grouping.asRange ? "true" : "false"}" title="Group same-candle trades into a single range line">📊 Range</button>
          </div>` : ""}
          <span id="${ids.status}" class="executionChartStatus" role="status">${options.status || "Loading…"}</span>
        </div>
        ${options.description ? `<div class="executionChartDescription">${options.description}</div>` : ""}
        ${options.secondaryStatus ? `<div id="${ids.secondaryStatus}" class="executionChartSecondaryStatus">${options.secondaryStatus}</div>` : ""}
        <div id="${ids.host}" class="executionChartHost" style="height:${Number(options.height) || 420}px"></div>
        ${options.showAssetPane ? `
        <div id="${ids.assetPaneShell}" class="assetPricePaneShell" style="position:relative;height:${Number(options.assetHeight) || 185}px;border-top:2px solid #cbd5e1;background:#fff;width:100%;display:block;">
          <div class="assetPriceLegendBar" style="position:absolute;top:6px;left:12px;z-index:10;display:flex;align-items:center;gap:10px;font-size:11px;background:rgba(255,255,255,0.92);backdrop-filter:blur(4px);padding:3px 8px;border-radius:4px;border:1px solid #cbd5e1;pointer-events:none;">
            <span style="font-weight:800;color:#0f172a;">📊 2-ASSET PRICES:</span>
            <span style="color:#2563eb;font-weight:700;">● SKHYUSDT (ADR, Right Scale)</span>
            <span style="color:#d97706;font-weight:700;">● CSOP 2L ETF / Domestic (Left Scale)</span>
            <span id="${ids.assetDetails}" style="color:#475569;font-family:monospace;font-size:11px;"></span>
          </div>
          <div id="${ids.assetHost}" style="height:${Number(options.assetHeight) || 185}px;min-height:150px;width:100%;display:block;"></div>
        </div>` : ""}
        <div class="executionChartFooter">
          <div id="${ids.legend}" class="executionChartLegend">${options.legend || ""}</div>
          <span id="${ids.sync}" class="executionChartSync">${options.syncText || ""}</span>
        </div>`;

      const elements = {
        action: document.getElementById(ids.action),
        actual: document.getElementById(ids.actual),
        virtual: document.getElementById(ids.virtual),
        individualTrades: grouping ? document.getElementById(ids.individualTrades) : null,
        rangeTrades: grouping ? document.getElementById(ids.rangeTrades) : null,
        status: document.getElementById(ids.status),
        secondaryStatus: document.getElementById(ids.secondaryStatus),
        host: document.getElementById(ids.host),
        legend: document.getElementById(ids.legend),
        sync: document.getElementById(ids.sync),
        assetPaneShell: document.getElementById(ids.assetPaneShell),
        assetHost: document.getElementById(ids.assetHost),
        assetDetails: document.getElementById(ids.assetDetails),
      };
      if (elements.action && typeof action.onClick === "function") elements.action.addEventListener("click", action.onClick);
      if (typeof actual.onToggle === "function") elements.actual.addEventListener("click", actual.onToggle);
      if (typeof virtual.onToggle === "function") elements.virtual.addEventListener("click", virtual.onToggle);
      if (elements.individualTrades && typeof grouping?.onChange === "function") {
        elements.individualTrades.addEventListener("click", () => grouping.onChange(false));
      }
      if (elements.rangeTrades && typeof grouping?.onChange === "function") {
        elements.rangeTrades.addEventListener("click", () => grouping.onChange(true));
      }
      if (actual && actual.enabled === false) elements.actual.disabled = true;
      if (virtual && virtual.enabled === false) elements.virtual.disabled = true;

      const frame = {
        container,
        elements,
        setVisibility(kind, visible) {
          const button = elements[kind];
          if (!button) return;
          const label = kind === "actual" ? (actual.label || "Actual") : (virtual.label || "Virtual");
          button.setAttribute("aria-pressed", visible ? "true" : "false");
          button.classList.toggle("isHidden", !visible);
          button.textContent = `${visible ? "✓" : "○"} ${label}`;
        },
        setGrouping(asRange) {
          if (elements.individualTrades) {
            elements.individualTrades.setAttribute("aria-pressed", !asRange ? "true" : "false");
            elements.individualTrades.classList.toggle("isActive", !asRange);
          }
          if (elements.rangeTrades) {
            elements.rangeTrades.setAttribute("aria-pressed", asRange ? "true" : "false");
            elements.rangeTrades.classList.toggle("isActive", Boolean(asRange));
          }
        },
        setStatus(text) { if (elements.status) elements.status.textContent = text; },
        setSecondaryStatus(text) { if (elements.secondaryStatus) elements.secondaryStatus.textContent = text; },
        setSync(text) { if (elements.sync) elements.sync.textContent = text; },
      };
      frame.setVisibility("actual", actual.visible !== false);
      frame.setVisibility("virtual", virtual.visible !== false);
      if (grouping) frame.setGrouping(Boolean(grouping.asRange));
      return frame;
    }
  }

  class StrategyExecutionChartController {
    constructor(options = {}) {
      this.series = options.series || null;
      this.lineStyle = options.lineStyle || { Solid: 0, Dashed: 2 };
      this.visibility = { actual: true, virtual: true };
      this.executions = [];
      this.referenceLines = [];
    }

    setSeries(series) {
      this.series = series;
    }

    setExecutions(executions = []) {
      this.executions = Array.isArray(executions) ? executions : [];
    }

    setVisibility(kind, visible) {
      if (kind !== "actual" && kind !== "virtual") return;
      this.visibility[kind] = Boolean(visible);
    }

    toggleVisibility(kind) {
      if (kind !== "actual" && kind !== "virtual") return false;
      this.visibility[kind] = !this.visibility[kind];
      return this.visibility[kind];
    }

    isVisible(execution) {
      const source = execution?.source || (execution?.hypothetical ? "virtual" : "actual");
      return this.visibility[source] !== false;
    }

    visibleExecutions() {
      return this.executions.filter((execution) => this.isVisible(execution));
    }

    executionTimeAtX(mouseX, options = {}) {
      const timeScale = options.timeScale;
      if (!Number.isFinite(mouseX) || !timeScale || !this.executions.length) return null;
      const range = timeScale.getVisibleLogicalRange?.();
      const hostWidth = Number(options.hostWidth) || 0;
      const visibleBars = range ? Math.max(1, range.to - range.from) : 0;
      const barSpacing = visibleBars && hostWidth ? hostWidth / visibleBars : 12;
      const columnHalfWidth = Math.max(8, Math.min(24, barSpacing / 2));
      let closestTime = null;
      let closestDistance = Infinity;
      for (const execution of this.visibleExecutions()) {
        const markerX = timeScale.timeToCoordinate(execution.time);
        if (!Number.isFinite(markerX)) continue;
        const distance = Math.abs(mouseX - markerX);
        if (distance <= columnHalfWidth && distance < closestDistance) {
          closestTime = execution.time;
          closestDistance = distance;
        }
      }
      return closestTime;
    }

    markersForRender(hoveredTime = null) {
      const visible = this.visibleExecutions();
      const confirmedKeys = new Set(
        visible.filter((m) => !m.hypothetical).map((m) => `${m.time}_${m.is_entry ? 1 : 0}`)
      );
      const seenKeys = new Set();
      return visible.filter((m) => {
        const key = `${m.time}_${m.is_entry ? 1 : 0}_${m.backtest ? "backtest" : "actual"}`;
        if (m.hypothetical && !m.backtest && confirmedKeys.has(`${m.time}_${m.is_entry ? 1 : 0}`)) return false;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      }).map((m) => {
        const isMatch = hoveredTime !== null && m.time === hoveredTime;
        const isShort = m.shape
          ? m.shape === "arrowDown"
          : (m.direction ? m.direction === "short" : (m.is_entry || m.color === "#dc2626"
            || (typeof m.color === "string" && m.color.includes("220"))));
        const dimAlpha = m.hypothetical ? "0.35" : "0.70";
        return {
          time: m.time,
          position: m.position,
          shape: isShort ? "arrowDown" : "arrowUp",
          color: isMatch
            ? (isShort ? "#dc2626" : "#16a34a")
            : (isShort ? `rgba(220, 38, 38, ${dimAlpha})` : `rgba(22, 163, 74, ${dimAlpha})`),
          size: 1.2,
          text: isMatch ? (m.hoverText || m.text || "") : (m.text || "")
        };
      });
    }

    clearReferenceLines() {
      if (this.series) {
        this.referenceLines.forEach((line) => {
          try { this.series.removePriceLine(line); } catch (e) {}
        });
      }
      this.referenceLines = [];
    }

    renderReferenceLines(config = {}) {
      if (!this.series || !(Number(config.entry) > 0)) return [];
      this.clearReferenceLines();
      this.referenceLines.push(this.series.createPriceLine({
        price: Number(config.entry),
        color: config.selected ? "#7c3aed" : "#0284c7",
        lineWidth: 1,
        lineStyle: this.lineStyle.Solid,
        axisLabelVisible: true,
        title: config.selected ? "ENTRY · SELECTED" : "ENTRY"
      }));
      (config.levels || []).forEach((level) => {
        this.referenceLines.push(this.series.createPriceLine({
          price: level.price,
          color: level.color || (level.netProfitPct === 0 ? "rgba(71, 85, 105, 0.34)" : "rgba(22, 163, 74, 0.18)"),
          lineWidth: level.lineWidth || 1,
          lineStyle: this.lineStyle.Dashed,
          axisLabelVisible: true,
          title: level.title
        }));
      });
      if (config.showScaleIn && Number(config.scaleInSpread) > 0) {
        this.referenceLines.push(this.series.createPriceLine({
          price: Number(config.scaleInSpread),
          color: "#dc2626",
          lineWidth: 1,
          lineStyle: this.lineStyle.Dashed,
          axisLabelVisible: true,
          title: "SCALE-IN SHORT"
        }));
      }
      if (Number(config.exit) > 0) {
        this.referenceLines.push(this.series.createPriceLine({
          price: Number(config.exit),
          color: "#dc2626",
          lineWidth: 1,
          lineStyle: this.lineStyle.Dashed,
          axisLabelVisible: true,
          title: config.exitTitle || "EXIT"
        }));
      }
      return this.referenceLines;
    }
  }

  // Both panes must contain the same timestamps, including whitespace for missing prices.
  // Release the recursion guard synchronously: a frame-long guard loses wheel/drag events.
  StrategyExecutionChartController.linkTimeScales = function (primary, secondary, scheduleFrame = requestAnimationFrame) {
    let syncing = false;
    let paused = 0;
    let pendingRange = null;
    let framePending = false;
    const same = (a, b) => a && b && Math.abs(a.from - b.from) < 1e-7 && Math.abs(a.to - b.to) < 1e-7;
    const sync = (source = primary, target = secondary) => {
      if (syncing || paused || pendingRange) return;
      const range = source.timeScale().getVisibleLogicalRange();
      if (!range || same(range, target.timeScale().getVisibleLogicalRange())) return;
      syncing = true;
      try { target.timeScale().setVisibleLogicalRange(range); }
      finally { syncing = false; }
    };
    for (const chart of [primary, secondary]) {
      chart.applyOptions({
        leftPriceScale: { visible: true, minimumWidth: 80 },
        rightPriceScale: { visible: true, minimumWidth: 90 },
        timeScale: { minBarSpacing: 0.5, lockVisibleTimeRangeOnResize: true },
      });
    }
    const forward = () => sync(primary, secondary);
    const backward = () => sync(secondary, primary);
    primary.timeScale().subscribeVisibleLogicalRangeChange(forward);
    secondary.timeScale().subscribeVisibleLogicalRangeChange(backward);
    return {
      sync: forward,
      getRange() { return pendingRange || primary.timeScale().getVisibleLogicalRange(); },
      setRange(range) {
        // Lightweight Charts applies programmatic ranges on its next draw. Keep
        // the requested viewport authoritative until both panes have drawn it.
        pendingRange = { ...range };
        primary.timeScale().setVisibleLogicalRange(range);
        secondary.timeScale().setVisibleLogicalRange(range);
        if (!framePending) {
          framePending = true;
          scheduleFrame(() => {
            framePending = false;
            pendingRange = null;
            forward();
          });
        }
      },
      pause() { paused++; },
      resume() { paused = Math.max(0, paused - 1); forward(); },
      dispose() {
        primary.timeScale().unsubscribeVisibleLogicalRangeChange(forward);
        secondary.timeScale().unsubscribeVisibleLogicalRangeChange(backward);
      },
    };
  };

  // Fit the newest 90% of loaded candles, with half-bar edges and no empty future space.
  StrategyExecutionChartController.initialRange = function (barCount) {
    if (!Number.isFinite(barCount) || barCount < 1) return null;
    const visibleBars = Math.max(1, Math.ceil(barCount * 0.9));
    return { from: barCount - visibleBars - 0.5, to: barCount - 0.5 };
  };

  // Retain the same candle when a fixed-length API window rolls forward.
  StrategyExecutionChartController.preserveRange = function (range, previous, next) {
    if (!range || !previous?.length || !next?.length) return null;
    let shift;
    if (range.to >= previous.length - 1) {
      shift = next.length - previous.length;
    } else {
      const nextIndex = new Map(next.map((bar, index) => [bar.time, index]));
      const anchor = previous.findIndex(bar => nextIndex.has(bar.time));
      if (anchor < 0) return null;
      shift = nextIndex.get(previous[anchor].time) - anchor;
    }
    return { from: range.from + shift, to: range.to + shift };
  };

  // Apply one compact crosshair-dot standard to every Lightweight Charts pane.
  // Patching chart construction here covers all tabs and any series added later.
  StrategyExecutionChartController.installCompactCrosshairMarkers = function (library, radius = 2) {
    if (!library?.createChart || library.__compactCrosshairMarkersInstalled) return;
    const createChart = library.createChart.bind(library);
    library.createChart = function (...args) {
      const chart = createChart(...args);
      for (const method of ["addLineSeries", "addAreaSeries", "addBaselineSeries"]) {
        if (typeof chart[method] !== "function") continue;
        const addSeries = chart[method].bind(chart);
        chart[method] = (options = {}) => addSeries({
          ...options,
          crosshairMarkerRadius: radius,
          crosshairMarkerBorderWidth: 1,
        });
      }
      return chart;
    };
    library.__compactCrosshairMarkersInstalled = true;
  };

  StrategyExecutionChartController.Frame = StrategyExecutionChartFrame;

  return StrategyExecutionChartController;
});
