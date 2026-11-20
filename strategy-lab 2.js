(function () {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const pct = (value) => `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;
  const krw = (value) => `₩${Math.round(Number(value || 0)).toLocaleString()}`;

  const lab = {
    chart: null,
    candles: null,
    maSeries: [],
    controller: null,
    frame: null,
    data: null,
    loaded: false,

    initFrame() {
      if (this.frame || !window.StrategyExecutionChartFrame) return;
      this.frame = StrategyExecutionChartFrame.mount({
        container: "strategyLabExecutionChartFrame",
        id: "strategyLabChart",
        ids: {
          action: "strategyLabRun", actual: "strategyLabActualToggle", virtual: "strategyLabVirtualToggle",
          status: "strategyLabStatus", secondaryStatus: "strategyLabMacroStatus",
          host: "strategyLabChartHost", legend: "strategyLabChartLegend", sync: "strategyLabChartSync",
        },
        title: "PRICE-SIGNAL REPLAY · UNCONSTRAINED CAPITAL",
        action: { label: "Rerun", onClick: () => this.run() },
        actual: { label: "Actual", enabled: false, visible: false },
        virtual: { label: "Virtual", onToggle: () => this.toggleVirtual() },
        status: "Run the backtest to load Upbit candles.",
        description: "Starts flat at the beginning of loaded history · completed 5m and 1h candles · next-open execution · entry and exit fees included.",
        secondaryStatus: "1h MA-stack state: waiting for completed hourly prices…",
        height: 420,
        legend: '<span style="color:#0f172a"><span style="display:inline-block;width:10px;height:3px;background:#0f172a"></span> BTC/KRW</span><span style="color:#7c3aed">— MA7</span><span style="color:#0284c7">— MA24</span><span style="color:#f59e0b">— MA60</span><span><strong style="color:#16a34a">▲</strong>/<strong style="color:#dc2626">▼</strong> Virtual</span><span style="color:#0f766e">Dashed: B/E and net-profit levels on entry hover</span>',
        syncText: "Upbit public candles",
      });
    },

    initChart() {
      this.initFrame();
      if (this.chart || !byId("strategyLabChartHost") || !window.LightweightCharts) return;
      const host = byId("strategyLabChartHost");
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth,
        height: 560,
        layout: { background: { color: "#ffffff" }, textColor: "#475569" },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#cbd5e1" },
        rightPriceScale: { borderColor: "#cbd5e1" },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        localization: { priceFormatter: (price) => `₩${Math.round(price).toLocaleString()}` },
      });
      this.candles = this.chart.addCandlestickSeries({
        upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
        wickUpColor: "#16a34a", wickDownColor: "#dc2626",
      });
      [
        ["ma7", "#7c3aed", 2], ["ma24", "#0284c7", 2], ["ma60", "#f59e0b", 2],
      ].forEach(([key, color, lineWidth]) => {
        this.maSeries.push({ key, series: this.chart.addLineSeries({ color, lineWidth, priceLineVisible: false, lastValueVisible: false }) });
      });
      this.controller = new StrategyExecutionChartController({
        series: this.candles,
        lineStyle: LightweightCharts.LineStyle,
      });
      this.chart.subscribeCrosshairMove((param) => this.onCrosshair(param));
      new ResizeObserver(() => {
        if (host.clientWidth) this.chart.applyOptions({ width: host.clientWidth });
      }).observe(host);
    },

    conditions() {
      return {
        entry_5m: byId("labEntry5m").checked,
        entry_1h: byId("labEntry1h").checked,
        exit_5m: byId("labExit5m").checked,
        exit_1h: byId("labExit1h").checked,
      };
    },

    async run() {
      this.initChart();
      const conditions = this.conditions();
      if (!conditions.entry_5m && !conditions.entry_1h) {
        byId("strategyLabStatus").textContent = "Enable at least one entry condition.";
        return;
      }
      if (!conditions.exit_5m && !conditions.exit_1h) {
        byId("strategyLabStatus").textContent = "Enable at least one exit condition.";
        return;
      }
      const button = byId("strategyLabRun");
      button.disabled = true;
      button.textContent = "Loading Upbit…";
      byId("strategyLabStatus").textContent = "Fetching public candles and replaying closed-bar signals…";
      const params = new URLSearchParams({
        days: byId("strategyLabDays").value,
        fee_bps: byId("strategyLabFee").value,
        ...Object.fromEntries(Object.entries(conditions).map(([key, value]) => [key, String(value)])),
      });
      try {
        const response = await fetch(`api/strategy-lab/upbit-ma-stack?${params}`);
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        this.render(data);
      } catch (error) {
        byId("strategyLabStatus").textContent = `Backtest failed: ${error.message}`;
      } finally {
        button.disabled = false;
        button.textContent = "▶ Run Backtest";
      }
    },

    render(data) {
      this.data = data;
      this.loaded = true;
      this.candles.setData(data.bars.map((bar) => ({
        time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close,
      })));
      this.maSeries.forEach(({ key, series }) => series.setData(
        data.bars.filter((bar) => Number.isFinite(bar[key])).map((bar) => ({ time: bar.time, value: bar[key] }))
      ));
      this.controller.setExecutions(data.markers || []);
      this.renderMarkers();
      const stats = data.stats || {};
      byId("labNetReturn").textContent = pct(stats.net_return_pct);
      byId("labBuyHold").textContent = pct(stats.buy_hold_pct);
      byId("labDrawdown").textContent = pct(stats.max_drawdown_pct);
      byId("labTrades").textContent = `${stats.completed_trades || 0} TRADES`;
      byId("labWinRate").textContent = pct(stats.win_rate_pct);
      byId("labEquity").textContent = krw(stats.ending_equity_krw);
      byId("strategyLabStatus").textContent = `${data.days}d · ${(data.bars || []).length.toLocaleString()} closed 5m bars · fee ${data.fee_bps}bp/side · next-open fills`;
      const latestHour = (data.hourly || []).at(-1);
      if (byId("strategyLabMacroStatus")) byId("strategyLabMacroStatus").textContent = latestHour
        ? `Completed 1h MA stack: ${latestHour.bullish ? "BULLISH" : latestHour.bearish ? "BEARISH" : "NOT ALIGNED"} · Close ${krw(latestHour.close)} · MA7 ${krw(latestHour.ma7)} · MA24 ${krw(latestHour.ma24)} · MA60 ${krw(latestHour.ma60)}`
        : "Completed 1h MA stack unavailable";
      this.chart.timeScale().fitContent();
    },

    renderMarkers(hoveredTime = null) {
      if (this.candles && this.controller) this.candles.setMarkers(this.controller.markersForRender(hoveredTime));
    },

    onCrosshair(param) {
      if (!this.controller || !param || !param.point || !this.chart) return;
      const host = byId("strategyLabChartHost");
      const time = this.controller.executionTimeAtX(param.point.x, {
        timeScale: this.chart.timeScale(), hostWidth: host.clientWidth,
      });
      this.renderMarkers(time);
      const entry = (this.data?.markers || []).find((marker) => marker.time === time && marker.is_entry);
      if (!entry) {
        this.controller.clearReferenceLines();
        return;
      }
      const feeRate = Number(this.data.fee_bps || 0) / 10000;
      const entryPrice = Number(entry.entry_price);
      const levels = [0, 0.2, 0.5, 1, 2, 3].map((target) => ({
        netProfitPct: target,
        price: entryPrice * (1 + feeRate) * (1 + target / 100) / (1 - feeRate),
        title: target === 0 ? "B/E NET" : `NET +${target}%`,
      }));
      this.controller.renderReferenceLines({ entry: entryPrice, selected: true, levels });
    },

    toggleVirtual() {
      const visible = this.controller.toggleVisibility("virtual");
      const button = byId("strategyLabVirtualToggle");
      button.classList.toggle("active", visible);
      if (this.frame) this.frame.setVisibility("virtual", visible);
      if (!visible) this.controller.clearReferenceLines();
      this.renderMarkers();
    },

    onTabActivated() {
      this.initChart();
      const host = byId("strategyLabChartHost");
      if (this.chart && host.clientWidth) this.chart.applyOptions({ width: host.clientWidth });
      if (!this.loaded) this.run();
    },
  };

  window.strategyLab = lab;
})();
