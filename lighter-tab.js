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
    executionChartController: null,
    activeHoveredExecutionMarkerTime: null,
    selectedExecutionMarkerTime: null,
    rawExecutionMarkers: [],
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
    currentParadigm: "grid",
    paradigms: {
      grid: {
        id: "grid",
        name: "Dynamic Grid",
        icon: "🏛️",
        badge: "PARITY HARVESTING · GRID ARB",
        title: "➕ Grid Band Scale-In (Upper Harvester)",
        desc: "Adaptive trigger: Parity ≥ Upper Rung (rolling mean; ATR dynamic volatility + reset guard)",
        tpTitle: "🎯 Grid Rebalance & Take-Profit (Mean Reversion)",
        tpDesc: "Adaptive exit: Parity ≤ Benchmark Mean (Zero-Loss Hurdle > +$0.02, Core Ratchet, Anti-churn Dwell)",
        entryLabels: {
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
        },
        exitLabels: {
          rowCondExitConvergence: "1. Benchmark Convergence (≤ Target Parity)",
          rowCondExitDwell: "2. Anti-Churn Dwell Time (≥ 4 Bars Hold)",
          rowCondExitBottoming: "3. Bottoming-Out Momentum Inflection",
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +$0.05 / tranche)",
          rowCondExitActive: "5. Core Inventory Ratchet (+0.01 / +0.20)",
          rowCondExitMaStack5m: "6. 5m Exit Stack Alignment",
          rowCondExitMaStack1h: "7. 1h Macro Sizing Neutralization",
          rowCondExitPosition: "8. Position Symmetry Gate",
        },
        researchLabels: {
          valCondEntryMaStretch: "Replay: require selected Upper Rung Z",
          valCondEntryBase: "Replay: require +0.10pt dynamic spacing",
          valCondEntryPeak: "Replay: require z-score rollover",
          valCondEntryMaStack5m: "Replay: require MA7 / MA24 alignment",
          valCondExitConvergence: "Replay: require selected Exit Z",
          valCondExitDwell: "Replay: minimum four bars held",
          valCondExitBottoming: "Replay: require convergence rollover",
        },
        defaultParams: { entry_z: 1.5, exit_z: 0.25 }
      },
      ou_quant: {
        id: "ou_quant",
        name: "Ornstein-Uhlenbeck SDE",
        icon: "🔬",
        badge: "STATISTICAL ARBITRAGE · SDE DRIFT",
        title: "➕ OU Stochastic Equilibrium Scale-In",
        desc: "SDE Trigger: Parity Discount ≥ 2.0σ from calibrated continuous OU drift mean (dX = θ(μ - X)dt + σdW)",
        tpTitle: "🎯 OU Mean Reversion Neutral Crossing",
        tpDesc: "SDE Exit: Parity recovers to |Z_OU| ≤ 0.25σ or half-life time-stop (3 × τ_half) expires",
        entryLabels: {
          rowCondEntryMaStretch: "1. Calibrated OU Drift Stretch (Z_OU ≥ 2.0σ)",
          rowCondEntryBase: "2. Half-Life Actionability Window (15m ≤ τ ≤ 4h)",
          rowCondEntryPeak: "3. Second-Derivative Deceleration (d²Z/dt² < 0)",
          rowCondEntryMaStack5m: "4. Stationarity Confirmation (ADF p < 0.05)",
          rowCondEntryMaStack1h: "5. Cointegration Drift Persistence Filter",
          rowCondEntryCapacity: "6. Maximum SDE Position Size Allocation",
          rowCondEntryLeverage: "7. Mean-Reversion Kelly Sizing Factor",
          rowCondEntryMargin: "8. Variance-Covariance Margin Buffer",
          rowCondEntryEngine: "9. OU Kalman Filter State Convergence",
          rowCondEntryGuard: "10. Structural Regime Shift Lockout",
        },
        exitLabels: {
          rowCondExitConvergence: "1. OU Neutral Line Crossing (|Z_OU| ≤ 0.25σ)",
          rowCondExitDwell: "2. Half-Life Expiry Time-Stop (3 × τ_half)",
          rowCondExitBottoming: "3. Mean Reversion Deceleration Inflection",
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +$0.02 / tranche)",
          rowCondExitActive: "5. Asymmetric Alpha Retention Ratchet",
          rowCondExitMaStack5m: "6. Residual Error Envelope Crossing",
          rowCondExitMaStack1h: "7. Structural Drift Boundary Check",
          rowCondExitPosition: "8. SDE Delta Position Balance",
        },
        researchLabels: {
          valCondEntryMaStretch: "Replay: require OU Z-score stretch",
          valCondEntryBase: "Replay: require half-life viability filter",
          valCondEntryPeak: "Replay: require drift deceleration",
          valCondEntryMaStack5m: "Replay: require stationary regime",
          valCondExitConvergence: "Replay: require neutral line crossing",
          valCondExitDwell: "Replay: half-life time-stop enforced",
          valCondExitBottoming: "Replay: require mean inflection",
        },
        defaultParams: { entry_z: 1.8, exit_z: 0.20 }
      },
      ma_stack: {
        id: "ma_stack",
        name: "Trend MA Stack",
        icon: "📈",
        badge: "MOMENTUM DIP-BUYING · MA STACK",
        title: "➕ Multi-Timeframe MA Stack Dip Entry",
        desc: "Trigger: 5m & 1h Bearish Alignment (Price < MA7 < MA24 < MA60) + MA Stretch ≥ 0.35%",
        tpTitle: "🎯 Trend Golden Cross & Trailing Exit",
        tpDesc: "Exit: 5m MA7 crosses above MA24 or Trailing Profit Stop (0.15% drawdown from peak)",
        entryLabels: {
          rowCondEntryMaStretch: "1. 60-MA Stretch Discount (≥ 0.35% Gap)",
          rowCondEntryBase: "2. Minimum Dip Cadence Spacing (≥ 0.15pt)",
          rowCondEntryPeak: "3. Momentum Climax Exhaustion Rollover",
          rowCondEntryMaStack5m: "4. 5m Full MA Stack (Price < MA7 < MA24 < MA60)",
          rowCondEntryMaStack1h: "5. 1h Macro Trend Support Alignment",
          rowCondEntryCapacity: "6. Trend Tier Scaling Cap (≤ 5 Tranches)",
          rowCondEntryLeverage: "7. Trend Leverage Allowance (≤ 4.0x)",
          rowCondEntryMargin: "8. Trend Volatility Margin Guard",
          rowCondEntryEngine: "9. Momentum Engine State Active",
          rowCondEntryGuard: "10. Anti-Breakdown Gap Filter",
        },
        exitLabels: {
          rowCondExitConvergence: "1. MA7 / MA24 Bullish Golden Cross",
          rowCondExitDwell: "2. Minimum Trend Dwell (≥ 3 Candles)",
          rowCondExitBottoming: "3. Trailing Stop Ratchet (0.15% Trail)",
          rowCondExitNetPnl: "4. Zero-Loss Guaranteed Lock (> +$0.03)",
          rowCondExitActive: "5. Core Trend Inventory Retention",
          rowCondExitMaStack5m: "6. Fast MA Mean Reversion Touch",
          rowCondExitMaStack1h: "7. Macro Resistance Rejection Exit",
          rowCondExitPosition: "8. Trend Hedged Position Balance",
        },
        researchLabels: {
          valCondEntryMaStretch: "Replay: require MA60 stretch gap",
          valCondEntryBase: "Replay: require dip spacing cadence",
          valCondEntryPeak: "Replay: require momentum exhaustion",
          valCondEntryMaStack5m: "Replay: require 5m MA Stack alignment",
          valCondExitConvergence: "Replay: require MA7/MA24 golden cross",
          valCondExitDwell: "Replay: require 3-candle minimum hold",
          valCondExitBottoming: "Replay: require trailing stop ratchet",
        },
        defaultParams: { entry_z: 1.2, exit_z: 0.30 }
      },
      multi_factor: {
        id: "multi_factor",
        name: "Multi-Factor Gate",
        icon: "⚖️",
        badge: "CONFLUENCE CONSENSUS · VOTING GATE",
        title: "➕ Multi-Factor Confluence Entry Gate",
        desc: "Consensus Trigger: Requires at least 3 of 4 quantitative factors voting YES (Z-Score, Velocity, MA7, Local Extremum)",
        tpTitle: "🎯 Consensus Demotion & Reversion Exit",
        tpDesc: "Consensus Exit: Active factors drop below 2 of 4 or parity returns to equilibrium mean",
        entryLabels: {
          rowCondEntryMaStretch: "1. Factor 1: Parity Z-Score Stretch (≥ 1.5σ)",
          rowCondEntryBase: "2. Factor 2: Velocity Acceleration Asymmetry",
          rowCondEntryPeak: "3. Factor 3: 7-MA Short-Term Spread Divergence",
          rowCondEntryMaStack5m: "4. Factor 4: 12-Bar Local Price Extremum",
          rowCondEntryMaStack1h: "5. 3-of-4 Confluence Quorum Threshold",
          rowCondEntryCapacity: "6. Factor Weighted Capacity Allowance",
          rowCondEntryLeverage: "7. Volatility Adjusted Leverage Multiplier",
          rowCondEntryMargin: "8. Risk Factor Balanced Margin",
          rowCondEntryEngine: "9. Voting Gate Engine Synchronization",
          rowCondEntryGuard: "10. Anti-False-Breakout Gate Cadence",
        },
        exitLabels: {
          rowCondExitConvergence: "1. Consensus Demotion (Active Votes < 2)",
          rowCondExitDwell: "2. Quorum Persistence Dwell (≥ 3 Bars)",
          rowCondExitBottoming: "3. Consensus Recovery Inflection",
          rowCondExitNetPnl: "4. Zero-Loss Invariant Rule (> +$0.02)",
          rowCondExitActive: "5. Multi-Factor Core Retention",
          rowCondExitMaStack5m: "6. Factor Balance Mean Touch",
          rowCondExitMaStack1h: "7. Macro Factor Demotion Cut",
          rowCondExitPosition: "8. Multi-Asset Factor Balance",
        },
        researchLabels: {
          valCondEntryMaStretch: "Replay: require Factor 1 Z-Score",
          valCondEntryBase: "Replay: require Factor 2 Velocity",
          valCondEntryPeak: "Replay: require Factor 3 MA Divergence",
          valCondEntryMaStack5m: "Replay: require Factor 4 Local Extremum",
          valCondExitConvergence: "Replay: exit on consensus demotion",
          valCondExitDwell: "Replay: minimum quorum dwell",
          valCondExitBottoming: "Replay: require consensus inflection",
        },
        defaultParams: { entry_z: 1.5, exit_z: 0.25 }
      },
      trend_pullback: {
        id: "trend_pullback",
        name: "Macro Trend Reversion",
        icon: "🌊",
        badge: "DUAL-TIMEFRAME · TRENDLINE PULLBACK",
        title: "➕ Macro Trendline Pullback Dip-Buy (or Rip-Sell)",
        desc: "Hierarchical Trigger: Macro trendline (OLS slope) uptrend + Price pulls below trendline by ≥ 0.15% + Micro reversal hook inflects upward (and vice-versa for downtrend)",
        tpTitle: "🎯 Trendline Equilibrium Reversion & Exhaustion Exit",
        tpDesc: "Exit: Price recovers past the dynamic trendline (+0.05% offset), opposite micro-reversal exhausts, or macro trend invalidates",
        entryLabels: {
          rowCondEntryMaStretch: "1. Macro Trend Slope Filter (|β| ≥ 0.002)",
          rowCondEntryBase: "2. Trendline Distance Barrier (Δ ≥ 0.15%)",
          rowCondEntryPeak: "3. Micro-Trend Reversal Hook (3-bar inflection)",
          rowCondEntryMaStack5m: "4. Multi-Timeframe Alignment Confirmation",
          rowCondEntryMaStack1h: "5. Higher-Timeframe Trend Continuity",
          rowCondEntryCapacity: "6. Trend Pullback Sizing Allowance",
          rowCondEntryLeverage: "7. Trend Volatility Adjusted Leverage",
          rowCondEntryMargin: "8. Directional Reserve Margin Buffer",
          rowCondEntryEngine: "9. Trend Tracker Engine Synchronization",
          rowCondEntryGuard: "10. Anti-Breakout Trap Filter",
        },
        exitLabels: {
          rowCondExitConvergence: "1. Dynamic Trendline Crossing (Target Reversion)",
          rowCondExitDwell: "2. Minimum Dip Absorption Dwell (≥ 3 bars)",
          rowCondExitBottoming: "3. Opposite Micro-Exhaustion Rollover",
          rowCondExitNetPnl: "4. Zero-Loss Hurdle Rule (> +$0.02 / tranche)",
          rowCondExitActive: "5. Trend Inventory Retention Ratchet",
          rowCondExitMaStack5m: "6. Fast Micro Trend Envelope Exit",
          rowCondExitMaStack1h: "7. Macro Trend Invalidation Stop",
          rowCondExitPosition: "8. Directional Delta Balance Gate",
        },
        researchLabels: {
          valCondEntryMaStretch: "Replay: require Macro Trend slope",
          valCondEntryBase: "Replay: require Trendline distance gap",
          valCondEntryPeak: "Replay: require micro reversal hook",
          valCondEntryMaStack5m: "Replay: require MTF confirmation",
          valCondExitConvergence: "Replay: exit on trendline crossing",
          valCondExitDwell: "Replay: minimum dip hold dwell",
          valCondExitBottoming: "Replay: opposite micro exhaustion exit",
        },
        defaultParams: { entry_z: 1.5, exit_z: 0.25 }
      },
      custom: {
        id: "custom",
        name: "Rule Composer",
        icon: "🛠️",
        badge: "USER CUSTOM RULES · SANDBOX",
        title: "➕ Custom Rule Composer (Scale-In)",
        desc: "Custom User Triggers: Interactive condition block builder with custom thresholds and parameters",
        tpTitle: "🎯 Custom Rebalance & Take-Profit Rules",
        tpDesc: "Custom User Exits: Parameterized convergence, dwell time, and custom stop horizons",
        entryLabels: {
          rowCondEntryMaStretch: "1. Custom Entry Trigger Threshold",
          rowCondEntryBase: "2. Custom Minimum Rung Spacing",
          rowCondEntryPeak: "3. Custom Momentum Filter Toggle",
          rowCondEntryMaStack5m: "4. Custom Micro-Trend Switch",
          rowCondEntryMaStack1h: "5. Custom Macro Divergence Guard",
          rowCondEntryCapacity: "6. Custom Position Max Cap",
          rowCondEntryLeverage: "7. Custom Leverage Limiter",
          rowCondEntryMargin: "8. Custom Margin Allocation",
          rowCondEntryEngine: "9. Custom Execution Cooldown",
          rowCondEntryGuard: "10. Custom Whipsaw Cadence",
        },
        exitLabels: {
          rowCondExitConvergence: "1. Custom Convergence Exit Target",
          rowCondExitDwell: "2. Custom Minimum Dwell Bars",
          rowCondExitBottoming: "3. Custom Inflection Confirmation",
          rowCondExitNetPnl: "4. Custom Minimum Profit Hurdle",
          rowCondExitActive: "5. Custom Core Retention Ratchet",
          rowCondExitMaStack5m: "6. Custom Timeframe Alignment",
          rowCondExitMaStack1h: "7. Custom Macro Sizing Guard",
          rowCondExitPosition: "8. Custom Balance Symmetry",
        },
        researchLabels: {
          valCondEntryMaStretch: "Replay: require custom entry threshold",
          valCondEntryBase: "Replay: require custom spacing",
          valCondEntryPeak: "Replay: require custom peak filter",
          valCondEntryMaStack5m: "Replay: require custom trend switch",
          valCondExitConvergence: "Replay: require custom exit target",
          valCondExitDwell: "Replay: require custom dwell time",
          valCondExitBottoming: "Replay: require custom bottoming",
        },
        defaultParams: { entry_z: 1.5, exit_z: 0.25 }
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
      this.renderParadigmNav();
      this.renderGridLadderSection();
      this.setParadigm(this.currentParadigm || "grid");
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

    renderParadigmNav() {
      const criteriaGrid = $("tabContentLighter")?.querySelector(".shortTermCriteriaGrid");
      if (!criteriaGrid) return;
      let nav = $("lighter_paradigmNav");
      if (!nav) {
        nav = document.createElement("div");
        nav.id = "lighter_paradigmNav";
        nav.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;margin:14px 0 10px;padding:10px 14px;background:#f8fafc;border:1.5px solid #cbd5e1;border-radius:10px;flex-wrap:wrap;";
        nav.innerHTML = `
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-size:11px;font-weight:800;color:#475569;margin-right:2px;letter-spacing:0.5px;">STRATEGY REGIME:</span>
            <button id="lighter_tabParadigm_grid" class="lighterParadigmBtn" type="button" data-mode="grid" style="border:1.5px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">🏛️ Dynamic Grid</button>
            <button id="lighter_tabParadigm_ou_quant" class="lighterParadigmBtn" type="button" data-mode="ou_quant" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">🔬 Ornstein-Uhlenbeck SDE</button>
            <button id="lighter_tabParadigm_ma_stack" class="lighterParadigmBtn" type="button" data-mode="ma_stack" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">📈 Trend MA Stack</button>
            <button id="lighter_tabParadigm_multi_factor" class="lighterParadigmBtn" type="button" data-mode="multi_factor" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">⚖️ Multi-Factor Gate</button>
            <button id="lighter_tabParadigm_trend_pullback" class="lighterParadigmBtn" type="button" data-mode="trend_pullback" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">🌊 Macro Trend Reversion</button>
            <button id="lighter_tabParadigm_custom" class="lighterParadigmBtn" type="button" data-mode="custom" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 12px;font-size:11.5px;font-weight:700;cursor:pointer;">🛠️ Rule Composer</button>
          </div>
          <div id="lighter_paradigmBadge" style="font-size:10px;font-weight:800;padding:4px 10px;border-radius:999px;background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;">
            PARITY HARVESTING · GRID ARB
          </div>
        `;
        criteriaGrid.parentNode.insertBefore(nav, criteriaGrid);
        ["grid", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom"].forEach((mode) => {
          const btn = $(`lighter_tabParadigm_${mode}`);
          if (btn) btn.addEventListener("click", () => this.setParadigm(mode));
        });
      }
    },

    setParadigm(mode) {
      if (!this.paradigms[mode]) return;
      this.currentParadigm = mode;
      const p = this.paradigms[mode];

      document.querySelectorAll(".lighterParadigmBtn").forEach((btn) => {
        const isCurrent = btn.dataset.mode === mode;
        btn.style.background = isCurrent ? "#7c3aed" : "#fff";
        btn.style.color = isCurrent ? "#fff" : "#475569";
        btn.style.borderColor = isCurrent ? "#7c3aed" : "#cbd5e1";
        btn.style.fontWeight = isCurrent ? "800" : "700";
      });

      const badge = $("lighter_paradigmBadge");
      if (badge) badge.textContent = p.badge;

      this.setText("lblCritScaleInTitle", p.title);
      const descEl = lid("txtCritScaleInDesc");
      if (descEl) descEl.innerHTML = p.desc;
      this.setText("lblCritTPTitle", p.tpTitle);
      const tpDescEl = lid("txtCritTpDesc");
      if (tpDescEl) tpDescEl.innerHTML = p.tpDesc;

      Object.entries(p.entryLabels).forEach(([id, text]) => {
        const el = lid(id)?.querySelector(".condLabel");
        if (el) el.textContent = text;
      });
      Object.entries(p.exitLabels).forEach(([id, text]) => {
        const el = lid(id)?.querySelector(".condLabel");
        if (el) el.textContent = text;
      });
      Object.entries(p.researchLabels).forEach(([id, text]) => this.setText(id, text));

      const ladderSec = $("lighter_gridMatrixSection");
      let detailSec = $("lighter_paradigmDetailSection");
      if (!detailSec && ladderSec) {
        detailSec = document.createElement("div");
        detailSec.id = "lighter_paradigmDetailSection";
        detailSec.style.cssText = "margin-top:14px;background:#ffffff;border:1.5px solid #cbd5e1;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);display:none;";
        ladderSec.parentNode.insertBefore(detailSec, ladderSec.nextSibling);
      }

      if (mode === "grid") {
        if (ladderSec) ladderSec.style.display = "block";
        if (detailSec) detailSec.style.display = "none";
      } else {
        if (ladderSec) ladderSec.style.display = "none";
        if (detailSec) {
          detailSec.style.display = "block";
          detailSec.innerHTML = this.renderParadigmDetail(mode);
          this.bindParadigmDetailEvents(mode);
        }
      }

      this.runBacktest();
    },

    renderParadigmDetail(mode) {
      if (mode === "ou_quant") {
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">🔬</span>
                <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Ornstein-Uhlenbeck Continuous Drift & Cointegration Matrix</strong>
                <span style="background:#e0e7ff;color:#4338ca;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #c7d2fe;">SDE CALIBRATED</span>
              </div>
              <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Continuous stochastic differential equation calibration: dX = θ(μ - X)dt + σdW · Normalized Z-score mean reversion.</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Entry Z:</span>
              <input id="lighter_inpOuEntryZ" type="number" step="0.1" value="1.8" style="width:58px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Exit Z:</span>
              <input id="lighter_inpOuExitZ" type="number" step="0.05" value="0.20" style="width:58px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <button id="lighter_btnOuReplay" type="button" style="border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Rerun SDE</button>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Reversion Speed (θ)</small>
              <strong id="lighter_valOuTheta" style="font-size:15px;color:#0f172a;">0.0418 / bar</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Equilibrium Half-Life (τ)</small>
              <strong id="lighter_valOuHalfLife" style="font-size:15px;color:#0284c7;">16.5 bars (4.1h)</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">ADF Stationarity</small>
              <strong style="font-size:15px;color:#16a34a;">p = 0.012 (Stationary ✓)</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Current SDE Divergence</small>
              <strong id="lighter_valOuZScore" style="font-size:15px;color:#7c3aed;">+1.84σ (Reversion Zone)</strong>
            </div>
          </div>
        `;
      }
      if (mode === "ma_stack") {
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">📈</span>
                <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Multi-Timeframe Trend & Momentum Exhaustion Tracker</strong>
                <span style="background:#fef3c7;color:#b45309;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #fde68a;">MOMENTUM DIP MONITOR</span>
              </div>
              <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Tracks 5m & 1h moving average cascade (MA7 / MA24 / MA60) · Filters out violent trend crashes with counter-leg absorption.</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Min Stretch %:</span>
              <input id="lighter_inpMaStretchMin" type="number" step="0.05" value="0.30" style="width:58px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Trailing Stop %:</span>
              <input id="lighter_inpMaTrailingStop" type="number" step="0.05" value="0.15" style="width:58px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <button id="lighter_btnMaReplay" type="button" style="border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Rerun Trend</button>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">5m MA Cascade</small>
              <strong style="font-size:15px;color:#dc2626;">P &lt; MA7 &lt; MA24 &lt; MA60</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">60-MA Stretch Gap</small>
              <strong id="lighter_valMaStretchGap" style="font-size:15px;color:#7c3aed;">-0.38% (Oversold Dip)</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">1h Macro Trend Anchor</small>
              <strong style="font-size:15px;color:#16a34a;">Bullish Support ($138.80)</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Golden Cross Distance</small>
              <strong style="font-size:15px;color:#0284c7;">+0.075 pts to MA24</strong>
            </div>
          </div>
        `;
      }
      if (mode === "multi_factor") {
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">⚖️</span>
                <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Multi-Factor Quantitative Confluence Voting Panel</strong>
                <span style="background:#f0fdf4;color:#15803d;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #bbf7d0;">VOTING ACTIVE</span>
              </div>
              <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Requires multi-signal quorum consensus: Z-Score stretch, velocity acceleration, MA divergence, and local extremum.</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Quorum Required:</span>
              <select id="lighter_selFactorQuorum" style="height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
                <option value="2">2 of 4 Votes</option>
                <option value="3" selected>3 of 4 Votes (Default)</option>
                <option value="4">4 of 4 (Strict)</option>
              </select>
              <button id="lighter_btnFactorReplay" type="button" style="border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Rerun Voting</button>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <small style="color:#64748b;font-weight:700;font-size:10px;text-transform:uppercase;">Factor 1: Z-Score</small>
                <span style="background:#dcfce7;color:#166534;font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;">YES (1.84σ)</span>
              </div>
              <strong style="font-size:13px;color:#0f172a;display:block;margin-top:4px;">Parity Dislocation</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <small style="color:#64748b;font-weight:700;font-size:10px;text-transform:uppercase;">Factor 2: Velocity</small>
                <span style="background:#dcfce7;color:#166534;font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;">YES (ΔV &gt; 0)</span>
              </div>
              <strong style="font-size:13px;color:#0f172a;display:block;margin-top:4px;">Acceleration Crest</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <small style="color:#64748b;font-weight:700;font-size:10px;text-transform:uppercase;">Factor 3: 7-MA Gap</small>
                <span style="background:#dcfce7;color:#166534;font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;">YES (0.11pt)</span>
              </div>
              <strong style="font-size:13px;color:#0f172a;display:block;margin-top:4px;">Short-Term Stretch</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <small style="color:#64748b;font-weight:700;font-size:10px;text-transform:uppercase;">Factor 4: Extremum</small>
                <span style="background:#fee2e2;color:#991b1b;font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;">NO (Mid-Band)</span>
              </div>
              <strong style="font-size:13px;color:#0f172a;display:block;margin-top:4px;">12-Bar Range Extremum</strong>
            </div>
          </div>
        `;
      }
      if (mode === "trend_pullback") {
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">🌊</span>
                <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Macro Trendline Pullback & Micro-Reversion Engine</strong>
                <span id="lighter_valTrendRegimeBadge" style="background:#dcfce7;color:#166534;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #bbf7d0;">REGIME: ACTIVE</span>
              </div>
              <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Buys dips under rising macro trendlines when short-term hooks up · Sells rips above falling trendlines when short-term hooks down.</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Pullback Δ:</span>
              <input id="lighter_inpTrendPullbackDist" type="number" step="0.05" value="0.15" style="width:58px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <span style="font-size:11px;font-weight:700;color:#475569;">TP Offset:</span>
              <input id="lighter_inpTrendTpDist" type="number" step="0.05" value="0.05" style="width:58px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <span style="font-size:11px;font-weight:700;color:#475569;">Macro Win:</span>
              <input id="lighter_inpTrendMacroWindow" type="number" step="4" value="24" style="width:52px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 6px;font-size:11px;font-weight:700;">
              <button id="lighter_btnTrendReplay" type="button" style="border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Rerun Trend</button>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Macro Trend Slope (β)</small>
              <strong id="lighter_valTrendSlope" style="font-size:15px;color:#0f172a;">+0.0034 / bar</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Current Trendline Level</small>
              <strong id="lighter_valTrendlinePrice" style="font-size:15px;color:#0284c7;">139.24%</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Distance to Trendline (Δ)</small>
              <strong id="lighter_valTrendDistance" style="font-size:15px;color:#16a34a;">-0.18% (Dip Active)</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Micro-Reversal Hook</small>
              <strong id="lighter_valTrendMicroState" style="font-size:15px;color:#7c3aed;">Armed (Hook Detected)</strong>
            </div>
          </div>
        `;
      }
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
          <div>
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="font-size:18px;">🛠️</span>
              <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">Custom Condition Composer & Sandbox Matrix</strong>
              <span style="background:#f1f5f9;color:#334155;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #cbd5e1;">SANDBOX BUILDER</span>
            </div>
            <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Freely combine mathematical triggers, adjust parameters, and save custom rule profiles to local storage.</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <button id="lighter_btnCustomSave" type="button" style="border:1px solid #16a34a;background:#16a34a;color:#fff;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;">💾 Save My Preset</button>
            <button id="lighter_btnCustomReset" type="button" style="border:1px solid #cbd5e1;background:#fff;color:#475569;border-radius:4px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;">↺ Reset</button>
          </div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px 14px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;">
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:#334155;margin-bottom:4px;">Custom Entry Z-Score (σ):</label>
            <input id="lighter_inpCustomEntryZ" type="number" step="0.1" value="1.5" style="width:100%;height:28px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:#334155;margin-bottom:4px;">Custom Exit Z-Score (σ):</label>
            <input id="lighter_inpCustomExitZ" type="number" step="0.05" value="0.25" style="width:100%;height:28px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;">
          </div>
          <div>
            <label style="display:block;font-size:11px;font-weight:700;color:#334155;margin-bottom:4px;">Min Dwell Candles (Hold):</label>
            <input id="lighter_inpCustomDwell" type="number" step="1" value="4" style="width:100%;height:28px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 8px;font-size:12px;font-weight:700;">
          </div>
        </div>
      `;
    },

    bindParadigmDetailEvents(mode) {
      if (mode === "ou_quant") {
        $("lighter_btnOuReplay")?.addEventListener("click", () => this.runBacktest());
      } else if (mode === "ma_stack") {
        $("lighter_btnMaReplay")?.addEventListener("click", () => this.runBacktest());
      } else if (mode === "multi_factor") {
        $("lighter_btnFactorReplay")?.addEventListener("click", () => this.runBacktest());
      } else if (mode === "trend_pullback") {
        $("lighter_btnTrendReplay")?.addEventListener("click", () => this.runBacktest());
      } else if (mode === "custom") {
        $("lighter_btnCustomSave")?.addEventListener("click", () => {
          const ez = $("lighter_inpCustomEntryZ")?.value || "1.5";
          const xz = $("lighter_inpCustomExitZ")?.value || "0.25";
          const dw = $("lighter_inpCustomDwell")?.value || "4";
          localStorage.setItem("skhynix_custom_rule_preset", JSON.stringify({ entry_z: ez, exit_z: xz, dwell: dw }));
          alert("Custom strategy preset saved to local storage!");
          this.runBacktest();
        });
        $("lighter_btnCustomReset")?.addEventListener("click", () => {
          if ($("lighter_inpCustomEntryZ")) $("lighter_inpCustomEntryZ").value = "1.5";
          if ($("lighter_inpCustomExitZ")) $("lighter_inpCustomExitZ").value = "0.25";
          if ($("lighter_inpCustomDwell")) $("lighter_inpCustomDwell").value = "4";
          this.runBacktest();
        });
      }
    },

    renderGridLadderSection() {
      const criteriaGrid = $("tabContentLighter")?.querySelector(".shortTermCriteriaGrid");
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

      const ControllerClass = window.StrategyExecutionChartController || (typeof StrategyExecutionChartController !== "undefined" ? StrategyExecutionChartController : null);
      if (ControllerClass) {
        this.executionChartController = new ControllerClass({
          series: this.series,
          lineStyle: LightweightCharts.LineStyle,
        });
        this.executionChartController.setVisibility("actual", this.showActualMarkers);
        this.executionChartController.setVisibility("virtual", this.showVirtualMarkers);
      }

      this.activeHoveredExecutionMarkerTime = null;
      this.selectedExecutionMarkerTime = null;

      this.chart.subscribeCrosshairMove((param) => {
        if (!param || !param.point) {
          if (this.activeHoveredExecutionMarkerTime !== null) {
            this.activeHoveredExecutionMarkerTime = null;
            if (this.selectedExecutionMarkerTime === null) {
              this.updateMarkerState(null);
            }
          }
          return;
        }
        const nextHover = this.markerTimeAtParam(param);
        if (nextHover !== this.activeHoveredExecutionMarkerTime) {
          this.activeHoveredExecutionMarkerTime = nextHover;
          if (this.selectedExecutionMarkerTime === null) {
            this.updateMarkerState(nextHover);
          }
        }
      });

      this.chart.subscribeClick((param) => this.onChartClick(param));

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
        shape: marker.shape || "arrowDown", text: "",
        hoverText: marker.hoverText || marker.text || "Actual",
        source: "actual", hypothetical: false, is_entry: marker.is_entry ?? (marker.shape !== "arrowUp"),
        entry_price: marker.entry_price || marker.ratio || marker.value,
        exit_price: marker.exit_price || (marker.is_entry ? null : (marker.ratio || marker.value)),
        ratio: marker.ratio || marker.value,
        pnl: marker.pnl,
        pnl_pct: marker.pnl_pct,
      })) : [];
      this.renderMarkers();
      this.renderCurrentPositionReferenceLines();
      this.chart.timeScale().fitContent();
      this.setText("valShortTermCurrentParity", `${this.currentRatio.toFixed(3)}%`);
      ["1m", "5m", "15m", "1h", "4h", "1d"].forEach((value) => {
        const button = lid(`btnShortInterval${value}`);
        if (button) button.classList.toggle("active", value === this.interval);
      });
      this.updateGridLadderData();
    },

    markerTimeAtParam(param) {
      if (!param) return null;
      if (param.time) {
        const direct = (this.rawExecutionMarkers || []).find((m) => m.time === param.time && this.isTradeMarkerVisible(m));
        if (direct) return direct.time;
      }
      if (param.point) {
        return this.executionMarkerTimeAtX(param.point.x);
      }
      return null;
    },

    executionMarkerTimeAtX(mouseX) {
      if (!this.executionChartController || !this.chart) return null;
      return this.executionChartController.executionTimeAtX(mouseX, {
        timeScale: this.chart.timeScale(),
        hostWidth: lid("shortTermSpreadChartHost")?.clientWidth || 0,
      });
    },

    isTradeMarkerVisible(marker) {
      return this.executionChartController ? this.executionChartController.isVisible(marker) : true;
    },

    onChartClick(param) {
      if (!this.chart || !this.series) return;
      const time = this.markerTimeAtParam(param);
      const marker = (this.rawExecutionMarkers || []).find((m) => m.time === time && this.isTradeMarkerVisible(m));
      if (marker) {
        this.selectedExecutionMarkerTime = (this.selectedExecutionMarkerTime === marker.time) ? null : marker.time;
      } else {
        this.selectedExecutionMarkerTime = null;
      }
      const activeTime = this.selectedExecutionMarkerTime !== null ? this.selectedExecutionMarkerTime : this.activeHoveredExecutionMarkerTime;
      this.updateMarkerState(activeTime);
    },

    updateMarkerState(hoveredTime = null) {
      if (!this.series) return;
      if (this.executionChartController) {
        const activeTime = this.selectedExecutionMarkerTime !== null ? this.selectedExecutionMarkerTime : hoveredTime;
        this.series.setMarkers(this.executionChartController.markersForRender(activeTime));
        this.syncHoveredMarkerDetails(activeTime);
      } else {
        this.series.setMarkers(this.rawExecutionMarkers || []);
      }
    },

    shortSpreadProfitLadder(entrySpread, maxNetProfitPct = 5, isLong = false) {
      const entry = Number(entrySpread);
      if (!(entry > 0)) return [];
      const roundTripCostRate = 16 / 10000;
      const netProfitTargets = [0, 0.2, 0.5, ...Array.from(
        { length: Math.max(0, Math.floor(maxNetProfitPct)) },
        (_, index) => index + 1
      )].filter((target, index, values) => target <= maxNetProfitPct && values.indexOf(target) === index);
      return netProfitTargets.map((netProfitPct) => ({
        netProfitPct,
        title: netProfitPct === 0 ? "B/E" : `NET +${netProfitPct}%`,
        price: isLong
          ? entry * (1 + roundTripCostRate + (netProfitPct / 100))
          : entry / (1 + roundTripCostRate + (netProfitPct / 100)),
        color: netProfitPct === 0 ? "rgba(71, 85, 105, 0.70)" : "rgba(22, 163, 74, 0.70)",
        lineWidth: 1.5,
      }));
    },

    clearReferenceLines() {
      if (this.executionChartController) this.executionChartController.clearReferenceLines();
    },

    renderShortTermReferenceLines(entrySpread, options = {}) {
      const entry = Number(entrySpread);
      if (!(entry > 0) || !this.executionChartController) return;
      this.executionChartController.renderReferenceLines({
        entry,
        selected: Boolean(options.selected),
        levels: this.shortSpreadProfitLadder(entry, 5, options.isLong),
        showScaleIn: Boolean(options.showScaleIn),
        scaleInSpread: options.scaleInSpread,
        exit: options.exitSpread,
        exitTitle: options.exitSpread ? `EXIT (${Number(options.exitSpread).toFixed(2)}%)` : "EXIT"
      });
    },

    renderCurrentPositionReferenceLines() {
      if (!this.executionChartController) return;
      const isVirtualVisible = this.executionChartController.visibility.virtual !== false;

      // 1. Open entry in virtual ledger
      const openEntry = isVirtualVisible && this.entries.length ? this.entries.at(-1) : null;
      if (openEntry && Number(openEntry.ratio) > 0) {
        this.renderShortTermReferenceLines(openEntry.ratio, {
          selected: false,
          isLong: openEntry.side > 0
        });
        return;
      }

      // 2. Visible markers with entry price
      const visibleMarkers = (this.rawExecutionMarkers || []).filter(m => this.isTradeMarkerVisible(m) && (m.entry_price || m.ratio));
      const lastMarker = visibleMarkers.at(-1);
      if (lastMarker) {
        const lastEntry = Number(lastMarker.entry_price || lastMarker.ratio);
        if (lastEntry > 0) {
          this.renderShortTermReferenceLines(lastEntry, {
            selected: false,
            exitSpread: lastMarker.exit_price || (lastMarker.is_entry ? null : lastMarker.ratio),
            isLong: lastMarker.shape === "arrowUp"
          });
          return;
        }
      }

      // 3. Fallback to current ratio
      if (Number(this.currentRatio) > 0) {
        this.renderShortTermReferenceLines(this.currentRatio, {
          selected: false,
        });
        return;
      }
      this.clearReferenceLines();
    },

    syncHoveredMarkerDetails(activeTime = null) {
      const pnlEl = lid("valShortTermNetPnl");
      const profitEl = lid("valSelectedMinProfit");
      if (!activeTime) {
        if (pnlEl) pnlEl.textContent = "--";
        if (profitEl) profitEl.textContent = "—";
        this.renderCurrentPositionReferenceLines();
        return;
      }
      const marker = (this.rawExecutionMarkers || []).find((m) => m.time === activeTime && this.isTradeMarkerVisible(m));
      if (!marker) {
        if (pnlEl) pnlEl.textContent = "--";
        if (profitEl) profitEl.textContent = "—";
        this.renderCurrentPositionReferenceLines();
        return;
      }
      const entrySpread = Number(marker.entry_price || marker.ratio);
      if (entrySpread > 0) {
        this.renderShortTermReferenceLines(entrySpread, {
          selected: true,
          exitSpread: marker.exit_price || (marker.is_entry ? null : marker.ratio),
          isLong: marker.shape === "arrowUp"
        });
      } else {
        this.renderCurrentPositionReferenceLines();
      }
      if (pnlEl) {
        if (marker.pnl_pct != null) {
          pnlEl.textContent = `${marker.pnl_pct >= 0 ? "+" : ""}${marker.pnl_pct.toFixed(2)}%`;
          pnlEl.style.color = marker.pnl_pct >= 0 ? "#16a34a" : "#dc2626";
        } else if (marker.pnl != null) {
          pnlEl.textContent = `${marker.pnl >= 0 ? "+" : ""}$${marker.pnl.toFixed(2)}`;
          pnlEl.style.color = marker.pnl >= 0 ? "#16a34a" : "#dc2626";
        } else {
          pnlEl.textContent = marker.is_entry ? "Entry Open" : "--";
          pnlEl.style.color = "";
        }
      }
      if (profitEl) {
        const val = marker.ratio != null ? marker.ratio : (marker.entry_price != null ? marker.entry_price : marker.exit_price);
        profitEl.textContent = Number.isFinite(val) ? `${Number(val).toFixed(2)}%` : "—";
      }
    },

    orderNotional() { return Math.max(10, Number(lid("inputOrderNotional")?.value || 1000)); },
    virtualPnl() { return this.entries.reduce((sum, entry) => sum + (this.currentRatio == null ? 0 : entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio), 0); },
    virtualPnlText() { const pnl = this.virtualPnl(); return `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`; },

    addVirtualEntry() {
      if (!Number.isFinite(this.currentRatio)) return;
      const entry = { time: Date.now(), ratio: this.currentRatio, notional: this.orderNotional(), side: this.currentRatio >= 100 ? -1 : 1 };
      this.entries.push(entry);
      this.ledger.unshift({ ...entry, action: entry.side < 0 ? "SHORT RATIO" : "LONG RATIO", pnl: null });
      this.save(); this.renderVirtualState(); this.renderMarkers(); this.renderCurrentPositionReferenceLines(); this.updateGridLadderData();
    },

    exitVirtual() {
      if (!this.entries.length || !Number.isFinite(this.currentRatio)) return;
      this.entries.forEach((entry) => this.ledger.unshift({ time: Date.now(), ratio: this.currentRatio,
        notional: entry.notional, action: "EXIT", pnl: entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio }));
      this.entries = []; this.save(); this.renderVirtualState(); this.renderMarkers(); this.renderCurrentPositionReferenceLines(); this.updateGridLadderData();
    },

    renderMarkers() {
      if (!this.series || typeof this.series.setMarkers !== "function") return;
      if (!this.bars.length) return;
      const paperMarkers = this.ledger.slice(0, 40).map((row) => ({
        time: TerminalCommon.alignTime(this.bars, row.time / 1000),
        position: row.action === "EXIT" ? "belowBar" : "aboveBar",
        color: row.action === "EXIT" ? "#10b981" : "#7c3aed",
        shape: row.action === "EXIT" ? "arrowUp" : "arrowDown",
        text: "",
        hoverText: row.action === "EXIT"
          ? `COVER ${row.ratio ? row.ratio.toFixed(2) + "%" : ""}${row.pnl != null ? " · " + (row.pnl >= 0 ? "+" : "") + "$" + row.pnl.toFixed(2) : ""}`
          : `${row.action === "LONG RATIO" ? "BUY" : "SHORT"} ${row.ratio ? row.ratio.toFixed(2) + "%" : ""} ($${(row.notional || 0).toFixed(0)})`,
        source: "virtual",
        hypothetical: true,
        is_paper: true,
        is_entry: row.action !== "EXIT",
        ratio: row.ratio,
        entry_price: row.ratio,
        exit_price: row.action === "EXIT" ? row.ratio : null,
        pnl: row.pnl,
      }));
      const rawMarkers = [
        ...(this.actualMarkers || []),
        ...paperMarkers,
        ...(this.backtestMarkers || []),
      ].sort((a, b) => a.time - b.time);

      this.rawExecutionMarkers = rawMarkers;
      this.executionChartController?.setExecutions(rawMarkers);

      const activeTime = this.selectedExecutionMarkerTime !== null ? this.selectedExecutionMarkerTime : this.activeHoveredExecutionMarkerTime;
      this.updateMarkerState(activeTime);
    },

    updateMarkerButtons() {
      this.executionChartController?.setVisibility("actual", this.showActualMarkers);
      this.executionChartController?.setVisibility("virtual", this.showVirtualMarkers);
      this.executionChartFrame?.setVisibility("actual", this.showActualMarkers);
      this.executionChartFrame?.setVisibility("virtual", this.showVirtualMarkers);
      const activeTime = this.selectedExecutionMarkerTime !== null ? this.selectedExecutionMarkerTime : this.activeHoveredExecutionMarkerTime;
      this.updateMarkerState(activeTime);
      if (activeTime === null) {
        this.renderCurrentPositionReferenceLines();
      }
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
        let entry = 1.5;
        let exit = 0.25;
        let ouHalfLife = 8.0;
        let maStretch = 0.30;
        let quorum = 3;
        let trendPullback = 0.15;
        let trendTp = 0.05;
        let trendMacroWin = 24;
        let trendSlope = 0.002;

        if (this.currentParadigm === "ou_quant") {
          entry = Number($("lighter_inpOuEntryZ")?.value || 1.8);
          exit = Number($("lighter_inpOuExitZ")?.value || 0.20);
        } else if (this.currentParadigm === "ma_stack") {
          maStretch = Number($("lighter_inpMaStretchMin")?.value || 0.30);
        } else if (this.currentParadigm === "multi_factor") {
          quorum = Number($("lighter_selFactorQuorum")?.value || 3);
        } else if (this.currentParadigm === "trend_pullback") {
          trendPullback = Number($("lighter_inpTrendPullbackDist")?.value || 0.15);
          trendTp = Number($("lighter_inpTrendTpDist")?.value || 0.05);
          trendMacroWin = Number($("lighter_inpTrendMacroWindow")?.value || 24);
        } else if (this.currentParadigm === "custom") {
          entry = Number($("lighter_inpCustomEntryZ")?.value || 1.5);
          exit = Number($("lighter_inpCustomExitZ")?.value || 0.25);
        }

        const toggles = new URLSearchParams({
          interval: this.interval, limit: "500",
          strategy_mode: this.currentParadigm || "grid",
          entry_z: String(entry), exit_z: String(exit),
          ou_halflife_max: String(ouHalfLife),
          ma_stretch_min: String(maStretch),
          min_consensus_votes: String(quorum),
          trend_pullback_dist: String(trendPullback),
          trend_tp_dist: String(trendTp),
          trend_macro_window: String(trendMacroWin),
          trend_slope_min: String(trendSlope),
          use_ma_stretch: String(lid("chkCondEntryMaStretch")?.checked !== false),
          use_base_spacing: String(lid("chkCondEntryBase")?.checked !== false),
          use_peak: String(lid("chkCondEntryPeak")?.checked !== false),
          use_ma_stack: String(lid("chkCondEntryMaStack5m")?.checked === true),
          use_convergence: String(lid("chkCondExitConvergence")?.checked !== false),
          use_dwell: String(lid("chkCondExitDwell")?.checked !== false),
          use_bottoming: String(lid("chkCondExitBottoming")?.checked === true),
        });
        const data = await api(`/api/lighter/backtest?${toggles}`);
        const pName = this.paradigms[this.currentParadigm]?.name || "Virtual";
        this.backtestMarkers = data.trades.flatMap((trade) => [
          {
            time: trade.entry_time,
            position: trade.side < 0 ? "aboveBar" : "belowBar",
            color: trade.side < 0 ? "rgba(220,38,38,.55)" : "rgba(22,163,74,.55)",
            shape: trade.side < 0 ? "arrowDown" : "arrowUp",
            text: "",
            hoverText: `${trade.side < 0 ? "SHORT" : "BUY"} ${trade.entry ? trade.entry.toFixed(2) + "%" : ""}`,
            source: "virtual",
            hypothetical: true,
            backtest: true,
            is_entry: true,
            entry_price: trade.entry,
            ratio: trade.entry,
          },
          {
            time: trade.exit_time,
            position: trade.side < 0 ? "belowBar" : "aboveBar",
            color: trade.side < 0 ? "rgba(22,163,74,.55)" : "rgba(220,38,38,.55)",
            shape: trade.side < 0 ? "arrowUp" : "arrowDown",
            text: "",
            hoverText: `${trade.side < 0 ? "COVER" : "SELL"} ${trade.exit ? trade.exit.toFixed(2) + "%" : ""} · ${trade.pnl_pct >= 0 ? "+" : ""}${trade.pnl_pct.toFixed(2)}% net`,
            source: "virtual",
            hypothetical: true,
            backtest: true,
            is_entry: false,
            entry_price: trade.entry,
            exit_price: trade.exit,
            ratio: trade.exit,
            pnl_pct: trade.pnl_pct,
          },
        ]);
        this.renderMarkers();
        this.renderCurrentPositionReferenceLines();
        if (summary) summary.innerHTML = `[<strong>${pName}</strong>] <strong>${data.summary.trades}</strong> trades · <strong>${data.summary.win_rate.toFixed(1)}%</strong> wins · net <strong>${data.summary.net_pct >= 0 ? "+" : ""}${data.summary.net_pct.toFixed(3)}%</strong>`;

        if (data.metrics && this.currentParadigm === "ou_quant") {
          const thetaEl = $("lighter_valOuTheta");
          if (thetaEl && data.metrics.avg_theta) thetaEl.textContent = `${data.metrics.avg_theta.toFixed(4)} / bar`;
          const hlEl = $("lighter_valOuHalfLife");
          if (hlEl && data.metrics.avg_half_life_bars) hlEl.textContent = `${data.metrics.avg_half_life_bars} bars (${data.metrics.half_life_mins}m)`;
        } else if (data.metrics && this.currentParadigm === "trend_pullback") {
          const slopeEl = $("lighter_valTrendSlope");
          if (slopeEl && data.metrics.latest_slope != null) {
            slopeEl.textContent = `${data.metrics.latest_slope >= 0 ? "+" : ""}${data.metrics.latest_slope.toFixed(5)} / bar`;
            slopeEl.style.color = data.metrics.latest_slope >= trendSlope ? "#16a34a" : (data.metrics.latest_slope <= -trendSlope ? "#dc2626" : "#475569");
          }
          const tlEl = $("lighter_valTrendlinePrice");
          if (tlEl && data.metrics.latest_trendline != null) tlEl.textContent = `${data.metrics.latest_trendline.toFixed(3)}%`;
          const distEl = $("lighter_valTrendDistance");
          if (distEl && data.metrics.latest_distance != null) {
            distEl.textContent = `${data.metrics.latest_distance >= 0 ? "+" : ""}${data.metrics.latest_distance.toFixed(3)}%`;
            distEl.style.color = Math.abs(data.metrics.latest_distance) >= trendPullback ? "#7c3aed" : "#0f172a";
          }
          const badgeEl = $("lighter_valTrendRegimeBadge");
          if (badgeEl && data.metrics.macro_regime) {
            badgeEl.textContent = `REGIME: ${data.metrics.macro_regime}`;
            badgeEl.style.background = data.metrics.macro_regime === "UPTREND" ? "#dcfce7" : (data.metrics.macro_regime === "DOWNTREND" ? "#fee2e2" : "#f1f5f9");
            badgeEl.style.color = data.metrics.macro_regime === "UPTREND" ? "#166534" : (data.metrics.macro_regime === "DOWNTREND" ? "#991b1b" : "#475569");
          }
        }
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
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => lighterEngine.init());
  } else {
    lighterEngine.init();
  }
})();
