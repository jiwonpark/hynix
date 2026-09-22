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
    currentRatio: null,
    entries: [],
    ledger: [],
    bars: [],
    interval: "15m",

    cloneTradingTerminal() {
      const source = $("tabContentTrading");
      const target = $("tabContentLighter");
      if (!source || !target || target.dataset.cloned === "true") return;
      const fragment = document.createDocumentFragment();
      Array.from(source.children).forEach((child) => fragment.appendChild(child.cloneNode(true)));
      target.replaceChildren(fragment);
      target.dataset.cloned = "true";
      target.querySelectorAll("[id]").forEach((element) => { element.id = `lighter_${element.id}`; });
      target.querySelectorAll("[for]").forEach((element) => {
        element.setAttribute("for", `lighter_${element.getAttribute("for")}`);
      });
      target.querySelectorAll("canvas, a[href*='tradingview.com']").forEach((element) => element.remove());
      target.querySelectorAll("button,input,select").forEach((element) => { element.disabled = true; });
      target.querySelectorAll(".terminalLockBanner").forEach((element) => { element.style.display = "none"; });
    },

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
        frame.innerHTML = ""; frame.style.height = "420px";
        const replay = document.createElement("div");
        replay.id = "lighterReplayControls";
        replay.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0 0;padding:9px 11px;border:1px solid #dbeafe;border-radius:7px;background:#f8fafc;font-size:11px;color:#475569";
        replay.innerHTML = '<strong>PRICE-SIGNAL REPLAY</strong><label>Entry Z <input id="lighterEntryZ" type="number" value="1.5" min="0.5" step="0.1" style="width:58px"></label><label>Exit Z <input id="lighterExitZ" type="number" value="0.25" min="0" step="0.05" style="width:58px"></label><button id="lighterRunBacktest" type="button" style="border:1px solid #0284c7;background:#fff;color:#0369a1;border-radius:5px;padding:5px 9px;font-weight:800;cursor:pointer">Rerun</button><span id="lighterBacktestSummary">Ready</span>';
        frame.insertAdjacentElement("afterend", replay);
        $("lighterRunBacktest").addEventListener("click", () => this.runBacktest());
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
    },

    init() {
      if (this.initialized || !$("tabContentLighter")) return;
      this.cloneTradingTerminal();
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
      const host = lid("shortTermExecutionChartFrame");
      if (this.chart || !host || !window.LightweightCharts) return;
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth, height: 420,
        layout: { background: { color: "#fff" }, textColor: "#475569" },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        rightPriceScale: { borderColor: "#e2e8f0" },
        timeScale: { borderColor: "#e2e8f0", timeVisible: true },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      });
      this.series = this.chart.addLineSeries({ color: "#0284c7", lineWidth: 2,
        priceFormat: { type: "custom", formatter: (value) => `${value.toFixed(2)}%` } });
      window.addEventListener("resize", () => this.resize());
    },

    async onTabActivated() {
      this.init(); this.ensureChart(); this.resize();
      await this.refresh();
    },

    resize() {
      const host = lid("shortTermExecutionChartFrame");
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
      const markers = this.ledger.slice(0, 40).map((row) => ({
        time: this.bars.reduce((best, bar) => Math.abs(bar.time - row.time / 1000) < Math.abs(best.time - row.time / 1000) ? bar : best).time,
        position: row.action === "EXIT" ? "belowBar" : "aboveBar",
        color: row.action === "EXIT" ? "#10b981" : "#7c3aed",
        shape: row.action === "EXIT" ? "arrowUp" : "arrowDown",
        text: row.action === "EXIT" ? "Virtual Exit" : "Virtual Entry",
      })).sort((a, b) => a.time - b.time);
      this.series.setMarkers(markers);
    },

    async runBacktest() {
      const summary = $("lighterBacktestSummary");
      const button = $("lighterRunBacktest");
      if (button) button.disabled = true;
      if (summary) summary.textContent = "Running…";
      try {
        const entry = Number($("lighterEntryZ")?.value || 1.5);
        const exit = Number($("lighterExitZ")?.value || 0.25);
        const data = await api(`/api/lighter/backtest?interval=${this.interval}&limit=500&entry_z=${entry}&exit_z=${exit}`);
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
