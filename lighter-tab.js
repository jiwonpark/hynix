(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "skhynix_lighter_virtual_ledger_v2";
  const lid = (id) => $(`lighter_${id}`);

  async function api(path) {
    let lastError;
    for (const prefix of ["/skhynix", ""]) {
      try {
        const response = await fetch(`${prefix}${path}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error("API unavailable");
  }

  const lighterEngine = {
    initialized: false,
    chart: null,
    series: null,
    maSeries: {},
    maVisibility: { 7: true, 24: true, 60: true },
    executionChartFrame: null,
    currentRatio: null,
    entries: [],
    ledger: [],
    bars: [],
    actualMarkers: [],
    backtestMarkers: [],
    showActualMarkers: true,
    showVirtualMarkers: true,
    interval: "15m",

    setText(id, text) { const element = lid(id); if (element) element.textContent = text; },

    labelTerminal() {
      this.setText("lblDaemonMainStatus", "Daemon: Lighter Market Data Active");
      this.setText("lblDaemonAuthBadge", "LIGHTER: READ ONLY");
      this.setText("lblDaemonUpbitBadge", "SIGNER: NOT CONFIGURED");
      this.setText("valDeployedStrategyName", "◈ SK Hynix Arb (Lighter SKHY / SKHYNIXUSD)");
      this.setText("valDeployedEngine", "Rolling Z-Score Mean Reversion");
      this.setText("valDeployedInterval", "15m Candles");
      this.setText("valDeployedCost", "0 BPS advertised fee / slippage excluded");
      this.setText("lblAccountEquity", "Lighter Account Equity");
      this.setText("badgeEquitySource", "SIGNER REQUIRED");
      this.setText("valAccountEquity", "—");
      this.setText("lblAvailMargin", "Available Margin");
      this.setText("valAvailMargin", "—");
      this.setText("lblUnrealizedPnl", "Virtual Unrealized PnL");
      this.setText("lblActivePairs", "Virtual Positions");
      this.setText("lblMarginRisk", "Live Execution");
      this.setText("valMarginRisk", "LOCKED");
      this.setText("lblCollateralSummary", "Lighter Venue Fees");
      this.setText("lblUpbitEquity", "Lighter Market Pair");
      this.setText("badgeUpbitSource", "PERPETUALS");
      this.setText("valUpbitEquity", "SKHY ↔ SKHYNIXUSD");
      this.setText("titleExecutionTerminal", "◈ 1-Click Lighter Pair Execution Terminal & Virtual Orders");
      this.setText("badgeExecMode", "LIGHTER PUBLIC DATA · PAPER EXECUTION");
      this.setText("lblHedgedSyncBadge", "Syncing with Lighter…");
      this.setText("lblShortTermTitle", "Lighter Parity Tracker & Virtual-Tranche Criteria");
      this.setText("lblShortTermSubtitle", "Solid arrows show virtual entries/exits. Backtest uses public Lighter candles.");
      this.setText("lblCritScaleInTitle", "➕ Virtual Scale-In");
      this.setText("lblCritTPTitle", "🎯 Virtual Take-Profit / Exit");
      this.setText("lblOrderNotional", "Virtual Order Notional (USDT)");
      this.setText("lblStepTrancheSize", "Add Virtual Tranche");
      this.setText("lblStepTrancheSub", "SKHY / SKHYNIXUSD");
      this.setText("lblReduceTrancheText", "Exit Virtual Position");
      const live = lid("modeLive"); if (live) live.textContent = "🔒 Live Locked";
      const semi = lid("modeSemiAuto"); if (semi) semi.textContent = "◈ Lighter Read-Only";
      const paper = lid("modePaper"); if (paper) paper.textContent = "✋ Virtual / Paper";
      const kill = lid("btnKillSwitch"); if (kill) kill.textContent = "🚨 Live Disabled";
      const auto = lid("lblAutoPeriodicText"); if (auto) auto.textContent = "Lighter auto-tranche requires signer configuration";
      const frame = lid("shortTermExecutionChartFrame");
      if (frame) {
        frame.innerHTML = "";
        this.executionChartFrame = StrategyExecutionChartFrame.mount({
          container: frame,
          id: "lighterShortTermSpreadChart",
          ids: {
            action: "lighter_btnRerunDynamicBacktest", actual: "lighter_legendActualTrades", virtual: "lighter_legendVirtualTrades",
            status: "lighter_dynamicBacktestStatus", secondaryStatus: "lighter_macroPolicyStatus",
            host: "lighter_shortTermSpreadChartHost", legend: "lighter_shortTermChartLegend", sync: "lighter_lblShortTermChartSync",
          },
          title: "PRICE-SIGNAL REPLAY · UNCONSTRAINED CAPITAL",
          action: { label: "Rerun", onClick: () => this.runBacktest() },
          actual: { label: "Actual", onToggle: () => { this.showActualMarkers = !this.showActualMarkers; this.updateMarkerButtons(); this.renderMarkers(); } },
          virtual: { label: "Virtual", onToggle: () => { this.showVirtualMarkers = !this.showVirtualMarkers; this.updateMarkerButtons(); this.renderMarkers(); } },
          status: "Ready · Actual fills require a configured Lighter account",
          description: "Starts flat at the beginning of loaded history · completed candles · capital, margin and leverage do not suppress simulated trades · advertised fees included. LIVE ONLY checks protect real orders; BACKTEST ONLY switches affect the simulation.",
          secondaryStatus: "Lighter replay uses public SKHY / SKHYNIXUSD candles.",
          height: 420,
          legend: '<span style="color:#0284c7"><span style="display:inline-block;width:10px;height:3px;background:#0284c7"></span> Parity</span><span id="lighter_legendShortMa7" style="cursor:pointer;color:#b45309">— 7-MA: <strong id="lighter_valShortTermMa7">--%</strong></span><span id="lighter_legendShortMa24" style="cursor:pointer;color:#6d28d9">— 24-MA: <strong id="lighter_valShortTermMa24">--%</strong></span><span id="lighter_legendShortMa60" style="cursor:pointer;color:#0891b2">— 60-MA: <strong id="lighter_valShortTermMa60">--%</strong></span><span><strong style="color:#dc2626">▼</strong>/<strong style="color:#16a34a">▲</strong> Actual</span><span><strong style="color:#dc2626;opacity:.45">⇩</strong>/<strong style="color:#16a34a;opacity:.45">⇧</strong> Virtual</span><span style="color:#0f766e">Selected net PnL: <strong id="lighter_valShortTermNetPnl">--</strong> · Exit &gt; <strong id="lighter_valSelectedMinProfit">—</strong></span><span>Scale-In</span>',
          syncText: "Updated 0s ago",
        });
        [7, 24, 60].forEach((period) => lid(`legendShortMa${period}`)?.addEventListener("click", () => this.toggleMA(period)));
      }
      const entry = lid("btnStepTranche");
      const exit = lid("btnReduceTranche");
      [entry, exit].forEach((button) => { if (button) { button.disabled = false; button.classList.remove("terminal-action-control"); button.style.cursor = "pointer"; } });
      if (entry) entry.addEventListener("click", () => this.addVirtualEntry());
      if (exit) exit.addEventListener("click", () => this.exitVirtual());
      ["1m", "5m", "15m", "1h", "4h", "1d"].forEach((value) => {
        const button = lid(`btnShortInterval${value}`);
        if (!button) return;
        button.disabled = false;
        button.addEventListener("click", () => { this.interval = value; this.refreshChart(); });
      });
      const ticket = lid("pairOrderTicket");
      if (ticket) {
        const warning = document.createElement("div");
        warning.style.cssText = "grid-column:1/-1;padding:9px 11px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;margin-bottom:8px";
        warning.textContent = "Live execution is fail-closed until the official Lighter signer and account are configured. Paper controls remain available.";
        ticket.prepend(warning);
      }
      const notionalInput = lid("inputOrderNotional");
      if (notionalInput) notionalInput.disabled = false;
      const guard = lid("hedgedControllerCard")?.querySelector(".zeroLossInvariantBanner p");
      if (guard) guard.innerHTML = 'Virtual take-profit closes the <strong>latest matched entry first (LIFO)</strong>. PnL is marked from the captured Lighter parity ratio using the selected virtual notional. <strong>Live orders remain impossible until signer configuration is complete.</strong>';
      this.bindResearchConditions();
    },

    init() {
      if (this.initialized || !$("tabContentLighter")) return;
      if (!window.TerminalCommon || $("tabContentLighter").dataset.terminalInstance !== "lighter") {
        throw new Error("Shared terminal module did not initialize the Lighter instance");
      }
      $("tabContentLighter").querySelectorAll("button,input,select").forEach((element) => { element.disabled = true; });
      $("tabContentLighter").querySelectorAll(".terminalLockBanner").forEach((element) => { element.style.display = "none"; });
      this.labelTerminal();
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        this.entries = Array.isArray(saved.entries) ? saved.entries : [];
        this.ledger = Array.isArray(saved.ledger) ? saved.ledger : [];
      } catch (_) {}
      this.initialized = true;
      this.renderVirtualState();
    },

    ensureChart() {
      const host = lid("shortTermSpreadChartHost");
      if (this.chart || !host || !window.LightweightCharts) return;
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth, height: 420,
        layout: { background: { color: "#f8fafc" }, textColor: "#475569" },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        rightPriceScale: { borderColor: "#e2e8f0" },
        timeScale: { borderColor: "#e2e8f0", timeVisible: true },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      });
      this.series = this.chart.addAreaSeries({ topColor: "rgba(2,132,199,.25)", bottomColor: "rgba(2,132,199,.02)", lineColor: "#0284c7", lineWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: .01 } });
      this.maSeries = {
        7: this.chart.addLineSeries({ color: "#f59e0b", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
        24: this.chart.addLineSeries({ color: "#8b5cf6", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
        60: this.chart.addLineSeries({ color: "#06b6d4", lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
      };
      window.addEventListener("resize", () => this.resize());
    },

    async onTabActivated() {
      this.init(); this.ensureChart(); this.resize();
      await this.refresh();
    },

    resize() {
      const host = lid("shortTermSpreadChartHost");
      if (host && this.chart) this.chart.applyOptions({ width: host.clientWidth });
    },

    async refresh() {
      try {
        const [status] = await Promise.all([api("/api/lighter/status"), this.refreshChart()]);
        if (!status.success) throw new Error(status.error || "Lighter unavailable");
        this.currentRatio = Number(status.parity_ratio);
        this.setText("lblDaemonSyncTime", `Last Sync: ${new Date(status.server_time_ms).toLocaleTimeString()}`);
        this.setText("lblDaemonLatency", "Lighter API: Online");
        this.setText("lblDaemonStats", "2 Markets · Public Feed");
        this.setText("lblHedgedSyncBadge", "LIGHTER LIVE MARKET DATA");
        this.setText("valShortTermCurrentParity", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valHedgedCombinedPnl", this.virtualPnlText());
        this.setText("valCollateralPills", `Maker 0.00% · Taker 0.00% · ${status.adr.spread_bps}/${status.domestic.spread_bps} bps books`);
        this.setText("valAutoCurrentEdge", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valCritCurrentSpread", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valCritTpCurrentSpread", `${this.currentRatio.toFixed(3)}%`);
        this.renderVirtualState();
      } catch (error) {
        this.setText("lblHedgedSyncBadge", `LIGHTER ERROR: ${error.message}`);
      }
    },

    async refreshChart() {
      this.ensureChart();
      const data = await api(`/api/lighter/parity?interval=${this.interval}&limit=300`);
      if (!data.success || !data.bars.length) throw new Error(data.error || "No Lighter candles");
      this.currentRatio = Number(data.bars[data.bars.length - 1].value);
      this.bars = data.bars;
      this.series.setData(data.bars.map((bar) => ({ time: bar.time, value: bar.value })));
      [7, 24, 60].forEach((windowSize) => this.maSeries[windowSize].setData(TerminalCommon.movingAverage(data.bars, windowSize)));
      [7, 24, 60].forEach((windowSize) => {
        const value = TerminalCommon.movingAverage(data.bars, windowSize).at(-1)?.value;
        this.setText(`valShortTermMa${windowSize}`, Number.isFinite(value) ? `${value.toFixed(2)}%` : "--%");
      });
      this.actualMarkers = Array.isArray(data.markers) ? data.markers.map((marker) => ({
        time: marker.time, position: marker.position || "aboveBar", color: marker.color || "#0f172a",
        shape: marker.shape || "arrowDown", text: marker.text || "Actual",
      })) : [];
      this.renderMarkers();
      this.chart.timeScale().fitContent();
      this.setText("valShortTermCurrentParity", `${this.currentRatio.toFixed(3)}%`);
      ["1m", "5m", "15m", "1h", "4h", "1d"].forEach((value) => {
        const button = lid(`btnShortInterval${value}`);
        if (button) button.classList.toggle("active", value === this.interval);
      });
    },

    orderNotional() { return Math.max(10, Number(lid("inputOrderNotional")?.value || 1000)); },
    virtualPnl() { return this.entries.reduce((sum, entry) => sum + (this.currentRatio == null ? 0 : entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio), 0); },
    virtualPnlText() { const pnl = this.virtualPnl(); return `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`; },

    bindResearchConditions() {
      const researchIds = [
        "chkCondEntryMaStretch", "chkCondEntryBase", "chkCondEntryPeak", "chkCondEntryMaStack5m",
        "chkCondExitConvergence", "chkCondExitDwell", "chkCondExitBottoming",
      ];
      researchIds.forEach((id) => {
        const input = lid(id);
        if (!input) return;
        input.onchange = null;
        input.disabled = false;
        input.closest(".terminal-action-control")?.classList.remove("terminal-action-control");
        input.addEventListener("change", () => this.runBacktest());
      });
      const labels = {
        valCondEntryMaStretch: "Replay: require selected Entry Z",
        valCondEntryBase: "Replay: require +0.10pt spacing from prior same-side entry",
        valCondEntryPeak: "Replay: require z-score rollover",
        valCondEntryMaStack5m: "Replay: require MA7 / MA24 alignment",
        valCondExitConvergence: "Replay: require selected Exit Z",
        valCondExitDwell: "Replay: minimum four bars held",
        valCondExitBottoming: "Replay: require convergence rollover",
      };
      Object.entries(labels).forEach(([id, text]) => this.setText(id, text));
      ["chkCondEntryMaStack1h", "chkCondEntryCapacity", "chkCondEntryLeverage",
       "chkCondEntryMargin", "chkCondEntryEngine", "chkCondEntryGuard", "chkCondExitActive",
       "chkCondExitNetPnl", "chkCondExitMaStack5m", "chkCondExitMaStack1h", "chkCondExitPosition"].forEach((id) => {
        const input = lid(id); if (input) { input.disabled = true; input.title = "Available when Lighter live account execution is configured"; }
      });
    },

    addVirtualEntry() {
      if (!Number.isFinite(this.currentRatio)) return;
      const entry = { time: Date.now(), ratio: this.currentRatio, notional: this.orderNotional(), side: this.currentRatio >= 100 ? -1 : 1 };
      this.entries.push(entry);
      this.ledger.unshift({ ...entry, action: entry.side < 0 ? "SHORT RATIO" : "LONG RATIO", pnl: null });
      this.save(); this.renderVirtualState(); this.renderMarkers();
    },

    exitVirtual() {
      if (!this.entries.length || !Number.isFinite(this.currentRatio)) return;
      this.entries.forEach((entry) => this.ledger.unshift({ time: Date.now(), ratio: this.currentRatio,
        notional: entry.notional, action: "EXIT", pnl: entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio }));
      this.entries = []; this.save(); this.renderVirtualState(); this.renderMarkers();
    },

    renderMarkers() {
      if (!this.series || typeof this.series.setMarkers !== "function") return;
      if (!this.bars.length) return;
      const paperMarkers = this.ledger.slice(0, 40).map((row) => ({
        time: TerminalCommon.alignTime(this.bars, row.time / 1000),
        position: row.action === "EXIT" ? "belowBar" : "aboveBar",
        color: row.action === "EXIT" ? "#10b981" : "#7c3aed",
        shape: row.action === "EXIT" ? "arrowUp" : "arrowDown",
        text: row.action === "EXIT" ? "Paper Exit" : "Paper Entry",
      }));
      const markers = [
        ...(this.showActualMarkers ? this.actualMarkers : []),
        ...(this.showVirtualMarkers ? [...paperMarkers, ...this.backtestMarkers] : []),
      ].sort((a, b) => a.time - b.time);
      this.series.setMarkers(markers);
    },

    updateMarkerButtons() {
      this.executionChartFrame?.setVisibility("actual", this.showActualMarkers);
      this.executionChartFrame?.setVisibility("virtual", this.showVirtualMarkers);
    },

    toggleMA(period) {
      this.maVisibility[period] = !this.maVisibility[period];
      this.maSeries[period]?.applyOptions({ visible: this.maVisibility[period] });
      const legend = lid(`legendShortMa${period}`);
      if (legend) { legend.style.opacity = this.maVisibility[period] ? "1" : ".35"; legend.style.textDecoration = this.maVisibility[period] ? "none" : "line-through"; }
    },

    async runBacktest() {
      const summary = lid("dynamicBacktestStatus");
      const button = lid("btnRerunDynamicBacktest");
      if (button) button.disabled = true;
      if (summary) summary.textContent = "Running…";
      try {
        const entry = 1.5;
        const exit = 0.25;
        const toggles = new URLSearchParams({
          interval: this.interval, limit: "500", entry_z: String(entry), exit_z: String(exit),
          use_ma_stretch: String(lid("chkCondEntryMaStretch")?.checked !== false),
          use_base_spacing: String(lid("chkCondEntryBase")?.checked !== false),
          use_peak: String(lid("chkCondEntryPeak")?.checked !== false),
          use_ma_stack: String(lid("chkCondEntryMaStack5m")?.checked === true),
          use_convergence: String(lid("chkCondExitConvergence")?.checked !== false),
          use_dwell: String(lid("chkCondExitDwell")?.checked !== false),
          use_bottoming: String(lid("chkCondExitBottoming")?.checked === true),
        });
        const data = await api(`/api/lighter/backtest?${toggles}`);
        this.backtestMarkers = data.trades.flatMap((trade) => [
          { time: trade.entry_time, position: trade.side < 0 ? "aboveBar" : "belowBar", color: "rgba(124,58,237,.55)", shape: trade.side < 0 ? "arrowDown" : "arrowUp", text: "Virtual Entry" },
          { time: trade.exit_time, position: trade.side < 0 ? "belowBar" : "aboveBar", color: "rgba(16,185,129,.55)", shape: trade.side < 0 ? "arrowUp" : "arrowDown", text: `Virtual Exit ${trade.pnl_pct >= 0 ? "+" : ""}${trade.pnl_pct.toFixed(2)}%` },
        ]);
        this.renderMarkers();
        if (summary) summary.innerHTML = `<strong>${data.summary.trades}</strong> trades · <strong>${data.summary.win_rate.toFixed(1)}%</strong> wins · net <strong>${data.summary.net_pct >= 0 ? "+" : ""}${data.summary.net_pct.toFixed(3)}%</strong>`;
      } catch (error) {
        if (summary) summary.textContent = error.message;
      } finally { if (button) button.disabled = false; }
    },

    save() { localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: this.entries, ledger: this.ledger.slice(0, 100) })); },

    renderVirtualState() {
      const total = this.entries.reduce((sum, entry) => sum + entry.notional, 0);
      this.setText("valHedgedTranches", `${this.entries.length} Virtual Tranche${this.entries.length === 1 ? "" : "s"}`);
      this.setText("valHedgedQuantities", `$${total.toFixed(0)} notional · ${this.virtualPnlText()} unrealized`);
      this.setText("valHedgedNotional", `$${total.toFixed(2)} USDT`);
      this.setText("valHedgedCombinedPnl", this.virtualPnlText());
      this.setText("valActivePairs", this.entries.length ? "1 Virtual Pair" : "0 Open (Flat)");
      this.setText("valUnrealizedPnl", this.virtualPnlText());
      this.setText("countPositions", String(this.entries.length));
      const body = lid("activePositionsBody");
      if (body) body.innerHTML = this.entries.length ? this.entries.map((entry, index) => `<tr><td>V-${index + 1}</td><td>SKHY / SKHYNIXUSD</td><td>${entry.side < 0 ? "SHORT / LONG" : "LONG / SHORT"}</td><td>${entry.ratio.toFixed(3)}%</td><td>$${entry.notional.toFixed(0)}</td><td>${this.virtualPnlText()}</td></tr>`).join("") : '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:20px;">No virtual Lighter positions</td></tr>';
    }
  };

  window.lighterEngine = lighterEngine;
  document.addEventListener("DOMContentLoaded", () => lighterEngine.init());
})();
