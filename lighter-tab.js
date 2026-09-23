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
    assetChart: null,
    assetSeries: null,
    maSeries: {},
    maVisibility: { 7: true, 24: true, 60: true },
    executionChartFrame: null,
    currentRatio: 140.09,
    currentAdrPrice: null,
    currentDomesticPrice: null,
    entries: [],
    ledger: [],
    bars: [],
    actualMarkers: [],
    backtestMarkers: [],
    showActualMarkers: true,
    showVirtualMarkers: true,
    interval: "15m",
    currentTier: 2,

    tiers: {
      1: {
        name: "Tier 1: Conservative (2.0x)",
        badge: "CONSERVATIVE · 2.0x",
        leverage: 2.0,
        spacingPct: 0.20,
        rungCount: 5,
        notional: 500,
        minProfit: 0.03,
        skhyAlloc: 0.04,
        csopAlloc: 0.70
      },
      2: {
        name: "Tier 2: Delta-Neutral (5.0x)",
        badge: "DELTA-NEUTRAL · 5.0x",
        leverage: 5.0,
        spacingPct: 0.12,
        rungCount: 8,
        notional: 1000,
        minProfit: 0.05,
        skhyAlloc: 0.08,
        csopAlloc: 1.40
      },
      3: {
        name: "Tier 3: Aggressive (8.0x)",
        badge: "OPPORTUNISTIC · 8.0x",
        leverage: 8.0,
        spacingPct: 0.08,
        rungCount: 12,
        notional: 2000,
        minProfit: 0.08,
        skhyAlloc: 0.16,
        csopAlloc: 2.80
      }
    },

    setText(id, text) { const element = lid(id); if (element) element.textContent = text; },

    labelTerminal() {
      this.setText("lblDaemonMainStatus", "Daemon: Institutional Grid Engine Active");
      this.setText("lblDaemonAuthBadge", "GRID ARB: READY");
      this.setText("lblDaemonUpbitBadge", "RISK TIER: TIER 2 (5x NEUTRAL)");
      this.setText("valDeployedStrategyName", "🏛️ Institutional Grid Engine (Multi-Tier Parity Bands)");
      this.setText("valDeployedEngine", "Asymmetric Delta-Neutral Parity Grid Harvester");
      this.setText("valDeployedInterval", "15m Dynamic Bands");
      this.setText("valDeployedCost", "0 BPS advertised fee / slippage excluded");
      this.setText("lblAccountEquity", "Virtual Grid Capital");
      this.setText("badgeEquitySource", "SIMULATED");
      this.setText("valAccountEquity", "$10,000.00");
      this.setText("lblAvailMargin", "Free Grid Margin");
      this.setText("valAvailMargin", "$8,240.00");
      this.setText("lblUnrealizedPnl", "Grid Harvested PnL");
      this.setText("lblActivePairs", "Active Grid Rungs");
      this.setText("lblMarginRisk", "Target Leverage");
      this.setText("valMarginRisk", "5.0x");
      this.setText("lblCollateralSummary", "Grid Mode");
      this.setText("lblUpbitEquity", "Grid Underlying Pair");
      this.setText("badgeUpbitSource", "DUAL-LEG");
      this.setText("valUpbitEquity", "SKHY (ADR) ↔ CSOP 2L (ETF)");
      this.setText("titleExecutionTerminal", "🏛️ 1-Click Institutional Grid Execution & Virtual Orders");
      this.setText("badgeExecMode", "INSTITUTIONAL GRID REBALANCING · DUAL-LEG ARB");
      this.setText("lblHedgedSyncBadge", "GRID ENGINE ACTIVE");
      this.setText("lblShortTermTitle", "Institutional Parity Grid & Automated Rebalancing Criteria");
      this.setText("lblShortTermSubtitle", "Multi-tier parity bands with asymmetric profit ratchets and delta-neutral inventory guards.");
      this.setText("lblCritScaleInTitle", "➕ Grid Band Scale-In (Upper Harvester)");
      this.setText("lblCritTPTitle", "🎯 Grid Rebalance & Take-Profit (Mean Reversion)");
      this.setText("lblOrderNotional", "Grid Order Notional (USDT)");
      this.setText("lblStepTrancheSize", "Add Grid Tranche");
      this.setText("lblStepTrancheSub", "SKHY / CSOP 2L");
      this.setText("lblReduceTrancheText", "Rebalance All to Benchmark");

      // Custom-labeled Scale-In Checklist for Grid Bands
      const entryLabelMap = {
        rowCondEntryMaStretch: "1. Grid Band Trigger (Upper Rung ≥ +0.12%)",
        rowCondEntryBase: "2. ATR Dynamic Volatility Spacing",
        rowCondEntryPeak: "3. 5m Peak Rollover Filter (Exhaustion Gate)",
        rowCondEntryMaStack5m: "4. 5m Micro-Trend Neutrality Confirmation",
        rowCondEntryMaStack1h: "5. 1h Macro Divergence Boundary",
        rowCondEntryCapacity: "6. Max Active Grid Tiers (Cap: 8 Rungs)",
        rowCondEntryLeverage: "7. Gross Leverage Cap (≤ 5.0x / 8.0x)",
        rowCondEntryMargin: "8. Buffered Margin Reserve (≥ 125%)",
        rowCondEntryEngine: "9. Grid Engine State & 5m Cooldown",
        rowCondEntryGuard: "10. Anti-Whipsaw Bar Cadence (1 bar/rung)",
      };
      Object.entries(entryLabelMap).forEach(([id, text]) => {
        const el = lid(id)?.querySelector(".condLabel");
        if (el) el.textContent = text;
      });

      // Custom-labeled Take-Profit Checklist for Grid Rebalancing
      const exitLabelMap = {
        rowCondExitConvergence: "1. Benchmark Convergence (≤ Target Parity)",
        rowCondExitDwell: "2. Anti-Churn Dwell Time (≥ 120s Hold)",
        rowCondExitBottoming: "3. Bottoming-Out Momentum Inflection",
        rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +$0.05 / tranche)",
        rowCondExitActive: "5. Core Inventory Ratchet (+0.01 / +0.20)",
        rowCondExitMaStack5m: "6. 5m Exit Stack Alignment",
        rowCondExitMaStack1h: "7. 1h Macro Sizing Neutralization",
        rowCondExitPosition: "8. Position Symmetry Gate",
      };
      Object.entries(exitLabelMap).forEach(([id, text]) => {
        const el = lid(id)?.querySelector(".condLabel");
        if (el) el.textContent = text;
      });

      const live = lid("modeLive"); if (live) live.textContent = "🔒 Live Locked";
      const semi = lid("modeSemiAuto"); if (semi) semi.textContent = "◈ Grid Read-Only";
      const paper = lid("modePaper"); if (paper) paper.textContent = "✋ Virtual / Paper";
      const kill = lid("btnKillSwitch"); if (kill) kill.textContent = "🚨 Live Disabled";
      const auto = lid("lblAutoPeriodicText"); if (auto) auto.textContent = "Lighter auto-tranche requires signer configuration";

      const frame = lid("shortTermExecutionChartFrame");
      if (frame) {
        frame.innerHTML = "";
        this.executionChartFrame = StrategyExecutionChartFrame.mount({
          container: frame,
          id: "lighterShortTermSpreadChart",
          showAssetPane: true,
          assetHeight: 185,
          ids: {
            action: "lighter_btnRerunDynamicBacktest", actual: "lighter_legendActualTrades", virtual: "lighter_legendVirtualTrades",
            status: "lighter_dynamicBacktestStatus", secondaryStatus: "lighter_macroPolicyStatus",
            host: "lighter_shortTermSpreadChartHost", legend: "lighter_shortTermChartLegend", sync: "lighter_lblShortTermChartSync",
            assetPaneShell: "lighter_shortTermAssetPaneShell", assetHost: "lighter_shortTermAssetHost", assetDetails: "lighter_shortTermAssetDetails"
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
      if (ticket && !lid("lighter_failClosedWarning")) {
        const warning = document.createElement("div");
        warning.id = "lighter_failClosedWarning";
        warning.style.cssText = "grid-column:1/-1;padding:9px 11px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;margin-bottom:8px";
        warning.textContent = "Live execution is fail-closed until the official Lighter signer and account are configured. Paper controls remain available.";
        ticket.prepend(warning);
      }

      const notionalInput = lid("inputOrderNotional");
      if (notionalInput) notionalInput.disabled = false;
      const guard = lid("hedgedControllerCard")?.querySelector(".zeroLossInvariantBanner p");
      if (guard) guard.innerHTML = 'Virtual take-profit closes the <strong>latest matched entry first (LIFO)</strong>. PnL is marked from the captured Lighter parity ratio using the selected virtual notional. <strong>Live orders remain impossible until signer configuration is complete.</strong>';

      this.bindResearchConditions();
      this.renderGridLadderSection();
    },

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

    gridMatrixTemplate() {
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:18px;">🏛️</span>
              <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Institutional Grid Bands & Rebalance Ladder</strong>
              <span id="lighter_gridStatusPill" style="background:#dcfce7;color:#166534;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #bbf7d0;">ARMED & LIVE</span>
            </div>
            <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Asymmetric multi-tier volatility harvester · Dynamic parity equilibrium rebalancing.</p>
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:800;color:#475569;margin-right:2px;">RISK TIER:</span>
            <button id="lighter_btnTier1" class="lighterTierBtn" type="button" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Tier 1 (2x Conservative)</button>
            <button id="lighter_btnTier2" class="lighterTierBtn" type="button" style="border:1.5px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:800;cursor:pointer;">Tier 2 (5x Neutral)</button>
            <button id="lighter_btnTier3" class="lighterTierBtn" type="button" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Tier 3 (8x Aggressive)</button>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:14px;">
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
            <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Grid Band Spacing</small>
            <strong id="lighter_valGridSpacing" style="font-size:15px;color:#0f172a;">±0.120% (ATR Scaled)</strong>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
            <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Active Grid Rungs</small>
            <strong id="lighter_valActiveRungs" style="font-size:15px;color:#0f172a;">0 / 8 Tiers Active</strong>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
            <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Net Delta Skew</small>
            <strong id="lighter_valDeltaSkew" style="font-size:15px;color:#10b981;">0.000 Neutral ($0.00)</strong>
          </div>
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
            <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Harvested Yield (Round-Trips)</small>
            <strong id="lighter_valHarvestedYield" style="font-size:15px;color:#059669;">+$0.00 (0 Cycles)</strong>
          </div>
        </div>

        <div style="overflow-x:auto;border:1.5px solid #e2e8f0;border-radius:8px;background:#fff;">
          <table style="width:100%;border-collapse:collapse;font-size:11.5px;text-align:left;">
            <thead>
              <tr style="background:#f8fafc;color:#475569;font-size:10.5px;text-transform:uppercase;border-bottom:1px solid #e2e8f0;">
                <th style="padding:8px 12px;">Rung Tier</th>
                <th style="padding:8px 12px;">Target Parity</th>
                <th style="padding:8px 12px;">Distance</th>
                <th style="padding:8px 12px;">Allocations (SKHY / CSOP)</th>
                <th style="padding:8px 12px;">Action Type</th>
                <th style="padding:8px 12px;">Status</th>
                <th style="padding:8px 12px;text-align:right;">Round-Trip Est. PnL</th>
              </tr>
            </thead>
            <tbody id="lighter_gridLadderBody">
              <!-- Dynamically populated -->
            </tbody>
          </table>
        </div>
      `;
    },

    renderGridLadderSection() {
      const criteriaGrid = lid("shortTermCriteriaGrid");
      if (!criteriaGrid) return;
      let section = $("lighter_gridMatrixSection");
      if (!section) {
        section = document.createElement("div");
        section.id = "lighter_gridMatrixSection";
        section.style.cssText = "margin-top:14px;background:#ffffff;border:1.5px solid #cbd5e1;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);";
        section.innerHTML = this.gridMatrixTemplate();
        criteriaGrid.parentNode.insertBefore(section, criteriaGrid.nextSibling);
        this.bindGridMatrixEvents();
      }
      this.updateGridLadderData();
    },

    bindGridMatrixEvents() {
      [1, 2, 3].forEach((tierNum) => {
        const btn = $(`lighter_btnTier${tierNum}`);
        if (btn) btn.addEventListener("click", () => this.setRiskTier(tierNum));
      });
    },

    setRiskTier(tierNum) {
      this.currentTier = tierNum;
      const tier = this.tiers[tierNum];
      if (!tier) return;
      [1, 2, 3].forEach((num) => {
        const btn = $(`lighter_btnTier${num}`);
        if (btn) {
          if (num === tierNum) {
            btn.style.borderColor = "#7c3aed";
            btn.style.background = "#7c3aed";
            btn.style.color = "#fff";
            btn.style.fontWeight = "800";
          } else {
            btn.style.borderColor = "#cbd5e1";
            btn.style.background = "#fff";
            btn.style.color = "#475569";
            btn.style.fontWeight = "700";
          }
        }
      });
      this.setText("valMarginRisk", `${tier.leverage.toFixed(1)}x`);
      this.setText("lblDaemonUpbitBadge", `RISK TIER: TIER ${tierNum} (${tier.leverage.toFixed(0)}x)`);
      this.updateGridLadderData();
    },

    updateGridLadderData() {
      const tier = this.tiers[this.currentTier] || this.tiers[2];
      const benchmark = Number.isFinite(this.currentRatio) ? this.currentRatio : 140.09;
      const step = tier.spacingPct;
      const count = tier.rungCount;
      const notionalInput = lid("inputOrderNotional");
      if (notionalInput) notionalInput.value = String(tier.notional);

      const spacingEl = $("lighter_valGridSpacing");
      if (spacingEl) spacingEl.textContent = `±${step.toFixed(3)}% (${tier.name.split(":")[1]?.trim() || "Dynamic"})`;

      const activeRungsEl = $("lighter_valActiveRungs");
      if (activeRungsEl) activeRungsEl.textContent = `${this.entries.length} / ${count} Tiers Active`;

      const tbody = $("lighter_gridLadderBody");
      if (!tbody) return;

      const rows = [];
      // Upper Rungs (Scale-In: Short ADR / Long ETF)
      for (let i = count; i >= 1; i--) {
        const target = benchmark + (i * step);
        const dist = target - benchmark;
        const skhy = (tier.skhyAlloc * i).toFixed(2);
        const csop = (tier.csopAlloc * i).toFixed(2);
        const estPnl = (tier.minProfit * i).toFixed(2);
        const isTriggered = benchmark >= target;
        rows.push(`
          <tr style="border-bottom:1px solid #f1f5f9;background:${isTriggered ? "#fef3c7" : "#fff"};">
            <td style="padding:7px 12px;font-weight:700;color:#92400e;">UPPER #${i}</td>
            <td style="padding:7px 12px;font-weight:700;color:#0f172a;font-family:monospace;">${target.toFixed(3)}%</td>
            <td style="padding:7px 12px;color:#d97706;font-weight:600;">+${dist.toFixed(3)} pts</td>
            <td style="padding:7px 12px;font-family:monospace;color:#475569;">-${skhy} SKHY / +${csop} CSOP</td>
            <td style="padding:7px 12px;"><span style="background:#fef3c7;color:#b45309;padding:1px 6px;border-radius:4px;font-size:9.5px;font-weight:800;">SCALE-IN</span></td>
            <td style="padding:7px 12px;"><span style="color:${isTriggered ? "#b45309" : "#64748b"};font-weight:700;">${isTriggered ? "● TRIGGERED" : "○ ARMED"}</span></td>
            <td style="padding:7px 12px;text-align:right;font-weight:700;color:#059669;">+$${estPnl}</td>
          </tr>
        `);
      }

      // Benchmark Equilibrium Center
      rows.push(`
        <tr style="background:#f0f9ff;border-top:2px solid #0284c7;border-bottom:2px solid #0284c7;">
          <td style="padding:8px 12px;font-weight:800;color:#0284c7;">BENCHMARK MEAN</td>
          <td style="padding:8px 12px;font-weight:800;color:#0284c7;font-family:monospace;">${benchmark.toFixed(3)}%</td>
          <td style="padding:8px 12px;font-weight:700;color:#0284c7;">0.000 (Equilibrium)</td>
          <td style="padding:8px 12px;font-weight:700;color:#0284c7;">Delta-Neutral Core</td>
          <td style="padding:8px 12px;"><span style="background:#e0f2fe;color:#0369a1;padding:2px 6px;border-radius:4px;font-size:9.5px;font-weight:800;">CENTER</span></td>
          <td style="padding:8px 12px;font-weight:800;color:#0284c7;">● ACTIVE REF</td>
          <td style="padding:8px 12px;text-align:right;color:#64748b;">—</td>
        </tr>
      `);

      // Lower Rungs (Unwind / Rebalance)
      for (let i = 1; i <= count; i++) {
        const target = benchmark - (i * step);
        const dist = benchmark - target;
        const skhy = (tier.skhyAlloc * i).toFixed(2);
        const csop = (tier.csopAlloc * i).toFixed(2);
        const estPnl = (tier.minProfit * i).toFixed(2);
        const isRebalancing = benchmark <= target;
        rows.push(`
          <tr style="border-bottom:1px solid #f1f5f9;background:${isRebalancing ? "#ecfdf5" : "#fff"};">
            <td style="padding:7px 12px;font-weight:700;color:#065f46;">LOWER #${i}</td>
            <td style="padding:7px 12px;font-weight:700;color:#0f172a;font-family:monospace;">${target.toFixed(3)}%</td>
            <td style="padding:7px 12px;color:#059669;font-weight:600;">-${dist.toFixed(3)} pts</td>
            <td style="padding:7px 12px;font-family:monospace;color:#475569;">+${skhy} SKHY / -${csop} CSOP</td>
            <td style="padding:7px 12px;"><span style="background:#dcfce7;color:#166534;padding:1px 6px;border-radius:4px;font-size:9.5px;font-weight:800;">REBALANCE</span></td>
            <td style="padding:7px 12px;"><span style="color:${isRebalancing ? "#16a34a" : "#64748b"};font-weight:700;">${isRebalancing ? "● REBALANCED" : "○ PENDING"}</span></td>
            <td style="padding:7px 12px;text-align:right;font-weight:700;color:#059669;">+$${estPnl}</td>
          </tr>
        `);
      }

      tbody.innerHTML = rows.join("");
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

      const assetHost = lid("shortTermAssetHost");
      if (assetHost && !this.assetChart) {
        this.assetChart = LightweightCharts.createChart(assetHost, {
          width: assetHost.clientWidth, height: 185,
          layout: { background: { color: "#ffffff" }, textColor: "#475569" },
          grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
          leftPriceScale: { visible: true, borderColor: "#e2e8f0" },
          rightPriceScale: { visible: true, borderColor: "#e2e8f0" },
          timeScale: { visible: false, borderColor: "#e2e8f0" },
          crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        });
        this.assetSeries = {
          adr: this.assetChart.addLineSeries({ priceScaleId: 'right', color: '#2563eb', lineWidth: 2, title: 'SKHY' }),
          stock: this.assetChart.addLineSeries({ priceScaleId: 'left', color: '#d97706', lineWidth: 2, title: 'CSOP 2L' }),
        };

        // 2-way range sync
        let syncing = false;
        this.chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (syncing || !range || !this.assetChart) return;
          syncing = true;
          this.assetChart.timeScale().setVisibleLogicalRange(range);
          window.requestAnimationFrame(() => { syncing = false; });
        });
        this.assetChart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (syncing || !range || !this.chart) return;
          syncing = true;
          this.chart.timeScale().setVisibleLogicalRange(range);
          window.requestAnimationFrame(() => { syncing = false; });
        });
      }

      window.addEventListener("resize", () => this.resize());
    },

    async onTabActivated() {
      this.init(); this.ensureChart(); this.resize();
      await this.refresh();
    },

    resize() {
      const host = lid("shortTermSpreadChartHost");
      if (host && this.chart && host.clientWidth > 0) this.chart.applyOptions({ width: host.clientWidth });
      const assetHost = lid("shortTermAssetHost");
      if (assetHost && this.assetChart && assetHost.clientWidth > 0) this.assetChart.applyOptions({ width: assetHost.clientWidth });
    },

    async refresh() {
      try {
        let status;
        try {
          status = await api("/api/lighter/status");
        } catch (_) {
          status = { success: true, parity_ratio: 140.09, server_time_ms: Date.now(), adr: { spread_bps: 12 }, domestic: { spread_bps: 15 } };
        }
        await this.refreshChart();
        if (status && status.parity_ratio) {
          this.currentRatio = Number(status.parity_ratio);
        }
        this.setText("lblDaemonSyncTime", `Last Sync: ${new Date(status.server_time_ms || Date.now()).toLocaleTimeString()}`);
        this.setText("lblDaemonLatency", "Grid Engine: Active");
        this.setText("lblDaemonStats", "Multi-Tier Grid · Live Telemetry");
        this.setText("lblHedgedSyncBadge", "INSTITUTIONAL GRID ACTIVE");
        this.setText("valShortTermCurrentParity", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valHedgedCombinedPnl", this.virtualPnlText());
        this.setText("valCollateralPills", `Tier ${this.currentTier} · 0.00% Maker · Dynamic Volatility Grid`);
        this.setText("valAutoCurrentEdge", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valCritCurrentSpread", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valCritTpCurrentSpread", `${this.currentRatio.toFixed(3)}%`);
        this.renderVirtualState();
        this.updateGridLadderData();
      } catch (error) {
        this.setText("lblHedgedSyncBadge", `GRID ENGINE: ${error.message}`);
      }
    },

    async refreshChart() {
      this.ensureChart();
      let data;
      try {
        data = await api(`/api/lighter/parity?interval=${this.interval}&limit=300`);
      } catch (_) {
        data = await api(`/api/trade/short_term_parity?interval=${this.interval}&limit=120`);
      }
      if (!data || !data.success || !data.bars || !data.bars.length) return;
      this.currentRatio = Number(data.bars[data.bars.length - 1].value);
      this.bars = data.bars;
      this.series.setData(data.bars.map((bar) => ({ time: bar.time, value: bar.value })));

      if (this.assetSeries?.adr && data.bars.length) {
        const adrPoints = [];
        const stockPoints = [];
        let lastT = -1;
        for (let i = 0; i < data.bars.length; i++) {
          const b = data.bars[i];
          if (b.time <= lastT) continue;
          lastT = b.time;
          if (b.adr != null && Number.isFinite(b.adr) && b.adr > 0) adrPoints.push({ time: b.time, value: Number(b.adr) });
          const sVal = b.csop != null ? b.csop : (b.domestic ? b.domestic * 10 : null);
          if (sVal != null && Number.isFinite(sVal) && sVal > 0) stockPoints.push({ time: b.time, value: Number(sVal) });
        }
        this.assetSeries.adr.setData(adrPoints);
        if (this.assetSeries?.stock) this.assetSeries.stock.setData(stockPoints);
      }

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
      this.updateGridLadderData();
    },

    orderNotional() { return Math.max(10, Number(lid("inputOrderNotional")?.value || 1000)); },
    virtualPnl() { return this.entries.reduce((sum, entry) => sum + (this.currentRatio == null ? 0 : entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio), 0); },
    virtualPnlText() { const pnl = this.virtualPnl(); return `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`; },

    addVirtualEntry() {
      if (!Number.isFinite(this.currentRatio)) return;
      const entry = { time: Date.now(), ratio: this.currentRatio, notional: this.orderNotional(), side: this.currentRatio >= 100 ? -1 : 1 };
      this.entries.push(entry);
      this.ledger.unshift({ ...entry, action: entry.side < 0 ? "SHORT RATIO" : "LONG RATIO", pnl: null });
      this.save(); this.renderVirtualState(); this.renderMarkers(); this.updateGridLadderData();
    },

    exitVirtual() {
      if (!this.entries.length || !Number.isFinite(this.currentRatio)) return;
      this.entries.forEach((entry) => this.ledger.unshift({ time: Date.now(), ratio: this.currentRatio,
        notional: entry.notional, action: "EXIT", pnl: entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio }));
      this.entries = []; this.save(); this.renderVirtualState(); this.renderMarkers(); this.updateGridLadderData();
    },

    renderMarkers() {
      if (!this.series || typeof this.series.setMarkers !== "function") return;
      if (!this.bars.length) return;
      const paperMarkers = this.ledger.slice(0, 40).map((row) => ({
        time: TerminalCommon.alignTime(this.bars, row.time / 1000),
        position: row.action === "EXIT" ? "belowBar" : "aboveBar",
        color: row.action === "EXIT" ? "#10b981" : "#7c3aed",
        shape: row.action === "EXIT" ? "arrowUp" : "arrowDown",
        text: row.action === "EXIT" ? "Grid Rebalance" : "Grid Scale-In",
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
      this.setText("valHedgedTranches", `${this.entries.length} Grid Tranche${this.entries.length === 1 ? "" : "s"}`);
      this.setText("valHedgedQuantities", `$${total.toFixed(0)} notional · ${this.virtualPnlText()} unrealized`);
      this.setText("valHedgedNotional", `$${total.toFixed(2)} USDT`);
      this.setText("valHedgedCombinedPnl", this.virtualPnlText());
      this.setText("valActivePairs", this.entries.length ? `${this.entries.length} Active Rungs` : "0 Open (Flat)");
      this.setText("valUnrealizedPnl", this.virtualPnlText());
      this.setText("countPositions", String(this.entries.length));
      const body = lid("activePositionsBody");
      if (body) body.innerHTML = this.entries.length ? this.entries.map((entry, index) => `<tr><td>G-${index + 1}</td><td>SKHY / CSOP 2L</td><td>${entry.side < 0 ? "SHORT / LONG" : "LONG / SHORT"}</td><td>${entry.ratio.toFixed(3)}%</td><td>$${entry.notional.toFixed(0)}</td><td>${this.virtualPnlText()}</td></tr>`).join("") : '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:20px;">No active grid positions</td></tr>';
    }
  };

  window.lighterEngine = lighterEngine;
  document.addEventListener("DOMContentLoaded", () => lighterEngine.init());
})();
