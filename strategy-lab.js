(function () {
  "use strict";

  const rootId = (id) => `lab_${id}`;
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
    chartInterval: "5m",
    selectedMarkerTime: null,
    hoveredMarkerTime: null,
    syncingMarkerState: false,

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
        actual: { label: "Actual", enabled: false, visible: false },
        virtual: { label: "Virtual", onToggle: () => this.toggleVirtual() },
        status: "Loading backtest…",
        description: "Starts flat at the beginning of loaded history · completed 5m and 1h candles · next-open execution · entry and exit fees included.",
        secondaryStatus: "Completed 1h MA stack: waiting for data…",
        height: 420,
        legend: '<span style="color:#0284c7">━ BTC/KRW</span><span style="color:#b45309">— 7-MA: <strong id="lab_valShortTermMa7">--</strong></span><span style="color:#6d28d9">— 24-MA: <strong id="lab_valShortTermMa24">--</strong></span><span style="color:#0891b2">— 60-MA: <strong id="lab_valShortTermMa60">--</strong></span><span><strong style="color:#16a34a">▲</strong>/<strong style="color:#dc2626">▼</strong> Virtual</span>',
        syncText: "Upbit public candles",
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

      const supported = new Set([
        "chkCondEntryMaStack5m", "chkCondEntryMaStack1h",
        "chkCondExitMaStack5m", "chkCondExitMaStack1h",
      ]);
      section.querySelectorAll('input[type="checkbox"]').forEach((input) => {
        const original = input.id.replace(/^lab_/, "");
        if (!supported.has(original)) {
          input.checked = false;
          input.disabled = true;
          input.closest(".condRow")?.classList.add("disabled-cond");
        } else {
          input.disabled = false;
          input.closest(".condRow")?.classList.remove("disabled-cond");
        }
      });
      el("chkCondEntryMaStack5m").addEventListener("change", () => this.run());
      el("chkCondEntryMaStack1h").addEventListener("change", () => this.run());
      el("chkCondExitMaStack5m").addEventListener("change", () => this.run());
      el("chkCondExitMaStack1h").addEventListener("change", () => this.run());
      document.getElementById("strategyLabDays").addEventListener("change", () => this.run());
      document.getElementById("strategyLabTranches")?.addEventListener("change", () => this.run());
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
      this.chart.subscribeClick((param) => this.onClick(param));
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
        button.disabled = false;
        button.textContent = "Rerun";
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
      el("macroPolicyStatus").textContent = `Completed 1h: ${latestHour?.bearish ? "BEARISH STACK (DIP ENTRY)" : latestHour?.bullish ? "BULLISH STACK (RALLY EXIT)" : "NOT ALIGNED"} · next-open fills · ${data.fee_bps}bp/side`;
      el("valShortTermCurrentParity").textContent = latest ? krw(latest.close) : "--";
      el("valShortTermMa7").textContent = latest ? krw(latest.ma7) : "--";
      el("valShortTermMa24").textContent = latest ? krw(latest.ma24) : "--";
      el("valShortTermMa60").textContent = latest ? krw(latest.ma60) : "--";
      el("lblShortTermChartSync").textContent = `${data.days}d · ${data.bars.length.toLocaleString()} closed 5m bars`;
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
            const match = (this.data.markers || []).find(m => Math.floor(m.time / 3600) * 3600 === this.selectedMarkerTime);
            this.selectedMarkerTime = match ? match.time : null;
          }
        }
        this.renderChartData();
      }
    },

    executionsForInterval() {
      const markers = this.data?.markers || [];
      if (this.chartInterval === "5m") {
        return markers;
      }
      const hourlyBars = this.data?.hourly || [];
      const hourlyTimes = hourlyBars.map(b => b.time);
      return markers.map(m => {
        let hourTime = Math.floor(m.time / 3600) * 3600;
        if (hourlyTimes.length) {
          const match = hourlyBars.find(b => b.time <= m.time && m.time < b.time + 3600);
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
      const markers = this.data?.markers || [];
      const direct = markers.find(m => m.time === targetTime || m.rawTime === targetTime);
      if (direct) return direct;
      if (this.chartInterval === "1h") {
        const inHour = markers.filter(m => Math.floor(m.time / 3600) * 3600 === targetTime);
        if (inHour.length) {
          return inHour.find(m => !m.is_entry && m.exit_price) || inHour.at(-1);
        }
      }
      return null;
    },

    renderChartData() {
      const rows = this.chartInterval === "1h" ? (this.data?.hourly || []) : (this.data?.bars || []);
      this.candles.setData(rows.map((bar) => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      this.maSeries.forEach(({ key, series }) => series.setData(rows.filter((bar) => Number.isFinite(bar[key])).map((bar) => ({ time: bar.time, value: bar[key] }))));
      this.controller.setExecutions(this.executionsForInterval());
      this.syncMarkerState();
      this.chart.timeScale().fitContent();
    },

    syncConditionBadges(latest, hourly) {
      const data = this.data || {};
      const cap = data.capacity || {};
      const stack = Array.isArray(data.active_tranche_stack) ? data.active_tranche_stack : [];
      const top = stack[0] || null;

      const states = [
        ["badgeCondEntryMaStack5m", latest?.bearish], ["badgeCondEntryMaStack1h", hourly?.bearish],
        ["badgeCondEntryCapacity", (cap.remaining_tranches ?? 5) > 0],
        ["badgeCondEntryMargin", (cap.free_cash_krw ?? 10000000) >= (cap.tranche_capital_krw ?? 2000000) * 0.95],
        ["badgeCondExitActive", stack.length > 0],
        ["badgeCondExitMaStack5m", latest?.bullish], ["badgeCondExitMaStack1h", hourly?.bullish],
        ["badgeCondExitNetPnl", top ? top.unrealized_return_pct > 0 : false],
      ];
      states.forEach(([id, pass]) => {
        const badge = el(id);
        if (!badge) return;
        badge.textContent = pass ? "PASS" : "WAIT";
        badge.className = `condBadge ${pass ? "pass" : "wait"}`;
      });
      if (el("valCondEntryCapacity")) el("valCondEntryCapacity").textContent = `${cap.active_tranches ?? 0} / ${cap.max_tranches ?? 5}`;
      if (el("valCondEntryMargin")) el("valCondEntryMargin").textContent = `${krw(cap.free_cash_krw ?? 10000000)} free`;
      if (el("valCondExitActive")) el("valCondExitActive").textContent = `${stack.length} open`;
      if (el("valCondExitNetPnl")) el("valCondExitNetPnl").textContent = top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}%` : "—";

      el("badgeCriteriaScaleIn").textContent = latest?.bearish && hourly?.bearish ? "ENTRY ARMED (DIP)" : "AWAITING BEARISH STACK (5m/1h)";
      el("badgeCriteriaTP").textContent = latest?.bullish || hourly?.bullish ? "EXIT ARMED (RALLY)" : (stack.length ? "HOLDING TRANCHES" : "AWAITING BULLISH STACK");
    },

    syncCriteriaPanels(latest, hourly) {
      const data = this.data || {};
      const cap = data.capacity || {};
      const stack = Array.isArray(data.active_tranche_stack) ? data.active_tranche_stack : [];
      const top = stack[0] || null;

      // Card 1: Scale-in Criteria Card
      const scaleInTitle = el("lblCritScaleInTitle");
      if (scaleInTitle) scaleInTitle.textContent = "➕ Speculative Scale-In (KRW-BTC Dip Entry)";
      const scaleInDesc = el("txtCritScaleInDesc");
      if (scaleInDesc) scaleInDesc.innerHTML = `Trigger: 5m &amp; 1h Bearish MA Stack (<strong>Price &lt; MA7 &lt; MA24 &lt; MA60</strong>)`;
      const currentPrice = el("valCritCurrentSpread");
      if (currentPrice && latest) currentPrice.textContent = krw(latest.close);
      const gapScaleIn = el("valCritGapScaleIn");
      const dipArmed = latest?.bearish && hourly?.bearish;
      if (gapScaleIn) {
        gapScaleIn.textContent = dipArmed ? "DIP ARMED" : (latest?.bearish ? "5m ARMED (WAIT 1h)" : "AWAITING DIP");
        gapScaleIn.style.color = dipArmed ? "#16a34a" : "#d97706";
      }
      const scaleInProgress = el("barCritScaleInProgress");
      if (scaleInProgress) {
        scaleInProgress.style.width = dipArmed ? "100%" : (latest?.bearish ? "50%" : "20%");
      }

      // Card 2: Take-Profit Criteria Card
      const tpTitle = el("lblCritTPTitle");
      if (tpTitle) tpTitle.textContent = "🎯 LIFO Take-Profit (KRW-BTC Rally Exit)";
      const tpDesc = el("txtCritTPDesc");
      if (tpDesc) {
        tpDesc.innerHTML = top
          ? `Top tranche ref: <strong>${top.id} @ ${krw(top.entry_price)}</strong> (${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net)`
          : `Top tranche ref: <strong>No active tranches</strong> (Awaiting entry dip)`;
      }
      const tpCurrentPrice = el("valCritTpCurrentSpread");
      if (tpCurrentPrice && latest) tpCurrentPrice.textContent = krw(latest.close);
      const gapTP = el("valCritGapTP");
      const rallyArmed = latest?.bullish || hourly?.bullish;
      if (gapTP) {
        gapTP.textContent = top ? `${top.unrealized_return_pct >= 0 ? "+" : ""}${top.unrealized_return_pct.toFixed(2)}% net` : "Flat";
        gapTP.style.color = top ? (top.unrealized_return_pct >= 0 ? "#16a34a" : "#dc2626") : "#64748b";
      }
      const tpProgress = el("barCritTPProgress");
      if (tpProgress) {
        tpProgress.style.width = rallyArmed ? "100%" : (top && top.unrealized_return_pct > 0 ? "60%" : "15%");
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
      if (this.controller.visibility.virtual === false) {
        this.controller.clearReferenceLines();
        return;
      }
      const targetTime = this.selectedMarkerTime !== null ? this.selectedMarkerTime : hoverTime;
      const marker = this.findMarkerForTime(targetTime);
      if (marker && marker.entry_price) {
        this.renderEntryReferenceLines(marker.entry_price, true, marker.exit_price || null, marker);
      } else if (this.data?.open_position?.price) {
        this.renderEntryReferenceLines(this.data.open_position.price, false);
      } else {
        const lastMarker = (this.data?.markers || []).filter(m => m.entry_price).at(-1);
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

    toggleVirtual() {
      const visible = this.controller.toggleVisibility("virtual");
      const button = el("legendVirtualTrades");
      button.textContent = `${visible ? "✓" : "○"} Virtual`;
      button.setAttribute("aria-pressed", String(visible));
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
    },
  };

  window.strategyLab = lab;
})();
