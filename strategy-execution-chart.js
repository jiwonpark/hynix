(function (root, factory) {
  const Controller = factory();
  if (typeof module === "object" && module.exports) module.exports = Controller;
  if (root) {
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
      const legendMarkup = `<div class="executionChartFooter">
          <div id="${ids.legend}" class="executionChartLegend">${options.legend || ""}</div>
          <span id="${ids.sync}" class="executionChartSync">${options.syncText || ""}</span>
        </div>`;
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
        ${options.legendPosition === "top" ? legendMarkup : ""}
        <div id="${ids.host}" class="executionChartHost" style="height:${Number(options.height) || 420}px"></div>
        ${options.showAssetPane ? `
        <div id="${ids.assetPaneShell}" class="assetPricePaneShell" style="position:relative;height:${Number(options.assetHeight) || 185}px;border-top:2px solid #cbd5e1;background:#fff;width:100%;display:block;">
          <div class="assetPriceLegendBar" style="position:absolute;top:6px;left:12px;max-width:calc(100% - 24px);height:24px;box-sizing:border-box;z-index:10;display:flex;align-items:center;flex-wrap:nowrap;gap:10px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums;background:rgba(255,255,255,0.92);backdrop-filter:blur(4px);padding:3px 8px;border-radius:4px;border:1px solid #cbd5e1;pointer-events:none;">
            <span style="font-weight:800;color:#0f172a;flex-shrink:0;">📊 2-ASSET PRICES:</span>
            <span style="color:#2563eb;font-weight:700;flex-shrink:0;">● SKHYUSDT (ADR, Right Scale)</span>
            <span style="color:#d97706;font-weight:700;flex-shrink:0;">● CSOP 2L ETF / Domestic (Left Scale)</span>
            <span id="${ids.assetDetails}" style="color:#475569;font-family:monospace;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></span>
          </div>
          <div id="${ids.assetHost}" style="height:${Number(options.assetHeight) || 185}px;min-height:150px;width:100%;display:block;"></div>
        </div>` : ""}
        ${options.legendPosition === "top" ? "" : legendMarkup}`;

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
        setStatus(text) { if (elements.status) { elements.status.textContent = text; elements.status.title = text || ""; } },
        setSecondaryStatus(text) { if (elements.secondaryStatus) { elements.secondaryStatus.textContent = text; elements.secondaryStatus.title = text || ""; } },
        setSync(text) { if (elements.sync) { elements.sync.textContent = text; elements.sync.title = text || ""; } },
      };
      frame.setVisibility("actual", actual.visible !== false);
      frame.setVisibility("virtual", virtual.visible !== false);
      if (grouping) frame.setGrouping(Boolean(grouping.asRange));
      return frame;
    }
  }

  class StrategyExecutionChartController {
    static isPriceVisible(coordinate, height) {
      return Number.isFinite(coordinate) && Number.isFinite(height)
        && coordinate >= 0 && coordinate <= height;
    }

    // Lightweight Charts exposes a visible-range callback for time, but no
    // corresponding callback for a drag or wheel change on the price axis.
    // Sample two nearby prices so overlays repaint only when their y mapping
    // actually changes. Hidden charts are skipped until they become visible.
    static watchPriceScale({ series, host, samplePrice, onChange, requestFrame } = {}) {
      const frame = requestFrame || ((callback) => requestAnimationFrame(callback));
      let previous = null;
      let running = true;
      const tick = () => {
        if (!running) return;
        const price = Number(samplePrice?.());
        const visible = host && host.clientWidth > 0 && host.clientHeight > 0
          && (!host.getClientRects || host.getClientRects().length > 0);
        if (visible && Number.isFinite(price) && price > 0 && series?.priceToCoordinate) {
          const nearby = price * 1.001;
          const current = [series.priceToCoordinate(price), series.priceToCoordinate(nearby)];
          if (current.every(Number.isFinite)) {
            if (previous && current.some((coordinate, index) => Math.abs(coordinate - previous[index]) >= 0.25)) {
              onChange?.();
            }
            previous = current;
          } else {
            previous = null;
          }
        } else {
          previous = null;
        }
        frame(tick);
      };
      frame(tick);
      return () => { running = false; };
    }

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
        const streamKind = m.backtest ? "backtest" : (m.is_paper || m.source === "virtual" ? "paper" : "actual");
        const key = `${m.time}_${m.is_entry ? 1 : 0}_${streamKind}`;
        if (m.hypothetical && !m.backtest && !m.is_paper && confirmedKeys.has(`${m.time}_${m.is_entry ? 1 : 0}`)) return false;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
      }).map((m) => {
        const isMatch = hoveredTime !== null && m.time === hoveredTime;
        const isShort = m.direction
          ? m.direction === "short"
          : (m.shape ? m.shape === "arrowDown" : (m.is_entry || m.color === "#dc2626"
            || (typeof m.color === "string" && m.color.includes("220"))));
        const isEntry = m.is_entry !== false;
        const isSell = isShort ? isEntry : !isEntry;
        const isPaper = Boolean(m.hypothetical || m.is_paper || m.backtest || m.source === "virtual");
        const dimAlpha = isPaper ? "0.35" : "0.70";
        const shape = (m.shape && (m.shape === "arrowUp" || m.shape === "arrowDown" || m.shape === "circle" || m.shape === "square"))
          ? m.shape
          : (isSell ? "arrowDown" : "arrowUp");
        const position = m.position || (isSell ? "aboveBar" : "belowBar");
        const label = isMatch ? (m.hoverText || m.text || "") : (m.text || "");
        return {
          time: m.time,
          position,
          shape,
          color: isMatch
            ? (isSell ? "#dc2626" : "#16a34a")
            : (isSell ? `rgba(220, 38, 38, ${dimAlpha})` : `rgba(22, 163, 74, ${dimAlpha})`),
          // Native shapes are solid. Hide the shape for paper events and use an
          // outline glyph so shared charts follow the same hollow-marker style.
          size: isPaper ? 0 : 1.4,
          text: [isPaper ? (isEntry ? "▷" : "◁") : "", label].filter(Boolean).join(" ")
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

    static compactProfitLineTitle(level = {}) {
      if (typeof level.axisTitle === "string" && level.axisTitle.trim()) return level.axisTitle.trim();
      const target = Number(level.netProfitPct);
      if (!Number.isFinite(target)) return String(level.title || "");
      if (target === 0) return "B/E";
      return `NET ${target > 0 ? "+" : ""}${target}%`;
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
          title: StrategyExecutionChartController.compactProfitLineTitle(level)
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
  const defaultScheduleFrame = typeof requestAnimationFrame !== "undefined"
    ? requestAnimationFrame
    : (cb) => setTimeout(cb, 0);

  StrategyExecutionChartController.linkTimeScales = function (primary, secondary, scheduleFrame = defaultScheduleFrame, options = {}) {
    let charts = [];
    if (Array.isArray(primary)) {
      charts = primary.filter(Boolean);
      options = (typeof secondary === "object" && secondary !== null) ? secondary : {};
      scheduleFrame = (typeof scheduleFrame === "function") ? scheduleFrame : defaultScheduleFrame;
    } else {
      charts = [primary, secondary].filter(Boolean);
      if (typeof scheduleFrame === "object" && scheduleFrame !== null) {
        options = scheduleFrame;
        scheduleFrame = defaultScheduleFrame;
      }
    }
    if (charts.length < 2) return { sync() {}, getRange() { return null; }, setRange() {}, pause() {}, resume() {}, dispose() {} };

    let syncing = false;
    let paused = 0;
    let pendingRange = null;
    let framePending = false;
    const same = (a, b) => a && b && Math.abs(a.from - b.from) < 1e-7 && Math.abs(a.to - b.to) < 1e-7;

    const hasLeft = options.hasLeftScale ?? false;
    const leftWidth = options.leftWidth ?? 80;
    const rightWidth = options.rightWidth ?? 90;

    for (const chart of charts) {
      chart.applyOptions({
        leftPriceScale: hasLeft ? { visible: true, minimumWidth: leftWidth } : { visible: false },
        rightPriceScale: { visible: true, minimumWidth: rightWidth },
        timeScale: { minBarSpacing: 0.5, rightOffset: 0, lockVisibleTimeRangeOnResize: true },
      });
    }

    const syncFrom = (source) => {
      if (syncing || paused || pendingRange) return;
      const range = source.timeScale().getVisibleLogicalRange();
      if (!range) return;
      syncing = true;
      try {
        for (const target of charts) {
          if (target !== source) {
            const current = target.timeScale().getVisibleLogicalRange();
            if (!same(range, current)) {
              target.timeScale().setVisibleLogicalRange(range);
            }
          }
        }
      } finally {
        syncing = false;
      }
    };

    const subscriptions = charts.map((chart) => {
      const handler = () => syncFrom(chart);
      chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
      return [chart, handler];
    });

    const syncAll = () => syncFrom(charts[0]);

    return {
      sync: syncAll,
      getRange() { return pendingRange || charts[0].timeScale().getVisibleLogicalRange(); },
      setRange(range) {
        // Lightweight Charts applies programmatic ranges on its next draw. Keep
        // the requested viewport authoritative until both panes have drawn it.
        pendingRange = { ...range };
        for (const chart of charts) {
          chart.timeScale().setVisibleLogicalRange(range);
        }
        if (!framePending) {
          framePending = true;
          scheduleFrame(() => {
            framePending = false;
            pendingRange = null;
            syncAll();
          });
        }
      },
      pause() { paused++; },
      resume() { paused = Math.max(0, paused - 1); syncAll(); },
      dispose() {
        subscriptions.forEach(([chart, handler]) => {
          chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
        });
      },
    };
  };

  // Synchronize the vertical focus line between related chart panes. Each pane
  // supplies the series that should anchor the target crosshair and a value
  // lookup for a timestamp; this keeps price, indicator, and PnL scales separate.
  StrategyExecutionChartController.linkCrosshairs = function (panes = []) {
    const linked = panes.filter((pane) => pane?.chart && pane?.series && typeof pane.valueAtTime === "function");
    if (linked.length < 2) return { dispose() {} };
    let syncing = false;
    const subscriptions = [];
    const clearTargets = (source) => {
      linked.forEach((pane) => {
        if (pane !== source && typeof pane.chart.clearCrosshairPosition === "function") {
          pane.chart.clearCrosshairPosition();
        }
      });
    };
    linked.forEach((source) => {
      const handler = (param) => {
        if (syncing) return;
        syncing = true;
        try {
          if (!param?.time) {
            clearTargets(source);
            return;
          }
          const rawTime = typeof param.time === "number" ? param.time : (param.time.timestamp ?? param.time);
          linked.forEach((target) => {
            if (target === source || typeof target.chart.setCrosshairPosition !== "function") return;
            const value = Number(target.valueAtTime(rawTime));
            if (Number.isFinite(value)) target.chart.setCrosshairPosition(value, param.time, target.series);
            else if (typeof target.chart.clearCrosshairPosition === "function") target.chart.clearCrosshairPosition();
          });
        } finally {
          syncing = false;
        }
      };
      source.chart.subscribeCrosshairMove(handler);
      subscriptions.push([source.chart, handler]);
    });
    return {
      dispose() {
        subscriptions.forEach(([chart, handler]) => chart.unsubscribeCrosshairMove?.(handler));
      },
    };
  };

  // Fit recent candles up to targetVisibleBars (e.g. 48 for comfortable candle spacing, or newest 90%), with half-bar edges and no empty future space.
  StrategyExecutionChartController.initialRange = function (barCount, targetVisibleBars = null) {
    if (!Number.isFinite(barCount) || barCount < 1) return null;
    const visibleBars = Number.isFinite(targetVisibleBars) && targetVisibleBars > 0
      ? Math.min(barCount, Math.round(targetVisibleBars))
      : Math.max(1, Math.ceil(barCount * 0.9));
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
  StrategyExecutionChartController.compactCrosshairMarkers = function (chart, radius = 2) {
    if (!chart || chart.__compactCrosshairMarkersInstalled) return chart;
    for (const method of ["addLineSeries", "addAreaSeries", "addBaselineSeries"]) {
      if (typeof chart[method] !== "function") continue;
      const addSeries = chart[method].bind(chart);
      chart[method] = (options = {}) => addSeries({
        ...options,
        crosshairMarkerRadius: radius,
        crosshairMarkerBorderWidth: 1,
      });
    }
    chart.__compactCrosshairMarkersInstalled = true;
    return chart;
  };

  // Configure standardized timeScale across all terminal tabs.
  StrategyExecutionChartController.configureStandardTimeScale = function (chart, options = {}) {
    if (!chart) return;
    chart.applyOptions({
      timeScale: {
        borderColor: options.borderColor || "#e2e8f0",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: Number.isFinite(options.rightOffset) ? options.rightOffset : 4,
        minBarSpacing: options.minBarSpacing || 0.5,
        fixLeftEdge: options.fixLeftEdge ?? false,
        fixRightEdge: options.fixRightEdge ?? false,
        lockVisibleTimeRangeOnResize: true,
        shiftVisibleRangeOnNewBar: false,
      }
    });
  };

  // Keep visible candles and zoom span invariant when older candles are prepended.
  StrategyExecutionChartController.applyPrependedRange = function (chart, addedCount, baseRange = null) {
    if (!chart || !Number.isFinite(addedCount) || addedCount <= 0) return null;
    const current = baseRange || chart.timeScale().getVisibleLogicalRange();
    if (current && Number.isFinite(current.from) && Number.isFinite(current.to)) {
      const updated = {
        from: current.from + addedCount,
        to: current.to + addedCount,
      };
      chart.timeScale().setVisibleLogicalRange(updated);
      return updated;
    }
    return null;
  };

  // Zoom-aware prefetcher and boundary clamp:
  // Detects when user scrolls or zooms near earliest loaded bars, proactively fetches more,
  // and prevents scrolling or zooming out into empty unloaded space when at history limits.
  StrategyExecutionChartController.attachZoomAwarePrefetch = function (chart, options = {}) {
    if (!chart) return () => {};
    let isFetching = false;
    let isClamping = false;
    let detached = false;
    let latestRange = null;
    let queuedNeeded = 0;
    const threshold = options.threshold || 150;
    const futureOffset = Number.isFinite(options.futureOffset) ? options.futureOffset : 8;

    const getCount = () => {
      if (typeof options.getTotalBars === "function") return options.getTotalBars();
      if (typeof options.getBars === "function") return options.getBars()?.length || 0;
      if (Number.isFinite(options.totalBars)) return options.totalBars;
      return 0;
    };
    const checkHasMore = () => {
      if (typeof options.hasMore === "function") return options.hasMore();
      if (typeof options.isExhausted === "function") return !options.isExhausted();
      if (typeof options.hasMore === "boolean") return options.hasMore;
      return true;
    };
    const triggerPrefetch = (needed) => {
      if (typeof options.onPrefetchNeeded === "function") return options.onPrefetchNeeded(needed);
      if (typeof options.onNeedOlder === "function") return options.onNeedOlder(needed);
      return null;
    };

    const demandForRange = (range) => {
      if (!range) return 0;
      const totalBars = getCount();
      if (totalBars < 10 || !checkHasMore()) return 0;
      const span = range.to - range.from;
      const zoomExceeds = span > totalBars * 0.40;
      return (range.from < threshold || zoomExceeds || range.from < 0)
        ? Math.max(300, Math.ceil(span * 1.5))
        : 0;
    };
    const drainPrefetch = () => {
      if (detached || isFetching || !checkHasMore() || queuedNeeded <= 0) return;
      const needed = queuedNeeded;
      queuedNeeded = 0;
      isFetching = true;
      Promise.resolve()
        .then(() => triggerPrefetch(needed))
        .catch(() => 0)
        .then((added) => {
          isFetching = false;
          if (detached || !(Number(added) > 0) || !checkHasMore()) return;
          // Re-evaluate the most recent viewport, not the range which started
          // the request. Rapid wheel events are coalesced into the next page.
          const current = chart.timeScale().getVisibleLogicalRange?.() || latestRange;
          queuedNeeded = Math.max(queuedNeeded, demandForRange(current));
          drainPrefetch();
        });
    };

    const handler = (range) => {
      if (!range || isClamping) return;
      latestRange = { from: range.from, to: range.to };
      const totalBars = getCount();
      if (totalBars < 10) return;
      const span = range.to - range.from;

      // 1. Zoom-aware prefetch. Keep the largest request observed while a page
      // is in flight so rapid zoom-out gestures cannot be lost.
      queuedNeeded = Math.max(queuedNeeded, demandForRange(range));
      drainPrefetch();

      // 2. Boundary clamp: if all history is loaded and user zooms/scrolls past bar 0 into negative void, clamp left
      if (range.from < 0 && !checkHasMore() && options.clampLeft !== false) {
        isClamping = true;
        try {
          chart.timeScale().setVisibleLogicalRange({ from: 0, to: Math.max(5, span) });
        } catch (_) {}
        isClamping = false;
        return;
      }

      // 3. Boundary clamp: prevent drifting entirely into empty future void
      const maxRight = totalBars + futureOffset;
      if (options.clampRight !== false && range.from > totalBars + 5) {
        isClamping = true;
        try {
          chart.timeScale().setVisibleLogicalRange({ from: maxRight - span, to: maxRight });
        } catch (_) {}
        isClamping = false;
        return;
      }
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(handler);
    return () => {
      detached = true;
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler);
    };
  };

  StrategyExecutionChartController.Frame = StrategyExecutionChartFrame;

  return StrategyExecutionChartController;
});
