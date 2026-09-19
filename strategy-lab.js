(function () {
  "use strict";

  const rootId = (id) => `lab_${id}`;
  const el = (id) => document.getElementById(rootId(id));
  const pct = (value) => `${Number(value || 0) >= 0 ? "+" : ""}${Number(value || 0).toFixed(2)}%`;
  const krw = (value) => `₩${Math.round(Number(value || 0)).toLocaleString()}`;
  const formatKst = (dateOrMs, options = {}) => {
    if (!dateOrMs && dateOrMs !== 0) return "";
    const t = typeof dateOrMs === "number" ? (dateOrMs < 1e11 ? dateOrMs * 1000 : dateOrMs) : Number(dateOrMs);
    const d = new Date(t);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...options
    }) + " KST";
  };

  const lab = {
    forked: false,
    chart: null,
    candles: null,
    maSeries: [],
    bbSeries: [],
    controller: null,
    data: null,
    loaded: false,
    chartInterval: "5m",
    strategyMode: "ma_stack",
    selectedMarkerTime: null,
    hoveredMarkerTime: null,
    syncingMarkerState: false,
    botState: null,
    botPollInterval: null,

    bindForkedSection() {
      if (this.forked) return;
      const section = el("shortTermExecutionSection");
      if (!section) return;
      StrategyExecutionChartFrame.mount({
        container: rootId("shortTermExecutionChartFrame"),
        id: "labShortTermChart",
        ids: {
          action: rootId("btnRerunDynamicBacktest"), actual: rootId("legendActualTrades"), virtual: rootId("legendVirtualTrades"),
          status: rootId("dynamicBacktestStatus"), secondaryStatus: rootId("macroPolicyStatus"),
          host: rootId("shortTermSpreadChartHost"), legend: rootId("shortTermChartLegend"), sync: rootId("lblShortTermChartSync"),
        },
        title: "PRICE-SIGNAL REPLAY · UNCONSTRAINED CAPITAL",
        action: { label: "Rerun", onClick: () => this.run() },
        actual: { label: "Actual", onToggle: () => this.toggleActual() },
        virtual: { label: "Virtual", onToggle: () => this.toggleVirtual() },
        status: "Loading backtest…",
        description: "Starts flat at the beginning of loaded history · completed 5m and 1h candles · next-open execution · entry and exit fees included.",
        secondaryStatus: "Completed 1h MA stack: waiting for data…",
        height: 420,
        legend: '<span style="color:#0284c7">━ BTC/KRW</span><span style="color:#b45309">— 7-MA: <strong id="lab_valShortTermMa7">--</strong></span><span style="color:#6d28d9">— 24-MA: <strong id="lab_valShortTermMa24">--</strong></span><span style="color:#0891b2">— 60-MA: <strong id="lab_valShortTermMa60">--</strong></span><span><strong style="color:#16a34a">▲</strong>/<strong style="color:#dc2626">▼</strong> Actual</span><span><strong style="color:#16a34a;opacity:.45">⇧</strong>/<strong style="color:#dc2626;opacity:.45">⇩</strong> Virtual</span>',
        syncText: "Upbit public candles (KST)",
      });
      this.forked = true;

      const controls = el("valShortTermCurrentParity").parentElement.parentElement;
      const parityBox = el("valShortTermCurrentParity").parentElement;
      parityBox.firstChild.textContent = "BTC/KRW: ";
      parityBox.insertAdjacentHTML("beforebegin", `
        <select id="strategyLabDays" style="height:28px;width:auto;"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="14">14 days</option></select>
        <label style="font-size:11px;font-weight:700;color:#475569;">Fee/side <input id="strategyLabFee" type="number" value="5" min="0" max="100" step=".5" style="width:52px;height:28px;"> bp</label>
        <label style="font-size:11px;font-weight:700;color:#475569;">Tranches <input id="strategyLabTranches" type="number" value="5" min="1" max="20" step="1" style="width:44px;height:28px;"></label>`);
      ["1m", "15m", "4h", "1d"].forEach((interval) => { el(`btnShortInterval${interval}`).disabled = true; });
      el("btnShortInterval5m").addEventListener("click", () => this.setChartInterval("5m"));
      el("btnShortInterval1h").addEventListener("click", () => this.setChartInterval("1h"));

      // Live Bot Controls
      el("btnBindStrategy")?.addEventListener("click", () => this.bindActiveStrategyToBot());
      el("btnModePaper")?.addEventListener("click", () => this.setBotMode("paper"));
      el("btnModeLive")?.addEventListener("click", () => this.setBotMode("live"));
      el("btnToggleBotPower")?.addEventListener("click", () => this.toggleBotPower());
      el("btnEmergencyFlatten")?.addEventListener("click", () => this.emergencyFlatten());
      el("inpBotTrancheSize")?.addEventListener("change", () => this.updateBotSizing());

      this.renderConditionsChecklists(null, null);
      this.startBotPolling();

      document.getElementById("strategyLabDays").addEventListener("change", () => this.run());
      document.getElementById("strategyLabTranches")?.addEventListener("change", () => this.run());
    },

    setStrategyMode(mode) {
      if (!mode) return Promise.resolve();
      this.strategyMode = mode;
      const modes = ["ma_stack", "bollinger_zscore", "rsi_momentum", "multi_factor", "ou_quant"];
      const ids = {
        ma_stack: "lab_tabModeMaStack",
        bollinger_zscore: "lab_tabModeBollinger",
        rsi_momentum: "lab_tabModeRsi",
        multi_factor: "lab_tabModeMultiFactor",
        ou_quant: "lab_tabModeOuQuant",
      };
      modes.forEach((m) => {
        const btn = document.getElementById(ids[m]);
        if (btn) btn.classList.toggle("active", m === mode);
      });
      return this.run();
    },

    initChart() {
      this.bindForkedSection();
      const host = el("shortTermSpreadChartHost");
      if (this.chart || !host || !window.LightweightCharts) return;
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth, height: 420,
        layout: { background: { color: "#ffffff" }, textColor: "#475569" },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#cbd5e1" },
        rightPriceScale: { borderColor: "#cbd5e1" },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        localization: {
          locale: "ko-KR",
          priceFormatter: (price) => krw(price),
          timeFormatter: (time) => formatKst(time),
        },
      });
      this.candles = this.chart.addCandlestickSeries({
        upColor: "#16a34a", downColor: "#dc2626", borderVisible: false,
        wickUpColor: "#16a34a", wickDownColor: "#dc2626",
      });
      [["ma7", "#f59e0b"], ["ma24", "#8b5cf6"], ["ma60", "#06b6d4"]].forEach(([key, color]) => {
        this.maSeries.push({ key, series: this.chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }) });
      });
      [["bb_upper", "rgba(14, 165, 233, 0.75)"], ["bb_middle", "rgba(100, 116, 139, 0.60)"], ["bb_lower", "rgba(14, 165, 233, 0.75)"]].forEach(([key, color]) => {
        this.bbSeries.push({ key, series: this.chart.addLineSeries({ color, lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false }) });
      });
      this.controller = new StrategyExecutionChartController({ series: this.candles, lineStyle: LightweightCharts.LineStyle });
      this.chart.subscribeCrosshairMove((param) => this.onCrosshair(param));
      this.chart.subscribeClick((param) => this.onClick(param));
      new ResizeObserver(() => { if (host.clientWidth) this.chart.applyOptions({ width: host.clientWidth }); }).observe(host);
    },

    conditions() {
      const result = {};
      const entryContainer = el("entryConditionsChecklist");
      if (entryContainer) {
        entryContainer.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          const key = input.dataset.key || input.id.replace(/^lab_chk_/, "").replace(/^chk_/, "");
          result[key] = input.checked;
        });
      }
      const exitContainer = el("exitConditionsChecklist");
      if (exitContainer) {
        exitContainer.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          const key = input.dataset.key || input.id.replace(/^lab_chk_/, "").replace(/^chk_/, "");
          result[key] = input.checked;
        });
      }
      if (Object.keys(result).length === 0) {
        return {
          entry_5m: true, entry_1h: true, exit_5m: true, exit_1h: true,
          entry_zscore: true, entry_bb_pierce: true, entry_atr_filter: true,
          exit_bb_middle: true, exit_z_extreme: true, exit_bullish_stack: true,
        };
      }
      return result;
    },

    async run() {
      this.initChart();
      const conditions = this.conditions();
      const button = el("btnRerunDynamicBacktest");
      if (button) {
        button.disabled = true;
        button.textContent = "Loading Upbit…";
      }
      el("dynamicBacktestStatus").textContent = "Fetching public candles and replaying quantitative signals…";
      const params = new URLSearchParams({
        strategy_mode: this.strategyMode || "ma_stack",
        days: document.getElementById("strategyLabDays")?.value || "7",
        fee_bps: document.getElementById("strategyLabFee")?.value || "5",
        max_tranches: document.getElementById("strategyLabTranches")?.value || "5",
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
        if (button) {
          button.disabled = false;
          button.textContent = "Rerun";
        }
      }
    },

    render(data) {
      this.data = data;
      this.loaded = true;
      this.selectedMarkerTime = null;
      this.hoveredMarkerTime = null;
      this.renderChartData();
      const stats = data.stats || {};
      el("dynamicBacktestStatus").textContent = `${stats.completed_trades || 0} trades · Net ${pct(stats.net_return_pct)} · Buy & Hold ${pct(stats.buy_hold_pct)} · Max drawdown ${pct(stats.max_drawdown_pct)} · Win rate ${pct(stats.win_rate_pct)} · Ending ${krw(stats.ending_equity_krw)}`;
      const latest = data.bars.at(-1);
      const latestHour = data.hourly.at(-1);
      el("macroPolicyStatus").textContent = `[${data.strategy_badge || "QUANT"}] ${data.strategy_desc || ""} · next-open fills · ${data.fee_bps}bp/side`;
      el("valShortTermCurrentParity").textContent = latest ? krw(latest.close) : "--";
      el("valShortTermMa7").textContent = latest ? krw(latest.ma7) : "--";
      el("valShortTermMa24").textContent = latest ? krw(latest.ma24) : "--";
      el("valShortTermMa60").textContent = latest ? krw(latest.ma60) : "--";
      el("lblShortTermChartSync").textContent = `${data.days}d · ${data.bars.length.toLocaleString()} closed 5m bars · Sync ${formatKst(Date.now())}`;
      this.syncConditionBadges(latest, latestHour);
      this.syncCriteriaPanels(latest, latestHour);
      this.chart.timeScale().fitContent();
    },

    setChartInterval(interval) {
      if (interval !== "5m" && interval !== "1h") return;
      const prevInterval = this.chartInterval;
      this.chartInterval = interval;
      ["5m", "1h"].forEach((value) => el(`btnShortInterval${value}`)?.classList.toggle("active", value === interval));
      if (this.data) {
        if (this.selectedMarkerTime !== null) {
          if (prevInterval === "5m" && interval === "1h") {
            this.selectedMarkerTime = Math.floor(this.selectedMarkerTime / 3600) * 3600;
          } else if (prevInterval === "1h" && interval === "5m") {
            const match = (this.data.markers || []).find((m) => Math.floor(m.time / 3600) * 3600 === this.selectedMarkerTime);
            this.selectedMarkerTime = match ? match.time : null;
          }
        }
        this.renderChartData();
      }
    },

    getActualTradeMarkers() {
      const markers = [];
      const s = this.botState;
      if (!s) return markers;

      const trades = s.recent_trades || s.trade_history || [];
      const tranches = s.active_tranches || [];

      // Closed trades
      trades.forEach((t) => {
        const modeStr = (t.mode || s.mode || "live").toUpperCase();
        if (t.entry_time && Number(t.entry_price) > 0) {
          const timeStr = formatKst(t.entry_time);
          markers.push({
            time: Number(t.entry_time),
            source: "actual",
            hypothetical: false,
            backtest: false,
            is_entry: true,
            action: "entry",
            direction: "long",
            position: "belowBar",
            shape: "arrowUp",
            color: "#16a34a",
            entry_price: Number(t.entry_price),
            hoverText: `ACTUAL BUY ${t.id || "Tranche"} ₩${Math.round(t.entry_price).toLocaleString()} · ${timeStr} (${modeStr})`,
          });
        }
        if (t.exit_time && Number(t.exit_price) > 0) {
          const ret = Number(t.net_return_pct || 0);
          const timeStr = formatKst(t.exit_time);
          markers.push({
            time: Number(t.exit_time),
            source: "actual",
            hypothetical: false,
            backtest: false,
            is_entry: false,
            action: "exit",
            direction: "long",
            position: "aboveBar",
            shape: "arrowDown",
            color: "#dc2626",
            entry_price: Number(t.entry_price),
            exit_price: Number(t.exit_price),
            net_return_pct: ret,
            hoverText: `ACTUAL SELL ${t.id || "Tranche"} ₩${Math.round(t.exit_price).toLocaleString()} · ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% net · ${timeStr} (${modeStr})`,
          });
        }
      });

      // Active open tranches
      tranches.forEach((t) => {
        const modeStr = (t.mode || s.mode || "live").toUpperCase();
        if (t.entry_time && Number(t.entry_price) > 0) {
          const timeStr = formatKst(t.entry_time);
          markers.push({
            time: Number(t.entry_time),
            source: "actual",
            hypothetical: false,
            backtest: false,
            is_entry: true,
            action: "entry",
            direction: "long",
            position: "belowBar",
            shape: "arrowUp",
            color: "#16a34a",
            entry_price: Number(t.entry_price),
            hoverText: `ACTUAL OPEN ${t.id || "Tranche"} ₩${Math.round(t.entry_price).toLocaleString()} · ${timeStr} (${modeStr})`,
          });
        }
      });

      return markers;
    },

    executionsForInterval() {
      const virtualMarkers = this.data?.markers || [];
      const actualMarkers = this.getActualTradeMarkers();
      const allMarkers = [...virtualMarkers, ...actualMarkers];
      if (this.chartInterval === "5m") {
        return allMarkers;
      }
      const hourlyBars = this.data?.hourly || [];
      const hourlyTimes = hourlyBars.map((b) => b.time);
      return allMarkers.map((m) => {
        let hourTime = Math.floor(m.time / 3600) * 3600;
        if (hourlyTimes.length) {
          const match = hourlyBars.find((b) => b.time <= m.time && m.time < b.time + 3600);
          if (match) hourTime = match.time;
        }
        return {
          ...m,
          time: hourTime,
          rawTime: m.time,
        };
      });
    },

    findMarkerForTime(targetTime) {
      if (targetTime === null || targetTime === undefined) return null;
      const markers = this.controller ? this.controller.visibleExecutions() : (this.data?.markers || []);
      const direct = markers.find((m) => m.time === targetTime || m.rawTime === targetTime);
      if (direct) return direct;
      if (this.chartInterval === "1h") {
        const inHour = markers.filter((m) => Math.floor(m.time / 3600) * 3600 === targetTime);
        if (inHour.length) {
          return inHour.find((m) => !m.is_entry && m.exit_price) || inHour.at(-1);
        }
      }
      return null;
    },

    renderChartData() {
      const rows = this.chartInterval === "1h" ? (this.data?.hourly || []) : (this.data?.bars || []);
      this.candles.setData(rows.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      this.maSeries.forEach(({ key, series }) => series.setData(rows.filter((bar) => Number.isFinite(bar[key])).map((bar) => ({ time: bar.time, value: bar[key] }))));
      this.bbSeries.forEach(({ key, series }) => {
        if (this.strategyMode === "bollinger_zscore") {
          series.setData(rows.filter((bar) => Number.isFinite(bar[key])).map((bar) => ({ time: bar.time, value: bar[key] })));
        } else {
          series.setData([]);
        }
      });
      this.controller.setExecutions(this.executionsForInterval());
      this.syncMarkerState();
      this.chart.timeScale().fitContent();
    },

    getConditionDefinitions(mode, latest, hourly, cap, stack, top) {
      const z = Number(latest?.z_score ?? 0);
      const rsi5 = Number(latest?.rsi ?? 50);
      const rsi1 = Number(hourly?.rsi ?? 50);
      const stochK = Number(latest?.stoch_k ?? 50);
      const ouZ = Number(latest?.ou_z ?? 0);
      const pRev = Number(latest?.p_reversion ?? 0.5);
      const volRatio = Number(latest?.vol_ratio ?? 1);
      const bbLow = latest?.bb_lower;
      const bbMid = latest?.bb_middle;
      const bbUp = latest?.bb_upper;
      const close = Number(latest?.close ?? 0);
      const range = latest ? (latest.high - latest.low) : 0;
      const atr = Number(latest?.atr ?? 0);
      const remaining = cap.remaining_tranches ?? 5;
      const maxTranches = cap.max_tranches ?? 5;
      const freeCash = cap.free_cash_krw ?? 10000000;
      const openBtc = cap.open_quantity_btc ?? 0;

      let entryRows = [];
      let exitRows = [];

      if (mode === "bollinger_zscore") {
        const isBB = bbLow != null && latest?.low <= bbLow && close > bbLow;
        const isZ = z <= -1.8;
        const hasVol = atr > 0 ? (range >= 0.6 * atr) : true;
        entryRows = [
          { key: "entry_zscore", label: "1. 24h VWAP Z-Score (Z ≤ -1.80σ)", value: `${z.toFixed(2)}σ (VWAP ${latest?.vwap ? krw(latest.vwap) : "--"})`, pass: isZ, toggleable: true },
          { key: "entry_bb_pierce", label: "2. Lower BB Pierce (Low ≤ BB_low & Close > BB_low)", value: `Low ${latest ? krw(latest.low) : "--"} / BB ${bbLow ? krw(bbLow) : "--"}`, pass: isBB, toggleable: true },
          { key: "entry_atr_filter", label: "3. Volatility Expansion Filter (Range ≥ 0.60x ATR)", value: `Range ${krw(range)} / ATR ${krw(atr * 0.6)}`, pass: hasVol, toggleable: true },
          { key: "entry_capacity", label: "4. Dynamic Tranche Capacity", value: `${cap.active_tranches ?? 0} / ${maxTranches}`, pass: remaining > 0, liveOnly: true },
          { key: "entry_margin", label: "5. Capital & Headroom Check", value: `${krw(freeCash)} free`, pass: freeCash >= 1900000, liveOnly: true },
          { key: "entry_engine", label: "6. Worker State & Cooldown", value: "READY", pass: true, liveOnly: true },
        ];
        exitRows = [
          { key: "exit_active", label: "1. Active Speculative Tranche (≥ 1 open)", value: `${stack.length} open`, pass: stack.length > 0, required: true },
          { key: "exit_net_pnl", label: "2. Net Profit (> 0.00% net)", value: top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "—", pass: top && top.unrealized_return_pct > 0, backtestOnly: true },
          { key: "exit_bb_middle", label: "3. BB Middle Band Reversion (Close ≥ SMA20)", value: `Close ${krw(close)} / Mid ${bbMid ? krw(bbMid) : "--"}`, pass: bbMid != null && close >= bbMid, toggleable: true },
          { key: "exit_z_extreme", label: "4. Volatility Upper Target (Z-Score ≥ +0.50σ)", value: `${z.toFixed(2)}σ`, pass: z >= 0.5, toggleable: true },
          { key: "exit_bullish_stack", label: "5. Bullish Trend Overlay (Price > MA Stacks)", value: latest?.bullish || hourly?.bullish ? "BULLISH RALLY" : "WAIT", pass: Boolean(latest?.bullish || hourly?.bullish), toggleable: true },
          { key: "exit_position", label: "6. Position Sufficiency Check", value: `${openBtc.toFixed(6)} BTC`, pass: true, required: true },
        ];
      } else if (mode === "rsi_momentum") {
        const isDual = rsi5 < 30.0 && rsi1 < 45.0;
        const isHook = stochK < 20.0 && rsi5 < 35.0;
        entryRows = [
          { key: "entry_rsi_dual", label: "1. Dual-Timeframe RSI Oversold (5m < 30 & 1h < 45)", value: `5m: ${rsi5.toFixed(1)} / 1h: ${rsi1.toFixed(1)}`, pass: isDual, toggleable: true },
          { key: "entry_stoch_hook", label: "2. Stochastic RSI Rebound Hook (%K < 20 & RSI < 35)", value: `%K ${stochK.toFixed(1)} / RSI ${rsi5.toFixed(1)}`, pass: isHook, toggleable: true },
          { key: "entry_capacity", label: "3. Dynamic Tranche Capacity", value: `${cap.active_tranches ?? 0} / ${maxTranches}`, pass: remaining > 0, liveOnly: true },
          { key: "entry_margin", label: "4. Capital & Headroom Check", value: `${krw(freeCash)} free`, pass: freeCash >= 1900000, liveOnly: true },
          { key: "entry_engine", label: "5. Worker State & Cooldown", value: "READY", pass: true, liveOnly: true },
        ];
        exitRows = [
          { key: "exit_active", label: "1. Active Speculative Tranche (≥ 1 open)", value: `${stack.length} open`, pass: stack.length > 0, required: true },
          { key: "exit_net_pnl", label: "2. Net Profit (> 0.00% net)", value: top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "—", pass: top && top.unrealized_return_pct > 0, backtestOnly: true },
          { key: "exit_rsi_5m", label: "3. 5m RSI Momentum Exhaustion (RSI ≥ 60.0)", value: `5m RSI ${rsi5.toFixed(1)}`, pass: rsi5 >= 60.0, toggleable: true },
          { key: "exit_stoch_k", label: "4. Stochastic RSI Overbought (Stoch %K ≥ 80.0)", value: `Stoch %K ${stochK.toFixed(1)}`, pass: stochK >= 80.0, toggleable: true },
          { key: "exit_bullish_stack", label: "5. Bullish Trend Overlay (Price > MA Stacks)", value: latest?.bullish || hourly?.bullish ? "BULLISH RALLY" : "WAIT", pass: Boolean(latest?.bullish || hourly?.bullish), toggleable: true },
          { key: "exit_position", label: "6. Position Sufficiency Check", value: `${openBtc.toFixed(6)} BTC`, pass: true, required: true },
        ];
      } else if (mode === "multi_factor") {
        const macroPass = rsi1 >= 35.0 || (hourly?.ma24 != null && close >= Number(hourly.ma24));
        const vStretch = z <= -1.4 || (bbLow != null && close <= bbLow * 1.002);
        const vVol = volRatio >= 1.3;
        const vRsi = rsi5 <= 35.0 || stochK <= 25.0;
        const votes = (vStretch ? 1 : 0) + (vVol ? 1 : 0) + (vRsi ? 1 : 0);
        entryRows = [
          { key: "entry_macro_1h", label: "1. Macro 1h Baseline Trend (1h RSI ≥ 35 OR Close ≥ 1h MA24)", value: `1h RSI ${rsi1.toFixed(1)} / MA24 ${hourly?.ma24 ? krw(hourly.ma24) : "--"}`, pass: macroPass, toggleable: true },
          { key: "entry_micro_stretch", label: "2. Micro Vote A: Volatility Stretch (Z ≤ -1.40σ / BB Low)", value: `Z: ${z.toFixed(2)}σ / BB: ${bbLow ? krw(bbLow) : "--"}`, pass: vStretch, badgeLabel: vStretch ? "VOTE PASS" : "WAIT", toggleable: true },
          { key: "entry_micro_volume", label: "3. Micro Vote B: Volume Absorption Spike (Vol ≥ 1.30x SMA20)", value: `${volRatio.toFixed(2)}x SMA20 vol`, pass: vVol, badgeLabel: vVol ? "VOTE PASS" : "WAIT", toggleable: true },
          { key: "entry_micro_rsi", label: "4. Micro Vote C: Momentum Dip (5m RSI ≤ 35 OR %K ≤ 25)", value: `5m RSI ${rsi5.toFixed(1)} / %K ${stochK.toFixed(1)}`, pass: vRsi, badgeLabel: vRsi ? "VOTE PASS" : "WAIT", toggleable: true },
          { key: "entry_consensus", label: "5. Micro Consensus Gate (≥ 2-of-3 Micro Dip Votes Required)", value: `${votes} / 3 micro votes`, pass: votes >= 2, badgeLabel: votes >= 2 ? "GATE PASS" : "WAIT", toggleable: false },
          { key: "entry_capacity", label: "6. Dynamic Tranche Capacity & Headroom", value: `${cap.active_tranches ?? 0} / ${maxTranches}`, pass: remaining > 0, liveOnly: true },
        ];
        exitRows = [
          { key: "exit_active", label: "1. Active Speculative Tranche (≥ 1 open)", value: `${stack.length} open`, pass: stack.length > 0, required: true },
          { key: "exit_net_pnl", label: "2. Net Profit (> 0.00% net)", value: top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "—", pass: top && top.unrealized_return_pct > 0, backtestOnly: true },
          { key: "exit_rsi_65", label: "3. 5m RSI Extended Exit (5m RSI ≥ 65.0)", value: `5m RSI ${rsi5.toFixed(1)}`, pass: rsi5 >= 65.0, toggleable: true },
          { key: "exit_bb_upper", label: "4. Upper Bollinger Band Touch (Close ≥ Upper BB)", value: `Close ${krw(close)} / BB Up ${bbUp ? krw(bbUp) : "--"}`, pass: bbUp != null && close >= bbUp, toggleable: true },
          { key: "exit_bullish_stack", label: "5. Bullish Trend Overlay (Price > MA Stacks)", value: latest?.bullish ? "5m BULLISH" : "WAIT", pass: Boolean(latest?.bullish), toggleable: true },
          { key: "exit_position", label: "6. Position Sufficiency Check", value: `${openBtc.toFixed(6)} BTC`, pass: true, required: true },
        ];
      } else if (mode === "ou_quant") {
        const isOU = ouZ <= -1.5;
        const isPrev = pRev >= 0.55;
        entryRows = [
          { key: "entry_ou_spread", label: "1. Continuous OU SDE Equilibrium Discount (OU Spread ≤ -1.50σ)", value: `${ouZ.toFixed(2)}σ (OU Mean: ${latest?.ou_mu ? krw(latest.ou_mu) : "--"})`, pass: isOU, toggleable: true },
          { key: "entry_p_reversion", label: "2. HMM Reversion Regime Probability (P(Reversion) ≥ 55%)", value: `${(pRev * 100).toFixed(1)}% reversion prob`, pass: isPrev, toggleable: true },
          { key: "entry_capacity", label: "3. Dynamic Tranche Capacity", value: `${cap.active_tranches ?? 0} / ${maxTranches}`, pass: remaining > 0, liveOnly: true },
          { key: "entry_margin", label: "4. Capital & Headroom Check", value: `${krw(freeCash)} free`, pass: freeCash >= 1900000, liveOnly: true },
          { key: "entry_engine", label: "5. Worker State & Cooldown", value: "READY", pass: true, liveOnly: true },
        ];
        exitRows = [
          { key: "exit_active", label: "1. Active Speculative Tranche (≥ 1 open)", value: `${stack.length} open`, pass: stack.length > 0, required: true },
          { key: "exit_net_pnl", label: "2. Net Profit (> 0.00% net)", value: top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "—", pass: top && top.unrealized_return_pct > 0, backtestOnly: true },
          { key: "exit_ou_mean", label: "3. Continuous OU Equilibrium Target (OU Spread ≥ 0.00σ)", value: `Spread ${ouZ.toFixed(2)}σ`, pass: ouZ >= 0.0, toggleable: true },
          { key: "exit_bullish_stack", label: "4. Bullish Trend Overlay (Price > MA Stacks)", value: latest?.bullish || hourly?.bullish ? "BULLISH RALLY" : "WAIT", pass: Boolean(latest?.bullish || hourly?.bullish), toggleable: true },
          { key: "exit_position", label: "5. Position Sufficiency Check", value: `${openBtc.toFixed(6)} BTC`, pass: true, required: true },
        ];
      } else {
        // ma_stack
        entryRows = [
          { key: "entry_5m", id: "chkCondEntryMaStack5m", label: "1. 5m Bearish MA Stack (Price < MA7 < MA24 < MA60)", value: latest?.bearish ? "5m BEARISH DIP" : "5m WAITING", pass: Boolean(latest?.bearish), toggleable: true },
          { key: "entry_1h", id: "chkCondEntryMaStack1h", label: "2. 1h Bearish MA Stack (Price < MA7 < MA24 < MA60)", value: hourly?.bearish ? "1h BEARISH DIP" : "1h WAITING", pass: Boolean(hourly?.bearish), toggleable: true },
          { key: "entry_capacity", label: "3. Dynamic Tranche Capacity", value: `${cap.active_tranches ?? 0} / ${maxTranches}`, pass: remaining > 0, liveOnly: true },
          { key: "entry_margin", label: "4. Capital & Headroom Check", value: `${krw(freeCash)} free`, pass: freeCash >= 1900000, liveOnly: true },
          { key: "entry_engine", label: "5. Worker State & Cooldown", value: "READY", pass: true, liveOnly: true },
        ];
        exitRows = [
          { key: "exit_active", label: "1. Active Speculative Tranche (≥ 1 open)", value: `${stack.length} open`, pass: stack.length > 0, required: true },
          { key: "exit_net_pnl", label: "2. Net Profit (> 0.00% net)", value: top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "—", pass: top && top.unrealized_return_pct > 0, backtestOnly: true },
          { key: "exit_5m", id: "chkCondExitMaStack5m", label: "3. 5m Bullish MA Stack (Price > MA7 > MA24 > MA60)", value: latest?.bullish ? "5m BULLISH RALLY" : "5m WAITING", pass: Boolean(latest?.bullish), toggleable: true },
          { key: "exit_1h", id: "chkCondExitMaStack1h", label: "4. 1h Bullish MA Stack (Price > MA7 > MA24 > MA60)", value: hourly?.bullish ? "1h BULLISH RALLY" : "1h WAITING", pass: Boolean(hourly?.bullish), toggleable: true },
          { key: "exit_position", label: "5. Position Sufficiency Check", value: `${openBtc.toFixed(6)} BTC`, pass: true, required: true },
        ];
      }

      return { entryRows, exitRows };
    },

    renderConditionsChecklists(latest, hourly) {
      const data = this.data || {};
      const cap = data.capacity || {};
      const stack = Array.isArray(data.active_tranche_stack) ? data.active_tranche_stack : [];
      const top = stack[0] || null;
      const mode = this.strategyMode || "ma_stack";

      const { entryRows, exitRows } = this.getConditionDefinitions(mode, latest, hourly, cap, stack, top);

      const renderList = (containerId, rows) => {
        const container = el(containerId);
        if (!container) return;

        const previousStates = {};
        container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          const k = input.dataset.key || input.id.replace(/^lab_chk_/, "").replace(/^lab_/, "");
          previousStates[k] = input.checked;
        });

        container.innerHTML = rows.map((r) => {
          const isChecked = previousStates[r.key] !== undefined ? previousStates[r.key] : true;
          const badgeText = r.badgeLabel || (r.pass ? "PASS" : "WAIT");
          const badgeClass = r.pass ? "pass" : "wait";
          const tag = r.liveOnly ? '<span style="font-size: 8px; color: #64748b;" title="Always enforced for live orders">LIVE ONLY</span>' : (r.backtestOnly ? '<span style="font-size: 8px; color: #64748b;" title="Always enforced for backtest orders">BACKTEST ONLY</span>' : (r.required ? '<span style="font-size: 8px; color: #64748b;" title="Always required">REQUIRED</span>' : ''));
          const disabledAttr = r.toggleable ? "" : "disabled";
          const inputId = r.id ? `lab_${r.id}` : `lab_chk_${r.key}`;

          return `<div class="condRow ${!r.toggleable ? "disabled-cond" : ""}" id="lab_row_${r.key}">
            <label class="toggleSwitch" title="Turn condition ON/OFF">
              <input type="checkbox" id="${inputId}" data-key="${r.key}" ${isChecked ? "checked" : ""} ${disabledAttr}>
              <span class="toggleSlider"></span>
            </label>${tag}
            <span class="condLabel">${r.label}</span>
            <span class="condValue">${r.value}</span>
            <span class="condBadge ${badgeClass}">${badgeText}</span>
          </div>`;
        }).join("");

        container.querySelectorAll('input[type="checkbox"]').forEach((input) => {
          if (!input.disabled) {
            input.addEventListener("change", () => this.run());
          }
        });
      };

      renderList("entryConditionsChecklist", entryRows);
      renderList("exitConditionsChecklist", exitRows);
    },

    syncConditionBadges(latest, hourly) {
      const data = this.data || {};
      const cap = data.capacity || {};
      const stack = Array.isArray(data.active_tranche_stack) ? data.active_tranche_stack : [];
      const top = stack[0] || null;
      const mode = this.strategyMode || "ma_stack";

      let armedEntry = false;
      let armedExit = false;

      const z = Number(latest?.z_score ?? 0);
      const rsi5 = Number(latest?.rsi ?? 50);
      const rsi1 = Number(hourly?.rsi ?? 50);
      const stochK = Number(latest?.stoch_k ?? 50);
      const ouZ = Number(latest?.ou_z ?? 0);
      const pRev = Number(latest?.p_reversion ?? 0.5);
      const volRatio = Number(latest?.vol_ratio ?? 1);
      const bbLow = latest?.bb_lower;
      const bbMid = latest?.bb_middle;
      const bbUp = latest?.bb_upper;
      const close = Number(latest?.close ?? 0);

      if (mode === "bollinger_zscore") {
        armedEntry = z <= -1.8 || (bbLow != null && latest?.low <= bbLow && close > bbLow);
        armedExit = (bbMid != null && close >= bbMid) || z >= 0.5 || Boolean(latest?.bullish) || Boolean(hourly?.bullish);
      } else if (mode === "rsi_momentum") {
        armedEntry = (rsi5 < 30.0 && rsi1 < 45.0) || (stochK < 20.0 && rsi5 < 35.0);
        armedExit = rsi5 >= 60.0 || stochK >= 80.0 || Boolean(latest?.bullish) || Boolean(hourly?.bullish);
      } else if (mode === "multi_factor") {
        const macroPass = rsi1 >= 35.0 || (hourly?.ma24 != null && close >= Number(hourly.ma24));
        const vStretch = z <= -1.4 || (bbLow != null && close <= bbLow * 1.002);
        const vVol = volRatio >= 1.3;
        const vRsi = rsi5 <= 35.0 || stochK <= 25.0;
        const votes = (vStretch ? 1 : 0) + (vVol ? 1 : 0) + (vRsi ? 1 : 0);
        armedEntry = macroPass && votes >= 2;
        armedExit = rsi5 >= 65.0 || (bbUp != null && close >= bbUp) || Boolean(latest?.bullish);
      } else if (mode === "ou_quant") {
        armedEntry = ouZ <= -1.5 && pRev >= 0.55;
        armedExit = ouZ >= 0.0 || Boolean(latest?.bullish) || Boolean(hourly?.bullish);
      } else {
        // ma_stack
        armedEntry = Boolean(latest?.bearish && hourly?.bearish);
        armedExit = Boolean(latest?.bullish || hourly?.bullish);
      }

      el("badgeCriteriaScaleIn").textContent = armedEntry ? "ENTRY ARMED (DIP)" : "AWAITING DIP CONDITIONS";
      el("badgeCriteriaTP").textContent = armedExit ? "EXIT ARMED (RALLY)" : (stack.length ? "HOLDING TRANCHES" : "AWAITING EXIT CRITERIA");
    },

    syncCriteriaPanels(latest, hourly) {
      const data = this.data || {};
      const cap = data.capacity || {};
      const stack = Array.isArray(data.active_tranche_stack) ? data.active_tranche_stack : [];
      const top = stack[0] || null;
      const mode = this.strategyMode || "ma_stack";

      const z = Number(latest?.z_score ?? 0);
      const rsi5 = Number(latest?.rsi ?? 50);
      const rsi1 = Number(hourly?.rsi ?? 50);
      const stochK = Number(latest?.stoch_k ?? 50);
      const ouZ = Number(latest?.ou_z ?? 0);
      const pRev = Number(latest?.p_reversion ?? 0.5);
      const volRatio = Number(latest?.vol_ratio ?? 1);
      const bbLow = latest?.bb_lower;
      const bbMid = latest?.bb_middle;
      const bbUp = latest?.bb_upper;
      const close = Number(latest?.close ?? 0);

      // Card 1: Scale-in Criteria Card
      const scaleInTitle = el("lblCritScaleInTitle");
      const scaleInDesc = el("txtCritScaleInDesc");
      const gapScaleIn = el("valCritGapScaleIn");
      const scaleInProgress = el("barCritScaleInProgress");

      if (mode === "bollinger_zscore") {
        if (scaleInTitle) scaleInTitle.textContent = "📊 Bollinger & Z-Score Dip Entry";
        if (scaleInDesc) scaleInDesc.innerHTML = `Trigger: <strong>Z-Score ≤ -1.8σ OR Lower BB Pierce</strong> (VWAP: ${latest?.vwap ? krw(latest.vwap) : "--"})`;
        const armed = z <= -1.8 || (bbLow != null && latest?.low <= bbLow && close > bbLow);
        if (gapScaleIn) {
          gapScaleIn.textContent = armed ? "OVERSOLD ARMED" : `Z: ${z.toFixed(2)}σ · BB Low: ${bbLow ? krw(bbLow) : "--"}`;
          gapScaleIn.style.color = armed ? "#16a34a" : "#d97706";
        }
        if (scaleInProgress) scaleInProgress.style.width = armed ? "100%" : `${Math.min(90, Math.max(15, Math.abs(z) / 1.8 * 100))}%`;
      } else if (mode === "rsi_momentum") {
        if (scaleInTitle) scaleInTitle.textContent = "⚡ RSI Momentum Deceleration Entry";
        if (scaleInDesc) scaleInDesc.innerHTML = `Trigger: <strong>5m RSI < 30 &amp; 1h RSI < 45</strong> OR <strong>StochRSI < 20 &amp; 5m RSI < 35</strong>`;
        const armed = (rsi5 < 30.0 && rsi1 < 45.0) || (stochK < 20.0 && rsi5 < 35.0);
        if (gapScaleIn) {
          gapScaleIn.textContent = armed ? "RSI DIP ARMED" : `5m RSI ${rsi5.toFixed(1)} · 1h ${rsi1.toFixed(1)} · %K ${stochK.toFixed(1)}`;
          gapScaleIn.style.color = armed ? "#16a34a" : "#d97706";
        }
        if (scaleInProgress) scaleInProgress.style.width = armed ? "100%" : `${Math.min(90, Math.max(15, (50 - rsi5) * 3))}%`;
      } else if (mode === "multi_factor") {
        if (scaleInTitle) scaleInTitle.textContent = "⚖️ Multi-Factor Voting Gate Entry";
        if (scaleInDesc) scaleInDesc.innerHTML = `Trigger: <strong>Macro 1h Filter + ≥ 2-of-3 Micro Dip Votes</strong> (Stretch, Vol Spike ≥ 1.3x, RSI ≤ 35)`;
        const macroPass = rsi1 >= 35.0 || (hourly?.ma24 != null && close >= Number(hourly.ma24));
        const vStretch = z <= -1.4 || (bbLow != null && close <= bbLow * 1.002);
        const vVol = volRatio >= 1.3;
        const vRsi = rsi5 <= 35.0 || stochK <= 25.0;
        const votes = (vStretch ? 1 : 0) + (vVol ? 1 : 0) + (vRsi ? 1 : 0);
        const armed = macroPass && votes >= 2;
        if (gapScaleIn) {
          gapScaleIn.textContent = armed ? `VOTING ARMED (${votes}/3 votes)` : `Macro: ${macroPass ? "OK" : "WAIT"} · Micro: ${votes}/3 votes`;
          gapScaleIn.style.color = armed ? "#16a34a" : "#d97706";
        }
        if (scaleInProgress) scaleInProgress.style.width = armed ? "100%" : `${(votes / 3) * 75 + 15}%`;
      } else if (mode === "ou_quant") {
        if (scaleInTitle) scaleInTitle.textContent = "🔬 Quant Ornstein-Uhlenbeck SDE Entry";
        if (scaleInDesc) scaleInDesc.innerHTML = `Trigger: <strong>OU Equilibrium Spread ≤ -1.5σ &amp; P(Reversion) ≥ 55%</strong>`;
        const armed = ouZ <= -1.5 && pRev >= 0.55;
        if (gapScaleIn) {
          gapScaleIn.textContent = armed ? "OU VALUE ARMED" : `Spread: ${ouZ.toFixed(2)}σ · P(Rev): ${(pRev * 100).toFixed(0)}%`;
          gapScaleIn.style.color = armed ? "#16a34a" : "#d97706";
        }
        if (scaleInProgress) scaleInProgress.style.width = armed ? "100%" : `${Math.min(90, Math.max(15, Math.abs(ouZ) / 1.5 * 70))}%`;
      } else {
        // ma_stack
        if (scaleInTitle) scaleInTitle.textContent = "➕ Speculative Scale-In (KRW-BTC Dip Entry)";
        if (scaleInDesc) scaleInDesc.innerHTML = `Trigger: 5m &amp; 1h Bearish MA Stack (<strong>Price &lt; MA7 &lt; MA24 &lt; MA60</strong>)`;
        const dipArmed = latest?.bearish && hourly?.bearish;
        if (gapScaleIn) {
          gapScaleIn.textContent = dipArmed ? "DIP ARMED" : (latest?.bearish ? "5m ARMED (WAIT 1h)" : "AWAITING DIP");
          gapScaleIn.style.color = dipArmed ? "#16a34a" : "#d97706";
        }
        if (scaleInProgress) scaleInProgress.style.width = dipArmed ? "100%" : (latest?.bearish ? "50%" : "20%");
      }

      const currentPrice = el("valCritCurrentSpread");
      if (currentPrice && latest) currentPrice.textContent = krw(latest.close);

      // Card 2: Take-Profit Criteria Card
      const tpTitle = el("lblCritTPTitle");
      const tpDesc = el("txtCritTPDesc");
      const gapTP = el("valCritGapTP");
      const tpProgress = el("barCritTPProgress");

      if (mode === "bollinger_zscore") {
        if (tpTitle) tpTitle.textContent = "🎯 Bollinger Mean-Reversion Exit";
      } else if (mode === "rsi_momentum") {
        if (tpTitle) tpTitle.textContent = "🎯 RSI Momentum Exhaustion Exit";
      } else if (mode === "multi_factor") {
        if (tpTitle) tpTitle.textContent = "🎯 Multi-Factor Target Exit";
      } else if (mode === "ou_quant") {
        if (tpTitle) tpTitle.textContent = "🎯 OU Equilibrium Mean Exit";
      } else {
        if (tpTitle) tpTitle.textContent = "🎯 LIFO Take-Profit (KRW-BTC Rally Exit)";
      }

      if (tpDesc) {
        tpDesc.innerHTML = top
          ? `Top tranche ref: <strong>${top.id} @ ${krw(top.entry_price)}</strong> (${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net)`
          : `Top tranche ref: <strong>No active tranches</strong> (Awaiting entry dip)`;
      }
      const tpCurrentPrice = el("valCritTpCurrentSpread");
      if (tpCurrentPrice && latest) tpCurrentPrice.textContent = krw(latest.close);
      if (gapTP) {
        gapTP.textContent = top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "Flat";
        gapTP.style.color = top ? (top.unrealized_return_pct >= 0 ? "#16a34a" : "#dc2626") : "#64748b";
      }
      if (tpProgress) {
        tpProgress.style.width = top && top.unrealized_return_pct > 0 ? "75%" : (top ? "40%" : "15%");
      }

      // Card 3: Sizing, Risk Gate & Headroom
      const gateTitle = el("lblCritGateTitle");
      if (gateTitle) gateTitle.textContent = "⚙️ Tranche Sizing & Capital Headroom";
      const remainingTranches = el("valCritRemainingTranches");
      if (remainingTranches) remainingTranches.textContent = `${cap.remaining_tranches ?? 5} / ${cap.max_tranches ?? 5} UNITS LEFT`;
      const entrySize = el("valCritEntrySize");
      if (entrySize) entrySize.textContent = `${krw(cap.tranche_capital_krw ?? 2000000)} / tranche`;
      const cycleCore = el("valCritCycleCore");
      if (cycleCore) cycleCore.textContent = "1 Tranche (LIFO Top)";
      const grossLev = el("valCritGrossLev");
      if (grossLev) grossLev.textContent = "1.00x Spot";
      const grossCap = el("valCritGrossCap");
      if (grossCap) grossCap.textContent = krw(data.stats?.initial_capital_krw ?? 10000000);
      const grossHeadroom = el("valCritGrossHeadroom");
      if (grossHeadroom) grossHeadroom.textContent = `${krw(cap.free_cash_krw ?? 10000000)} free`;
      const retainedCore = el("valCritRetainedCore");
      if (retainedCore) retainedCore.textContent = `${(cap.open_quantity_btc || 0).toFixed(6)} BTC open`;

      // Dynamically re-render full condition checklist sections for selected strategy
      this.renderConditionsChecklists(latest, hourly);

      // LIFO Tranche Stack Render
      const stackCount = el("valCritStackCount");
      if (stackCount) stackCount.textContent = `${stack.length} unmatched · newest exits first`;
      const stackContainer = el("lifoTrancheStack");
      if (stackContainer) {
        if (!stack.length) {
          stackContainer.innerHTML = `<div style="padding: 8px; text-align: center; color: #94a3b8; background: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 5px;">Stack empty · awaiting dip entry signals</div>`;
        } else {
          stackContainer.innerHTML = stack.map((t, visualIndex) => {
            const isTop = visualIndex === 0;
            const net = Number(t.unrealized_pnl_krw || 0);
            const ret = Number(t.unrealized_return_pct || 0);
            const pnlColor = ret >= 0 ? "#16a34a" : "#dc2626";
            const retText = `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`;
            const pnlText = `${net >= 0 ? "+" : ""}${krw(net)}`;
            return `<div style="padding: 7px 8px; border: ${isTop ? "1.5px solid #16a34a" : "1px solid #cbd5e1"}; border-radius: 6px; background: ${isTop ? "#f0fdf4" : "#fff"}; box-shadow: ${isTop ? "0 1px 3px rgba(22,163,74,.12)" : "none"}; cursor: pointer;" onclick="if(window.strategyLab) window.strategyLab.onTrancheClick(${t.time})">
              <div style="display:flex; justify-content:space-between; gap:8px; align-items:center;">
                <strong style="color:${isTop ? "#166534" : "#334155"}; font-size:10.5px;">${isTop ? "TOP · NEXT EXIT" : `STACK ${visualIndex + 1}`} <span style="color:#64748b;">${t.id}</span></strong>
                <strong style="color:${pnlColor}; font-size:10px;">Est. net ${retText} (${pnlText})</strong>
              </div>
              <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:2px 8px; margin-top:4px; color:#64748b; font-size:9.5px;">
                <span>Entry <strong style="color:#334155;">${krw(t.entry_price)}</strong></span>
                <span>Qty <strong style="color:#334155;">${Number(t.quantity).toFixed(6)} BTC</strong></span>
                <span>Alloc <strong style="color:#334155;">${krw(t.capital_before)}</strong></span>
                <span>Time <strong style="color:#334155;">${formatKst(t.time || t.entry_time)}</strong></span>
              </div>
            </div>`;
          }).join("");
        }
      }
    },

    renderMarkers(hoveredTime = null) {
      this.candles.setMarkers(this.controller.markersForRender(hoveredTime));
    },

    markerTimeAtParam(param, host) {
      if (!param) return null;
      if (param.time) {
        const direct = (this.controller?.visibleExecutions() || []).find((m) => m.time === param.time);
        if (direct) return direct.time;
      }
      if (param.point && host && this.controller) {
        return this.controller.executionTimeAtX(param.point.x, {
          timeScale: this.chart.timeScale(),
          hostWidth: host.clientWidth,
        });
      }
      return null;
    },

    onClick(param) {
      if (!this.chart) return;
      const host = el("shortTermSpreadChartHost");
      const time = this.markerTimeAtParam(param, host);
      const marker = this.findMarkerForTime(time);
      if (marker && marker.entry_price) {
        this.selectedMarkerTime = (this.selectedMarkerTime === time) ? null : time;
      } else {
        this.selectedMarkerTime = null;
      }
      this.hoveredMarkerTime = time;
      this.syncMarkerState();
    },

    onCrosshair(param) {
      if (this.syncingMarkerState || !this.chart) return;
      const host = el("shortTermSpreadChartHost");
      const time = param?.point ? this.markerTimeAtParam(param, host) : null;
      if (time === this.hoveredMarkerTime) return;
      this.hoveredMarkerTime = time;
      this.syncMarkerState();
    },

    syncMarkerState() {
      if (this.syncingMarkerState || !this.controller) return;
      // setMarkers recalculates the crosshair synchronously in Lightweight Charts.
      // Ignore that notification while updating markers and their price lines.
      this.syncingMarkerState = true;
      try {
        const activeTime = this.selectedMarkerTime ?? this.hoveredMarkerTime;
        this.renderMarkers(activeTime);
        this.syncActiveReferenceLines(this.hoveredMarkerTime);
      } finally {
        this.syncingMarkerState = false;
      }
    },

    syncActiveReferenceLines(hoverTime = null) {
      if (!this.controller) return;
      if (this.controller.visibility.virtual === false && (this.controller.visibility.actual === false || this.controller.visibleExecutions().length === 0)) {
        this.controller.clearReferenceLines();
        return;
      }
      const targetTime = this.selectedMarkerTime !== null ? this.selectedMarkerTime : hoverTime;
      const marker = this.findMarkerForTime(targetTime);
      if (marker && marker.entry_price) {
        this.renderEntryReferenceLines(marker.entry_price, true, marker.exit_price || null, marker);
      } else if (this.data?.open_position?.price && this.controller.visibility.virtual !== false) {
        this.renderEntryReferenceLines(this.data.open_position.price, false);
      } else {
        const visibleMarkers = this.controller.visibleExecutions();
        const lastMarker = visibleMarkers.filter(m => m.entry_price).at(-1);
        if (lastMarker?.entry_price) {
          this.renderEntryReferenceLines(lastMarker.entry_price, false, lastMarker.exit_price || null, lastMarker);
        } else {
          this.controller.clearReferenceLines();
        }
      }
    },

    renderEntryReferenceLines(entryPrice, selected = false, exitPrice = null, marker = null) {
      const price = Number(entryPrice);
      if (!(price > 0)) {
        this.controller.clearReferenceLines();
        return;
      }
      const fee = Number(this.data?.fee_bps || 0) / 10000;
      const levels = [0, .2, .5, 1, 2, 3].map((target) => ({
        netProfitPct: target,
        price: price * (1 + fee) * (1 + target / 100) / (1 - fee),
        title: target === 0 ? "B/E NET" : `NET +${target}%`,
        color: target === 0 ? "rgba(71, 85, 105, 0.70)" : "rgba(22, 163, 74, 0.70)",
        lineWidth: 1.5,
      }));
      let exitTitle = "EXIT";
      if (exitPrice) {
        const ret = marker?.net_return_pct;
        const retStr = typeof ret === "number" ? ` (${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% net)` : "";
        exitTitle = `EXIT ₩${Math.round(exitPrice).toLocaleString()}${retStr}`;
      }
      this.controller.renderReferenceLines({
        entry: price,
        selected,
        levels,
        exit: exitPrice,
        exitTitle,
      });
    },

    toggleActual() {
      if (!this.controller) return;
      const visible = this.controller.toggleVisibility("actual");
      const button = el("legendActualTrades");
      if (button) {
        button.textContent = `${visible ? "✓" : "○"} Actual`;
        button.setAttribute("aria-pressed", String(visible));
        button.classList.toggle("isHidden", !visible);
      }
      this.selectedMarkerTime = null;
      this.hoveredMarkerTime = null;
      this.syncMarkerState();
    },

    toggleVirtual() {
      if (!this.controller) return;
      const visible = this.controller.toggleVisibility("virtual");
      const button = el("legendVirtualTrades");
      if (button) {
        button.textContent = `${visible ? "✓" : "○"} Virtual`;
        button.setAttribute("aria-pressed", String(visible));
        button.classList.toggle("isHidden", !visible);
      }
      this.selectedMarkerTime = null;
      this.hoveredMarkerTime = null;
      this.syncMarkerState();
    },

    onTrancheClick(time) {
      if (!this.chart) return;
      const mappedTime = (this.chartInterval === "1h") ? Math.floor(time / 3600) * 3600 : time;
      this.selectedMarkerTime = (this.selectedMarkerTime === mappedTime) ? null : mappedTime;
      this.hoveredMarkerTime = mappedTime;
      this.syncMarkerState();
    },

    onTabActivated() {
      this.initChart();
      const host = el("shortTermSpreadChartHost");
      if (this.chart && host?.clientWidth) this.chart.applyOptions({ width: host.clientWidth });
      if (!this.loaded) this.run();
      this.fetchBotStatus();
      this.startBotPolling();
    },

    startBotPolling() {
      if (this.botPollInterval) return;
      this.fetchBotStatus();
      this.botPollInterval = setInterval(() => {
        const sec = document.getElementById("tab-content-strategylab");
        if (sec && sec.style.display !== "none") {
          this.fetchBotStatus();
        }
      }, 3500);
    },

    stopBotPolling() {
      if (this.botPollInterval) {
        clearInterval(this.botPollInterval);
        this.botPollInterval = null;
      }
    },

    async fetchBotStatus() {
      try {
        const res = await fetch("api/strategy-lab/bot-status?market=KRW-BTC");
        if (!res.ok) return;
        const json = await res.json();
        if (json && json.success && json.status) {
          this.botState = json.status;
          this.renderBotUI();
        }
      } catch (err) {
        // silent fail on network hiccups
      }
    },

    async bindActiveStrategyToBot(autoStart = null) {
      try {
        const opts = this.conditions();
        const payload = { strategy: this.strategyMode, options: opts };
        if (autoStart !== null) payload.enable = Boolean(autoStart);
        const res = await fetch("api/strategy-lab/set-bot-strategy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const json = await res.json();
        if (json && json.success && json.status) {
          this.botState = json.status;
          this.renderBotUI();
        }
      } catch (err) {
        console.error("[StrategyLab] Error binding strategy to bot:", err);
      }
    },

    async setBotMode(mode) {
      try {
        // When clicking Live or Paper, switch mode, auto-bind current strategy, and activate immediately
        const opts = this.conditions();
        const res = await fetch("api/strategy-lab/set-mode", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, enable: true }),
        });
        const json = await res.json();
        if (json && json.success && json.status) {
          this.botState = json.status;
          // Also bind current strategy tab
          await this.bindActiveStrategyToBot(true);
        }
      } catch (err) {
        console.error("[StrategyLab] Error setting bot mode:", err);
      }
    },

    async toggleBotPower() {
      try {
        const res = await fetch("api/strategy-lab/toggle-bot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (json && json.success && json.status) {
          this.botState = json.status;
          this.renderBotUI();
        }
      } catch (err) {
        console.error("[StrategyLab] Error toggling bot power:", err);
      }
    },

    async updateBotSizing() {
      const input = el("inpBotTrancheSize");
      const trancheSize = input ? Number(input.value) : 2000000;
      if (trancheSize >= 5000) {
        try {
          const res = await fetch("api/strategy-lab/set-sizing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tranche_size_krw: trancheSize }),
          });
          const json = await res.json();
          if (json && json.success && json.status) {
            this.botState = json.status;
            this.renderBotUI();
          }
        } catch (err) {
          console.error("[StrategyLab] Error setting sizing:", err);
        }
      }
    },

    async emergencyFlatten() {
      const ok = window.confirm("🚨 EMERGENCY FLATTEN ALL:\n\nImmediately pause the bot and market sell ALL open bot tranches back to 100% KRW cash?");
      if (!ok) return;
      try {
        const res = await fetch("api/strategy-lab/emergency-flatten", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const json = await res.json();
        if (json && json.success && json.status) {
          this.botState = json.status;
          this.renderBotUI();
        }
      } catch (err) {
        console.error("[StrategyLab] Error flattening bot tranches:", err);
      }
    },

    renderBotUI() {
      const s = this.botState;
      if (!s) return;

      const lblStrategy = el("lblLiveBotStrategy");
      if (lblStrategy) {
        const stratName = s.strategy_name || s.active_strategy;
        if (s.enabled && s.mode === "live") {
          lblStrategy.innerHTML = `<span style="color:#b91c1c; font-weight:800; display:inline-flex; align-items:center; gap:5px;"><span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#ef4444;"></span> REAL UPBIT: ${stratName}</span>`;
          lblStrategy.style.background = "#fee2e2";
          lblStrategy.style.borderColor = "#f87171";
        } else if (s.enabled && s.mode === "paper") {
          lblStrategy.innerHTML = `<span style="color:#1d4ed8; font-weight:800; display:inline-flex; align-items:center; gap:5px;"><span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#3b82f6;"></span> PAPER: ${stratName}</span>`;
          lblStrategy.style.background = "#eff6ff";
          lblStrategy.style.borderColor = "#93c5fd";
        } else {
          lblStrategy.innerHTML = `<span style="color:#64748b; font-weight:700;">${stratName} <small style="color:#94a3b8;">(PAUSED)</small></span>`;
          lblStrategy.style.background = "#f8fafc";
          lblStrategy.style.borderColor = "#e2e8f0";
        }
      }

      const btnPaper = el("btnModePaper");
      const btnLive = el("btnModeLive");
      if (btnPaper && btnLive) {
        if (s.mode === "live") {
          btnLive.classList.add("active");
          btnLive.style.background = "#dc2626";
          btnLive.style.color = "#ffffff";
          btnLive.style.fontWeight = "800";
          btnLive.textContent = s.enabled ? "🔴 Real Live (ACTIVE)" : "🔴 Real Upbit Live";

          btnPaper.classList.remove("active");
          btnPaper.style.background = "#ffffff";
          btnPaper.style.color = "#475569";
          btnPaper.style.fontWeight = "700";
          btnPaper.textContent = "🧪 Paper Trading";
        } else {
          btnPaper.classList.add("active");
          btnPaper.style.background = "#0284c7";
          btnPaper.style.color = "#ffffff";
          btnPaper.style.fontWeight = "800";
          btnPaper.textContent = s.enabled ? "🧪 Paper (ACTIVE)" : "🧪 Paper Trading";

          btnLive.classList.remove("active");
          btnLive.style.background = "#ffffff";
          btnLive.style.color = "#dc2626";
          btnLive.style.fontWeight = "700";
          btnLive.textContent = "🔴 Real Upbit Live";
        }
      }

      const btnPower = el("btnToggleBotPower");
      if (btnPower) {
        if (s.enabled) {
          btnPower.textContent = s.mode === "live" ? "⏸️ Pause Real Bot" : "⏸️ Pause Paper Bot";
          btnPower.style.background = s.mode === "live" ? "#b91c1c" : "#d97706";
          btnPower.style.borderColor = s.mode === "live" ? "#991b1b" : "#b45309";
          btnPower.style.color = "#ffffff";
        } else {
          btnPower.textContent = s.mode === "live" ? "▶️ Start Real Trading" : "▶️ Start Paper Trading";
          btnPower.style.background = s.mode === "live" ? "#dc2626" : "#16a34a";
          btnPower.style.borderColor = s.mode === "live" ? "#b91c1c" : "#15803d";
          btnPower.style.color = "#ffffff";
        }
      }

      const inpSize = el("inpBotTrancheSize");
      if (inpSize && document.activeElement !== inpSize) {
        inpSize.value = s.tranche_size_krw || 2000000;
      }

      if (s.active_tranches && s.active_tranches.length > 0) {
        const stackCount = el("valCritStackCount");
        if (stackCount) {
          const modeTag = s.mode === "live" ? "REAL UPBIT" : "PAPER";
          stackCount.innerHTML = `<span style="color:#0284c7; font-weight:700;">${s.active_tranches.length} ${modeTag} ACTIVE</span>`;
        }
      }

      if (this.controller && this.data) {
        this.controller.setExecutions(this.executionsForInterval());
        this.syncMarkerState();
      }
    },
  };

  window.strategyLab = lab;
})();
