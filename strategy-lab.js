(function () {
  "use strict";

  const rootId = (id) => `labFork_${id}`;
  const el = (id) => document.getElementById(rootId(id));
  const pct = (value) => `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;
  const krw = (value) => `₩${Math.round(Number(value || 0)).toLocaleString()}`;

  const lab = {
    forked: false,
    chart: null,
    candles: null,
    maSeries: [],
    controller: null,
    data: null,
    loaded: false,

    forkOriginalSection() {
      if (this.forked) return;
      const source = document.getElementById("shortTermExecutionSection");
      const destination = document.getElementById("tabContentStrategyLab");
      if (!source || !destination) return;
      const clone = source.cloneNode(true);
      clone.id = "strategyLabExecutionSection";
      clone.querySelectorAll("[id]").forEach((node) => { node.id = rootId(node.id); });
      clone.querySelectorAll("*").forEach((node) => {
        [...node.attributes].forEach((attr) => {
          if (attr.name.startsWith("on")) node.removeAttribute(attr.name);
        });
      });
      destination.replaceChildren(clone);
      this.forked = true;

      el("lblShortTermTitle").textContent = "BTC/KRW Tracker & Auto-Backtest Criteria";
      el("lblShortTermSubtitle").textContent = "Direct fork of the execution tracker · Upbit public candles · virtual fills only.";
      const headerBadge = el("lblShortTermTitle").nextElementSibling;
      if (headerBadge) headerBadge.textContent = "UPBIT STRATEGY LAB";

      const controls = el("valShortTermCurrentParity").parentElement.parentElement;
      controls.innerHTML = `
        <div class="pillGroup" style="display:inline-flex;background:#f1f5f9;padding:2px;border-radius:6px;">
          <button type="button" disabled>1m</button><button type="button" class="active">5m</button><button type="button" disabled>15m</button><button type="button">1h</button><button type="button" disabled>4h</button><button type="button" disabled>1d</button>
        </div>
        <select id="strategyLabDays" style="height:28px;width:auto;"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option></select>
        <label style="font-size:11px;font-weight:700;color:#475569;">Fee/side <input id="strategyLabFee" type="number" value="5" min="0" max="100" step=".5" style="width:62px;height:28px;"> bp</label>
        <div style="font-size:11.5px;font-weight:700;background:#f8fafc;border:1px solid #e2e8f0;padding:4px 10px;border-radius:6px;">BTC/KRW: <strong id="${rootId("valShortTermCurrentParity")}" style="color:#0284c7;">--</strong></div>`;

      const host = el("shortTermSpreadChartHost");
      host.replaceChildren();
      const rerun = el("btnRerunDynamicBacktest");
      rerun.classList.remove("terminal-action-control");
      rerun.disabled = false;
      rerun.addEventListener("click", () => this.run());
      el("legendActualTrades").disabled = true;
      el("legendActualTrades").textContent = "○ Actual";
      el("legendVirtualTrades").addEventListener("click", () => this.toggleVirtual());

      const supported = new Set([
        "chkCondEntryMaStack5m", "chkCondEntryMaStack1h",
        "chkCondExitMaStack5m", "chkCondExitMaStack1h",
      ]);
      clone.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        const original = input.id.replace(/^labFork_/, "");
        if (!supported.has(original)) {
          input.checked = false;
          input.disabled = true;
          input.closest(".condRow")?.classList.add("disabled-cond");
        }
      });
      el("chkCondEntryMaStack5m").addEventListener("change", () => this.run());
      el("chkCondEntryMaStack1h").addEventListener("change", () => this.run());
      el("chkCondExitMaStack5m").addEventListener("change", () => this.run());
      el("chkCondExitMaStack1h").addEventListener("change", () => this.run());
      document.getElementById("strategyLabDays").addEventListener("change", () => this.run());
    },

    initChart() {
      this.forkOriginalSection();
      const host = el("shortTermSpreadChartHost");
      if (this.chart || !host || !window.LightweightCharts) return;
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth, height: 420,
        layout: { background: { color: "#ffffff" }, textColor: "#475569" },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#cbd5e1" },
        rightPriceScale: { borderColor: "#cbd5e1" },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        localization: { priceFormatter: (price) => krw(price) },
      });
      this.candles = this.chart.addCandlestickSeries({
        upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
        wickUpColor: "#16a34a", wickDownColor: "#dc2626",
      });
      [["ma7", "#f59e0b"], ["ma24", "#8b5cf6"], ["ma60", "#06b6d4"]].forEach(([key, color]) => {
        this.maSeries.push({ key, series: this.chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }) });
      });
      this.controller = new StrategyExecutionChartController({ series: this.candles, lineStyle: LightweightCharts.LineStyle });
      this.chart.subscribeCrosshairMove((param) => this.onCrosshair(param));
      new ResizeObserver(() => { if (host.clientWidth) this.chart.applyOptions({ width: host.clientWidth }); }).observe(host);
    },

    conditions() {
      return {
        entry_5m: el("chkCondEntryMaStack5m").checked,
        entry_1h: el("chkCondEntryMaStack1h").checked,
        exit_5m: el("chkCondExitMaStack5m").checked,
        exit_1h: el("chkCondExitMaStack1h").checked,
      };
    },

    async run() {
      this.initChart();
      const conditions = this.conditions();
      if ((!conditions.entry_5m && !conditions.entry_1h) || (!conditions.exit_5m && !conditions.exit_1h)) {
        el("dynamicBacktestStatus").textContent = "Enable at least one entry and one exit condition.";
        return;
      }
      const button = el("btnRerunDynamicBacktest");
      button.disabled = true;
      button.textContent = "Loading Upbit…";
      el("dynamicBacktestStatus").textContent = "Fetching public candles and replaying closed-bar signals…";
      const params = new URLSearchParams({
        days: document.getElementById("strategyLabDays").value,
        fee_bps: document.getElementById("strategyLabFee").value,
        ...Object.fromEntries(Object.entries(conditions).map(([key, value]) => [key, String(value)])),
      });
      try {
        const response = await fetch(`api/strategy-lab/upbit-ma-stack?${params}`);
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || `HTTP ${response.status}`);
        this.render(data);
      } catch (error) {
        el("dynamicBacktestStatus").textContent = `Backtest failed: ${error.message}`;
      } finally {
        button.disabled = false;
        button.textContent = "Rerun";
      }
    },

    render(data) {
      this.data = data;
      this.loaded = true;
      this.candles.setData(data.bars.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      this.maSeries.forEach(({ key, series }) => series.setData(data.bars.filter((bar) => Number.isFinite(bar[key])).map((bar) => ({ time: bar.time, value: bar[key] }))));
      this.controller.setExecutions(data.markers || []);
      this.renderMarkers();
      const stats = data.stats || {};
      el("dynamicBacktestStatus").textContent = `${stats.completed_trades || 0} trades · Net ${pct(stats.net_return_pct)} · Buy & Hold ${pct(stats.buy_hold_pct)} · Max drawdown ${pct(stats.max_drawdown_pct)} · Win rate ${pct(stats.win_rate_pct)} · Ending ${krw(stats.ending_equity_krw)}`;
      const latest = data.bars.at(-1);
      const latestHour = data.hourly.at(-1);
      el("macroPolicyStatus").textContent = `Completed 1h: ${latestHour?.bullish ? "BULLISH STACK" : latestHour?.bearish ? "BEARISH STACK" : "NOT ALIGNED"} · next-open fills · ${data.fee_bps}bp/side`;
      el("valShortTermCurrentParity").textContent = latest ? krw(latest.close) : "--";
      el("valShortTermMa7").textContent = latest ? krw(latest.ma7) : "--";
      el("valShortTermMa24").textContent = latest ? krw(latest.ma24) : "--";
      el("valShortTermMa60").textContent = latest ? krw(latest.ma60) : "--";
      el("lblShortTermChartSync").textContent = `${data.days}d · ${data.bars.length.toLocaleString()} closed 5m bars`;
      this.syncConditionBadges(latest, latestHour);
      this.chart.timeScale().fitContent();
    },

    syncConditionBadges(latest, hourly) {
      const states = [
        ["badgeCondEntryMaStack5m", latest?.bullish], ["badgeCondEntryMaStack1h", hourly?.bullish],
        ["badgeCondExitMaStack5m", latest?.bearish], ["badgeCondExitMaStack1h", hourly?.bearish],
      ];
      states.forEach(([id, pass]) => {
        const badge = el(id);
        if (!badge) return;
        badge.textContent = pass ? "PASS" : "WAIT";
        badge.className = `condBadge ${pass ? "pass" : "wait"}`;
      });
      el("badgeCriteriaScaleIn").textContent = latest?.bullish && hourly?.bullish ? "ENTRY ARMED" : "AWAITING MA STACKS (5m/1h)";
      el("badgeCriteriaTP").textContent = latest?.bearish || hourly?.bearish ? "EXIT ARMED" : "AWAITING BEARISH STACK";
    },

    renderMarkers(hoveredTime = null) { this.candles.setMarkers(this.controller.markersForRender(hoveredTime)); },

    onCrosshair(param) {
      if (!param?.point || !this.chart) return;
      const host = el("shortTermSpreadChartHost");
      const time = this.controller.executionTimeAtX(param.point.x, { timeScale: this.chart.timeScale(), hostWidth: host.clientWidth });
      this.renderMarkers(time);
      const entry = (this.data?.markers || []).find((marker) => marker.time === time && marker.is_entry);
      if (!entry) return this.controller.clearReferenceLines();
      const fee = Number(this.data.fee_bps || 0) / 10000;
      const price = Number(entry.entry_price);
      const levels = [0, .2, .5, 1, 2, 3].map((target) => ({
        netProfitPct: target, price: price * (1 + fee) * (1 + target / 100) / (1 - fee),
        title: target === 0 ? "B/E NET" : `NET +${target}%`,
      }));
      this.controller.renderReferenceLines({ entry: price, selected: true, levels });
    },

    toggleVirtual() {
      const visible = this.controller.toggleVisibility("virtual");
      const button = el("legendVirtualTrades");
      button.textContent = `${visible ? "✓" : "○"} Virtual`;
      button.setAttribute("aria-pressed", String(visible));
      if (!visible) this.controller.clearReferenceLines();
      this.renderMarkers();
    },

    onTabActivated() {
      this.initChart();
      const host = el("shortTermSpreadChartHost");
      if (this.chart && host?.clientWidth) this.chart.applyOptions({ width: host.clientWidth });
      if (!this.loaded) this.run();
    },
  };

  window.strategyLab = lab;
})();
