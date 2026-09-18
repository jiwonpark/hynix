(function (root, factory) {
  const Controller = factory();
  if (typeof module === "object" && module.exports) module.exports = Controller;
  if (root) root.StrategyExecutionChartController = Controller;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

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
        const isShort = m.shape === "arrowDown" || m.is_entry || m.color === "#dc2626"
          || (typeof m.color === "string" && m.color.includes("220"));
        const dimAlpha = m.hypothetical ? "0.35" : "0.70";
        return {
          time: m.time,
          position: m.position,
          shape: isShort ? "arrowDown" : "arrowUp",
          color: isMatch
            ? (isShort ? "#dc2626" : "#16a34a")
            : (isShort ? `rgba(220, 38, 38, ${dimAlpha})` : `rgba(22, 163, 74, ${dimAlpha})`),
          size: 1.2,
          text: isMatch ? (m.hoverText || m.text || "") : ""
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
        lineWidth: config.selected ? 2 : 1.5,
        lineStyle: this.lineStyle.Solid,
        axisLabelVisible: true,
        title: config.selected ? "ENTRY · SELECTED" : "ENTRY"
      }));
      (config.levels || []).forEach((level) => {
        this.referenceLines.push(this.series.createPriceLine({
          price: level.price,
          color: level.netProfitPct === 0 ? "rgba(71, 85, 105, 0.34)" : "rgba(22, 163, 74, 0.18)",
          lineWidth: 1,
          lineStyle: this.lineStyle.Dashed,
          axisLabelVisible: true,
          title: level.title
        }));
      });
      if (config.showScaleIn && Number(config.scaleInSpread) > 0) {
        this.referenceLines.push(this.series.createPriceLine({
          price: Number(config.scaleInSpread),
          color: "#dc2626",
          lineWidth: 1.5,
          lineStyle: this.lineStyle.Dashed,
          axisLabelVisible: true,
          title: "SCALE-IN SHORT"
        }));
      }
      return this.referenceLines;
    }
  }

  return StrategyExecutionChartController;
});
