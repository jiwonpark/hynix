(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "skhynix_lighter_virtual_ledger_v2";
  const STRATEGY_STORAGE_KEY = "skhynix_lighter_selected_strategy";
  const safeStorage = {
    getItem: (key) => {
      try { return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null; } catch (_) { return null; }
    },
    setItem: (key, val) => {
      try { if (typeof localStorage !== "undefined") localStorage.setItem(key, val); } catch (_) {}
    }
  };
  const lid = (id) => $(`lighter_${id}`);
  const KST_TIME_ZONE = "Asia/Seoul";

  function formatKstDateTime(value, includeDate = true) {
    const date = value instanceof Date ? value : new Date(value);
    const options = includeDate
      ? { timeZone: KST_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      : { timeZone: KST_TIME_ZONE, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false };
    return `${date.toLocaleString("en-CA", options).replace(",", "")} KST`;
  }

  function formatKstChartTime(unixSeconds) {
    return new Date(Number(unixSeconds) * 1000).toLocaleString("en-CA", {
      timeZone: KST_TIME_ZONE, month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).replace(",", "");
  }

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

  async function apiPost(path, body) {
    const token = window.terminalLockManager?.token;
    if (!token) throw new Error("Unlock the terminal first");
    let lastError;
    for (const prefix of ["/skhynix", ""]) {
      try {
        const response = await fetch(`${prefix}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        return payload;
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
    trendRanges: [],
    maVisibility: { 7: true, 24: true, 60: true },
    executionChartFrame: null,
    executionChartController: null,
    activeHoveredExecutionMarkerTime: null,
    activeHoveredExecutionMarkerKey: null,
    activeHoveredPairKey: null,
    selectedExecutionMarkerTime: null,
    selectedExecutionMarkerKey: null,
    selectedPairKey: null,
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
    groupTradesAsRange: (typeof localStorage !== "undefined" && localStorage.getItem("lighter_group_trades_as_range") === "true"),
    interval: "5m",
    smallTrendInterval: "5m",
    bigTrendInterval: "1h",
    currentTier: 2,
    botState: null,

    tiers: {
      1: {
        name: "Tier 1: Conservative (1.0x)",
        badge: "CONSERVATIVE · 1.0x",
        leverage: 1.0,
        spacingPct: 0.20,
        rungCount: 5,
        notional: 500,
        minProfit: 0.03,
        skhyAlloc: 0.04,
        csopAlloc: 0.004
      },
      2: {
        name: "Tier 2: Delta-Neutral (1.0x)",
        badge: "DELTA-NEUTRAL · 1.0x",
        leverage: 1.0,
        spacingPct: 0.12,
        rungCount: 8,
        notional: 1000,
        minProfit: 0.05,
        skhyAlloc: 0.08,
        csopAlloc: 0.008
      },
      3: {
        name: "Tier 3: Opportunistic (1.0x)",
        badge: "OPPORTUNISTIC · 1.0x",
        leverage: 1.0,
        spacingPct: 0.08,
        rungCount: 12,
        notional: 2000,
        minProfit: 0.08,
        skhyAlloc: 0.16,
        csopAlloc: 0.016
      }
    },
    currentParadigm: "ou_quant",
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
          rowCondEntryLeverage: "7. Fixed 1.0x Position Sizing",
          rowCondEntryMargin: "8. Buffered Margin Reserve (≥ 125%)",
          rowCondEntryEngine: "9. Grid Engine State & Configured Rate Limit",
          rowCondEntryGuard: "10. Anti-Whipsaw Bar Cadence (1 bar/rung)",
        },
        exitLabels: {
          rowCondExitConvergence: "1. Benchmark Convergence (≤ Target Parity)",
          rowCondExitDwell: "2. Anti-Churn Dwell Time (≥ 4 Bars Hold)",
          rowCondExitBottoming: "3. Bottoming-Out Momentum Inflection",
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +0.10% / tranche)",
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
        desc: "OU entry uses the enabled Z, half-life, absolute-deviation, macro EMA and upper-Z checks shown below.",
        tpTitle: "🎯 OU Mean Reversion Neutral Crossing",
        tpDesc: "OU exit uses the selected neutral-Z target, subject to net-profit checks; emergency stop remains active.",
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
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +0.10% / tranche)",
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
        defaultParams: { entry_z: 1.4, exit_z: 0.20 }
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
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +0.10% / tranche)",
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
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +0.10% / tranche)",
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
          rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +0.10% / tranche)",
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
      this.setText("lblDaemonUpbitBadge", "RISK TIER: TIER 2 (1x NEUTRAL)");
      this.setText("valDeployedStrategyName", "🏛️ Institutional Grid Engine (Multi-Tier Parity Bands)");
      this.setText("valDeployedEngine", "Asymmetric Delta-Neutral Parity Grid Harvester");
      this.setText("valDeployedInterval", "5m completed candles");
      this.setText("valDeployedWindow", "24 completed bars");
      this.setText("valDeployedEdge", "Entry |Z| ≥ 1.40");
      this.setText("valDeployedMaxLeverage", "800% (8.0x account cap)");
      this.setText("valDeployedSpeed", "Configurable paired trade rate (0.2–10/min)");
      this.setText("valDeployedMinProfit", "Exit |Z| ≤ 0.20");
      this.setText("valDeployedCost", "0 BPS advertised fee / slippage excluded");
      this.setText("lblAccountEquity", "Lighter Account Collateral");
      this.setText("badgeEquitySource", "SYNCING");
      this.setText("valAccountEquity", "—");
      this.setText("lblAvailMargin", "Free Grid Margin");
      this.setText("valAvailMargin", "$8,240.00");
      this.setText("lblUnrealizedPnl", "Verified Realized PnL");
      this.setText("lblActivePairs", "Active Grid Rungs");
      this.setText("lblMarginRisk", "Target Leverage");
      this.setText("valMarginRisk", "8.0x cap");
      this.setText("lblCollateralSummary", "Grid Mode");
      this.setText("lblUpbitEquity", "Grid Underlying Pair");
      this.setText("badgeUpbitSource", "DUAL-LEG");
      this.setText("valUpbitEquity", "SKHY (ADR) ↔ SKHYNIXUSD (Korean underlying)");
      this.setText("titleExecutionTerminal", "🏛️ 1-Click Institutional Grid Execution & Virtual Orders");
      this.setText("badgeExecMode", "INSTITUTIONAL GRID REBALANCING · DUAL-LEG ARB");
      this.setText("lblHedgedSyncBadge", "GRID ENGINE ACTIVE");
      this.setText("lblShortTermTitle", "Paper Replay Conditions — Do Not Control the Real Bot");
      this.setText("lblShortTermSubtitle", "Chart interval, strategy tabs, condition switches, and Rerun affect the historical paper simulation only.");
      this.setText("lblCritScaleInTitle", "➕ Grid Band Scale-In (Upper Harvester)");
      this.setText("lblCritTPTitle", "🎯 Grid Rebalance & Take-Profit (Mean Reversion)");
      this.setText("lblOrderNotional", "Grid Order Notional (USDT)");
      this.setText("lblStepTrancheSize", "➕ Add Paper Tranche");
      this.setText("lblStepTrancheSub", "SIMULATED");
      this.setText("lblReduceTrancheText", "Close All Paper Tranches");
      const trancheHeading = lid("valHedgedTranches")?.previousElementSibling;
      if (trancheHeading) trancheHeading.textContent = "Campaign Entry Slots";
      const utilizationHeading = lid("lblTranchePct")?.previousElementSibling;
      if (utilizationHeading) utilizationHeading.textContent = "Gross Leverage Utilization (separate from campaign slot cap):";

      // Custom-labeled Scale-In Checklist for Grid Bands
      const entryLabelMap = {
        rowCondEntryMaStretch: "1. Grid Band Trigger (Upper Rung ≥ +0.12%)",
        rowCondEntryBase: "2. ATR Dynamic Volatility Spacing",
        rowCondEntryPeak: "3. 5m Peak Rollover Filter (Exhaustion Gate)",
        rowCondEntryMaStack5m: "4. 5m Micro-Trend Neutrality Confirmation",
        rowCondEntryMaStack1h: "5. 1h Macro Divergence Boundary",
        rowCondEntryCapacity: "6. Max Active Grid Tiers (Cap: 8 Rungs)",
        rowCondEntryLeverage: "7. Account-Wide Gross Leverage (≤ 8.0x)",
        rowCondEntryMargin: "8. Buffered Margin Reserve (≥ 125%)",
        rowCondEntryEngine: "9. Grid Engine State & Configured Rate Limit",
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
        rowCondExitNetPnl: "4. Zero-Loss Hurdle (> +0.10% / tranche)",
        rowCondExitActive: "5. Core Inventory Ratchet (+0.01 / +0.20)",
        rowCondExitMaStack5m: "6. 5m Exit Stack Alignment",
        rowCondExitMaStack1h: "7. 1h Macro Sizing Neutralization",
        rowCondExitPosition: "8. Position Symmetry Gate",
      };
      Object.entries(exitLabelMap).forEach(([id, text]) => {
        const el = lid(id)?.querySelector(".condLabel");
        if (el) el.textContent = text;
      });

      const paper = lid("modePaper");
      const semi = lid("modeSemiAuto");
      const live = lid("modeLive");
      const kill = lid("btnKillSwitch");
      const resetPaper = lid("btnResetPaperBalance");
      const auto = lid("lblAutoPeriodicText");
      if (auto) auto.textContent = "24/7 EC2 Lighter bot (continues when this browser closes)";
      if (resetPaper) resetPaper.textContent = "↺ Reset Paper $10k";

      [paper, semi, live, kill, resetPaper].forEach((btn) => {
        if (btn) {
          btn.disabled = false;
          btn.classList.remove("terminal-action-control");
          btn.style.cursor = "pointer";
        }
      });
      if (paper && !paper._boundMode) {
        paper._boundMode = true;
        paper.textContent = "✋ Manual / Paper";
        paper.addEventListener("click", () => this.setMode("paper"));
      }
      if (semi && !semi._boundMode) {
        semi._boundMode = true;
        semi.textContent = "⚡ Semi-Auto";
        semi.addEventListener("click", () => this.setMode("semi_auto"));
      }
      if (live && !live._boundMode) {
        live._boundMode = true;
        live.textContent = "🤖 Full-Auto";
        live.addEventListener("click", () => this.setMode("live"));
      }
      if (kill && !kill._boundKill) {
        kill._boundKill = true;
        kill.textContent = "🚨 Kill-Switch";
        kill.addEventListener("click", () => this.emergencyFlatten());
      }
      if (resetPaper && !resetPaper._boundReset) {
        resetPaper._boundReset = true;
        resetPaper.addEventListener("click", () => this.resetPaperBalance());
      }

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
          title: "PAPER REPLAY · INTERVAL-DEPENDENT · NOT LIVE EXECUTION",
          action: { label: "Rerun Paper", onClick: () => this.runBacktest() },
          actual: { label: "Actual", onToggle: () => { this.showActualMarkers = !this.showActualMarkers; this.updateMarkerButtons(); this.renderMarkers(); } },
          virtual: { label: "Virtual", onToggle: () => { this.showVirtualMarkers = !this.showVirtualMarkers; this.updateMarkerButtons(); this.renderMarkers(); } },
          grouping: {
            asRange: this.groupTradesAsRange,
            onChange: (asRange) => this.setTradeGrouping(asRange),
          },
          status: "PAPER ONLY · Select a strategy and interval, then rerun",
          description: "Paper results intentionally change with the selected candle interval and strategy. These controls never reconfigure the real EC2 bot.",
          legend: '<span style="color:#0284c7"><span style="display:inline-block;width:10px;height:3px;background:#0284c7"></span> Parity</span><span id="lighter_legendShortMa7" style="cursor:pointer;color:#b45309">— 7-MA: <strong id="lighter_valShortTermMa7">--%</strong></span><span id="lighter_legendShortMa24" style="cursor:pointer;color:#6d28d9">— 24-MA: <strong id="lighter_valShortTermMa24">--%</strong></span><span id="lighter_legendShortMa60" style="cursor:pointer;color:#0891b2">— 60-MA: <strong id="lighter_valShortTermMa60">--%</strong></span><span><strong style="color:#16a34a">▶</strong> Long Entry (Buy)</span><span><strong style="color:#dc2626">◀</strong> Long Exit (Sell)</span><span><strong style="color:#dc2626">▶</strong> Short Entry (Sell)</span><span><strong style="color:#16a34a">◀</strong> Short Exit (Buy/Cover)</span><span style="color:#0f766e">Selected net PnL: <strong id="lighter_valShortTermNetPnl">--</strong> · Exit &gt; <strong id="lighter_valSelectedMinProfit">—</strong></span><span>Scale-In</span>',
        });
        [7, 24, 60].forEach((period) => lid(`legendShortMa${period}`)?.addEventListener("click", () => this.toggleMA(period)));
        const chartHost = lid("shortTermSpreadChartHost");
        if (chartHost && !$("lighterTrendOverlay")) {
          chartHost.style.position = "relative";
          const bands = document.createElement("div");
          bands.id = "lighterTrendBandLayer";
          bands.style.cssText = "position:absolute;z-index:2;inset:0 0 26px 0;overflow:hidden;pointer-events:none";
          chartHost.appendChild(bands);
          const overlay = document.createElement("div");
          overlay.id = "lighterTrendOverlay";
          overlay.style.cssText = "position:absolute;z-index:5;top:8px;right:55px;display:flex;align-items:center;gap:6px;pointer-events:auto;flex-wrap:wrap";
          overlay.innerHTML = '<span id="lighterMatchPill" style="border-radius:4px;padding:3px 7px;font-size:9.5px;font-weight:900;border:1px solid #cbd5e1;background:#f8fafc;color:#475569;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.05)">RULES MATCHING…</span><span style="border-radius:4px;padding:3px 6px;font-size:9px;font-weight:900;background:linear-gradient(90deg,rgba(220,38,38,.20),rgba(100,116,139,.05),rgba(22,163,74,.22));color:#334155">TREND SCORE −1 ← 0 → +1</span><div style="display:inline-flex;align-items:center;gap:3px;background:rgba(255,255,255,0.94);padding:2px 6px;border-radius:4px;border:1px solid #cbd5e1;font-size:9px;font-weight:800;color:#334155;box-shadow:0 1px 2px rgba(0,0,0,0.04)"><span>MICRO:</span><select id="lighterSelSmallTrend" style="font-size:10px;font-weight:900;border:none;background:transparent;cursor:pointer;color:#0f172a"><option value="1m">1m</option><option value="5m" selected>5m</option><option value="15m">15m</option></select><span id="lighterTrendSmall" class="lighterTrendBadge" style="pointer-events:none">5m —</span></div><div style="display:inline-flex;align-items:center;gap:3px;background:rgba(255,255,255,0.94);padding:2px 6px;border-radius:4px;border:1px solid #cbd5e1;font-size:9px;font-weight:800;color:#334155;box-shadow:0 1px 2px rgba(0,0,0,0.04)"><span>MACRO:</span><select id="lighterSelBigTrend" style="font-size:10px;font-weight:900;border:none;background:transparent;cursor:pointer;color:#0f172a"><option value="15m">15m</option><option value="1h" selected>1h</option><option value="4h">4h</option><option value="1d">1d</option></select><span id="lighterTrendBig" class="lighterTrendBadge" style="pointer-events:none">1h —</span></div>';
          chartHost.appendChild(overlay);
          this.bindMatchPill(overlay.querySelector("#lighterMatchPill"));

          $("lighterSelSmallTrend")?.addEventListener("change", (e) => {
            this.smallTrendInterval = e.target.value;
            this.fetchAndRenderTrends();
          });
          $("lighterSelBigTrend")?.addEventListener("change", (e) => {
            this.bigTrendInterval = e.target.value;
            this.fetchAndRenderTrends();
          });
        }
      }

      const entry = lid("btnStepTranche");
      const exit = lid("btnReduceTranche");
      const flatten = lid("btnEmergencyFlatten");

      // Inject Direction Dropdown & Paper Indicator if not already present
      if (entry && !lid("selTrancheDirection") && entry.parentNode) {
        const dirSelect = document.createElement("select");
        dirSelect.id = "lighter_selTrancheDirection";
        dirSelect.style.cssText = "height:38px;padding:0 10px;font-size:12px;font-weight:700;background:#fff;color:#0f172a;border:1.5px solid #0284c7;border-radius:6px;cursor:pointer;";
        dirSelect.innerHTML = `
          <option value="auto">⚡ Auto (Ratio Parity)</option>
          <option value="short">▼ Short Parity (Short ADR / Long KR)</option>
          <option value="long">▲ Long Parity (Long ADR / Short KR)</option>
        `;
        entry.parentNode.insertBefore(dirSelect, entry);

        const paperBadge = document.createElement("span");
        paperBadge.id = "lighter_paperBadge";
        paperBadge.style.cssText = "display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;font-size:10.5px;font-weight:800;background:#fef3c7;color:#92400e;border:1px solid #fde68a;";
        paperBadge.textContent = "PAPER SIMULATION ONLY";
        entry.parentNode.appendChild(paperBadge);

        const enforceLabel = document.createElement("label");
        enforceLabel.id = "lighter_lblEnforceConditions";
        enforceLabel.style.cssText = "display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;color:#334155;cursor:pointer;background:#f8fafc;padding:5px 9px;border-radius:6px;border:1.5px solid #cbd5e1;user-select:none;";
        enforceLabel.title = "When enabled, manual paper trades validate against active criteria checklist (MA Stretch, Peak, Spacing). Uncheck to trade unrestricted.";
        enforceLabel.innerHTML = `
          <input type="checkbox" id="lighter_chkEnforceConditions" checked style="cursor:pointer;accent-color:#0284c7;margin:0;width:14px;height:14px;">
          <span>Enforce Live Conditions</span>
        `;
        entry.parentNode.appendChild(enforceLabel);
      }

      [entry, exit, flatten].forEach((button) => {
        if (button) {
          button.disabled = false;
          button.classList.remove("terminal-action-control");
          button.style.cursor = "pointer";
        }
      });
      if (flatten && !flatten._boundFlatten) {
        flatten._boundFlatten = true;
        flatten.textContent = "🚨 Reset Paper State";
        flatten.addEventListener("click", () => this.emergencyFlatten());
      }
      if (entry && !entry._boundClick) {
        entry._boundClick = true;
        entry.addEventListener("click", () => {
          if (this.mode === "live" || this.mode === "semi_auto") {
            this.stepTrancheLive();
          } else {
            this.addVirtualEntry();
          }
        });
      }
      if (exit && !exit._boundClick) {
        exit._boundClick = true;
        exit.addEventListener("click", () => {
          if (this.mode === "live" || this.mode === "semi_auto") {
            this.reduceTrancheLive();
          } else {
            this.exitVirtual();
          }
        });
      }
      ["1m", "5m", "15m", "1h", "4h", "1d"].forEach((value) => {
        const button = lid(`btnShortInterval${value}`);
        if (!button) return;
        button.disabled = false;
        button.addEventListener("click", () => {
          this.interval = value;
          this.updateRulesMatchStatus();
          this.refreshChart();
        });
      });

      const ticket = lid("pairOrderTicket");
      if (ticket && !lid("lighter_failClosedWarning")) {
        const warning = document.createElement("div");
        warning.id = "lighter_failClosedWarning";
        warning.style.cssText = "grid-column:1/-1;padding:9px 11px;border-radius:6px;background:#fef3c7;color:#92400e;font-size:11px;font-weight:700;margin-bottom:8px";
        warning.textContent = "Live execution is fail-closed and uses SKHY + SKHYNIXUSD only (no 2x ETF). Unlock the terminal and enable the EC2 bot explicitly; all failures pause it.";
        ticket.prepend(warning);
      }
      if (ticket) {
        const rows = ticket.querySelectorAll(":scope > .ticketRow");
        rows.forEach((row, index) => { if (index > 0) row.style.display = "none"; });
        ticket.querySelector(".presetButtonGroup")?.setAttribute("style", "display:none");
        ticket.querySelector(".dualActionButtons")?.setAttribute("style", "display:none");
        this.setText("valCalculatedMargin", "1x dollar-neutral pair");
      }

      const notionalInput = lid("inputOrderNotional");
      if (notionalInput) {
        notionalInput.disabled = false;
        notionalInput.min = "10";
        notionalInput.max = "500";
        notionalInput.step = "5";
        notionalInput.value = "25";
        notionalInput.addEventListener("input", () => this.updateLeverageMetrics());
      }
      const autoToggle = lid("chkAutoPeriodic48h");
      if (autoToggle) autoToggle.addEventListener("change", () => this.toggleLiveBot(autoToggle.checked));
      const guard = lid("hedgedControllerCard")?.querySelector(".zeroLossInvariantBanner p");
      const switchPosTab = (activeTab) => {
        ["tabPositions", "tabAssets", "tabDaemonActivity", "tabOrderLog"].forEach((id) => {
          const tabEl = lid(id);
          if (tabEl) tabEl.classList.toggle("active", id === activeTab);
        });
        const paneMap = {
          tabPositions: "panePositions",
          tabAssets: "paneAssets",
          tabDaemonActivity: "paneDaemonActivity",
          tabOrderLog: "paneOrderLog"
        };
        Object.entries(paneMap).forEach(([tabId, paneId]) => {
          const paneEl = lid(paneId);
          if (paneEl) paneEl.style.display = (tabId === activeTab) ? "block" : "none";
        });
      };
      ["tabPositions", "tabAssets", "tabDaemonActivity", "tabOrderLog"].forEach((id) => {
        const tabEl = lid(id);
        if (tabEl) {
          tabEl.disabled = false;
          tabEl.style.cursor = "pointer";
          tabEl.addEventListener("click", () => switchPosTab(id));
        }
      });
      const irrelevantUpbitTab = lid("tabUpbit");
      const irrelevantUpbitPane = lid("paneUpbit");
      if (irrelevantUpbitTab) irrelevantUpbitTab.style.display = "none";
      if (irrelevantUpbitPane) irrelevantUpbitPane.style.display = "none";
      const orderPane = lid("paneOrderLog");
      if (orderPane) {
        const headers = ["Timestamp (KST)", "Event", "Direction", "Filled Qty / USDT Size", "Entry → Exit Ratio", "Fees", "Net P&L / Return", "Status"];
        orderPane.querySelectorAll("thead th").forEach((cell, index) => {
          if (headers[index]) cell.textContent = headers[index];
        });
        if (!lid("executionHistorySummary")) {
          const summary = document.createElement("div");
          summary.id = "lighter_executionHistorySummary";
          summary.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;padding:10px 13px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11px;color:#475569";
          summary.textContent = "Loading persisted Lighter executions…";
          orderPane.prepend(summary);
        }
      }
      const positionsPane = lid("panePositions");
      if (positionsPane) {
        const headers = ["Position", "Asset", "Side", "Quantity", "Entry Price", "USDT Size", "Est. 1x Margin", "Unrealized P&L / ROE"];
        positionsPane.querySelectorAll("thead th").forEach((cell, index) => {
          if (headers[index]) cell.textContent = headers[index];
        });
        if (!lid("activePositionsSummary")) {
          const summary = document.createElement("div");
          summary.id = "lighter_activePositionsSummary";
          summary.style.cssText = "display:flex;gap:14px;flex-wrap:wrap;padding:10px 13px;background:#f8fafc;border-bottom:1px solid #e2e8f0;font-size:11px;color:#475569";
          summary.textContent = "Loading current Lighter position sizes…";
          positionsPane.prepend(summary);
        }
      }

      const progressBar = lid("barTrancheProgress");
      const utilizationLabel = progressBar?.parentElement?.previousElementSibling?.querySelector("span");
      if (utilizationLabel) utilizationLabel.textContent = "Gross Leverage Utilization (separate from campaign slot cap):";

      this.renderLiveRulesPanel();
      const saveLiveCooldown = lid("btnSaveLiveCooldown");
      if (saveLiveCooldown && !saveLiveCooldown._boundClick) {
        saveLiveCooldown._boundClick = true;
        saveLiveCooldown.addEventListener("click", () => this.saveLiveBotRate());
      }
      const liveTradeRate = lid("inputLiveTradeRate");
      if (liveTradeRate && !liveTradeRate._boundInput) {
        liveTradeRate._boundInput = true;
        liveTradeRate.addEventListener("input", () => this.renderTradeRatePreview());
      }
      window.terminalLockManager?.applyState?.();

      const tab = $("tabContentLighter");
      if (tab) {
        const walker = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          walker.currentNode.nodeValue = walker.currentNode.nodeValue
            .replace(/CSOP 2L ETF \/ Domestic/g, "SKHYNIXUSD Korean underlying")
            .replace(/CSOP 2L/g, "SKHYNIXUSD")
            .replace(/\bCSOP\b/g, "SKHYNIXUSD");
        }
        Array.from(tab.querySelectorAll("span")).forEach((element) => {
          if (element.textContent.trim() === "LIVE BINANCE EXECUTION") element.textContent = "PAPER / BACKTEST ONLY";
          if (element.textContent.trim() === "ARMED & LIVE") element.textContent = "PAPER LADDER";
        });
        tab.querySelectorAll("[title]").forEach((element) => {
          element.title = element.title.replace(/CSOP/g, "SKHYNIXUSD").replace(/8\.00x/g, "1.00x");
        });
      }

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
        input.addEventListener("change", () => {
          this.updateRulesMatchStatus();
          this.runBacktest();
        });
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
            <button id="lighter_btnTier1" class="lighterTierBtn" type="button" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Tier 1 (1x Conservative)</button>
            <button id="lighter_btnTier2" class="lighterTierBtn" type="button" style="border:1.5px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:800;cursor:pointer;">Tier 2 (1x Neutral)</button>
            <button id="lighter_btnTier3" class="lighterTierBtn" type="button" style="border:1.5px solid #cbd5e1;background:#fff;color:#475569;border-radius:6px;padding:6px 10px;font-size:11px;font-weight:700;cursor:pointer;">Tier 3 (1x Opportunistic)</button>
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
                <th style="padding:8px 12px;">Allocations (SKHY / SKHYNIXUSD)</th>
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
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span id="lighter_liveBotStrategyBadge" style="font-size:10px;font-weight:800;padding:4px 8px;border-radius:6px;background:#dcfce7;color:#166534;border:1px solid #86efac;display:none;">
              ● LIVE BOT: DYNAMIC GRID
            </span>
            <div id="lighter_paradigmBadge" style="font-size:10px;font-weight:800;padding:4px 10px;border-radius:999px;background:#e0e7ff;color:#4338ca;border:1px solid #c7d2fe;">
              PARITY HARVESTING · GRID ARB
            </div>
          </div>
        `;
        criteriaGrid.parentNode.insertBefore(nav, criteriaGrid);
        ["grid", "ou_quant", "ma_stack", "multi_factor", "trend_pullback", "custom"].forEach((mode) => {
          const btn = $(`lighter_tabParadigm_${mode}`);
          if (btn) btn.addEventListener("click", () => {
            this._userSelectedParadigm = true;
            this.setParadigm(mode);
          });
        });
      }
    },

    async setParadigm(mode) {
      if (!this.paradigms[mode]) return;
      this.currentParadigm = mode;
      safeStorage.setItem(STRATEGY_STORAGE_KEY, mode);
      const p = this.paradigms[mode];

      if (typeof document.querySelectorAll === "function") {
        document.querySelectorAll(".lighterParadigmBtn").forEach((btn) => {
          const isCurrent = btn.dataset.mode === mode;
          btn.style.background = isCurrent ? "#7c3aed" : "#fff";
          btn.style.color = isCurrent ? "#fff" : "#475569";
          btn.style.borderColor = isCurrent ? "#7c3aed" : "#cbd5e1";
          btn.style.fontWeight = isCurrent ? "800" : "700";
        });
      }

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
      const legacyEntryChecklist = lid("entryConditionsChecklist");
      if (legacyEntryChecklist) legacyEntryChecklist.style.display = mode === "ou_quant" ? "none" : "";
      const legacyExitChecklist = lid("exitConditionsChecklist");
      if (legacyExitChecklist) legacyExitChecklist.style.display = mode === "ou_quant" ? "none" : "";
      const legacyCards = $("tabContentLighter")?.querySelector(".shortTermCriteriaGrid")?.children || [];
      for (const card of [legacyCards[0], legacyCards[1]]) {
        if (card) card.style.display = mode === "ou_quant" ? "none" : "";
      }

      const ladderSec = $("lighter_gridMatrixSection");
      let detailSec = $("lighter_paradigmDetailSection");
      const rulesPanel = $("lighterLiveRulesPanel");
      if (!detailSec && ladderSec) {
        detailSec = document.createElement("div");
        detailSec.id = "lighter_paradigmDetailSection";
        detailSec.style.cssText = "margin-top:14px;background:#ffffff;border:1.5px solid #cbd5e1;border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,0.05);display:none;";
        if (rulesPanel) {
          ladderSec.parentNode.insertBefore(detailSec, rulesPanel);
        } else {
          ladderSec.parentNode.insertBefore(detailSec, ladderSec.nextSibling);
        }
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
      this.updateRulesMatchStatus();
      this.updateDeployButtonState();
    },

    renderParadigmDetail(mode) {
      if (mode === "ou_quant") {
        const liveEntryZ = Number(this.botState?.strategy_params?.entry_z ?? this.botState?.entry_z ?? 1.4).toFixed(1);
        const liveExitZ = Number(this.botState?.strategy_params?.exit_z ?? this.botState?.exit_z ?? 0.20).toFixed(2);
        const params = this.botState?.strategy_params || {};
        const ouChecked = (key) => params[key] !== false ? "checked" : "";
        const ouNumber = (key, fallback) => Number(params[key] ?? fallback);
        const ouRowStyle = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;font-size:12px;color:#334155;";
        const ouToggleStyle = "appearance:auto;display:inline-block;width:16px;height:16px;min-width:16px;margin:0;flex:none;";
        const ouNumberStyle = "display:inline-block;width:62px;height:26px;margin:0;padding:2px 5px;border:1px solid #cbd5e1;border-radius:4px;font-size:12px;";
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:1.5px solid #e2e8f0;padding-bottom:12px;margin-bottom:14px;">
            <div>
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">🔬</span>
                <strong style="font-size:14px;color:#0f172a;text-transform:uppercase;letter-spacing:0.5px;">OU mean-reversion rules</strong>
                <span style="background:#e0e7ff;color:#4338ca;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;border:1px solid #c7d2fe;">SDE CALIBRATED</span>
              </div>
              <p style="margin:4px 0 0;color:#64748b;font-size:11.5px;">Continuous stochastic differential equation calibration: dX = θ(μ - X)dt + σdW · Normalized Z-score mean reversion.</p>
            </div>
            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:11px;font-weight:700;color:#475569;">Entry Z:</span>
                <input id="lighter_rangeOuEntryZ" type="range" min="0.8" max="3.0" step="0.05" value="${liveEntryZ}" aria-label="OU Entry Z-score threshold slider" style="width:90px;height:24px;margin:0;cursor:pointer;accent-color:#7c3aed;">
                <input id="lighter_inpOuEntryZ" type="number" step="0.05" min="0.8" max="3.0" value="${liveEntryZ}" style="width:54px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 5px;font-size:11px;font-weight:700;">
                <span id="lighter_valOuEntryZBadge" style="font-size:10px;font-weight:800;color:#6d28d9;background:#f5f3ff;border:1px solid #ddd6fe;padding:2px 6px;border-radius:4px;">≥ ${liveEntryZ}σ</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:11px;font-weight:700;color:#475569;">Exit Z:</span>
                <input id="lighter_rangeOuExitZ" type="range" min="0.05" max="0.80" step="0.05" value="${liveExitZ}" aria-label="OU Exit Z-score threshold slider" style="width:90px;height:24px;margin:0;cursor:pointer;accent-color:#0284c7;">
                <input id="lighter_inpOuExitZ" type="number" step="0.05" min="0.05" max="0.80" value="${liveExitZ}" style="width:54px;height:26px;border:1px solid #cbd5e1;border-radius:4px;padding:2px 5px;font-size:11px;font-weight:700;">
                <span id="lighter_valOuExitZBadge" style="font-size:10px;font-weight:800;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;padding:2px 6px;border-radius:4px;">≤ ${liveExitZ}σ</span>
              </div>
              <button id="lighter_btnOuReplay" type="button" style="border:1px solid #7c3aed;background:#7c3aed;color:#fff;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">Rerun SDE</button>
            </div>
          </div>
          <div id="lighter_ouEntryConditions" style="display:grid;gap:8px;margin:12px 0 14px;">
            <strong style="font-size:12px;color:#0f172a;">Entry conditions · switches and values apply to replay; Deploy applies them to the live bot</strong>
            <div style="${ouRowStyle}"><input id="lighter_ouUseEntryZ" type="checkbox" aria-label="Enable minimum entry Z" style="${ouToggleStyle}" ${ouChecked("ou_use_entry_z")}><span>1. Minimum |Z| (Entry Z above)</span></div>
            <div style="${ouRowStyle}"><input id="lighter_ouUseHalflife" type="checkbox" aria-label="Enable maximum half-life" style="${ouToggleStyle}" ${ouChecked("ou_use_halflife")}><span>2. Maximum half-life</span><input id="lighter_ouHalflifeMax" type="number" aria-label="Maximum half-life parameter" min="1" max="50" step="0.5" value="${ouNumber("ou_halflife_max", 8)}" style="${ouNumberStyle}"><span>× 4 bars</span></div>
            <div style="${ouRowStyle}"><input id="lighter_ouUseMinDeviation" type="checkbox" aria-label="Enable minimum OU deviation" style="${ouToggleStyle}" ${ouChecked("ou_use_min_abs_deviation")}><span>3. Minimum deviation from OU mean</span><input id="lighter_ouMinDeviation" type="number" aria-label="Minimum OU deviation in percentage points" min="0" max="5" step="0.01" value="${ouNumber("ou_min_abs_deviation_pp", 0.25)}" style="${ouNumberStyle}"><span>pp</span></div>
            <div style="${ouRowStyle}"><input id="lighter_ouUseMacroTrend" type="checkbox" aria-label="Enable macro EMA alignment" style="${ouToggleStyle}" ${ouChecked("ou_use_macro_trend")}><span>4. Macro EMA slope aligned · EMA</span><input id="lighter_ouMacroSpan" type="number" aria-label="Macro EMA span" min="5" max="120" step="1" value="${ouNumber("ou_macro_ema_span", 60)}" style="${ouNumberStyle}"><span>over</span><input id="lighter_ouMacroSlopeBars" type="number" aria-label="Macro EMA slope comparison bars" min="1" max="60" step="1" value="${ouNumber("ou_macro_slope_bars", 12)}" style="${ouNumberStyle}"><span>bars</span></div>
            <div style="${ouRowStyle}"><input id="lighter_ouUseStopZone" type="checkbox" aria-label="Enable upper entry Z limit" style="${ouToggleStyle}" ${ouChecked("ou_use_stop_zone")}><span>5. Entry below emergency |Z| limit</span><input id="lighter_ouStopZ" type="number" aria-label="Emergency Z limit" min="1.5" max="6" step="0.05" value="${ouNumber("ou_stop_z", 3.5)}" style="${ouNumberStyle}"><span>σ</span></div>
            <small style="color:#64748b;">Live order-book quote confirmation, account capacity and order safety remain separate execution checks. Historical replay has no order-book quotes.</small>
          </div>
          <div id="lighter_ouExitConditions" style="display:grid;gap:8px;margin:12px 0 14px;">
            <strong style="font-size:12px;color:#0f172a;">Exit condition</strong>
            <div style="${ouRowStyle}"><input id="lighter_ouUseExitZ" type="checkbox" aria-label="Enable neutral Z exit" style="${ouToggleStyle}" ${ouChecked("ou_use_exit_z")}><span>1. OU neutral |Z| target (Exit Z above)</span></div>
            <small style="color:#64748b;">Emergency stop at the upper Z limit remains active. Live exits also check net profit and actual positions; replay uses price signals only.</small>
          </div>
          <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Reversion Speed (θ)</small>
              <strong id="lighter_valOuTheta" style="font-size:15px;color:#0f172a;">Awaiting replay</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Equilibrium Half-Life (τ)</small>
              <strong id="lighter_valOuHalfLife" style="font-size:15px;color:#0284c7;">Awaiting replay</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Replay macro EMA slope</small>
              <strong id="lighter_valOuMacroSlope" style="font-size:15px;color:#16a34a;">Awaiting completed bars</strong>
            </div>
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;">
              <small style="color:#64748b;font-weight:700;font-size:10px;display:block;text-transform:uppercase;">Current SDE Divergence</small>
              <strong id="lighter_valOuZScore" style="font-size:15px;color:#7c3aed;">Awaiting replay</strong>
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
      const detailSec = $("lighter_paradigmDetailSection");
      if (detailSec && typeof detailSec.querySelectorAll === "function") {
        detailSec.querySelectorAll("input, select").forEach((input) => {
          if (typeof input.addEventListener === "function") {
            input.addEventListener("input", () => { input._userModified = true; this.updateRulesMatchStatus(); });
            input.addEventListener("change", () => { input._userModified = true; });
            input.addEventListener("change", () => this.runBacktest());
          }
        });
      }
      if (mode === "ou_quant") {
        const rangeEntry = $("lighter_rangeOuEntryZ");
        const inpEntry = $("lighter_inpOuEntryZ");
        const badgeEntry = $("lighter_valOuEntryZBadge");
        const rangeExit = $("lighter_rangeOuExitZ");
        const inpExit = $("lighter_inpOuExitZ");
        const badgeExit = $("lighter_valOuExitZBadge");

        const syncEntry = (val, fromSlider = false) => {
          const num = Number(val);
          if (!Number.isFinite(num)) return;
          const formatted = num.toFixed(2);
          if (fromSlider && inpEntry) {
            inpEntry.value = formatted;
            inpEntry._userModified = true;
          } else if (!fromSlider && rangeEntry) {
            rangeEntry.value = formatted;
          }
          if (badgeEntry) badgeEntry.textContent = `≥ ${formatted}σ`;
          this.updateRulesMatchStatus();
        };

        const syncExit = (val, fromSlider = false) => {
          const num = Number(val);
          if (!Number.isFinite(num)) return;
          const formatted = num.toFixed(2);
          if (fromSlider && inpExit) {
            inpExit.value = formatted;
            inpExit._userModified = true;
          } else if (!fromSlider && rangeExit) {
            rangeExit.value = formatted;
          }
          if (badgeExit) badgeExit.textContent = `≤ ${formatted}σ`;
          this.updateRulesMatchStatus();
        };

        if (rangeEntry && typeof rangeEntry.addEventListener === "function") {
          rangeEntry.addEventListener("input", (e) => syncEntry(e.target.value, true));
          rangeEntry.addEventListener("change", () => this.runBacktest());
        }
        if (inpEntry && typeof inpEntry.addEventListener === "function") {
          inpEntry.addEventListener("input", (e) => syncEntry(e.target.value, false));
        }
        if (rangeExit && typeof rangeExit.addEventListener === "function") {
          rangeExit.addEventListener("input", (e) => syncExit(e.target.value, true));
          rangeExit.addEventListener("change", () => this.runBacktest());
        }
        if (inpExit && typeof inpExit.addEventListener === "function") {
          inpExit.addEventListener("input", (e) => syncExit(e.target.value, false));
        }

        const btnReplay = $("lighter_btnOuReplay");
        if (btnReplay && typeof btnReplay.addEventListener === "function") {
          btnReplay.addEventListener("click", () => this.runBacktest());
        }
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
          safeStorage.setItem("skhynix_custom_rule_preset", JSON.stringify({ entry_z: ez, exit_z: xz, dwell: dw }));
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
        const rulesPanel = $("lighterLiveRulesPanel");
        if (rulesPanel) {
          criteriaGrid.parentNode.insertBefore(section, rulesPanel);
        } else {
          criteriaGrid.parentNode.insertBefore(section, criteriaGrid.nextSibling);
        }
        this.bindGridMatrixEvents();
      }
      this.updateGridLadderData();
    },

    renderLiveRulesPanel() {
      const criteriaGrid = $("tabContentLighter")?.querySelector(".shortTermCriteriaGrid");
      if (!criteriaGrid || $("lighterLiveRulesPanel")) return;
      const panel = document.createElement("section");
      panel.id = "lighterLiveRulesPanel";
      panel.style.cssText = "margin:14px 0 10px;padding:14px 16px;border:2px solid #059669;border-radius:10px;background:#ecfdf5;color:#064e3b;box-shadow:0 1px 3px rgba(0,0,0,0.05);";
      panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;border-bottom:1px solid rgba(5,150,105,0.2);padding-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <strong style="font-size:13px;letter-spacing:.35px">REAL EC2 BOT — PRODUCTION RULES</strong>
            <span id="lighter_liveBotEnginePill" style="font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;background:#059669;color:#fff;">LIVE: DYNAMIC GRID</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <button id="lighter_btnDeployLiveStrategy" type="button" class="terminal-action-control" style="display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 12px;background:#0284c7;color:#fff;border:none;border-radius:6px;font-size:11px;font-weight:800;cursor:pointer;">
              <span>⚡</span> <span id="lighter_btnDeployLiveStrategyLabel">Deploy Current Strategy to Live Bot</span>
            </button>
            <span id="lighterLiveRulesState" style="font-size:10px;font-weight:900;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#475569">LOADING</span>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:9px;font-size:11px;line-height:1.4">
          <div>
            <b>Active Live Engine</b><br>
            <span id="lighterLiveEngine">Dynamic Grid</span>
            <div id="lighterLiveEngineDesc" style="font-size:10px;color:#047857;margin-top:2px;">Parity harvesting mean-reversion</div>
          </div>
          <div>
            <b>Execution Data & Interval</b><br>
            <span id="lighterLiveInterval">Completed 5m candles</span> · 24-bar window
          </div>
          <div>
            <b>Entry Trigger</b><br>
            |Z| ≥ <span id="lighterLiveEntryZ">1.50</span>
            <div id="lighterLiveEntryDetail" style="font-size:10px;color:#047857;margin-top:2px;">Z high: short SKHY / long KR<br>Z low: long SKHY / short KR</div>
          </div>
          <div>
            <b>Exit Target</b><br>
            |Z| ≤ <span id="lighterLiveExitZ">0.25</span> · Zero-Loss Guard
            <div id="lighterLiveExitDetail" style="font-size:10px;color:#047857;margin-top:2px;">Full pair unwind at convergence</div>
          </div>
          <div>
            <b>Size / dynamic capacity</b><br>
            ADR target $<span id="lighterLiveNotional">25</span> · pair gross ≈ $<span id="lighterLivePairGross">—</span><br>
            <span id="lighterLiveMaxTranches">—</span> safe tranches · ≤8x account gross
          </div>
          <div>
            <b>Execution guards</b><br>
            Book spread ≤ <span id="lighterLiveMaxSpread">45</span> bps
            <div class="terminal-action-control" style="display:flex;align-items:center;gap:7px;margin-top:5px">
              <input id="lighter_inputLiveTradeRate" type="range" min="0.2" max="10" step="0.2" value="0.2" aria-label="Maximum paired trades per minute" style="width:118px;height:28px;margin:0;cursor:pointer;accent-color:#0284c7">
              <output id="lighterLiveTradeRateValue" for="lighter_inputLiveTradeRate" style="min-width:48px;font-weight:900;color:#0369a1">0.2/min</output>
              <button id="lighter_btnSaveLiveCooldown" type="button" style="height:28px;padding:0 8px;border:0;border-radius:5px;background:#0284c7;color:#fff;font-size:10px;font-weight:800;cursor:pointer">Save</button>
            </div>
            <small id="lighterLiveCooldown" style="display:block;margin-top:3px;color:#64748b">Current: 0.2 paired trades/min · 300s minimum · unlock required</small>
          </div>
          <div>
            <b>Zero-Loss Hurdle</b><br>
            Min Net Profit ≥ <span id="lighterLiveMinProfitPctVal">0.10</span>%
            <div class="terminal-action-control" style="display:flex;align-items:center;gap:7px;margin-top:5px">
              <input id="lighter_inputLiveMinProfitPct" type="range" min="0.0" max="1.0" step="0.05" value="0.10" aria-label="Minimum net profit percent hurdle per tranche" style="width:118px;height:28px;margin:0;cursor:pointer;accent-color:#059669">
              <output id="lighterLiveMinProfitPctDisplay" for="lighter_inputLiveMinProfitPct" style="min-width:48px;font-weight:900;color:#047857">0.10%</output>
              <button id="lighter_btnSaveLiveMinProfit" type="button" style="height:28px;padding:0 8px;border:0;border-radius:5px;background:#059669;color:#fff;font-size:10px;font-weight:800;cursor:pointer">Save</button>
            </div>
            <small id="lighterLiveMinProfitDesc" style="display:block;margin-top:3px;color:#64748b">Current: 0.10% notional (~$0.025 hurdle) · unlock required</small>
          </div>
          <div>
            <b>Current evaluation</b><br>
            <span id="lighterLiveEvaluation">Awaiting completed bar</span>
          </div>
        </div>
        <div style="margin-top:10px;padding:8px 10px;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:11px;font-weight:800;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <span>Live execution parameters and active engine are managed directly in this STRATEGY REGIME command center.</span>
          <span style="font-size:10px;font-weight:700;color:#c2410c;">Simulations in chart/backtest remain paper-only until deployed.</span>
        </div>
      `;
      const detailSec = $("lighter_paradigmDetailSection");
      const ladderSec = $("lighter_gridMatrixSection");
      if (detailSec) {
        detailSec.parentNode.insertBefore(panel, detailSec.nextSibling);
      } else if (ladderSec) {
        ladderSec.parentNode.insertBefore(panel, ladderSec.nextSibling);
      } else {
        criteriaGrid.parentNode.appendChild(panel);
      }

      const deployBtn = $("lighter_btnDeployLiveStrategy");
      if (deployBtn && !deployBtn._boundClick) {
        deployBtn._boundClick = true;
        deployBtn.addEventListener("click", () => this.deployLiveStrategy());
      }
      const saveBtn = $("lighter_btnSaveLiveCooldown");
      if (saveBtn && !saveBtn._boundClick) {
        saveBtn._boundClick = true;
        saveBtn.addEventListener("click", () => this.saveLiveBotRate());
      }
      const rateInput = $("lighter_inputLiveTradeRate");
      if (rateInput && !rateInput._boundInput) {
        rateInput._boundInput = true;
        rateInput.addEventListener("input", () => this.renderTradeRatePreview());
      }
      const minProfitSaveBtn = $("lighter_btnSaveLiveMinProfit");
      if (minProfitSaveBtn && !minProfitSaveBtn._boundClick) {
        minProfitSaveBtn._boundClick = true;
        minProfitSaveBtn.addEventListener("click", () => this.saveLiveMinProfitPct());
      }
      const minProfitInput = $("lighter_inputLiveMinProfitPct");
      if (minProfitInput && !minProfitInput._boundInput) {
        minProfitInput._boundInput = true;
        minProfitInput.addEventListener("input", () => this.renderMinProfitPreview());
      }
      this.updateDeployButtonState();
      window.terminalLockManager?.applyState?.();
    },

    updateDeployButtonState() {
      const btnLabel = $("lighter_btnDeployLiveStrategyLabel");
      const btn = $("lighter_btnDeployLiveStrategy");
      if (!btn || !btnLabel) return;
      const currentMode = this.currentParadigm || "grid";
      const liveMode = this.botState?.strategy_mode || "grid";
      const currentName = this.paradigms[currentMode]?.name || currentMode;
      if (currentMode === liveMode) {
        btnLabel.textContent = `✓ ${currentName} Active on Live Bot (Re-apply)`;
        btn.style.background = "#059669";
      } else {
        btnLabel.textContent = `⚡ Deploy ${currentName} to Live Bot`;
        btn.style.background = "#0284c7";
      }
    },

    ouConditionSettings() {
      const live = this.botState?.strategy_params || {};
      const number = (id, key, fallback) => {
        const raw = $(id)?.value;
        const value = raw == null || raw === "" ? NaN : Number(raw);
        return Number.isFinite(value) ? value : Number(live[key] ?? fallback);
      };
      const enabled = (id, key) => $(id)?.checked ?? (live[key] !== false);
      return {
        ou_halflife_max: number("lighter_ouHalflifeMax", "ou_halflife_max", 8),
        ou_stop_z: number("lighter_ouStopZ", "ou_stop_z", 3.5),
        ou_min_abs_deviation_pp: number("lighter_ouMinDeviation", "ou_min_abs_deviation_pp", 0.25),
        ou_macro_ema_span: number("lighter_ouMacroSpan", "ou_macro_ema_span", 60),
        ou_macro_slope_bars: number("lighter_ouMacroSlopeBars", "ou_macro_slope_bars", 12),
        ou_use_entry_z: enabled("lighter_ouUseEntryZ", "ou_use_entry_z"),
        ou_use_halflife: enabled("lighter_ouUseHalflife", "ou_use_halflife"),
        ou_use_min_abs_deviation: enabled("lighter_ouUseMinDeviation", "ou_use_min_abs_deviation"),
        ou_use_macro_trend: enabled("lighter_ouUseMacroTrend", "ou_use_macro_trend"),
        ou_use_stop_zone: enabled("lighter_ouUseStopZone", "ou_use_stop_zone"),
        ou_use_exit_z: enabled("lighter_ouUseExitZ", "ou_use_exit_z"),
      };
    },

    liveStrategyPayload(mode = this.currentParadigm || "grid") {
      const payload = {
        strategy_mode: mode,
        strategy_interval: this.interval || "5m",
      };
      const numeric = (id, fallback) => {
        const value = Number($(id)?.value);
        return Number.isFinite(value) ? value : fallback;
      };
      if (mode === "ou_quant") {
        payload.entry_z = numeric("lighter_inpOuEntryZ", Number(this.botState?.strategy_params?.entry_z ?? this.botState?.entry_z ?? 1.4));
        payload.exit_z = numeric("lighter_inpOuExitZ", Number(this.botState?.strategy_params?.exit_z ?? this.botState?.exit_z ?? 0.20));
        Object.assign(payload, this.ouConditionSettings());
      } else if (mode === "ma_stack") {
        payload.ma_stretch_min = numeric("lighter_inpMaStretchMin", 0.30);
        payload.ma_trailing_stop = numeric("lighter_inpMaTrailingStop", 0.15);
      } else if (mode === "multi_factor") {
        payload.min_consensus_votes = numeric("lighter_selFactorQuorum", 3);
      } else if (mode === "trend_pullback") {
        payload.trend_pullback_dist = numeric("lighter_inpTrendPullbackDist", 0.15);
        payload.trend_tp_dist = numeric("lighter_inpTrendTpDist", 0.05);
        payload.trend_macro_window = numeric("lighter_inpTrendMacroWindow", 24);
      } else if (mode === "custom") {
        payload.entry_z = numeric("lighter_inpCustomEntryZ", 1.5);
        payload.exit_z = numeric("lighter_inpCustomExitZ", 0.25);
      }
      const minProfitInp = $("lighter_inputLiveMinProfitPct");
      if (minProfitInp) {
        payload.min_profit_pct = numeric("lighter_inputLiveMinProfitPct", Number(this.botState?.strategy_params?.min_profit_pct ?? this.botState?.min_profit_pct ?? 0.10));
      }
      return payload;
    },

    async deployLiveStrategy(options = {}) {
      if (window.terminalLockManager?.isLocked) {
        window.showToast?.("🔒 Terminal is in read-only mode. Unlock using the slide switch at the top.", "warn");
        window.terminalLockManager?.openPasswordModal?.();
        return false;
      }
      const mode = this.currentParadigm || "grid";
      if (mode === "ou_quant") {
        const controls = $("lighter_paradigmDetailSection")?.querySelectorAll?.("input[type=number]") || [];
        for (const input of controls) {
          if (typeof input.checkValidity === "function" && !input.checkValidity()) {
            input.reportValidity?.();
            return false;
          }
        }
      }
      const pName = this.paradigms[mode]?.name || mode;
      const confirmed = options.skipConfirm || window.confirm(`Deploy "${pName}" (${this.interval}) to the live EC2 trading daemon?\n\nLive orders and existing inventory exits will immediately follow this strategy's parameters.`);
      if (!confirmed) return false;

      const btn = $("lighter_btnDeployLiveStrategy");
      if (btn) btn.disabled = true;

      const payload = this.liveStrategyPayload(mode);

      try {
        const data = await apiPost("/api/lighter/bot/config", payload);
        if (data?.bot) {
          this.updateBotStatus(data.bot, this.liveVenue || { execution_enabled: true });
        }
        window.showToast?.(`✅ Live EC2 strategy changed to ${pName} (${payload.strategy_interval}).`, "success");
        return true;
      } catch (err) {
        window.alert(`Failed to deploy strategy: ${err.message}`);
        return false;
      } finally {
        if (btn) btn.disabled = false;
      }
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
      const spacingEl = $("lighter_valGridSpacing");
      if (spacingEl) spacingEl.textContent = `±${step.toFixed(3)}% (${tier.name.split(":")[1]?.trim() || "Dynamic"})`;

      const activeRungsEl = $("lighter_valActiveRungs");
      const activeCount = (this.mode === "live" || Boolean(this.botState?.enabled))
        ? ((this.botState?.tranches || []).filter(t => (t.adr_qty > 0 || t.domestic_qty > 0)).length)
        : this.entries.length;
      if (activeRungsEl) activeRungsEl.textContent = `${activeCount} / ${count} Tiers Active`;

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
            <td style="padding:7px 12px;font-family:monospace;color:#475569;">-${skhy} SKHY / +${csop} SKHYNIXUSD</td>
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
            <td style="padding:7px 12px;font-family:monospace;color:#475569;">+${skhy} SKHY / -${csop} SKHYNIXUSD</td>
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
      try {
        const saved = JSON.parse(safeStorage.getItem(STORAGE_KEY) || "{}");
        this.entries = Array.isArray(saved.entries) ? saved.entries : [];
        this.ledger = Array.isArray(saved.ledger) ? saved.ledger : [];
      } catch (_) {}
      const selectedStrategy = safeStorage.getItem(STRATEGY_STORAGE_KEY);
      if (this.paradigms[selectedStrategy]) this.currentParadigm = selectedStrategy;
      this.mode = safeStorage.getItem("skhynix_lighter_mode") || "paper";
      this.labelTerminal();
      this.applyMode(this.mode, false);
      this.initialized = true;
      this.renderVirtualState();
    },

    ensureChart() {
      const host = lid("shortTermSpreadChartHost");
      if (this.chart || !host || !window.LightweightCharts) return;
      this.chart = LightweightCharts.createChart(host, {
        width: host.clientWidth, height: 420,
        layout: { background: { color: "#f8fafc" }, textColor: "#475569" },
        localization: {
          timeFormatter: (time) => formatKstDateTime(Number(time) * 1000, false),
        },
        grid: { vertLines: { color: "#f1f5f9" }, horzLines: { color: "#f1f5f9" } },
        rightPriceScale: { borderColor: "#e2e8f0" },
        timeScale: {
          borderColor: "#e2e8f0", timeVisible: true,
          tickMarkFormatter: (time) => formatKstChartTime(time),
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      });
      StrategyExecutionChartController.compactCrosshairMarkers(this.chart);
      this.series = this.chart.addAreaSeries({ topColor: "rgba(2,132,199,.25)", bottomColor: "rgba(2,132,199,.02)", lineColor: "#0284c7", lineWidth: 1,
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
      this.activeHoveredExecutionMarkerKey = null;
      this.activeHoveredPairKey = null;
      this.selectedExecutionMarkerTime = null;
      this.selectedExecutionMarkerKey = null;
      this.selectedPairKey = null;

      host.style.position = "relative";
      if (!lid("tradeMarkerHover")) {
        const hoverLabel = document.createElement("div");
        hoverLabel.id = "lighter_tradeMarkerHover";
        hoverLabel.setAttribute("role", "status");
        hoverLabel.setAttribute("aria-live", "polite");
        hoverLabel.style.cssText = "display:none;position:absolute;z-index:8;top:8px;left:12px;max-width:min(420px,calc(100% - 24px));padding:6px 10px;border-radius:6px;border:1px solid #cbd5e1;background:rgba(255,255,255,.97);box-shadow:0 2px 8px rgba(15,23,42,.12);font-size:11px;font-weight:800;line-height:1.35;color:#0f172a;pointer-events:auto;white-space:normal";
        host.appendChild(hoverLabel);
      }
      if (!lid("tradeTrianglesLayer")) {
        const svgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svgLayer.id = "lighter_tradeTrianglesLayer";
        svgLayer.setAttribute("aria-label", "Trade entry-exit triangles");
        svgLayer.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:6;pointer-events:none;overflow:hidden";
        host.appendChild(svgLayer);
      }
      if (!lid("tradeMarkerTargets")) {
        const targetLayer = document.createElement("div");
        targetLayer.id = "lighter_tradeMarkerTargets";
        targetLayer.setAttribute("aria-label", "Individual trade markers");
        targetLayer.style.cssText = "position:absolute;inset:0;z-index:7;pointer-events:none;overflow:hidden";
        host.appendChild(targetLayer);
      }

      // The native crosshair owns x-axis/price inspection. Trade details are
      // driven only by the individual DOM marker targets rendered above it.
      this.chart.subscribeClick((param) => this.onChartClick(param));
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (this._rangeChangeRaf) return;
        this._rangeChangeRaf = requestAnimationFrame(() => {
          this._rangeChangeRaf = null;
          this.renderTrendRanges();
          this.renderTradeMarkerTargets();
          this.renderTradeTriangles();
        });
      });

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
        StrategyExecutionChartController.compactCrosshairMarkers(this.assetChart);
        this.assetSeries = {
          adr: this.assetChart.addLineSeries({ priceScaleId: 'right', color: '#2563eb', lineWidth: 2, title: 'SKHY' }),
          stock: this.assetChart.addLineSeries({ priceScaleId: 'left', color: '#d97706', lineWidth: 2, title: 'SKHYNIXUSD' }),
        };

        this.chartSync = StrategyExecutionChartController.linkTimeScales(this.chart, this.assetChart);
      }

      window.addEventListener("resize", () => this.resize());
    },

    async onTabActivated() {
      this.init(); this.ensureChart(); this.resize();
      await this.refresh();
    },

    resize() {
      const host = lid("shortTermSpreadChartHost");
      if (host && this.chart && host.clientWidth > 0) {
        this.chart.applyOptions({ width: host.clientWidth });
        this.renderTrendRanges();
        this.renderTradeMarkerTargets();
        this.renderTradeTriangles();
      }
      const assetHost = lid("shortTermAssetHost");
      if (assetHost && this.assetChart && assetHost.clientWidth > 0) this.assetChart.applyOptions({ width: assetHost.clientWidth });
      this.chartSync?.sync();
    },

    async refresh() {
      const chartRefresh = this.refreshChart().catch((error) => {
        this.setText("lblShortTermChartStatus", `Chart unavailable: ${error.message}`);
        return false;
      });
      try {
        const sParam = encodeURIComponent(this.smallTrendInterval || "5m");
        const bParam = encodeURIComponent(this.bigTrendInterval || "1h");
        const [statusResult, botStatus, trendStatus] = await Promise.all([
          api("/api/lighter/status").catch(() => null),
          api("/api/lighter/bot/status").catch(() => null),
          api(`/api/lighter/trends?small=${sParam}&big=${bParam}`).catch(() => null),
        ]);
        const status = statusResult || { success: false, server_time_ms: Date.now(), positions: [] };
        this.liveVenue = status;
        this.livePositions = Array.isArray(status?.positions) ? status.positions : [];
        if (status && status.parity_ratio) {
          this.currentRatio = Number(status.parity_ratio);
        }
        this.setText("lblDaemonSyncTime", `Last Sync: ${formatKstDateTime(status.server_time_ms || Date.now(), false)}`);
        this.setText("lblDaemonLatency", "Grid Engine: Active");
        this.setText("lblDaemonStats", "Multi-Tier Grid · Live Telemetry");
        this.setText("lblHedgedSyncBadge", "INSTITUTIONAL GRID ACTIVE");
        if (status && status.l1_address) {
          const shortAddr = `${status.l1_address.slice(0, 6)}...${status.l1_address.slice(-4)}`;
          if (status.authenticated && status.account_index) {
            this.setText("lblDaemonMainStatus", `Daemon: Lighter Account #${status.account_index} Active`);
            this.setText("lblDaemonAuthBadge", `LIVE: $${(status.collateral || 0).toFixed(2)} USDC`);
            this.setText("valAccountEquity", `$${(status.collateral || 0).toFixed(2)}`);
            this.setText("badgeEquitySource", "LIGHTER L2");
          } else {
            this.setText("lblDaemonMainStatus", `Daemon: Bot Wallet ${shortAddr}`);
            this.setText("lblDaemonAuthBadge", "BOT WALLET READY");
            this.setText("badgeEquitySource", shortAddr);
          }
        }
        this.setText("valShortTermCurrentParity", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valHedgedCombinedPnl", this.virtualPnlText());
        this.setText("valCollateralPills", `Tier ${this.currentTier} · 0.00% Maker · Dynamic Volatility Grid`);
        this.setText("valAutoCurrentEdge", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valCritCurrentSpread", `${this.currentRatio.toFixed(3)}%`);
        this.setText("valCritTpCurrentSpread", `${this.currentRatio.toFixed(3)}%`);
        if (botStatus?.bot) this.updateBotStatus(botStatus.bot, status);
        if (trendStatus?.success && trendStatus?.trends && Object.keys(trendStatus.trends).length) {
          if (this.trendRetryTimer) clearTimeout(this.trendRetryTimer);
          this.renderTrends(trendStatus.trends);
        } else this.scheduleTrendRetry();
        this.renderVirtualState();
        this.updateGridLadderData();
      } catch (error) {
        this.setText("lblHedgedSyncBadge", `GRID ENGINE: ${error.message}`);
      }
      await chartRefresh;
    },

    renderTrends(trends) {
      const sInt = this.smallTrendInterval || "5m";
      const bInt = this.bigTrendInterval || "1h";
      [[sInt, "lighterTrendSmall", "lighterTrend5m"], [bInt, "lighterTrendBig", "lighterTrend1h"]].forEach(([interval, id, fallbackId]) => {
        const trend = trends?.[interval] || trends?.[id === "lighterTrendSmall" ? "small" : "big"] || {};
        const badge = $(id) || $(fallbackId);
        if (!badge) return;
        const direction = trend.direction || "UNKNOWN";
        const icon = direction === "UPTREND" ? "▲" : (direction === "DOWNTREND" ? "▼" : "◆");
        const score = Number(trend.score || 0);
        badge.textContent = `${interval} ${icon} ${direction} ${score >= 0 ? "+" : ""}${score.toFixed(2)}`;
        const up = direction === "UPTREND", down = direction === "DOWNTREND";
        badge.style.cssText = `border:1px solid ${up ? "#86efac" : down ? "#fca5a5" : "#cbd5e1"};background:${up ? "#dcfce7" : down ? "#fee2e2" : "#f8fafc"};color:${up ? "#166534" : down ? "#991b1b" : "#475569"};border-radius:999px;padding:3px 7px;font-size:10px;font-weight:900;box-shadow:0 1px 3px rgba(15,23,42,.1)`;
      });
      this.updateRulesMatchStatus();
    },

    async fetchAndRenderTrends() {
      try {
        const sParam = encodeURIComponent(this.smallTrendInterval || "5m");
        const bParam = encodeURIComponent(this.bigTrendInterval || "1h");
        const res = await api(`/api/lighter/trends?small=${sParam}&big=${bParam}`);
        if (res?.success && res?.trends && Object.keys(res.trends).length) {
          if (this.trendRetryTimer) clearTimeout(this.trendRetryTimer);
          this.trendRetryTimer = null;
          this.renderTrends(res.trends);
        } else this.scheduleTrendRetry();
      } catch (_) { this.scheduleTrendRetry(); }
    },

    scheduleTrendRetry() {
      if (this.trendRetryTimer) return;
      this.trendRetryTimer = setTimeout(() => {
        this.trendRetryTimer = null;
        this.fetchAndRenderTrends();
      }, 5000);
    },

    replaySettings() {
      const mode = this.currentParadigm || "grid";
      const numeric = (id, fallback) => {
        const raw = $(id)?.value;
        const value = raw == null || raw === "" ? NaN : Number(raw);
        return Number.isFinite(value) ? value : fallback;
      };
      const liveOuEntryFallback = Number(this.botState?.strategy_params?.entry_z ?? this.botState?.entry_z ?? 1.4);
      const liveOuExitFallback = Number(this.botState?.strategy_params?.exit_z ?? this.botState?.exit_z ?? 0.20);
      return {
        interval: this.interval, limit: 500, strategy_mode: mode,
        entry_z: mode === "ou_quant" ? numeric("lighter_inpOuEntryZ", liveOuEntryFallback) :
          mode === "custom" ? numeric("lighter_inpCustomEntryZ", 1.5) : 1.5,
        exit_z: mode === "ou_quant" ? numeric("lighter_inpOuExitZ", liveOuExitFallback) :
          mode === "custom" ? numeric("lighter_inpCustomExitZ", 0.25) : 0.25,
        ...this.ouConditionSettings(),
        ma_stretch_min: numeric("lighter_inpMaStretchMin", 0.30),
        ma_trailing_stop: numeric("lighter_inpMaTrailingStop", 0.15),
        min_consensus_votes: numeric("lighter_selFactorQuorum", 3),
        trend_pullback_dist: numeric("lighter_inpTrendPullbackDist", 0.15),
        trend_tp_dist: numeric("lighter_inpTrendTpDist", 0.05),
        trend_macro_window: numeric("lighter_inpTrendMacroWindow", 24),
        trend_slope_min: 0.002,
        use_ma_stretch: lid("chkCondEntryMaStretch")?.checked !== false,
        use_base_spacing: lid("chkCondEntryBase")?.checked !== false,
        use_peak: lid("chkCondEntryPeak")?.checked !== false,
        use_ma_stack: lid("chkCondEntryMaStack5m")?.checked === true,
        use_convergence: lid("chkCondExitConvergence")?.checked !== false,
        use_dwell: lid("chkCondExitDwell")?.checked !== false,
        use_bottoming: lid("chkCondExitBottoming")?.checked === true,
      };
    },

    bindMatchPill(pill) {
      if (!pill || pill._boundAlignClick) return;
      pill._boundAlignClick = true;
      pill.setAttribute("role", "button");
      pill.setAttribute("tabindex", "0");
      const align = () => {
        if (pill.dataset.matchState !== "divergent" || !this.botState) return;
        this.alignReplayToLive();
      };
      pill.addEventListener("click", align);
      pill.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          align();
        }
      });
    },

    updateRulesMatchStatus() {
      const pill = $("lighterMatchPill");
      if (!pill) return;
      this.bindMatchPill(pill);
      const settings = this.replaySettings();
      const liveMode = this.botState?.strategy_mode || "grid";
      const liveInterval = this.botState?.strategy_interval || "5m";
      const liveName = this.botState?.strategy_name || this.paradigms[liveMode]?.name || liveMode;
      const currentMode = settings.strategy_mode;
      const currentInterval = settings.interval;
      const isIntervalMatch = currentInterval === liveInterval;
      const isParadigmMatch = currentMode === liveMode;
      const diffs = [];
      if (!this.botState) diffs.push("Live settings unavailable");
      if (!isIntervalMatch) diffs.push(`Interval ${currentInterval} ≠ ${liveInterval}`);
      if (!isParadigmMatch) diffs.push(`Strategy ${currentMode} ≠ ${liveMode}`);
      const parameterKeys = {
        grid: ["entry_z", "exit_z"], custom: ["entry_z", "exit_z"],
        ou_quant: ["entry_z", "exit_z", "ou_halflife_max", "ou_stop_z",
          "ou_min_abs_deviation_pp", "ou_macro_ema_span", "ou_macro_slope_bars",
          "ou_use_entry_z", "ou_use_halflife", "ou_use_min_abs_deviation",
          "ou_use_macro_trend", "ou_use_stop_zone", "ou_use_exit_z"],
        ma_stack: ["ma_stretch_min", "ma_trailing_stop"],
        multi_factor: ["entry_z", "exit_z", "min_consensus_votes"],
        trend_pullback: ["trend_pullback_dist", "trend_tp_dist", "trend_macro_window", "trend_slope_min"],
      };
      const liveParams = this.botState?.strategy_params || this.botState || {};
      if (isParadigmMatch) (parameterKeys[currentMode] || []).forEach((key) => {
        const live = liveParams[key];
        if (live == null || (typeof settings[key] === "boolean"
          ? settings[key] !== live
          : !Number.isFinite(Number(live)) || Math.abs(settings[key] - Number(live)) > 1e-9))
          diffs.push(`${key}: ${settings[key]} ≠ ${live ?? "unknown"}`);
      });
      // Only Grid/Custom consume these optional research filters. The other
      // strategies ignore these checkboxes, so their state cannot affect matching.
      const usesFilters = ["grid", "custom"].includes(currentMode);
      const rules = [
        ["EntryMaStretch", "use_ma_stretch", true, "Entry trigger"],
        ["EntryBase", "use_base_spacing", false, "Spacing"],
        ["EntryPeak", "use_peak", false, "Peak rollover"],
        ["EntryMaStack5m", "use_ma_stack", false, "Trend stack"],
        ["ExitConvergence", "use_convergence", true, "Convergence"],
        ["ExitDwell", "use_dwell", false, "Dwell"],
        ["ExitBottoming", "use_bottoming", false, "Bottoming"],
      ];
      rules.forEach(([suffix, key, liveEnabled, name]) => {
        const input = lid(`chkCond${suffix}`);
        const badge = lid(`badgeCond${suffix}`);
        if (input) {
          input.disabled = !usesFilters;
          input.title = usesFilters ? "Paper replay filter" : "Not used by this strategy";
        }
        if (badge) {
          badge.textContent = !usesFilters ? "N/A" : settings[key] ? "ON" : "OFF";
          badge.className = "condBadge neutral";
        }
        if (usesFilters && settings[key] !== liveEnabled)
          diffs.push(`${name} ${settings[key] ? "ON" : "OFF"} (live ${liveEnabled ? "ON" : "OFF"})`);
      });
      if (!["grid", "custom", "ou_quant"].includes(currentMode))
        diffs.push("Replay signal/exit rules differ from live");
      const matched = diffs.length === 0;
      const active = Boolean(this.botState?.enabled);
      pill.textContent = matched
        ? `${active ? "●" : "○"} LIVE-MATCHED SIGNALS (${liveInterval} · ${liveName} · Bot ${active ? "Active" : "Paused"})`
        : `▲ PAPER DIVERGENT (${diffs.join(" · ")}) — Click to match live`;
      pill.title = matched
        ? "Price signals only. Replay ignores margin, execution cooldown, slippage and funding; fills can differ."
        : "Click to align paper replay with the live bot settings";
      pill.style.cursor = matched ? "default" : "pointer";
      pill.dataset.matchState = matched ? "matched" : "divergent";
      pill.style.background = matched ? (active ? "#dcfce7" : "#fef3c7") : "#fff7ed";
      pill.style.color = matched ? (active ? "#166534" : "#92400e") : "#c2410c";
      pill.style.borderColor = matched ? (active ? "#86efac" : "#fcd34d") : "#fdba74";
    },

    alignReplayToLive() {
      if (!this.botState) return;
      const liveMode = this.botState.strategy_mode || "ou_quant";
      const liveInterval = this.botState.strategy_interval || "5m";
      this._userSelectedParadigm = false;
      this.interval = liveInterval;
      ["1m", "5m", "15m", "1h", "4h", "1d"].forEach((v) => {
        const btn = lid(`btnShortInterval${v}`);
        if (btn) btn.classList.toggle("active", v === liveInterval);
      });
      if (this.paradigms[liveMode]) {
        this.setParadigm(liveMode);
      }
      const params = this.botState.strategy_params || {};
      if (liveMode === "ou_quant") {
        const inpEntry = $("lighter_inpOuEntryZ");
        const rangeEntry = $("lighter_rangeOuEntryZ");
        const badgeEntry = $("lighter_valOuEntryZBadge");
        if (params.entry_z != null) {
          const val = Number(params.entry_z).toFixed(2);
          if (inpEntry) { inpEntry.value = val; inpEntry._userModified = false; }
          if (rangeEntry) rangeEntry.value = val;
          if (badgeEntry) badgeEntry.textContent = `≥ ${val}σ`;
        }
        const inpExit = $("lighter_inpOuExitZ");
        const rangeExit = $("lighter_rangeOuExitZ");
        const badgeExit = $("lighter_valOuExitZBadge");
        if (params.exit_z != null) {
          const val = Number(params.exit_z).toFixed(2);
          if (inpExit) { inpExit.value = val; inpExit._userModified = false; }
          if (rangeExit) rangeExit.value = val;
          if (badgeExit) badgeExit.textContent = `≤ ${val}σ`;
        }
        const controls = {
          ou_halflife_max: "lighter_ouHalflifeMax", ou_stop_z: "lighter_ouStopZ",
          ou_min_abs_deviation_pp: "lighter_ouMinDeviation",
          ou_macro_ema_span: "lighter_ouMacroSpan",
          ou_macro_slope_bars: "lighter_ouMacroSlopeBars",
          ou_use_entry_z: "lighter_ouUseEntryZ",
          ou_use_halflife: "lighter_ouUseHalflife",
          ou_use_min_abs_deviation: "lighter_ouUseMinDeviation",
          ou_use_macro_trend: "lighter_ouUseMacroTrend",
          ou_use_stop_zone: "lighter_ouUseStopZone",
          ou_use_exit_z: "lighter_ouUseExitZ",
        };
        Object.entries(controls).forEach(([key, id]) => {
          const input = $(id);
          if (input && params[key] != null) {
            if (typeof params[key] === "boolean") input.checked = params[key];
            else input.value = String(params[key]);
            input._userModified = false;
          }
        });
      }
      this.updateRulesMatchStatus();
      this.refreshChart();
    },

    trendScore(values) {
      const logs = values.map((value) => Math.log(Math.max(Number(value), 1e-12)));
      const returns = logs.slice(1).map((value, index) => value - logs[index]);
      const meanReturn = returns.reduce((sum, value) => sum + value, 0) / returns.length;
      const returnStd = Math.sqrt(returns.reduce((sum, value) => sum + ((value - meanReturn) ** 2), 0) / returns.length);
      const xMean = (logs.length - 1) / 2;
      const yMean = logs.reduce((sum, value) => sum + value, 0) / logs.length;
      let numerator = 0, denominator = 0;
      logs.forEach((value, index) => {
        numerator += (index - xMean) * (value - yMean);
        denominator += (index - xMean) ** 2;
      });
      const slope = numerator / denominator;
      const slopeScore = Math.tanh(2 * slope / Math.max(returnStd, 1e-9));
      const ma7 = values.slice(-7).reduce((sum, value) => sum + value, 0) / 7;
      const ma24 = values.reduce((sum, value) => sum + value, 0) / values.length;
      const priceStd = Math.sqrt(values.reduce((sum, value) => sum + ((value - ma24) ** 2), 0) / values.length);
      const maScore = Math.tanh((ma7 - ma24) / Math.max(priceStd, 1e-9));
      const travel = values.slice(1).reduce((sum, value, index) => sum + Math.abs(value - values[index]), 0);
      const efficiency = travel > 1e-12 ? (values.at(-1) - values[0]) / travel : 0;
      return Math.max(-1, Math.min(1, 0.45 * slopeScore + 0.35 * maScore + 0.20 * efficiency));
    },

    calculateTrendRanges(bars) {
      const points = [];
      let state = "SIDEWAYS", pending = null, pendingCount = 0;
      for (let index = 23; index < bars.length; index += 1) {
        const values = bars.slice(index - 23, index + 1).map((bar) => Number(bar.value));
        if (values.some((value) => !Number.isFinite(value))) continue;
        const score = this.trendScore(values);
        let target;
        if (state === "UPTREND") target = score <= -0.35 ? "DOWNTREND" : (score < 0.15 ? "SIDEWAYS" : "UPTREND");
        else if (state === "DOWNTREND") target = score >= 0.35 ? "UPTREND" : (score > -0.15 ? "SIDEWAYS" : "DOWNTREND");
        else target = score >= 0.35 ? "UPTREND" : (score <= -0.35 ? "DOWNTREND" : "SIDEWAYS");
        if (target === state) {
          pending = null; pendingCount = 0;
        } else {
          if (target === pending) pendingCount += 1;
          else { pending = target; pendingCount = 1; }
          if (pendingCount >= 3) { state = target; pending = null; pendingCount = 0; }
        }
        points.push({ direction: state, score, time: bars[index].time, index });
      }
      return points;
    },

    alignChartOverlay(layer) {
      // Chart coordinates start at the plot, after the left price scale if present.
      let left = 0;
      try {
        const scale = this.chart?.priceScale?.("left");
        if (scale && typeof scale.width === "function") {
          left = Number(scale.width()) || 0;
        }
      } catch (_) {
        left = 0;
      }
      const width = Number(this.chart?.timeScale?.().width()) || 0;
      layer.style.left = `${left}px`;
      layer.style.right = "auto";
      layer.style.width = `${width}px`;
      return width;
    },

    renderTrendRanges() {
      const layer = $("lighterTrendBandLayer");
      const host = lid("shortTermSpreadChartHost");
      if (!layer || !host || !this.chart || !this.trendRanges.length) return;
      const scale = this.chart.timeScale();
      const width = this.alignChartOverlay(layer);
      const html = [];
      this.trendRanges.forEach((point) => {
        const x = scale.timeToCoordinate(point.time);
        if (x == null) return;
        const nextBar = this.bars[point.index + 1];
        const previousBar = this.bars[point.index - 1];
        const adjacentX = nextBar ? scale.timeToCoordinate(nextBar.time) : (previousBar ? scale.timeToCoordinate(previousBar.time) : null);
        const barWidth = adjacentX == null ? 7 : Math.max(2, Math.abs(adjacentX - x));
        const left = Math.max(0, x - barWidth / 2);
        const right = Math.min(width, x + barWidth / 2);
        if (right <= 0 || left >= width || right - left < 1) return;
        const magnitude = Math.min(1, Math.abs(point.score));
        const alpha = 0.025 + magnitude * 0.17;
        const background = point.score > 0.03
          ? `rgba(22,163,74,${alpha.toFixed(3)})`
          : (point.score < -0.03 ? `rgba(220,38,38,${alpha.toFixed(3)})` : "rgba(100,116,139,.025)");
        const strip = point.direction === "UPTREND" ? "#16a34a" : (point.direction === "DOWNTREND" ? "#dc2626" : "#94a3b8");
        html.push(`<div title="${this.interval} score ${point.score >= 0 ? "+" : ""}${point.score.toFixed(2)} · stable ${point.direction}" style="position:absolute;top:0;bottom:0;left:${left.toFixed(1)}px;width:${Math.max(1, right - left).toFixed(1)}px;background:${background};border-top:4px solid ${strip}"></div>`);
      });
      layer.innerHTML = html.join("");
    },

    updateBotStatus(bot, venue) {
      if (!bot) return;
      this.botState = bot;
      const isEnabled = Boolean(bot?.enabled);
      const isRecovery = Boolean(bot?.recovery_required);
      const tranches = Array.isArray(bot?.tranches) ? bot.tranches : [];
      // The EC2 bot is shared across browsers; per-browser localStorage is not
      // authoritative. Reconcile the visible execution mode to persisted server
      // state so a fresh profile/session cannot look like paper mode while the
      // real background bot is enabled (or vice versa).
      const authoritativeMode = isEnabled ? "live" : (this.mode === "live" ? "paper" : this.mode);
      if (authoritativeMode !== this.mode) {
        this.mode = authoritativeMode;
        safeStorage.setItem("skhynix_lighter_mode", authoritativeMode);
        this.applyMode(authoritativeMode, false);
      }
      const toggle = lid("chkAutoPeriodic48h");
      if (toggle) {
        toggle.checked = isEnabled;
        toggle.disabled = Boolean(window.terminalLockManager?.isLocked) || !venue?.execution_enabled || isRecovery;
      }
      const banner = lid("autoTradeMasterBanner");
      const pulseEl = lid("autoTradePulseIndicator");
      const titleEl = lid("lblAutoTradeStateTitle");
      const badge = lid("badgeAutoPeriodicStatus");
      const headingEl = lid("lblAutoTradeStatusHeading");
      const detailEl = lid("lblAutoTradeStatusDetail");
      const isKo = window.currentLang === "ko";

      if (banner) banner.classList.remove("active", "recovery");
      if (pulseEl) pulseEl.className = "autoTradePulseIndicator";
      if (badge) badge.classList.remove("active", "recovery");

      if (isRecovery) {
        if (banner) banner.classList.add("recovery");
        if (pulseEl) pulseEl.className = "autoTradePulseIndicator recovery";
        if (titleEl) titleEl.textContent = isKo ? "⚠️ 그리드 봇: 중단됨 (복구 필요)" : "⚠️ INSTITUTIONAL GRID BOT: HALTED (RECOVERY)";
        if (badge) {
          badge.style.display = "inline-flex";
          badge.className = "badgeAutoPeriodicStatus recovery";
          badge.textContent = "⚠ RECOVERY REQUIRED";
          badge.style.background = "#fee2e2";
          badge.style.color = "#991b1b";
        }
        if (headingEl) headingEl.textContent = "GRID BOT: RECOVERY";
        if (detailEl) detailEl.textContent = "Order reconciliation required on Lighter/EC2";
      } else if (isEnabled) {
        if (banner) banner.classList.add("active");
        if (pulseEl) pulseEl.className = "autoTradePulseIndicator active";
        if (titleEl) titleEl.textContent = isKo ? "⚡ 그리드 봇: 실시간 가동 중" : "⚡ INSTITUTIONAL GRID BOT: ACTIVE";
        if (badge) {
          badge.style.display = "inline-flex";
          badge.className = "badgeAutoPeriodicStatus active";
          badge.textContent = "● EC2 LIVE BOT ACTIVE";
          badge.style.background = "#dcfce7";
          badge.style.color = "#166534";
        }
        if (headingEl) headingEl.textContent = "EC2 DAEMON: ACTIVE";
        if (detailEl) detailEl.textContent = isKo ? "실시간 그리드 차익거래 가동 중" : "Running 24/7 institutional grid engine on EC2";
      } else {
        if (pulseEl) pulseEl.className = "autoTradePulseIndicator paused";
        if (titleEl) titleEl.textContent = isKo ? "○ 그리드 봇: 대기 (일시정지)" : "○ INSTITUTIONAL GRID BOT: PAUSED";
        if (badge) {
          badge.style.display = "inline-flex";
          badge.className = "badgeAutoPeriodicStatus";
          badge.textContent = "○ EC2 BOT PAUSED";
          badge.style.background = "#f1f5f9";
          badge.style.color = "#475569";
        }
        if (headingEl) headingEl.textContent = "EC2 DAEMON: STANDBY";
        if (detailEl) detailEl.textContent = isKo ? "토글 스위치를 켜서 24/7 그리드 매매를 시작하세요" : "Click toggle switch to start 24/7 grid bot";
      }

      const stratMode = bot?.strategy_mode || "grid";
      const stratName = bot?.strategy_name || this.paradigms[stratMode]?.name || "Dynamic Grid";
      const stratInterval = bot?.strategy_interval || "5m";
      const stratShort = stratMode === "grid" ? "GRID" : (stratMode === "ou_quant" ? "OU" : stratName.toUpperCase().slice(0, 8));

      // Sync Tab 3 Top Nav Pill
      const navLighterPill = $("navLighterLivePill");
      if (navLighterPill) {
        navLighterPill.className = "navLivePill";
        if (isRecovery) {
          navLighterPill.classList.add("recovery");
          navLighterPill.textContent = "⚠ RECOVERY";
        } else if (isEnabled) {
          navLighterPill.classList.add("active");
          navLighterPill.textContent = `● ${stratShort} AUTO ON`;
        } else {
          navLighterPill.classList.add("paused");
          navLighterPill.textContent = `○ ${stratShort} PAUSED`;
        }
      }

      const liveBtn = lid("modeLive");
      if (liveBtn) liveBtn.classList.toggle("botActiveLive", isEnabled);

      this.setText("lblDaemonLatency", isEnabled ? "Lighter Bot: Running on EC2" : "Lighter Bot: Paused");
      this.setText("lblDaemonStats", bot?.last_evaluation ? `Z ${Number(bot.last_evaluation.z || 0).toFixed(2)} · ${tranches.length}/${bot?.max_tranches ?? tranches.length} safe tranches` : "Awaiting first closed-bar evaluation");
      const rulesPanel = $("lighterLiveRulesPanel");
      if (rulesPanel) {
        rulesPanel.style.borderColor = isEnabled ? "#059669" : "#94a3b8";
        rulesPanel.style.background = isEnabled ? "#ecfdf5" : "#f8fafc";
      }
      const rulesState = $("lighterLiveRulesState");
      if (rulesState) {
        rulesState.textContent = isEnabled ? "● REAL BOT ACTIVE" : "○ REAL BOT PAUSED";
        rulesState.style.background = isEnabled ? "#dcfce7" : "#e2e8f0";
        rulesState.style.color = isEnabled ? "#166534" : "#475569";
      }
      const writeRule = (id, value) => { const element = $(id); if (element) element.textContent = value; };
      writeRule("lighterLiveEngine", `${stratName} (${stratInterval})`);
      const enginePill = $("lighter_liveBotEnginePill");
      if (enginePill) enginePill.textContent = `LIVE: ${stratName.toUpperCase()}`;
      const navLiveBadge = $("lighter_liveBotStrategyBadge");
      if (navLiveBadge) {
        navLiveBadge.style.display = "inline-block";
        navLiveBadge.textContent = `● LIVE BOT: ${stratName.toUpperCase()} (${stratInterval})`;
      }
      this.updateDeployButtonState();
      if (!this._userSelectedParadigm && stratMode && this.currentParadigm !== stratMode && this.paradigms[stratMode]) {
        this.setParadigm(stratMode);
      }
      this.setText("valDeployedInterval", `${stratInterval} completed candles`);
      this.setText("valDeployedEdge", `Entry |Z| ≥ ${Number(bot?.entry_z ?? 1.4).toFixed(2)}`);
      this.setText("valDeployedMinProfit", `Exit |Z| ≤ ${Number(bot?.exit_z ?? 0.2).toFixed(2)}`);

      writeRule("lighterLiveEntryZ", Number(bot?.entry_z ?? 1.4).toFixed(2));
      writeRule("lighterLiveExitZ", Number(bot?.exit_z ?? 0.2).toFixed(2));
      const liveEntryDetail = $("lighterLiveEntryDetail");
      if (liveEntryDetail) {
        const rules = bot?.strategy_params || {};
        liveEntryDetail.textContent = stratMode === "ou_quant"
          ? `OU entry: Z ${rules.ou_use_entry_z === false ? "off" : `≥ ${Number(bot?.entry_z ?? 1.5).toFixed(2)}`}; half-life ${rules.ou_use_halflife === false ? "off" : `≤ ${Number(rules.ou_halflife_max ?? 8) * 4} bars`}; deviation ${rules.ou_use_min_abs_deviation === false ? "off" : `≥ ${Number(rules.ou_min_abs_deviation_pp ?? 0.25).toFixed(2)} pp`}; EMA ${rules.ou_use_macro_trend === false ? "off" : `${rules.ou_macro_ema_span ?? 60}/${rules.ou_macro_slope_bars ?? 12} aligned`}; upper Z ${rules.ou_use_stop_zone === false ? "off" : `< ${Number(rules.ou_stop_z ?? 3.5).toFixed(2)}`}`
          : "Z high: short SKHY / long KR; Z low: long SKHY / short KR";
      }
      const liveEntryZ = Number(bot?.entry_z ?? 1.4);
      const liveExitZ = Number(bot?.exit_z ?? 0.2);
      const ouControlMap = {
        ou_halflife_max: "lighter_ouHalflifeMax", ou_stop_z: "lighter_ouStopZ",
        ou_min_abs_deviation_pp: "lighter_ouMinDeviation",
        ou_macro_ema_span: "lighter_ouMacroSpan", ou_macro_slope_bars: "lighter_ouMacroSlopeBars",
        ou_use_entry_z: "lighter_ouUseEntryZ", ou_use_halflife: "lighter_ouUseHalflife",
        ou_use_min_abs_deviation: "lighter_ouUseMinDeviation",
        ou_use_macro_trend: "lighter_ouUseMacroTrend", ou_use_stop_zone: "lighter_ouUseStopZone",
        ou_use_exit_z: "lighter_ouUseExitZ",
      };
      Object.entries(ouControlMap).forEach(([key, id]) => {
        const input = $(id);
        const value = bot?.strategy_params?.[key];
        if (!input || input._userModified || value == null) return;
        if (typeof value === "boolean") input.checked = value;
        else input.value = String(value);
      });
      const ouEntryInp = $("lighter_inpOuEntryZ");
      const ouExitInp = $("lighter_inpOuExitZ");
      const ouEntryRange = $("lighter_rangeOuEntryZ");
      const ouExitRange = $("lighter_rangeOuExitZ");
      const ouEntryBadge = $("lighter_valOuEntryZBadge");
      const ouExitBadge = $("lighter_valOuExitZBadge");
      if (ouEntryInp && !ouEntryInp._userModified) {
        ouEntryInp.value = liveEntryZ.toFixed(2);
        if (ouEntryRange) ouEntryRange.value = liveEntryZ.toFixed(2);
        if (ouEntryBadge) ouEntryBadge.textContent = `≥ ${liveEntryZ.toFixed(2)}σ`;
      }
      if (ouExitInp && !ouExitInp._userModified) {
        ouExitInp.value = liveExitZ.toFixed(2);
        if (ouExitRange) ouExitRange.value = liveExitZ.toFixed(2);
        if (ouExitBadge) ouExitBadge.textContent = `≤ ${liveExitZ.toFixed(2)}σ`;
      }
      const configuredAdrNotional = Number(bot?.notional_usd ?? 50);
      const liveRatio = Number(bot?.last_evaluation?.ratio || this.currentRatio || 0);
      const estimatedPairGross = configuredAdrNotional * (1 + (liveRatio > 0 ? 100 / liveRatio : 1));
      writeRule("lighterLiveNotional", configuredAdrNotional.toFixed(0));
      writeRule("lighterLivePairGross", estimatedPairGross.toFixed(2));
      const capacity = bot?.risk_capacity || {};
      writeRule("lighterLiveMaxTranches", `${capacity.active_tranches ?? tranches.length}/${capacity.max_tranches ?? bot?.max_tranches ?? tranches.length} campaign slots`);
      writeRule("lighterLiveMaxSpread", Number(bot?.max_book_spread_bps ?? 45).toFixed(0));
      const cooldownSeconds = Math.max(6, Number(bot?.min_seconds_between_orders ?? 300));
      const tradeRate = Math.max(0.2, Math.min(10, 60 / cooldownSeconds));
      const tradeRateText = this.formatTradeRate(tradeRate);
      writeRule("lighterLiveCooldown", `Current: ${tradeRateText} paired trades/min · ${Math.round(cooldownSeconds)}s minimum · unlock required`);
      writeRule("lighterLiveEvaluation", bot?.last_evaluation
        ? `Z ${Number(bot.last_evaluation.z || 0).toFixed(3)} · ratio ${Number(bot.last_evaluation.ratio || 0).toFixed(3)}% · mean ${Number(bot.last_evaluation.mean || 0).toFixed(3)}%`
        : "Awaiting completed bar");
      const notionalInput = lid("inputOrderNotional");
      if (notionalInput && document.activeElement !== notionalInput) {
        notionalInput.value = String(bot?.notional_usd || 25);
        notionalInput.min = "10"; notionalInput.max = "500"; notionalInput.step = "5";
      }
      const tradeRateInput = lid("inputLiveTradeRate");
      if (tradeRateInput && document.activeElement !== tradeRateInput) {
        tradeRateInput.value = String(Math.round(tradeRate * 5) / 5);
      }
      this.renderTradeRatePreview();

      const liveMinProfitPct = Number(bot?.strategy_params?.min_profit_pct ?? bot?.min_profit_pct ?? 0.10);
      writeRule("lighterLiveMinProfitPctVal", liveMinProfitPct.toFixed(2));
      const minProfitInput = $("lighter_inputLiveMinProfitPct");
      const minProfitDisplay = $("lighterLiveMinProfitPctDisplay");
      const minProfitDesc = $("lighterLiveMinProfitDesc");
      if (minProfitInput && document.activeElement !== minProfitInput) {
        minProfitInput.value = liveMinProfitPct.toFixed(2);
        if (minProfitDisplay) minProfitDisplay.textContent = `${liveMinProfitPct.toFixed(2)}%`;
        const notional = Number(bot?.notional_usd || 25);
        const hurdleUsd = Math.max(0.01, notional * liveMinProfitPct / 100);
        if (minProfitDesc) minProfitDesc.textContent = `Current: ${liveMinProfitPct.toFixed(2)}% notional (~$${hurdleUsd.toFixed(3)} hurdle) · unlock required`;
      }
      this.setText("valDeployedMinProfit", `Min Profit ≥ ${liveMinProfitPct.toFixed(2)}%`);

      this.setText("valDeployedSpeed", `${tradeRateText} paired trades/min (${Math.round(cooldownSeconds)}s minimum)`);
      const engineCondition = lid("rowCondEntryEngine")?.querySelector(".condLabel");
      if (engineCondition) engineCondition.textContent = `9. ${stratName} State & ${tradeRateText}/min Rate Limit`;
      this.setText("valCritRetainedCore", `${tranches.length} tracked pair tranche${tranches.length === 1 ? "" : "s"}`);
      if (bot?.last_error) {
        this.setText("lblHedgedSyncBadge", isEnabled
          ? `BOT ACTIVE · AUTO-RETRYING: ${bot.last_error}`
          : `BOT PAUSED: ${bot.last_error}`);
      }
      this.updateRulesMatchStatus();
      this.updateLeverageMetrics();
    },

    updateLeverageMetrics() {
      const riskCapacity = this.botState?.risk_capacity || {};
      const levCap = Number(riskCapacity.gross_leverage_cap || 8.0);
      let grossNotional = 0;
      let collateral = 187.55;
      let adrQty = 0;
      let domesticQty = 0;
      let adrNotional = 0;
      let domesticNotional = 0;
      let tranchesCount = 0;
      let maxTranches = 8;

      const hasLiveExposure = (this.livePositions || []).some((pos) => Math.abs(Number(pos.position || pos.size || 0)) > 1e-6);
      if (this.mode === "live" || Boolean(this.botState?.enabled) || hasLiveExposure) {
        collateral = this.liveVenue?.collateral != null ? Number(this.liveVenue.collateral) : 187.55;
        const positions = Array.isArray(this.livePositions) ? this.livePositions : [];
        positions.forEach((pos) => {
          const rawSize = Number(pos.position || pos.size || 0);
          const size = Math.abs(rawSize);
          const price = Number(pos.avg_entry_price || pos.entry_price || pos.price || 0);
          const positionValue = Math.abs(Number(pos.position_value || 0));
          const notional = positionValue > 0 ? positionValue : (size * price);
          grossNotional += notional;

          const sym = String(pos.symbol || "").toUpperCase();
          const isAdr = Number(pos.market_id) === 216 || (sym.includes("SKHY") && !sym.includes("USD"));
          if (isAdr) {
            adrQty = size;
            adrNotional = notional;
          } else {
            domesticQty = size;
            domesticNotional = notional;
          }
        });

        const validTranches = (this.botState?.tranches || []).filter((t) => (t.adr_qty > 0 || t.domestic_qty > 0));
        tranchesCount = validTranches.length;
        maxTranches = Number(this.botState?.max_tranches || 8);

        // Fallback to tranche notional if livePositions hasn't returned yet or is zero
        if (grossNotional === 0 && tranchesCount > 0) {
          const singleLeg = Number(this.botState?.notional_usd || 25);
          const ratio = Number(this.botState?.last_evaluation?.ratio || this.currentRatio || 0);
          const pairFactor = 1 + (ratio > 0 ? 100 / ratio : 1);
          grossNotional = tranchesCount * singleLeg * pairFactor;
        }
      } else {
        collateral = 10000.0;
        tranchesCount = this.entries.length;
        maxTranches = 8;
        grossNotional = this.entries.reduce((sum, entry) => sum + (Number(entry.notional) || 0) * 2, 0);
      }

      const grossLev = collateral > 0 ? (grossNotional / collateral) : 0;
      const dynamicCapUsd = collateral * levCap;
      const headroomUsd = Math.max(0, dynamicCapUsd - grossNotional);
      const freeMarginUsd = Number(riskCapacity.available_margin_usd ?? Math.max(0, collateral - (grossNotional / levCap)));
      const hasLeverage = grossLev <= levCap;
      const netDeltaUsd = adrNotional - domesticNotional;
      const netShares = domesticQty - adrQty;
      const loss10 = grossNotional * 0.10 * 0.5;
      const maxDiv = grossNotional > 0 ? ((collateral / grossNotional) * 100) : 999;
      const utilPct = Math.min(100, Math.max(0, (grossLev / levCap) * 100));

      // 1. Gross Leverage Card
      this.setText("valHedgedLeverage", `${grossLev.toFixed(2)}x`);
      const levEl = lid("valHedgedLeverage");
      if (levEl) {
        levEl.style.color = grossLev > levCap ? "#dc2626" : (grossLev > levCap * 0.75 ? "#d97706" : "#0284c7");
      }
      this.setText("valHedgedNotional", `Gross Size: $${grossNotional.toFixed(2)} USDT · Est. ${levCap.toFixed(0)}x Margin: $${(grossNotional / levCap).toFixed(2)}`);
      this.setText("valDeployedMaxLeverage", `${(levCap * 100).toFixed(0)}% (${levCap.toFixed(1)}x account cap)`);
      this.setText("valMarginRisk", `${grossLev.toFixed(2)}x / ${levCap.toFixed(1)}x cap`);

      // 2. Telemetry Cards
      this.setText("valHedgedDelta", `$${Math.abs(netDeltaUsd).toFixed(2)}`);
      this.setText("valHedgedNetDeltaSubtitle", tranchesCount > 0
        ? `Net: ${netShares >= 0 ? "+" : ""}${netShares.toFixed(4)} SKHY eq.`
        : "Dollar Neutral 1:1 Hedge");
      this.setText("valHedgedLoss10", `-$${loss10.toFixed(2)} USDT`);
      this.setText("valHedgedMaxDiv", maxDiv >= 900 ? "+∞ % pts" : `+${maxDiv.toFixed(1)}% pts`);

      // 3. SKHY Shares Exposure Bar
      this.setText("pillAdrShares", `Short Leg: ${adrQty.toFixed(4)} SKHY`);
      this.setText("pillStockShares", `Long Hedge: ${domesticQty.toFixed(4)} SKHY eq.`);
      this.setText("pillNetShares", `Net Delta: ${netShares >= 0 ? "+" : ""}${netShares.toFixed(4)} shares`);

      // 4. Sizing Progress Bar & Utilization
      const capacityBlock = riskCapacity.blocked_reason === "CAMPAIGN_CAPACITY"
        ? ` · ENTRY BLOCKED: ${tranchesCount}/${maxTranches} slot hard cap`
        : "";
      this.setText("lblTranchePct", `${utilPct.toFixed(1)}% (${grossLev.toFixed(2)}x / ${levCap.toFixed(1)}x)${capacityBlock}`);
      const progressBar = lid("barTrancheProgress");
      if (progressBar) {
        progressBar.style.width = `${utilPct.toFixed(1)}%`;
      }

      // 5. Conditions & Criteria Checklist
      this.setText("valCondEntryLeverage", `${grossLev.toFixed(2)}x ≤ ${levCap.toFixed(1)}x`);
      const chkLev = lid("chkCondEntryLeverage");
      if (chkLev) chkLev.checked = hasLeverage;
      const badgeLev = lid("badgeCondEntryLeverage");
      if (badgeLev) {
        badgeLev.textContent = hasLeverage ? "PASS" : "LEV CAP";
        badgeLev.className = hasLeverage ? "condBadge pass" : "condBadge fail";
        badgeLev.style.background = hasLeverage ? "#dcfce7" : "#fee2e2";
        badgeLev.style.color = hasLeverage ? "#166534" : "#dc2626";
      }

      const remCapacity = Math.max(0, maxTranches - tranchesCount);
      const hasCapacity = tranchesCount < maxTranches;
      this.setText("valCondEntryCapacity", `${tranchesCount} / ${maxTranches} (${remCapacity} Left)`);
      const chkCap = lid("chkCondEntryCapacity");
      if (chkCap) chkCap.checked = hasCapacity;
      const badgeCap = lid("badgeCondEntryCapacity");
      if (badgeCap) {
        badgeCap.textContent = hasCapacity ? "PASS" : "MAX CAP";
        badgeCap.className = hasCapacity ? "condBadge pass" : "condBadge fail";
        badgeCap.style.background = hasCapacity ? "#dcfce7" : "#fee2e2";
        badgeCap.style.color = hasCapacity ? "#166534" : "#dc2626";
      }

      const sizingRatio = Number(this.botState?.last_evaluation?.ratio || this.currentRatio || 0);
      const pairFactor = 1 + (sizingRatio > 0 ? 100 / sizingRatio : 1);
      const nextPairGross = Number(riskCapacity.next_tranche_gross_usd || (Number(this.orderNotional() || 25) * pairFactor));
      const reqMarginPerTranche = Number(riskCapacity.required_margin_buffer_usd || Math.max(2.5, (nextPairGross / 10) * 1.25));
      const hasMargin = freeMarginUsd >= reqMarginPerTranche;
      this.setText("valCondEntryMargin", `$${freeMarginUsd.toFixed(2)} ≥ $${reqMarginPerTranche.toFixed(2)}`);
      const chkMargin = lid("chkCondEntryMargin");
      if (chkMargin) chkMargin.checked = hasMargin;
      const badgeMargin = lid("badgeCondEntryMargin");
      if (badgeMargin) {
        badgeMargin.textContent = hasMargin ? "PASS" : "LOW MARGIN";
        badgeMargin.className = hasMargin ? "condBadge pass" : "condBadge fail";
        badgeMargin.style.background = hasMargin ? "#dcfce7" : "#fee2e2";
        badgeMargin.style.color = hasMargin ? "#166534" : "#dc2626";
      }

      // 6. Leverage & Capacity Breakdown Section
      this.setText("valCritGrossLev", `${grossLev.toFixed(2)}x / ${levCap.toFixed(1)}x`);
      this.setText("valCritGrossCap", `$${dynamicCapUsd.toFixed(2)} (${levCap.toFixed(1)}x)`);
      this.setText("valCritGrossHeadroom", `$${headroomUsd.toFixed(2)} free`);
      this.setText("valAvailMargin", `$${freeMarginUsd.toFixed(2)} free`);
    },

    async toggleLiveBot(enabled) {
      const toggle = lid("chkAutoPeriodic48h");
      if (window.terminalLockManager?.isLocked) {
        if (toggle) toggle.checked = !enabled;
        const isKo = window.currentLang === "ko";
        window.showToast?.(
          isKo ? "🔒 읽기 전용 모드에서는 자동 매매 설정을 변경할 수 없습니다." : "🔒 Cannot toggle auto-trading in read-only mode.",
          "warn"
        );
        window.terminalLockManager?.openPasswordModal?.();
        return false;
      }
      try {
        if (enabled) {
          const notional = Math.max(10, Math.min(500, Number(lid("inputOrderNotional")?.value || 25)));
          const tradeRate = this.tradeRatePerMinute();
          const cooldownSeconds = this.cooldownSecondsForTradeRate(tradeRate);
          const confirmed = window.confirm(`Enable REAL 24/7 Lighter trading on EC2?\n\nPair: SKHY / SKHYNIXUSD (no 2x ETF)\nSizing: approximately $${notional.toFixed(0)} on each leg, dollar-neutral, 1x\nMaximum rate: ${this.formatTradeRate(tradeRate)} paired trades/min (${cooldownSeconds}s minimum)\n\nThe bot may place orders after the next closed-bar signal.`);
          if (!confirmed) { if (toggle) toggle.checked = false; return false; }
          await apiPost("/api/lighter/bot/config", { notional_usd: notional, min_seconds_between_orders: cooldownSeconds });
        }
        const data = await apiPost("/api/lighter/bot/toggle", { enabled, confirm_live_trading: enabled });
        if (data?.bot) {
          this.updateBotStatus(data.bot, { execution_enabled: true });
        }
        return Boolean(data?.success);
      } catch (error) {
        if (toggle) toggle.checked = Boolean(this.botState?.enabled);
        window.alert(error.message);
        return false;
      }
    },

    formatTradeRate(rate) {
      const rounded = Math.round(Number(rate) * 5) / 5;
      return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
    },

    tradeRatePerMinute() {
      const input = lid("inputLiveTradeRate");
      const fallback = 60 / Math.max(6, Number(this.botState?.min_seconds_between_orders || 300));
      const raw = Number(input?.value || fallback);
      const rate = Math.max(0.2, Math.min(10, Math.round((Number.isFinite(raw) ? raw : 0.2) * 5) / 5));
      if (input) input.value = String(rate);
      return rate;
    },

    cooldownSecondsForTradeRate(rate) {
      return Math.max(6, Math.round(60 / Math.max(0.2, Number(rate) || 0.2)));
    },

    renderTradeRatePreview() {
      const rate = this.tradeRatePerMinute();
      const output = $("lighterLiveTradeRateValue");
      if (output) output.textContent = `${this.formatTradeRate(rate)}/min`;
    },

    async saveLiveBotRate() {
      if (window.terminalLockManager?.isLocked) {
        window.showToast?.("🔒 Terminal is in read-only mode. Unlock using the slide switch at the top.", "warn");
        window.terminalLockManager?.openPasswordModal?.();
        return false;
      }
      const button = lid("btnSaveLiveCooldown");
      const tradeRate = this.tradeRatePerMinute();
      const cooldownSeconds = this.cooldownSecondsForTradeRate(tradeRate);
      if (button) button.disabled = true;
      try {
        const data = await apiPost("/api/lighter/bot/config", { min_seconds_between_orders: cooldownSeconds });
        if (data?.bot) this.updateBotStatus(data.bot, this.liveVenue || { execution_enabled: true });
        window.showToast?.(`Live bot rate saved: ${this.formatTradeRate(tradeRate)} paired trades/min (${cooldownSeconds}s minimum).`, "success");
        return true;
      } catch (error) {
        window.alert(error.message);
        return false;
      } finally {
        if (button) button.disabled = false;
      }
    },

    renderMinProfitPreview() {
      const input = $("lighter_inputLiveMinProfitPct");
      const output = $("lighterLiveMinProfitPctDisplay");
      if (!input || !output) return;
      const pct = Number(input.value || 0.10);
      output.textContent = `${pct.toFixed(2)}%`;
      const notional = Number(this.botState?.notional_usd || 25);
      const hurdleUsd = Math.max(0.01, notional * pct / 100);
      const desc = $("lighterLiveMinProfitDesc");
      if (desc) {
        desc.textContent = `Target: ${pct.toFixed(2)}% notional (~$${hurdleUsd.toFixed(3)} hurdle) · unlock required`;
      }
    },

    async saveLiveMinProfitPct() {
      if (window.terminalLockManager?.isLocked) {
        window.showToast?.("🔒 Terminal is in read-only mode. Unlock using the slide switch at the top.", "warn");
        window.terminalLockManager?.openPasswordModal?.();
        return false;
      }
      const button = $("lighter_btnSaveLiveMinProfit");
      const input = $("lighter_inputLiveMinProfitPct");
      if (!input) return false;
      const pct = Number(input.value);
      if (!Number.isFinite(pct) || pct < 0 || pct > 5.0) {
        window.showToast?.("Invalid profit percentage (must be between 0.0% and 5.0%)", "warn");
        return false;
      }
      if (button) button.disabled = true;
      try {
        const data = await apiPost("/api/lighter/bot/config", { min_profit_pct: pct });
        if (data?.bot) this.updateBotStatus(data.bot, this.liveVenue || { execution_enabled: true });
        window.showToast?.(`✓ Minimum net profit hurdle set to ${pct.toFixed(2)}%`, "success");
        return true;
      } catch (error) {
        window.alert(error.message);
        return false;
      } finally {
        if (button) button.disabled = false;
      }
    },

    async refreshChart() {
      this.ensureChart();
      const interval = this.interval;
      const request = this.chartRequest = (this.chartRequest || 0) + 1;
      let data;
      try {
        data = await api(`/api/lighter/parity?interval=${interval}&limit=300`);
      } catch (_) {
        data = await api(`/api/trade/short_term_parity?interval=${interval}&limit=120`);
      }
      if (interval !== this.interval || request !== this.chartRequest) return;
      if (!data || !data.success || !data.bars || !data.bars.length) return;
      const range = this.chartInterval === interval
        ? StrategyExecutionChartController.preserveRange(this.chartSync?.getRange() || this.chart.timeScale().getVisibleLogicalRange(), this.bars, data.bars)
        : null;
      this.chartSync?.pause();
      try {
        this.currentRatio = Number(data.bars[data.bars.length - 1].value);
        this.bars = data.bars;
        this.trendRanges = this.calculateTrendRanges(data.bars);
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
            else adrPoints.push({ time: b.time });
            const sVal = b.domestic != null ? b.domestic : b.csop;
            if (sVal != null && Number.isFinite(sVal) && sVal > 0) stockPoints.push({ time: b.time, value: Number(sVal) });
            else stockPoints.push({ time: b.time });
          }
          this.assetSeries.adr.setData(adrPoints);
          if (this.assetSeries?.stock) this.assetSeries.stock.setData(stockPoints);
        }

        [7, 24, 60].forEach((windowSize) => this.maSeries[windowSize].setData(TerminalCommon.movingAverage(data.bars, windowSize)));
        [7, 24, 60].forEach((windowSize) => {
          const value = TerminalCommon.movingAverage(data.bars, windowSize).at(-1)?.value;
          this.setText(`valShortTermMa${windowSize}`, Number.isFinite(value) ? `${value.toFixed(2)}%` : "--%");
        });

        const firstBarTime = Number(data.bars[0]?.time);
        const lastBarTime = Number(data.bars.at(-1)?.time);
        this.actualMarkers = Array.isArray(data.markers) ? data.markers
          .filter((marker) => Number(marker.time) >= firstBarTime && Number(marker.time) <= lastBarTime)
          .map((marker) => {
            const isEntry = marker.is_entry !== false;
            const isShort = marker.direction ? marker.direction === "short" : (isEntry ? (marker.side < 0) : (marker.side > 0));
            const isSell = isShort === isEntry;
            const markerColor = isSell ? "#dc2626" : "#16a34a";
            const markerShape = isEntry ? "arrowRight" : "arrowLeft";
            return {
              time: marker.time,
              position: marker.position || (isSell ? "aboveBar" : "belowBar"),
              color: marker.color || (isSell ? "rgba(220, 38, 38, 0.70)" : "rgba(22, 163, 74, 0.85)"),
              activeColor: marker.activeColor || markerColor,
              shape: markerShape,
              text: "",
              hoverText: marker.hoverText || marker.text || "Actual",
              source: "actual",
              hypothetical: false,
              is_entry: isEntry,
              is_exit: !isEntry,
              direction: isShort ? "short" : "long",
              entry_price: marker.entry_price || marker.ratio || marker.value,
              exit_price: marker.exit_price || (isEntry ? null : (marker.ratio || marker.value)),
              ratio: marker.ratio || marker.value,
              pnl: marker.pnl,
              pnl_pct: marker.pnl_pct,
              pairKey: marker.pairKey || null,
            };
          }) : [];
        this.renderMarkers();
        this.renderCurrentPositionReferenceLines();
        const viewport = range || StrategyExecutionChartController.initialRange(data.bars.length);
        if (this.chartSync) this.chartSync.setRange(viewport);
        else this.chart.timeScale().setVisibleLogicalRange(viewport);
        this.chartInterval = interval;
        window.requestAnimationFrame(() => this.renderTrendRanges());
        this.setText("valShortTermCurrentParity", `${this.currentRatio.toFixed(3)}%`);
        ["1m", "5m", "15m", "1h", "4h", "1d"].forEach((value) => {
          const button = lid(`btnShortInterval${value}`);
          if (button) button.classList.toggle("active", value === this.interval);
        });
        this.updateGridLadderData();
      } finally { this.chartSync?.resume(); }
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
      this.selectedExecutionMarkerTime = null;
      this.selectedExecutionMarkerKey = null;
      this.selectedPairKey = null;
      this.updateMarkerState(null);
      this.renderTradeTriangles();
    },

    executionMarkersAtTime(time) {
      if (time == null) return [];
      return (this.rawExecutionMarkers || [])
        .filter((marker) => marker.time === time && this.isTradeMarkerVisible(marker));
    },

    selectedExecutionMarker() {
      if (!this.selectedExecutionMarkerKey) return null;
      return (this.rawExecutionMarkers || [])
        .find((marker) => marker.markerKey === this.selectedExecutionMarkerKey && this.isTradeMarkerVisible(marker)) || null;
    },

    selectExecutionMarker(marker) {
      if (!marker) return;
      this.selectedExecutionMarkerTime = marker.time;
      this.selectedExecutionMarkerKey = marker.markerKey;
      this.selectedPairKey = marker.pairKey || null;
      this.updateMarkerState(marker.time);
      this.renderTradeMarkerTargets();
      this.renderTradeTriangles();
    },

    updateMarkerState(hoveredTime = null, exactMarker = null) {
      if (!this.series) return;
      const activeMarker = exactMarker
        || (this.activeHoveredExecutionMarkerKey
          ? (this.rawExecutionMarkers || []).find((marker) => marker.markerKey === this.activeHoveredExecutionMarkerKey)
          : null)
        || this.selectedExecutionMarker();
      if (this.executionChartController) {
        // DOM markers are the single visual and interaction surface. Keeping a
        // second canvas marker underneath makes per-trade hover impossible.
        this.series.setMarkers([]);
        this.syncHoveredMarkerDetails(hoveredTime, activeMarker);
        this.updateTradeHoverOverlay(hoveredTime, activeMarker);
      } else {
        this.series.setMarkers([]);
        this.updateTradeHoverOverlay(hoveredTime, activeMarker);
      }
    },

    updateTradeHoverOverlay(hoveredTime = null, exactMarker = null) {
      const overlay = lid("tradeMarkerHover");
      if (!overlay) return;
      const marker = exactMarker || null;
      if (!marker) {
        overlay.style.display = "none";
        overlay.textContent = "";
        return;
      }
      const isExit = !this.isTradeEntry(marker);
      if (isExit) {
        const tradePairs = this.getTradePairs();
        const isShort = this.isShortTrade(marker);
        const matchedPairs = tradePairs.filter((p) =>
          p.exit.markerKey === marker.markerKey
          || (!this.activeHoveredExecutionMarkerKey && p.exit.time === marker.time && this.isShortTrade(p.exit) === isShort)
        );
        if (matchedPairs.length > 1) {
          let totalPnl = 0;
          let hasPnl = false;
          matchedPairs.forEach((p) => {
            const pnlVal = p.exit.pnl ?? p.entry.pnl;
            if (pnlVal != null && Number.isFinite(pnlVal)) {
              totalPnl += pnlVal;
              hasPnl = true;
            }
          });
          const dirLabel = isShort ? "SHORT CAMPAIGN" : "LONG CAMPAIGN";
          const exitPrice = Number(marker.ratio ?? marker.exit_price ?? marker.entry_price);
          const isProfit = totalPnl >= 0;
          const pnlText = hasPnl ? `${isProfit ? "+" : ""}$${totalPnl.toFixed(2)}` : "";
          const timeText = formatKstDateTime(Number(marker.time) * 1000, false);
          const source = marker.source === "actual" ? "ACTUAL" : (marker.backtest ? "BACKTEST" : "PAPER");

          const trancheRows = matchedPairs.map((p, idx) => {
            const ep = Number(p.entry.ratio ?? p.entry.entry_price);
            const pnlVal = p.exit.pnl ?? p.entry.pnl;
            const pnlStr = (pnlVal != null && Number.isFinite(pnlVal))
              ? ` · <span style="color:${pnlVal >= 0 ? '#16a34a' : '#dc2626'}">${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}</span>`
              : "";
            const returnPct = (Number.isFinite(ep) && Number.isFinite(exitPrice) && ep > 0)
              ? (isShort ? (ep - exitPrice) / ep * 100 : (exitPrice - ep) / ep * 100)
              : null;
            const retStr = returnPct != null ? ` (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)` : "";
            return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:10px;font-weight:700;padding:1px 0;">
              <span>#${idx + 1} Entry @ ${ep.toFixed(2)}%</span>
              <span>${retStr}${pnlStr}</span>
            </div>`;
          }).join("");

          overlay.innerHTML = `
            <div style="font-weight:900;font-size:11px;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0;padding-bottom:3px;">
              <span>🏁 ${source} · ${dirLabel} EXIT (${matchedPairs.length} Tranches)</span>
              ${pnlText ? `<span style="color:${isProfit ? '#16a34a' : '#dc2626'};font-weight:900;">${pnlText}</span>` : ""}
            </div>
            <div style="display:flex;flex-direction:column;gap:1px;margin-bottom:3px;">
              ${trancheRows}
            </div>
            <div style="font-size:9.5px;color:#64748b;font-weight:700;display:flex;justify-content:space-between;">
              <span>Exit Price: ${exitPrice.toFixed(2)}%</span>
              <span>${timeText}</span>
            </div>
          `;
          overlay.style.display = "block";
          overlay.style.borderColor = isProfit ? "#86efac" : "#fca5a5";
          overlay.style.color = "#0f172a";
          return;
        }
      }

      const source = marker.source === "actual" ? "ACTUAL" : (marker.backtest ? "BACKTEST" : "PAPER");
      const siblings = this.executionMarkersAtTime(marker.time);
      const timeText = formatKstDateTime(Number(marker.time) * 1000, false);
      const markerColor = this.tradeMarkerColor(marker);

      if (siblings.length > 1) {
        const isShort = this.isShortTrade(marker);
        const dirLabel = isShort ? "SHORT" : "LONG";
        const prices = siblings.map((m) => Number(m.ratio ?? m.entry_price ?? m.exit_price)).filter(Number.isFinite);
        const minP = prices.length ? Math.min(...prices) : Number(marker.ratio ?? marker.entry_price ?? marker.exit_price);
        const maxP = prices.length ? Math.max(...prices) : minP;
        const avgP = prices.length ? prices.reduce((s, v) => s + v, 0) / prices.length : minP;
        const entryCount = siblings.filter((m) => this.isTradeEntry(m)).length;
        const exitCount = siblings.length - entryCount;
        const rangeText = (minP === maxP) ? `${avgP.toFixed(2)}%` : `${minP.toFixed(2)}% – ${maxP.toFixed(2)}%`;

        const rows = siblings.map((m, idx) => {
          const p = Number(m.ratio ?? m.entry_price ?? m.exit_price);
          const notional = m.notional ? ` · $${m.notional.toFixed(0)}` : "";
          const pnlVal = m.pnl;
          const pnlStr = (pnlVal != null && Number.isFinite(pnlVal))
            ? ` · <span style="color:${pnlVal >= 0 ? '#16a34a' : '#dc2626'}">${pnlVal >= 0 ? '+' : ''}$${pnlVal.toFixed(2)}</span>`
            : "";
          const action = this.isTradeEntry(m) ? (isShort ? "SHORT" : "BUY") : (isShort ? "COVER" : "SELL");
          return `<div style="display:flex;justify-content:space-between;gap:8px;font-size:10px;font-weight:700;padding:1px 0;">
            <span>#${idx + 1} ${action} @ ${p.toFixed(2)}%${notional}</span>
            <span>${pnlStr}</span>
          </div>`;
        }).join("");

        overlay.innerHTML = `
          <div style="font-weight:900;font-size:11px;margin-bottom:4px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid #e2e8f0;padding-bottom:3px;">
            <span>🏁 ${source} · ${dirLabel} (${siblings.length} Fills)</span>
            <span style="font-weight:900;">${rangeText}</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:1px;margin-bottom:3px;">
            ${rows}
          </div>
          <div style="font-size:9.5px;color:#64748b;font-weight:700;display:flex;justify-content:space-between;">
            <span>${timeText}</span>
            <span>${entryCount ? entryCount + ' entries' : ''}${entryCount && exitCount ? ' / ' : ''}${exitCount ? exitCount + ' exits' : ''}</span>
          </div>
        `;
        overlay.style.display = "block";
        overlay.style.borderColor = markerColor === "#dc2626" ? "#fca5a5" : "#86efac";
        overlay.style.color = "#0f172a";
        return;
      }

      const ordinal = siblings.findIndex((candidate) => candidate.markerKey === marker.markerKey) + 1;
      const position = siblings.length > 1 ? ` · trade ${ordinal}/${siblings.length}` : "";
      overlay.textContent = `${source}${position} · ${marker.hoverText || "Trade"} · ${timeText}`;
      overlay.style.display = "block";
      overlay.style.borderColor = markerColor === "#dc2626" ? "#fca5a5" : "#86efac";
      overlay.style.color = markerColor === "#dc2626" ? "#991b1b" : "#166534";
    },

    isTradeEntry(marker) {
      return marker?.is_entry !== false && marker?.is_exit !== true;
    },

    isShortTrade(marker) {
      if (marker?.direction) return marker.direction === "short";
      if (typeof marker?.side === "number") {
        return this.isTradeEntry(marker) ? marker.side < 0 : marker.side > 0;
      }
      const text = `${marker?.hoverText || ""} ${marker?.text || ""}`.toUpperCase();
      if (text.includes("SHORT") || text.includes("COVER")) return true;
      return false;
    },

    isTradeSell(marker) {
      const isShort = this.isShortTrade(marker);
      const isEntry = this.isTradeEntry(marker);
      // For Short position: entry is Sell (short), exit is Buy (cover).
      // For Long position: entry is Buy (long), exit is Sell.
      // Therefore, the trade itself is a SELL if: (isShort && isEntry) || (!isShort && !isEntry)
      return isShort === isEntry;
    },

    tradeMarkerColor(marker) {
      // Color according to the direction of the trade itself:
      // Sell = Red (#dc2626), Buy = Green (#16a34a)
      return this.isTradeSell(marker) ? "#dc2626" : "#16a34a";
    },

    tradeMarkerGlyph(marker) {
      const isEntry = this.isTradeEntry(marker);
      if (marker?.hypothetical) {
        return isEntry ? "▷" : "◁";
      }
      return isEntry ? "▶" : "◀";
    },

    getTradePairs() {
      const visible = (this.rawExecutionMarkers || []).filter((m) => this.isTradeMarkerVisible(m));
      if (!visible.length) return [];

      const pairMap = new Map();
      visible.forEach((marker) => {
        const key = marker.pairKey;
        if (!key) return;
        const p = pairMap.get(key) || { entries: [], exits: [] };
        if (this.isTradeEntry(marker)) {
          p.entries.push(marker);
        } else {
          p.exits.push(marker);
        }
        pairMap.set(key, p);
      });

      const tradePairs = [];
      pairMap.forEach((p, pairKey) => {
        if (p.entries.length && p.exits.length) {
          if (p.entries.length === 1 && p.exits.length === 1) {
            tradePairs.push({ entry: p.entries[0], exit: p.exits[0], pairKey });
          } else {
            // Map entries 1-to-1 to each corresponding exit
            for (let i = 0; i < p.entries.length; i++) {
              const entry = p.entries[i];
              const exit = p.exits[i] || p.exits[p.exits.length - 1];
              tradePairs.push({ entry, exit, pairKey });
            }
          }
        }
      });
      return tradePairs;
    },

    renderTradeMarkerTargets() {
      const layer = lid("tradeMarkerTargets");
      if (!layer || !this.chart || !this.series) return;
      const layerWidth = this.alignChartOverlay(layer);
      const layerHeight = layer.clientHeight || 420;
      layer.textContent = "";
      const fragment = document.createDocumentFragment();
      const tradePairs = this.getTradePairs();
      const exitPairsMap = new Map();
      const entryPairsMap = new Map();
      tradePairs.forEach((p) => {
        if (p.exit?.markerKey) {
          const list = exitPairsMap.get(p.exit.markerKey) || [];
          list.push(p);
          exitPairsMap.set(p.exit.markerKey, list);
        }
        if (p.entry?.markerKey) {
          const list = entryPairsMap.get(p.entry.markerKey) || [];
          list.push(p);
          entryPairsMap.set(p.entry.markerKey, list);
        }
      });
      const targetsByPair = new Map();
      const targetsByMarkerKey = new Map();
      const visible = (this.rawExecutionMarkers || []).filter((marker) => this.isTradeMarkerVisible(marker));
      const groups = new Map();
      visible.forEach((marker) => {
        const group = groups.get(marker.time) || [];
        group.push(marker);
        groups.set(marker.time, group);
      });
      groups.forEach((markers) => {
        const markerTime = markers[0]?.time;
        const x = this.chart.timeScale().timeToCoordinate(markerTime);
        if (!Number.isFinite(x) || x < -30 || x > layerWidth + 30) {
          markers.forEach((marker) => {
            marker._targetX = Number.isFinite(x) ? x : null;
            marker._targetY = null;
          });
          return;
        }
        const denseGroup = this.groupTradesAsRange && markers.length > 1;
        if (denseGroup) {
          const pricedMarkers = markers.map((marker) => ({
            marker,
            price: Number(marker.ratio ?? marker.entry_price ?? marker.exit_price),
          })).filter((item) => Number.isFinite(item.price));
          if (pricedMarkers.length) {
            const prices = pricedMarkers.map((item) => item.price);
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);
            const avgPrice = prices.reduce((sum, value) => sum + value, 0) / prices.length;
            let topY = this.series.priceToCoordinate(maxPrice);
            let bottomY = this.series.priceToCoordinate(minPrice);
            let avgY = this.series.priceToCoordinate(avgPrice);
            topY = Math.max(8, Math.min(layerHeight - 8, Number(topY)));
            bottomY = Math.max(8, Math.min(layerHeight - 8, Number(bottomY)));
            avgY = Math.max(Math.min(topY, bottomY), Math.min(Math.max(topY, bottomY), Number(avgY)));
            let visualTop = Math.min(topY, bottomY);
            let visualBottom = Math.max(topY, bottomY);
            if (visualBottom - visualTop < 6) {
              visualTop = Math.max(6, avgY - 4);
              visualBottom = Math.min(layerHeight - 6, avgY + 4);
            }
            const buttonTop = Math.max(0, visualTop - 6);
            const buttonBottom = Math.min(layerHeight, visualBottom + 6);
            const svgHeight = Math.max(16, buttonBottom - buttonTop);
            const topLocal = visualTop - buttonTop;
            const bottomLocal = visualBottom - buttonTop;
            const avgLocal = avgY - buttonTop;

            const sellCount = markers.filter((m) => this.isTradeSell(m)).length;
            const buyCount = markers.length - sellCount;
            const entryCount = markers.filter((m) => this.isTradeEntry(m)).length;
            const exitCount = markers.length - entryCount;

            const dominantSell = sellCount >= buyCount;
            const dominantEntry = entryCount >= exitCount;
            const markerColor = dominantSell ? "#dc2626" : "#16a34a";

            const range = document.createElement("button");
            range.type = "button";
            range.setAttribute("aria-label", `${markers.length} grouped trades; range ${minPrice.toFixed(3)} to ${maxPrice.toFixed(3)} percent; average ${avgPrice.toFixed(3)} percent`);

            if (dominantEntry) {
              range.style.cssText = `appearance:none;position:absolute;left:${x - 14}px;top:${buttonTop}px;width:16px;height:${svgHeight}px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;z-index:2;overflow:visible`;
              range.innerHTML = `<svg width="16" height="${svgHeight}" viewBox="0 0 16 ${svgHeight}" style="display:block;overflow:visible;pointer-events:none">
                <line x1="14" y1="${topLocal}" x2="14" y2="${bottomLocal}" stroke="${markerColor}" stroke-width="1" stroke-linecap="round"/>
                <polygon points="7,${avgLocal - 4} 14,${avgLocal} 7,${avgLocal + 4}" fill="${markerColor}" stroke="${markerColor}" stroke-width="0.75" stroke-linejoin="round"/>
              </svg>`;
            } else {
              range.style.cssText = `appearance:none;position:absolute;left:${x - 2}px;top:${buttonTop}px;width:16px;height:${svgHeight}px;padding:0;border:0;background:transparent;cursor:pointer;pointer-events:auto;z-index:2;overflow:visible`;
              range.innerHTML = `<svg width="16" height="${svgHeight}" viewBox="0 0 16 ${svgHeight}" style="display:block;overflow:visible;pointer-events:none">
                <line x1="2" y1="${topLocal}" x2="2" y2="${bottomLocal}" stroke="${markerColor}" stroke-width="1" stroke-linecap="round"/>
                <polygon points="9,${avgLocal - 4} 2,${avgLocal} 9,${avgLocal + 4}" fill="${markerColor}" stroke="${markerColor}" stroke-width="0.75" stroke-linejoin="round"/>
              </svg>`;
            }

            markers.forEach((marker) => {
              marker._targetX = x;
              marker._targetY = avgY;
              targetsByMarkerKey.set(marker.markerKey, range);
              const pairKey = marker.pairKey || marker.markerKey;
              const pairTargets = targetsByPair.get(pairKey) || [];
              pairTargets.push(range);
              targetsByPair.set(pairKey, pairTargets);
            });

            range.addEventListener("mouseenter", () => {
              range._blinkAnimation?.cancel();
              range._blinkAnimation = range.animate(
                [{ opacity: 1 }, { opacity: 0.12 }, { opacity: 1 }],
                { duration: 650, iterations: Infinity, easing: "ease-in-out" }
              );

              // Find and blink all opposite paired targets
              const relatedTargets = [];
              markers.forEach((marker) => {
                const isEntry = this.isTradeEntry(marker);
                if (!isEntry) {
                  const matched = exitPairsMap.get(marker.markerKey) || [];
                  matched.forEach((p) => {
                    const et = targetsByMarkerKey.get(p.entry.markerKey);
                    if (et && et !== range) relatedTargets.push(et);
                  });
                } else {
                  const matched = entryPairsMap.get(marker.markerKey) || [];
                  matched.forEach((p) => {
                    const xt = targetsByMarkerKey.get(p.exit.markerKey);
                    if (xt && xt !== range) relatedTargets.push(xt);
                  });
                }
                const pairTargets = targetsByPair.get(marker.pairKey || marker.markerKey) || [];
                pairTargets.forEach((pt) => { if (pt !== range) relatedTargets.push(pt); });
              });

              new Set(relatedTargets).forEach((targetEl) => {
                targetEl._blinkAnimation?.cancel();
                targetEl._blinkAnimation = targetEl.animate(
                  [{ opacity: 1 }, { opacity: 0.12 }, { opacity: 1 }],
                  { duration: 650, iterations: Infinity, easing: "ease-in-out" }
                );
              });

              this.activeHoveredExecutionMarkerTime = markerTime;
              this.activeHoveredExecutionMarkerKey = markers[0].markerKey;
              this.activeHoveredPairKey = markers[0].pairKey || markers[0].markerKey;
              this.updateMarkerState(markerTime, markers[0]);
              this.renderTradeTriangles();
            });

            range.addEventListener("mouseleave", () => {
              range._blinkAnimation?.cancel();
              range._blinkAnimation = null;

              markers.forEach((marker) => {
                const isEntry = this.isTradeEntry(marker);
                if (!isEntry) {
                  const matched = exitPairsMap.get(marker.markerKey) || [];
                  matched.forEach((p) => {
                    const et = targetsByMarkerKey.get(p.entry.markerKey);
                    if (et) { et._blinkAnimation?.cancel(); et._blinkAnimation = null; }
                  });
                } else {
                  const matched = entryPairsMap.get(marker.markerKey) || [];
                  matched.forEach((p) => {
                    const xt = targetsByMarkerKey.get(p.exit.markerKey);
                    if (xt) { xt._blinkAnimation?.cancel(); xt._blinkAnimation = null; }
                  });
                }
              });

              this.activeHoveredExecutionMarkerTime = null;
              this.activeHoveredExecutionMarkerKey = null;
              this.activeHoveredPairKey = null;
              this.updateMarkerState(this.selectedExecutionMarkerTime, this.selectedExecutionMarker());
              this.renderTradeTriangles();
            });

            range.addEventListener("click", (event) => {
              event.stopPropagation();
              this.selectExecutionMarker(markers[0]);
            });

            fragment.appendChild(range);
          }
          return;
        }
        markers.forEach((marker, index) => {
          const price = Number(marker.ratio ?? marker.entry_price ?? marker.exit_price);
          let y = Number.isFinite(price) ? this.series.priceToCoordinate(price) : null;
          if (!Number.isFinite(y)) y = marker.position === "aboveBar" ? 54 : Math.max(80, layerHeight - 54);
          // Individual trade markers are stacked vertically on the exact candle timestamp x
          const finalX = x;
          const finalY = Math.max(6, Math.min(Math.max(6, layerHeight - 6), y));
          marker._targetX = finalX;
          marker._targetY = finalY;

          const isEntry = this.isTradeEntry(marker);
          const isShort = this.isShortTrade(marker);
          const markerColor = this.tradeMarkerColor(marker);
          const glyph = this.tradeMarkerGlyph(marker);
          const baseOpacity = marker.hypothetical ? 0.65 : 0.90;
          const isHypo = Boolean(marker.hypothetical);
          const fill = isHypo ? "transparent" : markerColor;

          const target = document.createElement("button");
          target.type = "button";
          target.setAttribute("aria-label", `${glyph} ${marker.hoverText || "Trade"}, ${index + 1} of ${markers.length}`);

          // Entry: points left to right (▶).
          // SVG viewBox 0 0 8 8, polygon points="0.5,0.5 7.5,4 0.5,7.5".
          // Tip is at (7.5, 4). Position button at left: finalX, top: finalY, translate(-100%, -50%).
          // The rightmost tip aligns exactly to (finalX, finalY).
          // Exit: points right to left (◀).
          // SVG viewBox 0 0 8 8, polygon points="7.5,0.5 0.5,4 7.5,7.5".
          // Tip is at (0.5, 4). Position button at left: finalX, top: finalY, translate(0, -50%).
          // The leftmost tip aligns exactly to (finalX, finalY).
          if (isEntry) {
            target.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" style="display:block;overflow:visible;pointer-events:none;"><polygon points="0.5,0.5 7.5,4 0.5,7.5" fill="${fill}" stroke="${markerColor}" stroke-width="0.75" stroke-linejoin="round"/></svg>`;
            target.style.cssText = `appearance:none;position:absolute;left:${finalX}px;top:${finalY}px;transform:translate(-100%,-50%);width:8px;height:8px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;opacity:${baseOpacity};cursor:pointer;pointer-events:auto`;
          } else {
            target.innerHTML = `<svg width="8" height="8" viewBox="0 0 8 8" style="display:block;overflow:visible;pointer-events:none;"><polygon points="7.5,0.5 0.5,4 7.5,7.5" fill="${fill}" stroke="${markerColor}" stroke-width="0.75" stroke-linejoin="round"/></svg>`;
            target.style.cssText = `appearance:none;position:absolute;left:${finalX}px;top:${finalY}px;transform:translate(0,-50%);width:8px;height:8px;padding:0;border:0;background:transparent;display:flex;align-items:center;justify-content:center;opacity:${baseOpacity};cursor:pointer;pointer-events:auto`;
          }

          const pairKey = marker.pairKey || marker.markerKey;
          const pairTargets = targetsByPair.get(pairKey) || [];
          pairTargets.push(target);
          targetsByPair.set(pairKey, pairTargets);
          targetsByMarkerKey.set(marker.markerKey, target);

          target.addEventListener("mouseenter", () => {
            const relatedTargets = [];
            if (!isEntry) {
              const matched = tradePairs.filter((p) => p.exit.markerKey === marker.markerKey);
              matched.forEach((p) => {
                const et = targetsByMarkerKey.get(p.entry.markerKey);
                if (et) relatedTargets.push(et);
              });
            } else {
              const matched = tradePairs.filter((p) => p.entry.markerKey === marker.markerKey);
              matched.forEach((p) => {
                const xt = targetsByMarkerKey.get(p.exit.markerKey);
                if (xt) relatedTargets.push(xt);
              });
            }
            const allTargets = [target, ...relatedTargets];
            new Set(allTargets).forEach((pairTarget) => {
              pairTarget._blinkAnimation?.cancel();
              pairTarget._blinkAnimation = pairTarget.animate(
                [{ opacity: 1 }, { opacity: 0.12 }, { opacity: 1 }],
                { duration: 650, iterations: Infinity, easing: "ease-in-out" }
              );
            });
            this.activeHoveredExecutionMarkerTime = marker.time;
            this.activeHoveredExecutionMarkerKey = marker.markerKey;
            this.activeHoveredPairKey = pairKey;
            this.updateMarkerState(marker.time, marker);
            this.renderTradeTriangles();
          });
          target.addEventListener("mouseleave", () => {
            const relatedTargets = [];
            if (!isEntry) {
              const matched = exitPairsMap.get(marker.markerKey) || [];
              matched.forEach((p) => {
                const et = targetsByMarkerKey.get(p.entry.markerKey);
                if (et) relatedTargets.push(et);
              });
            } else {
              const matched = entryPairsMap.get(marker.markerKey) || [];
              matched.forEach((p) => {
                const xt = targetsByMarkerKey.get(p.exit.markerKey);
                if (xt) relatedTargets.push(xt);
              });
            }
            const allTargets = [target, ...relatedTargets];
            new Set(allTargets).forEach((pairTarget) => {
              pairTarget._blinkAnimation?.cancel();
              pairTarget._blinkAnimation = null;
            });
            this.activeHoveredExecutionMarkerTime = null;
            this.activeHoveredExecutionMarkerKey = null;
            this.activeHoveredPairKey = null;
            this.updateMarkerState(this.selectedExecutionMarkerTime, this.selectedExecutionMarker());
            this.renderTradeTriangles();
          });
          target.addEventListener("click", (event) => {
            event.stopPropagation();
            this.selectExecutionMarker(marker);
          });
          fragment.appendChild(target);
        });
      });
      layer.appendChild(fragment);
      this.renderTradeTriangles();
    },

    renderTradeTriangles() {
      const svg = lid("tradeTrianglesLayer");
      if (!svg || !this.chart || !this.series) return;
      this.alignChartOverlay(svg);
      svg.innerHTML = "";

      // Triangles and diagonal connectors should show ONLY on hover (or selection)
      const hasActive = Boolean(
        this.activeHoveredPairKey
        || this.activeHoveredExecutionMarkerKey
        || this.selectedPairKey
        || this.selectedExecutionMarkerKey
      );
      if (!hasActive) return;

      const tradePairs = this.getTradePairs();
      if (!tradePairs.length) return;

      const visible = (this.rawExecutionMarkers || []).filter((m) => this.isTradeMarkerVisible(m));
      const hoveredMarker = this.activeHoveredExecutionMarkerKey
        ? visible.find((m) => m.markerKey === this.activeHoveredExecutionMarkerKey)
        : (this.activeHoveredExecutionMarkerTime
            ? visible.find((m) => m.time === this.activeHoveredExecutionMarkerTime)
            : null);
      const selectedMarker = this.selectedExecutionMarker();

      const isHoveredExit = Boolean(hoveredMarker && !this.isTradeEntry(hoveredMarker));
      const isSelectedExit = Boolean(selectedMarker && !this.isTradeEntry(selectedMarker));

      const fragment = document.createDocumentFragment();

      tradePairs.forEach((pair) => {
        const { entry, exit, pairKey } = pair;
        if (!entry || !exit) return;

        const isExitHovered = isHoveredExit && (
          exit.markerKey === hoveredMarker.markerKey
          || (!this.activeHoveredExecutionMarkerKey && exit.time === hoveredMarker.time && this.isShortTrade(exit) === this.isShortTrade(hoveredMarker))
        );
        const isEntryHovered = !isHoveredExit && hoveredMarker && (
          entry.markerKey === hoveredMarker.markerKey
          || (!this.activeHoveredExecutionMarkerKey && entry.time === hoveredMarker.time && this.isShortTrade(entry) === this.isShortTrade(hoveredMarker))
        );

        const isExitSelected = isSelectedExit && (
          exit.markerKey === selectedMarker.markerKey
          || (!this.selectedExecutionMarkerKey && exit.time === selectedMarker.time && this.isShortTrade(exit) === this.isShortTrade(selectedMarker))
        );
        const isEntrySelected = !isSelectedExit && selectedMarker && (
          entry.markerKey === selectedMarker.markerKey
          || (!this.selectedExecutionMarkerKey && entry.time === selectedMarker.time && this.isShortTrade(entry) === this.isShortTrade(selectedMarker))
        );

        const isPairHovered = Boolean(!this.activeHoveredExecutionMarkerKey && this.activeHoveredPairKey && pairKey === this.activeHoveredPairKey);
        const isPairSelected = Boolean(!this.selectedExecutionMarkerKey && this.selectedPairKey && pairKey === this.selectedPairKey);

        const isHovered = isExitHovered || isEntryHovered || isPairHovered;
        const isSelected = isExitSelected || isEntrySelected || isPairSelected;
        if (!isHovered && !isSelected) return;

        const p1 = Number(entry.ratio ?? entry.entry_price);
        const p2 = Number(exit.ratio ?? exit.exit_price);
        if (!Number.isFinite(p1) || !Number.isFinite(p2) || p1 <= 0 || p2 <= 0) return;

        let x1 = entry._targetX ?? this.chart.timeScale().timeToCoordinate(entry.time);
        let x2 = exit._targetX ?? this.chart.timeScale().timeToCoordinate(exit.time);
        if (!Number.isFinite(x1) || !Number.isFinite(x2)) return;

        let y1 = this.series.priceToCoordinate(p1);
        if (!Number.isFinite(y1)) y1 = entry._targetY;
        let y2 = this.series.priceToCoordinate(p2);
        if (!Number.isFinite(y2)) y2 = exit._targetY;
        if (!Number.isFinite(y1) || !Number.isFinite(y2)) return;

        if (Math.abs(x1 - x2) < 1) return;

        const isShort = this.isShortTrade(entry);

        const origX1 = x1, origY1 = y1;
        const origX2 = x2, origY2 = y2;
        if (x1 > x2) {
          const tx = x1; x1 = x2; x2 = tx;
          const ty = y1; y1 = y2; y2 = ty;
        }

        // Invariant: Buy price lower than Sell close is ALWAYS Profit (Green).
        // For Long: p2 (sell) >= p1 (buy). For Short: p1 (sell) >= p2 (buy).
        const isProfit = isShort ? (p1 >= p2) : (p2 >= p1);

        let cornerX;
        let cornerY;
        if (isShort) {
          // If entry by short, ALWAYS the UPPER triangle of the rectangle
          if (y1 <= y2) {
            cornerX = x2;
            cornerY = y1;
          } else {
            cornerX = x1;
            cornerY = y2;
          }
        } else {
          // If entry by long, ALWAYS the LOWER triangle of the rectangle
          if (y1 <= y2) {
            cornerX = x1;
            cornerY = y2;
          } else {
            cornerX = x2;
            cornerY = y1;
          }
        }
        const pts = `${x1.toFixed(1)},${y1.toFixed(1)} ${cornerX.toFixed(1)},${cornerY.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;

        const fillColor = isProfit ? "rgba(34, 197, 94, 0.12)" : "rgba(239, 68, 68, 0.12)";
        const strokeColor = isProfit ? "rgba(22, 163, 74, 0.65)" : "rgba(220, 38, 38, 0.65)";
        const diagStroke = isProfit ? "#16a34a" : "#dc2626";

        const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        polygon.setAttribute("points", pts);
        polygon.setAttribute("fill", fillColor);
        polygon.setAttribute("stroke", strokeColor);
        polygon.setAttribute("stroke-width", "1");
        polygon.style.transition = "fill 0.15s ease, stroke 0.15s ease";
        fragment.appendChild(polygon);

        const diag = document.createElementNS("http://www.w3.org/2000/svg", "line");
        diag.setAttribute("x1", origX1.toFixed(1));
        diag.setAttribute("y1", origY1.toFixed(1));
        diag.setAttribute("x2", origX2.toFixed(1));
        diag.setAttribute("y2", origY2.toFixed(1));
        diag.setAttribute("stroke", diagStroke);
        diag.setAttribute("stroke-width", "1");
        diag.style.transition = "stroke-width 0.15s ease, stroke 0.15s ease";
        fragment.appendChild(diag);
      });

      svg.appendChild(fragment);
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
        lineWidth: 1,
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
            isLong: lastMarker.direction ? lastMarker.direction === "long" : lastMarker.shape === "arrowUp"
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

    syncHoveredMarkerDetails(activeTime = null, selectedMarker = null) {
      const pnlEl = lid("valShortTermNetPnl");
      const profitEl = lid("valSelectedMinProfit");
      if (!activeTime || !selectedMarker) {
        if (pnlEl) pnlEl.textContent = "--";
        if (profitEl) profitEl.textContent = "—";
        this.renderCurrentPositionReferenceLines();
        return;
      }
      const marker = selectedMarker && selectedMarker.time === activeTime ? selectedMarker : null;
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
          isLong: marker.direction === "long"
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

    orderNotional() { return Math.max(10, Math.min(500, Number(lid("inputOrderNotional")?.value || 25))); },
    virtualPnl() { return this.entries.reduce((sum, entry) => sum + (this.currentRatio == null ? 0 : entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio), 0); },
    virtualPnlText() { const pnl = this.virtualPnl(); return `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`; },

    async setMode(mode) {
      if (!['paper', 'semi_auto', 'live'].includes(mode)) return;
      const botEnabled = Boolean(this.botState?.enabled);
      const needsBotWrite = (mode === "live" && !botEnabled)
        || (mode !== "live" && (botEnabled || this.mode === "live"));
      if (needsBotWrite && window.terminalLockManager?.isLocked) {
        const isKo = window.currentLang === "ko";
        window.showToast?.(
          isKo ? "🔒 거래 터미널이 읽기 전용 모드입니다. 상단 스위치로 잠금을 해제하세요." : "🔒 Execution terminal is in read-only mode. Unlock using the slide switch at the top.",
          "warn"
        );
        return;
      }
      if (mode === "live" && !botEnabled) {
        if (!await this.toggleLiveBot(true)) return;
      } else if (mode !== "live" && (botEnabled || this.mode === "live")) {
        if (!await this.toggleLiveBot(false)) return;
      }
      this.mode = mode;
      safeStorage.setItem("skhynix_lighter_mode", mode);
      this.applyMode(mode, true);
    },

    applyMode(mode, showNotification = true) {
      const paperBtn = lid("modePaper");
      const semiBtn = lid("modeSemiAuto");
      const liveBtn = lid("modeLive");
      if (paperBtn) paperBtn.classList.toggle("active", mode === "paper");
      if (semiBtn) semiBtn.classList.toggle("active", mode === "semi_auto");
      if (liveBtn) liveBtn.classList.toggle("active", mode === "live");

      const badge = lid("badgeExecMode");
      const ticket = lid("pairOrderTicket");
      const autoBox = lid("autoBotBox");
      const paperBadge = lid("paperBadge");
      const isKo = window.currentLang === "ko";

      if (mode === "live") {
        if (badge) {
          badge.textContent = isKo ? "🤖 24H 전자동 알고리즘 가동" : "24H AUTONOMOUS ENGINE";
          badge.style.background = "#fee2e2";
          badge.style.color = "#991b1b";
          badge.style.borderColor = "#fca5a5";
        }
        if (paperBadge) paperBadge.style.display = "none";
        if (ticket) ticket.classList.add("locked");
        if (autoBox) autoBox.style.display = "block";
        if (lid("aiSignalBox")) lid("aiSignalBox").style.display = "none";
        this.setText("lblAutoBotTitle", "🤖 24H Autonomous Lighter Engine Active");
        this.setText("lblStepTrancheSize", "➕ Scale In (Live 1x Pair)");
        this.setText("lblStepTrancheSub", "SKHY / SKHYNIXUSD");
        this.setText("lblReduceTrancheText", "Trim 1 GCD Tranche (Take-Profit)");
        const flatten = lid("btnEmergencyFlatten");
        if (flatten) flatten.textContent = "🚨 Emergency Flatten";
      } else if (mode === "semi_auto") {
        if (badge) {
          badge.textContent = isKo ? "⚡ AI 시그널 반자동 승인" : "AI SEMI-AUTO APPROVAL";
          badge.style.background = "#f0fdf4";
          badge.style.color = "#15803d";
          badge.style.borderColor = "#86efac";
        }
        if (paperBadge) paperBadge.style.display = "none";
        if (ticket) ticket.classList.add("locked");
        if (autoBox) autoBox.style.display = "none";
        if (lid("aiSignalBox")) lid("aiSignalBox").style.display = "block";
        this.setText("lblStepTrancheSize", "➕ Scale In (Approve Signal)");
        this.setText("lblStepTrancheSub", "1-CLICK APPROVAL");
        this.setText("lblReduceTrancheText", "Trim 1 GCD Tranche (Take-Profit)");
        const flatten = lid("btnEmergencyFlatten");
        if (flatten) flatten.textContent = "🚨 Emergency Flatten";
      } else {
        if (badge) {
          badge.textContent = isKo ? "✋ 수동 모의매매 / 테스트" : "MANUAL PAPER TRADING";
          badge.style.background = "#e0f2fe";
          badge.style.color = "#0369a1";
          badge.style.borderColor = "#bae6fd";
        }
        if (paperBadge) paperBadge.style.display = "inline-flex";
        if (ticket) ticket.classList.remove("locked");
        if (autoBox) autoBox.style.display = "none";
        if (lid("aiSignalBox")) lid("aiSignalBox").style.display = "none";
        this.setText("lblStepTrancheSize", "➕ Add Paper Tranche");
        this.setText("lblStepTrancheSub", "SIMULATED");
        this.setText("lblReduceTrancheText", "Close All Paper Tranches");
        const flatten = lid("btnEmergencyFlatten");
        if (flatten) flatten.textContent = "🚨 Reset Paper State";
      }

      this.renderVirtualState();

      const isLive = (mode === "live");
      if (liveBtn) liveBtn.classList.toggle("botActiveLive", isLive);
      const banner = lid("autoTradeMasterBanner");
      const pulseEl = lid("autoTradePulseIndicator");
      const titleEl = lid("lblAutoTradeStateTitle");
      const headingEl = lid("lblAutoTradeStatusHeading");
      const detailEl = lid("lblAutoTradeStatusDetail");
      const navLighterPill = $("navLighterLivePill");

      if (isLive) {
        if (banner) banner.classList.add("active");
        if (pulseEl) pulseEl.className = "autoTradePulseIndicator active";
        if (titleEl) titleEl.textContent = isKo ? "⚡ 그리드 봇: 실시간 가동 중" : "⚡ INSTITUTIONAL GRID BOT: ACTIVE";
        if (headingEl) headingEl.textContent = "EC2 DAEMON: ACTIVE";
        if (detailEl) detailEl.textContent = isKo ? "실시간 그리드 차익거래 가동 중" : "Running 24/7 institutional grid engine on EC2";
        if (navLighterPill) {
          navLighterPill.className = "navLivePill active";
          navLighterPill.textContent = "● GRID AUTO ON";
        }
      } else {
        if (banner) banner.classList.remove("active");
        if (pulseEl) pulseEl.className = "autoTradePulseIndicator paused";
        if (titleEl) titleEl.textContent = isKo ? "○ 그리드 봇: 대기 (일시정지)" : "○ INSTITUTIONAL GRID BOT: PAUSED";
        if (headingEl) headingEl.textContent = "EC2 DAEMON: STANDBY";
        if (detailEl) detailEl.textContent = isKo ? "토글 스위치를 켜서 24/7 그리드 매매를 시작하세요" : "Click toggle switch to start 24/7 grid bot";
        if (navLighterPill) {
          navLighterPill.className = "navLivePill paused";
          navLighterPill.textContent = "○ GRID PAUSED";
        }
      }

      if (showNotification) {
        window.showToast?.(
          isKo ? `매매 모드 전환: ${mode === "live" ? "전자동 봇" : mode === "semi_auto" ? "반자동 승인" : "수동 모의"}` : `Mode switched: ${mode.toUpperCase()}`,
          mode === "live" ? "danger" : "info"
        );
      }
    },

    async stepTrancheLive() {
      if (window.terminalLockManager?.isLocked) {
        window.showToast?.("🔒 Terminal is in read-only mode. Unlock using the slide switch at the top.", "warn");
        return;
      }
      const dirSelect = lid("selTrancheDirection");
      let side = this.currentRatio >= 100 ? -1 : 1;
      if (dirSelect) {
        if (dirSelect.value === "short") side = -1;
        else if (dirSelect.value === "long") side = 1;
      }
      const notional = this.orderNotional();
      const btn = lid("btnStepTranche");
      if (btn) btn.disabled = true;
      window.showToast?.(`Submitting live 1x dollar-neutral pair (~$${notional} per leg) on Lighter DEX...`, "info");
      try {
        const res = await apiPost("/api/lighter/step_tranche", { side, notional_usd: notional });
        if (res.success) {
          window.showToast?.(`✅ ${res.message}`, "success");
          await this.refresh();
        } else {
          window.showToast?.(`Execution Error: ${res.error}`, "danger");
        }
      } catch (e) {
        window.showToast?.(`Error: ${e.message}`, "danger");
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    async reduceTrancheLive() {
      if (window.terminalLockManager?.isLocked) {
        window.showToast?.("🔒 Terminal is in read-only mode. Unlock using the slide switch at the top.", "warn");
        return;
      }
      const btn = lid("btnReduceTranche");
      if (btn) btn.disabled = true;
      window.showToast?.("Trimming 1x tranche on Lighter DEX...", "info");
      try {
        const res = await apiPost("/api/lighter/reduce_tranche", {});
        if (res.success) {
          window.showToast?.(`✅ ${res.message}`, "success");
          await this.refresh();
        } else {
          window.showToast?.(`Reduce Error: ${res.error}`, "danger");
        }
      } catch (e) {
        window.showToast?.(`Error: ${e.message}`, "danger");
      } finally {
        if (btn) btn.disabled = false;
      }
    },

    async emergencyFlatten() {
      if (this.mode === "live") {
        if (window.terminalLockManager?.isLocked) {
          window.showToast?.("🔒 Terminal is in read-only mode. Unlock before emergency flatten.", "warn");
          return;
        }
        const confirmed = window.confirm("🚨 EMERGENCY FLATTEN: Close both SKHY pair legs on Lighter DEX and pause the EC2 bot at market?");
        if (!confirmed) return;
        window.showToast?.("Closing all Lighter positions and halting bot...", "info");
        try {
          const res = await apiPost("/api/lighter/flatten", {});
          if (res.success) {
            window.showToast?.("✅ SKHY pair positions flattened and bot paused.", "success");
            await this.refresh();
          } else {
            window.showToast?.(`Error: ${res.error}`, "danger");
          }
        } catch (e) {
          window.showToast?.(`Flatten failed: ${e.message}`, "danger");
        }
      } else {
        this.exitVirtual();
      }
    },

    resetPaperBalance() {
      this.entries = [];
      this.ledger = [];
      this.save();
      this.renderVirtualState();
      this.renderMarkers();
      this.renderCurrentPositionReferenceLines();
      this.updateGridLadderData();
      window.showToast?.("↺ Reset paper balance to $10,000", "info");
    },

    computeParityMetrics() {
      if (!this.bars || this.bars.length < 24 || !Number.isFinite(this.currentRatio)) {
        return null;
      }
      const windowSize = 24;
      const sample = this.bars.slice(-windowSize).map((b) => Number(b.value));
      const mean = sample.reduce((a, b) => a + b, 0) / sample.length;
      const variance = sample.reduce((a, b) => a + (b - mean) ** 2, 0) / sample.length;
      const std = Math.sqrt(variance);
      const zScore = std > 1e-12 ? (this.currentRatio - mean) / std : 0.0;

      let prevZScore = null;
      if (this.bars.length >= windowSize + 1) {
        const prevSample = this.bars.slice(-windowSize - 1, -1).map((b) => Number(b.value));
        const prevMean = prevSample.reduce((a, b) => a + b, 0) / prevSample.length;
        const prevVar = prevSample.reduce((a, b) => a + (b - prevMean) ** 2, 0) / prevSample.length;
        const prevStd = Math.sqrt(prevVar);
        const prevBarVal = Number(this.bars.at(-2)?.value ?? prevMean);
        prevZScore = prevStd > 1e-12 ? (prevBarVal - prevMean) / prevStd : 0.0;
      }

      const ma7Sample = this.bars.slice(-7).map((b) => Number(b.value));
      const ma7 = ma7Sample.reduce((a, b) => a + b, 0) / ma7Sample.length;

      return { mean, std, zScore, prevZScore, ma7 };
    },

    getActiveZThresholds() {
      let entry = 1.5, exit = 0.25;
      if (this.currentParadigm === "ou_quant") {
        entry = Number($("lighter_inpOuEntryZ")?.value || this.botState?.strategy_params?.entry_z || this.botState?.entry_z || 1.4);
        exit = Number($("lighter_inpOuExitZ")?.value || this.botState?.strategy_params?.exit_z || this.botState?.exit_z || 0.20);
      } else if (this.currentParadigm === "custom") {
        entry = Number($("lighter_inpCustomEntryZ")?.value || 1.5);
        exit = Number($("lighter_inpCustomExitZ")?.value || 0.25);
      }
      return { entryZ: entry, exitZ: exit };
    },

    isEnforceConditionsEnabled() {
      const chk = lid("chkEnforceConditions");
      return chk ? chk.checked : true;
    },

    validateVirtualEntryConditions(side) {
      if (!this.isEnforceConditionsEnabled()) {
        return { ok: true };
      }

      const metrics = this.computeParityMetrics();
      if (!metrics) {
        return { ok: true };
      }

      const { entryZ } = this.getActiveZThresholds();
      const useMaStretch = lid("chkCondEntryMaStretch")?.checked !== false;
      const useBaseSpacing = lid("chkCondEntryBase")?.checked !== false;
      const usePeak = lid("chkCondEntryPeak")?.checked !== false;
      const useMaStack = lid("chkCondEntryMaStack5m")?.checked === true;

      // 1. MA Stretch / Z-score magnitude
      if (useMaStretch && Math.abs(metrics.zScore) < entryZ) {
        return {
          ok: false,
          reason: `|Z| = ${Math.abs(metrics.zScore).toFixed(2)} < required ${entryZ.toFixed(2)} (MA Stretch unmet)`,
        };
      }

      // 2. Base Spacing (minimum 0.10pt gap from last same-side tranche)
      if (useBaseSpacing && this.entries.length > 0) {
        const lastSameSide = [...this.entries].reverse().find((e) => e.side === side);
        if (lastSameSide) {
          const spacing = side < 0 ? (this.currentRatio - lastSameSide.ratio) : (lastSameSide.ratio - this.currentRatio);
          if (spacing < 0.10) {
            return {
              ok: false,
              reason: `Spread spacing from last entry @ ${lastSameSide.ratio.toFixed(3)}% is ${spacing >= 0 ? "+" : ""}${spacing.toFixed(3)}pt < +0.10pt (Base Spacing unmet)`,
            };
          }
        }
      }

      // 3. Peak Rollover (momentum crest)
      if (usePeak && metrics.prevZScore !== null) {
        if (Math.abs(metrics.zScore) > Math.abs(metrics.prevZScore)) {
          return {
            ok: false,
            reason: `Momentum is still expanding: |Z| ${Math.abs(metrics.zScore).toFixed(2)} > prev ${Math.abs(metrics.prevZScore).toFixed(2)} (Peak Rollover unmet)`,
          };
        }
      }

      // 4. 5m MA Stack
      if (useMaStack) {
        const isAligned = side < 0
          ? (this.currentRatio > metrics.ma7 && metrics.ma7 > metrics.mean)
          : (this.currentRatio < metrics.ma7 && metrics.ma7 < metrics.mean);
        if (!isAligned) {
          return {
            ok: false,
            reason: `5m MA Stack alignment not satisfied (requires ${side < 0 ? "Ratio > MA7 > MA24" : "Ratio < MA7 < MA24"})`,
          };
        }
      }

      return { ok: true };
    },

    validateVirtualExitConditions() {
      if (!this.isEnforceConditionsEnabled()) {
        return { ok: true };
      }

      const metrics = this.computeParityMetrics();
      if (!metrics) {
        return { ok: true };
      }

      const { exitZ } = this.getActiveZThresholds();
      const useConvergence = lid("chkCondExitConvergence")?.checked !== false;
      const useDwell = lid("chkCondExitDwell")?.checked !== false;
      const useBottoming = lid("chkCondExitBottoming")?.checked === true;

      // Calculate total unrealized PnL
      let totalPnl = 0;
      this.entries.forEach((e) => {
        totalPnl += e.notional * e.side * (this.currentRatio - e.ratio) / e.ratio;
      });

      // 1. Exit convergence: |Z| <= exitZ or positive net profit
      if (useConvergence && Math.abs(metrics.zScore) > exitZ && totalPnl <= 0) {
        return {
          ok: false,
          reason: `Exit convergence unmet: |Z| = ${Math.abs(metrics.zScore).toFixed(2)} > ${exitZ.toFixed(2)} and net PnL is non-positive ($${totalPnl.toFixed(2)})`,
        };
      }

      // 2. Dwell time: minimum 4 bars held
      if (useDwell && this.entries.length > 0 && this.bars?.length > 0) {
        const oldestTime = Math.min(...this.entries.map((e) => e.time));
        const barsSince = this.bars.filter((b) => b.time * 1000 >= oldestTime).length;
        if (barsSince < 4) {
          return {
            ok: false,
            reason: `Dwell time unmet: held for ${barsSince} bar${barsSince === 1 ? "" : "s"} < minimum 4 bars`,
          };
        }
      }

      // 3. Bottoming rollover
      if (useBottoming && metrics.prevZScore !== null) {
        if (Math.abs(metrics.zScore) < Math.abs(metrics.prevZScore)) {
          return {
            ok: false,
            reason: `Convergence rollover unmet: |Z| is still dropping towards mean`,
          };
        }
      }

      return { ok: true };
    },

    addVirtualEntry() {
      if (!Number.isFinite(this.currentRatio)) {
        if (typeof window.showToast === "function") {
          window.showToast("Parity ratio not available yet — awaiting market feed", "warning");
        }
        return;
      }
      const dirSelect = lid("selTrancheDirection");
      let side = this.currentRatio >= 100 ? -1 : 1;
      let dirLabel = side < 0 ? "SHORT RATIO" : "LONG RATIO";
      let dirToast = side < 0 ? "⚡ Auto: Short Parity (ADR Premium)" : "⚡ Auto: Long Parity (ADR Discount)";

      if (dirSelect) {
        if (dirSelect.value === "short") {
          side = -1;
          dirLabel = "SHORT RATIO";
          dirToast = "▼ Short Parity (Short ADR / Long KR)";
        } else if (dirSelect.value === "long") {
          side = 1;
          dirLabel = "LONG RATIO";
          dirToast = "▲ Long Parity (Long ADR / Short KR)";
        }
      }

      const validation = this.validateVirtualEntryConditions(side);
      if (!validation.ok) {
        if (typeof window.showToast === "function") {
          window.showToast(`⚠️ Paper Entry Blocked: ${validation.reason}. (Toggle condition switch or uncheck 'Enforce Live Conditions' to override)`, "warning");
        }
        return;
      }

      const notional = this.orderNotional();
      const entry = { time: Date.now(), ratio: this.currentRatio, notional, side };
      this.entries.push(entry);
      this.ledger.unshift({ ...entry, action: dirLabel, pnl: null });
      this.save();
      this.renderVirtualState();
      this.renderMarkers();
      this.renderCurrentPositionReferenceLines();
      this.updateGridLadderData();

      if (typeof window.showToast === "function") {
        window.showToast(
          `📄 Paper Tranche #${this.entries.length} Added: ${dirToast} @ ${this.currentRatio.toFixed(3)}% ($${notional} virtual)`,
          "info"
        );
      }
    },

    exitVirtual() {
      if (!this.entries.length || !Number.isFinite(this.currentRatio)) {
        if (typeof window.showToast === "function") {
          window.showToast("No active paper tranches to exit", "warning");
        }
        return;
      }

      const validation = this.validateVirtualExitConditions();
      if (!validation.ok) {
        if (typeof window.showToast === "function") {
          window.showToast(`⚠️ Paper Exit Blocked: ${validation.reason}. (Toggle condition switch or uncheck 'Enforce Live Conditions' to force exit)`, "warning");
        }
        return;
      }

      const count = this.entries.length;
      let totalPnl = 0;
      let totalNotional = 0;
      const closedEntries = [...this.entries];
      const trancheDetails = [];
      closedEntries.forEach((entry, idx) => {
        const pnl = entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio;
        totalPnl += pnl;
        totalNotional += entry.notional;
        trancheDetails.push({
          idx: idx + 1,
          time: entry.time,
          ratio: entry.ratio,
          notional: entry.notional,
          pnl,
        });
      });
      const firstSide = closedEntries[0]?.side || -1;
      const exitTime = Date.now();
      const campaignKey = `paper:campaign:${exitTime}`;

      this.ledger.unshift({
        time: exitTime,
        ratio: this.currentRatio,
        notional: totalNotional,
        action: "EXIT",
        side: firstSide,
        pnl: totalPnl,
        count,
        is_campaign_exit: true,
        campaignKey,
        tranches: trancheDetails,
      });
      this.entries = [];
      this.save();
      this.renderVirtualState();
      this.renderMarkers();
      this.renderCurrentPositionReferenceLines();
      this.updateGridLadderData();

      if (typeof window.showToast === "function") {
        const pnlText = `${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`;
        window.showToast(
          `📄 Closed ${count} Paper Tranche${count > 1 ? "s" : ""}: Net PnL ${pnlText}`,
          totalPnl >= 0 ? "success" : "warning"
        );
      }
    },

    renderMarkers() {
      if (!this.series || typeof this.series.setMarkers !== "function") return;
      if (!this.bars.length) return;
      const firstBarTime = Number(this.bars[0]?.time);
      const lastBarTime = Number(this.bars.at(-1)?.time);

      // Consolidate simultaneous/legacy paper exit rows into single campaign markers
      const paperRows = [];
      const exitBucketMap = new Map();
      (this.ledger || []).forEach((row) => {
        if (row.action === "EXIT") {
          const bucket = Math.floor((row.time || 0) / 1000);
          const group = exitBucketMap.get(bucket) || [];
          group.push(row);
          exitBucketMap.set(bucket, group);
        } else {
          paperRows.push(row);
        }
      });
      exitBucketMap.forEach((rows) => {
        if (rows.length === 1 || !this.groupTradesAsRange) {
          rows.forEach((r) => paperRows.push(r));
        } else {
          const totalPnl = rows.reduce((s, r) => s + (Number(r.pnl) || 0), 0);
          const totalNotional = rows.reduce((s, r) => s + (Number(r.notional) || 0), 0);
          paperRows.push({
            ...rows[0],
            notional: totalNotional,
            pnl: totalPnl,
            count: rows.length,
            is_campaign_exit: true,
          });
        }
      });

      const paperMarkers = paperRows
        .filter((row) => (row.time / 1000) >= firstBarTime && (row.time / 1000) <= lastBarTime)
        .slice(0, 40)
        .map((row) => {
        const isExit = row.action === "EXIT";
        const isShort = row.side < 0 || row.action === "SHORT RATIO";
        const isSell = isShort ? !isExit : isExit;
        const markerColor = isSell ? "#dc2626" : "#16a34a";
        const markerShape = isExit ? "arrowLeft" : "arrowRight";
        const cntStr = (row.count && row.count > 1) ? ` (${row.count}x)` : "";
        return {
          time: TerminalCommon.alignTime(this.bars, row.time / 1000),
          position: isSell ? "aboveBar" : "belowBar",
          color: isSell ? "rgba(220, 38, 38, 0.70)" : "rgba(22, 163, 74, 0.85)",
          activeColor: markerColor,
          shape: markerShape,
          text: "",
          hoverText: isExit
            ? `${isShort ? "COVER" : "SELL"}${cntStr} ${row.ratio ? row.ratio.toFixed(2) + "%" : ""}${row.pnl != null ? " · " + (row.pnl >= 0 ? "+" : "") + "$" + row.pnl.toFixed(2) : ""}`
            : `${isShort ? "SHORT" : "BUY"} ${row.ratio ? row.ratio.toFixed(2) + "%" : ""} ($${(row.notional || 0).toFixed(0)})`,
          source: "virtual",
          hypothetical: true,
          is_paper: true,
          is_entry: !isExit,
          is_campaign_exit: Boolean(row.is_campaign_exit || (row.count && row.count > 1)),
          count: row.count || 1,
          direction: isShort ? "short" : "long",
          ratio: row.ratio,
          entry_price: row.ratio,
          exit_price: isExit ? row.ratio : null,
          pnl: row.pnl,
        };
        });
      let rawMarkers = [
        ...(this.actualMarkers || []),
        ...paperMarkers,
        ...(this.backtestMarkers || []),
      ].sort((a, b) => (a.time - b.time) || (a.is_entry === false ? 1 : -1));

      const openPairs = new Map();
      let pairSequence = 0;
      rawMarkers.forEach((marker, index) => {
        const dir = marker.direction || (marker.shape === "arrowDown" ? (marker.is_entry !== false ? "short" : "long") : (marker.is_entry !== false ? "long" : "short"));
        const stream = `${marker.source || "trade"}:${marker.backtest ? "backtest" : (marker.is_paper ? "paper" : "live")}:${dir}`;
        const stack = openPairs.get(stream) || [];

        if (marker.is_entry !== false) {
          stack.push(marker);
          openPairs.set(stream, stack);
        } else {
          let closedEntries = [];

          // 1. If this exit marker has a pre-assigned pairKey matching an entry in the stack, pair 1-to-1
          let preMatchedIdx = -1;
          if (marker.pairKey) {
            preMatchedIdx = stack.findIndex((e) => e.pairKey === marker.pairKey);
          }

          if (preMatchedIdx >= 0) {
            closedEntries = [stack.splice(preMatchedIdx, 1)[0]];
            if (closedEntries[0]?.direction && !marker.direction) marker.direction = closedEntries[0].direction;
          } else {
            // 2. Otherwise match: only true multi-tranche campaigns close multiple entries
            const isCampaign = Boolean(
              marker.is_campaign_exit
              || (marker.count && marker.count > 1 && marker.count >= stack.length)
            );

            if (isCampaign) {
              closedEntries = [...stack];
              stack.length = 0;
            } else if (marker.count && marker.count > 1) {
              const n = Math.min(marker.count, stack.length);
              closedEntries = stack.splice(-n);
            } else {
              const entry = stack.pop();
              if (entry) closedEntries = [entry];
            }

            pairSequence += 1;
            const assignedPairKey = marker.pairKey || `${stream}:pair:${pairSequence}`;
            marker.pairKey = assignedPairKey;

            if (closedEntries.length > 0) {
              closedEntries.forEach((entry) => {
                if (!entry.pairKey) entry.pairKey = assignedPairKey;
                if (!entry.direction && marker.direction) entry.direction = marker.direction;
              });
              if (closedEntries[0]?.direction && !marker.direction) marker.direction = closedEntries[0].direction;
            } else if (!marker.pairKey) {
              marker.pairKey = `${stream}:unmatched:${index}`;
            }
          }
          openPairs.set(stream, stack);
        }
      });

      openPairs.forEach((stack, stream) => {
        stack.forEach((entry) => {
          if (!entry.pairKey) {
            pairSequence += 1;
            entry.pairKey = `${stream}:open:${pairSequence}`;
          }
        });
      });

      rawMarkers = rawMarkers
        .map((marker) => ({ ...marker, text: "" }))
        .map((marker, index) => ({
          ...marker,
          markerKey: `${marker.source || "trade"}:${marker.backtest ? "backtest" : "live"}:${marker.time}:${index}`,
        }));

      if (this.selectedExecutionMarkerKey && !rawMarkers.some((marker) => marker.markerKey === this.selectedExecutionMarkerKey)) {
        this.selectedExecutionMarkerKey = null;
        this.selectedExecutionMarkerTime = null;
      }

      this.rawExecutionMarkers = rawMarkers;
      this.executionChartController?.setExecutions(rawMarkers);

      this.updateMarkerState(this.activeHoveredExecutionMarkerTime);
      window.requestAnimationFrame(() => this.renderTradeMarkerTargets());
    },

    updateMarkerButtons() {
      this.executionChartController?.setVisibility("actual", this.showActualMarkers);
      this.executionChartController?.setVisibility("virtual", this.showVirtualMarkers);
      this.executionChartFrame?.setVisibility("actual", this.showActualMarkers);
      this.executionChartFrame?.setVisibility("virtual", this.showVirtualMarkers);
      this.executionChartFrame?.setGrouping?.(this.groupTradesAsRange);
      this.updateMarkerState(this.activeHoveredExecutionMarkerTime);
      this.renderTradeMarkerTargets();
      if (this.activeHoveredExecutionMarkerTime === null) {
        this.renderCurrentPositionReferenceLines();
      }
    },

    setTradeGrouping(asRange) {
      this.groupTradesAsRange = Boolean(asRange);
      safeStorage.setItem("lighter_group_trades_as_range", this.groupTradesAsRange ? "true" : "false");
      this.executionChartFrame?.setGrouping?.(this.groupTradesAsRange);
      this.renderTradeMarkerTargets();
      this.renderTradeTriangles();
    },

    toggleMA(period) {
      this.maVisibility[period] = !this.maVisibility[period];
      this.maSeries[period]?.applyOptions({ visible: this.maVisibility[period] });
      const legend = lid(`legendShortMa${period}`);
      if (legend) { legend.style.opacity = this.maVisibility[period] ? "1" : ".35"; legend.style.textDecoration = this.maVisibility[period] ? "none" : "line-through"; }
    },

    async runBacktest() {
      const requestId = this.backtestRequestId = (this.backtestRequestId || 0) + 1;
      const summary = lid("dynamicBacktestStatus");
      const button = lid("btnRerunDynamicBacktest");
      if (button) button.disabled = true;
      if (summary) summary.textContent = "Running…";
      try {
        if (this.currentParadigm === "ou_quant") {
          const controls = $("lighter_paradigmDetailSection")?.querySelectorAll?.("input[type=number]") || [];
          for (const input of controls) {
            if (typeof input.checkValidity === "function" && !input.checkValidity())
              throw new Error("Fix the highlighted OU threshold before replaying");
          }
        }
        const settings = this.replaySettings();
        this.updateRulesMatchStatus();
        const trendSlope = settings.trend_slope_min;
        const trendPullback = settings.trend_pullback_dist;
        const toggles = new URLSearchParams(settings);
        const data = await api(`/api/lighter/backtest?${toggles}`);
        if (requestId !== this.backtestRequestId) return;
        const pName = this.paradigms[this.currentParadigm]?.name || "Virtual";
        this.backtestMarkers = data.trades.flatMap((trade, tradeIndex) => [
          {
            time: trade.entry_time,
            position: trade.side < 0 ? "aboveBar" : "belowBar",
            color: trade.side < 0 ? "rgba(220,38,38,.55)" : "rgba(22,163,74,.55)",
            shape: "arrowRight",
            text: "",
            hoverText: `${trade.side < 0 ? "SHORT" : "BUY"} ${trade.entry ? trade.entry.toFixed(2) + "%" : ""}`,
            source: "virtual",
            hypothetical: true,
            backtest: true,
            pairKey: `backtest:${tradeIndex}`,
            direction: trade.side < 0 ? "short" : "long",
            is_entry: true,
            entry_price: trade.entry,
            ratio: trade.entry,
          },
          {
            time: trade.exit_time,
            position: trade.side < 0 ? "belowBar" : "aboveBar",
            color: trade.side < 0 ? "rgba(22,163,74,.55)" : "rgba(220,38,38,.55)",
            shape: "arrowLeft",
            text: "",
            hoverText: `${trade.side < 0 ? "COVER" : "SELL"} ${trade.exit ? trade.exit.toFixed(2) + "%" : ""} · ${trade.pnl_pct >= 0 ? "+" : ""}${trade.pnl_pct.toFixed(2)}% net`,
            source: "virtual",
            hypothetical: true,
            backtest: true,
            pairKey: `backtest:${tradeIndex}`,
            direction: trade.side < 0 ? "short" : "long",
            is_entry: false,
            entry_price: trade.entry,
            exit_price: trade.exit,
            ratio: trade.exit,
            pnl_pct: trade.pnl_pct,
          },
        ]);
        this.backtestMarkers.push(...(data.open_positions || []).map((entry, index) => ({
          time: entry.entry_time,
          position: entry.side < 0 ? "aboveBar" : "belowBar",
          color: entry.side < 0 ? "rgba(220,38,38,.55)" : "rgba(22,163,74,.55)",
          shape: "arrowRight", text: "", source: "virtual", hypothetical: true, backtest: true,
          pairKey: `backtest:open:${entry.entry_time}:${index}`,
          direction: entry.side < 0 ? "short" : "long", is_entry: true, is_open: true,
          entry_price: entry.entry, ratio: entry.entry,
          unrealized_pnl_pct: entry.unrealized_pnl_pct,
          hoverText: `${entry.side < 0 ? "SHORT" : "BUY"} ${entry.entry.toFixed(2)}% · OPEN · unrealized ${entry.unrealized_pnl_pct >= 0 ? "+" : ""}${entry.unrealized_pnl_pct.toFixed(2)}%`,
        })));
        this.renderMarkers();
        this.renderCurrentPositionReferenceLines();
        const sharedSignal = ["shared_live_ou", "shared_live_grid"].includes(data.metrics?.signal_engine);
        if (summary) summary.innerHTML = `[<strong>PAPER · ${pName} · ${this.interval}</strong>] <strong>${data.summary.trades}</strong> closed trades · <strong>${data.summary.win_rate.toFixed(1)}%</strong> wins · realized return sum <strong>${data.summary.net_pct.toFixed(3)}%</strong> · <strong>${data.open_positions?.length || 0}</strong> open · unrealized return sum <strong>${Number(data.summary.unrealized_pct || 0).toFixed(3)}%</strong> · <em>${sharedSignal ? "shared live signal timing" : "paper replay"}; price signals only, costs excluded</em>`;

        if (data.metrics && this.currentParadigm === "ou_quant") {
          const thetaEl = $("lighter_valOuTheta");
          if (thetaEl && data.metrics.avg_theta) thetaEl.textContent = `${data.metrics.avg_theta.toFixed(4)} / bar`;
          const hlEl = $("lighter_valOuHalfLife");
          if (hlEl && data.metrics.avg_half_life_bars) hlEl.textContent = `${data.metrics.avg_half_life_bars} bars (${data.metrics.half_life_mins}m)`;
          const slopeEl = $("lighter_valOuMacroSlope");
          if (slopeEl) {
            const slope = data.metrics.latest_macro_ema_slope;
            slopeEl.textContent = slope == null ? "Insufficient bars" : `${Number(slope).toFixed(4)} pp`;
          }
          const zEl = $("lighter_valOuZScore");
          const lastZ = data.series?.[data.series.length - 1]?.z;
          if (zEl) zEl.textContent = lastZ == null ? "Insufficient bars" : `${Number(lastZ) >= 0 ? "+" : ""}${Number(lastZ).toFixed(3)}σ`;
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
        if (summary && requestId === this.backtestRequestId) summary.textContent = error.message;
      } finally { if (button && requestId === this.backtestRequestId) button.disabled = false; }
    },

    save() { safeStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: this.entries, ledger: this.ledger.slice(0, 100) })); },

    tradeExposure(trade) {
      const ratio = Math.abs(Number(trade.exit_ratio || trade.entry_ratio || trade.ratio || this.currentRatio || 0));
      const configured = Math.abs(Number(trade.notional_usd || trade.notional || 0));
      const adrQty = Math.abs(Number(trade.adr_qty || 0));
      const domesticQty = Math.abs(Number(trade.domestic_qty || 0));
      const adrPrice = Math.abs(Number(trade.adr_price || trade.orders?.first_leg?.fill_price || trade.orders?.first_leg?.reference_price || 0));
      const domesticPrice = Math.abs(Number(trade.domestic_price || trade.orders?.second_leg?.fill_price || trade.orders?.second_leg?.reference_price || 0));
      const adr = Math.abs(Number(trade.adr_notional_usd || 0)) || (adrQty && adrPrice ? adrQty * adrPrice : configured);
      const domestic = Math.abs(Number(trade.domestic_notional_usd || 0)) || (domesticQty && domesticPrice ? domesticQty * domesticPrice : (adr && ratio ? adr * 100 / ratio : configured));
      const gross = Math.abs(Number(trade.gross_notional_usd || 0)) || adr + domestic;
      const margin = Math.abs(Number(trade.margin_usd || 0)) || gross;
      return { adr, domestic, gross, margin };
    },

    verifiedRealizedSummary() {
      const serverPnl = Number(this.botState?.verified_realized_pnl_usd);
      const serverCount = Number(this.botState?.verified_exit_count);
      if (Number.isFinite(serverPnl) && Number.isFinite(serverCount)) {
        return { pnl: serverPnl, count: serverCount };
      }
      const history = Array.isArray(this.botState?.execution_history) ? this.botState.execution_history : [];
      const exits = history.filter((trade) => (trade.event === "EXIT" || trade.is_exit)
        && (trade.pnl_authoritative || trade.pnl_source === "LIGHTER_REALIZED_PNL"));
      return {
        pnl: exits.reduce((sum, trade) => sum + Number(trade.net_pnl_usd ?? trade.pnl ?? 0), 0),
        count: exits.length,
      };
    },

    renderVirtualState() {
      const hasLiveExposure = (this.livePositions || []).some((pos) => Math.abs(Number(pos.position || pos.size || 0)) > 1e-6);
      const showExchangeState = this.mode === "live" || Boolean(this.botState?.enabled) || hasLiveExposure;
      if (showExchangeState) {
        const col = this.liveVenue?.collateral != null ? Number(this.liveVenue.collateral) : 187.55;
        const validTranches = (this.botState?.tranches || []).filter(t => (t.adr_qty > 0 || t.domestic_qty > 0));
        const liveUnrealized = (this.livePositions || []).reduce((acc, pos) => acc + Number(pos.unrealized_pnl || 0), 0);
        const pnlPct = col > 0 ? (liveUnrealized / col) * 100 : 0;
        const pnlSign = liveUnrealized >= 0 ? "+" : "";
        const pnlText = `${pnlSign}$${liveUnrealized.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)`;
        const realized = this.verifiedRealizedSummary();
        const realizedSign = realized.pnl >= 0 ? "+" : "";
        this.setText("valAccountEquity", `$${col.toFixed(2)}`);
        this.setText("badgeEquitySource", "LIGHTER L2");
        const openLive = (this.livePositions || []).filter(p => Math.abs(Number(p.position || p.size || 0)) > 1e-6);
        const liveGross = openLive.reduce((sum, pos) => {
          const quantity = Math.abs(Number(pos.position || pos.size || 0));
          const mark = Number(pos.mark_price || pos.avg_entry_price || pos.entry_price || pos.price || 0);
          return sum + (Math.abs(Number(pos.position_value || 0)) || quantity * mark);
        }, 0);
        const estimatedFreeMargin = Math.max(0, col - liveGross);
        this.setText("valActivePairs", `${openLive.length} Open on Exchange`);
        const maxTranches = Number(this.botState?.max_tranches || 8);
        this.setText("valHedgedTranches", `${validTranches.length} / ${maxTranches} Campaign Slots`);
        this.setText("valHedgedQuantities", `Gross $${liveGross.toFixed(2)} USDT · Est. 1x Margin $${liveGross.toFixed(2)}`);
        const pausedError = this.botState?.last_error && !this.botState?.enabled;
        this.setText("valHedgedCombinedPnl", pausedError ? `Error: ${this.botState.last_error}` : pnlText);
        const pnlEl = lid("valHedgedCombinedPnl");
        if (pnlEl) pnlEl.style.color = liveUnrealized > 0 ? "#16a34a" : (liveUnrealized < 0 ? "#dc2626" : "#0f172a");
        this.setText("valHedgedPnlSubtitle", this.botState?.enabled && this.botState?.last_error
          ? "Transient Lighter data error · EC2 bot remains enabled and will retry"
          : (validTranches.length > 0 ? (liveUnrealized >= 0 ? "✅ Positive Net Return (Take-Profit Eligible)" : "Holding (Awaiting Convergence)") : "All positions flat (Awaiting signal)"));
        this.setText("valUnrealizedPnl", `${realizedSign}$${realized.pnl.toFixed(2)} · ${realized.count} exits`);
        const realizedEl = lid("valUnrealizedPnl");
        if (realizedEl) realizedEl.style.color = realized.pnl > 0 ? "#16a34a" : (realized.pnl < 0 ? "#dc2626" : "#64748b");
        this.setText("countPositions", String(openLive.length));

        const body = lid("activePositionsBody");
        const positionSummary = lid("activePositionsSummary");
        if (positionSummary) {
          const liveRisk = this.botState?.risk_capacity || {};
          const liveLevCap = Number(liveRisk.gross_leverage_cap || 8);
          const displayedFreeMargin = Number(liveRisk.available_margin_usd ?? estimatedFreeMargin);
          positionSummary.innerHTML = `<span>Gross pair size <b>$${liveGross.toFixed(2)} USDT</b></span><span>Est. margin at ${liveLevCap.toFixed(0)}x <b>$${(liveGross / liveLevCap).toFixed(2)}</b></span><span>Collateral <b>$${col.toFixed(2)}</b></span><span>Available margin <b>$${displayedFreeMargin.toFixed(2)}</b></span><span style="color:#64748b">Exchange position values · cross-margin estimate</span>`;
        }
        if (body) {
          if (openLive.length) {
            body.innerHTML = openLive.map((pos, idx) => {
              const sym = Number(pos.market_id) === 216 ? "SKHY (ADR)" : "SKHYNIXUSD";
              const rawSize = Number(pos.position || pos.size || 0);
              const sign = pos.sign != null ? Number(pos.sign) : (rawSize < 0 ? -1 : 1);
              const isLong = sign === 1;
              const signedSize = sign === -1 ? -Math.abs(rawSize) : Math.abs(rawSize);
              const pnl = Number(pos.unrealized_pnl || 0);
              const price = Number(pos.avg_entry_price || pos.entry_price || pos.price || 0);
              const mark = Number(pos.mark_price || pos.price || price);
              const notional = Math.abs(Number(pos.position_value || 0)) || Math.abs(rawSize) * mark;
              const liveLevCap = Number(this.botState?.risk_capacity?.gross_leverage_cap || 8);
              const margin = Math.abs(Number(pos.allocated_margin || 0)) || notional / liveLevCap;
              const roePct = margin > 0 ? pnl / margin * 100 : 0;
              const sideBadge = isLong
                ? '<span style="color:#16a34a;font-weight:800;background:#dcfce7;padding:2px 6px;border-radius:4px;">LONG</span>'
                : '<span style="color:#dc2626;font-weight:800;background:#fee2e2;padding:2px 6px;border-radius:4px;">SHORT</span>';
              return `<tr><td>L-${idx + 1}</td><td><strong>${sym}</strong></td><td>${sideBadge}</td><td style="font-family:monospace">${signedSize > 0 ? "+" : ""}${signedSize.toFixed(4)}</td><td>$${price.toFixed(price > 500 ? 3 : 2)}</td><td><b>$${notional.toFixed(2)}</b> USDT</td><td>$${margin.toFixed(2)}</td><td style="font-weight:700;color:${pnl >= 0 ? "#16a34a" : "#dc2626"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}<br><small>${roePct >= 0 ? "+" : ""}${roePct.toFixed(3)}%</small></td></tr>`;
            }).join("");
          } else {
            body.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#64748b;padding:24px 16px;line-height:1.6;">🛡️ All positions closed / flat (Take-profit mean-reversion executed)<br><small style="color:#059669;font-weight:700;">Check Execution History tab below for filled orders</small></td></tr>';
          }
        }
        this.updateLeverageMetrics();
        this.renderExecutionHistory();
        return;
      }

      const total = this.entries.reduce((sum, entry) => sum + entry.notional, 0);
      const accountCollateral = Number(this.liveVenue?.collateral);
      this.setText("valAccountEquity", Number.isFinite(accountCollateral) ? `$${accountCollateral.toFixed(2)}` : "—");
      this.setText("badgeEquitySource", Number.isFinite(accountCollateral) ? "LIGHTER L2" : "SYNCING");
      this.setText("valHedgedTranches", `${this.entries.length} / 8 Grid Units`);
      const paperGross = total * 2;
      this.setText("valHedgedQuantities", `Gross $${paperGross.toFixed(2)} virtual · Est. 1x Margin $${paperGross.toFixed(2)}`);
      this.setText("valHedgedCombinedPnl", this.virtualPnlText());
      this.setText("valHedgedPnlSubtitle", this.entries.length > 0 ? "Simulated Grid Position" : "No active paper tranches");
      this.setText("valActivePairs", this.entries.length ? `${this.entries.length} Active Rungs` : "0 Open (Flat)");
      this.setText("valUnrealizedPnl", this.virtualPnlText());
      this.setText("countPositions", String(this.entries.length));
      const body = lid("activePositionsBody");
      const positionSummary = lid("activePositionsSummary");
      if (positionSummary) positionSummary.innerHTML = `<span>Paper gross size <b>$${paperGross.toFixed(2)}</b></span><span>Est. 1x margin <b>$${paperGross.toFixed(2)}</b></span><span style="color:#64748b">Simulated, $${total.toFixed(2)} per-leg targets</span>`;
      if (body) body.innerHTML = this.entries.length ? this.entries.map((entry, index) => {
        const gross = Number(entry.notional || 0) * 2;
        return `<tr><td>G-${index + 1}</td><td><strong>SKHY / SKHYNIXUSD</strong></td><td>${entry.side < 0 ? "SHORT / LONG" : "LONG / SHORT"}</td><td>Pair</td><td>${entry.ratio.toFixed(3)}%</td><td><b>$${gross.toFixed(2)}</b> virtual</td><td>$${gross.toFixed(2)}</td><td>${this.virtualPnlText()}</td></tr>`;
      }).join("") : '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:20px;">No active grid positions</td></tr>';
      this.updateLeverageMetrics();
      this.renderExecutionHistory();
    },

    renderExecutionHistory() {
      const historyBody = lid("executionHistoryBody");
      if (!historyBody) return;

      const normalized = Array.isArray(this.botState?.execution_history) ? this.botState.execution_history : [];
      const legacy = Array.isArray(this.botState?.history) ? this.botState.history : [];
      const history = normalized.length ? normalized : legacy;
      if (history.length) {
        const persistedCount = Number(this.botState?.history_event_count || history.length);
        this.setText("countOrderLog", String(persistedCount));
        const exits = history.filter((trade) => trade.event === "EXIT" || trade.is_exit);
        const authoritativeExits = exits.filter((trade) => trade.pnl_authoritative || trade.pnl_source === "LIGHTER_REALIZED_PNL");
        const totalFees = history.reduce((sum, trade) => {
          const isExit = trade.event === "EXIT" || trade.is_exit;
          return sum + Number(isExit ? (trade.exit_fee_usd ?? trade.fee_usd ?? 0) : (trade.fee_usd || 0));
        }, 0);
        const totalGrossTurnover = history.reduce((sum, trade) => sum + this.tradeExposure(trade).gross, 0);
        const wins = authoritativeExits.filter((trade) => Number(trade.net_pnl_usd ?? trade.pnl ?? 0) > 0).length;
        const summary = lid("executionHistorySummary");
        if (summary) {
          const verifiedSummary = this.verifiedRealizedSummary();
          summary.innerHTML = `<span><b>${persistedCount}</b> persisted events${persistedCount > history.length ? ` · latest ${history.length} shown` : ""}</span><span><b>${verifiedSummary.count}</b> verified exits</span><span>Recent displayed turnover <b>$${totalGrossTurnover.toFixed(2)}</b></span><span>Recent recorded fees <b>$${totalFees.toFixed(4)}</b></span><span>All-time verified net P&L <b style="color:${verifiedSummary.pnl >= 0 ? '#16a34a' : '#dc2626'}">${verifiedSummary.pnl >= 0 ? '+' : ''}$${verifiedSummary.pnl.toFixed(4)}</b></span><span>Displayed verified win rate <b>${authoritativeExits.length ? (wins / authoritativeExits.length * 100).toFixed(1) : '0.0'}%</b></span><span style="color:#64748b">Actual Lighter fills · legacy estimates excluded</span>`;
        }
        historyBody.innerHTML = history.slice().reverse().map((trade) => {
          const timeStr = formatKstDateTime(trade.time ? trade.time * 1000 : Date.now());
          const isExit = trade.event === "EXIT" || Boolean(trade.is_exit);
          const originalSide = isExit ? Number(trade.original_side ?? -Number(trade.side || 0)) : Number(trade.side || 0);
          const isShort = originalSide < 0;
          const eventBadge = isExit
            ? '<span style="color:#0369a1;font-weight:900;background:#e0f2fe;padding:2px 7px;border-radius:4px;">EXIT</span>'
            : '<span style="color:#7c3aed;font-weight:900;background:#ede9fe;padding:2px 7px;border-radius:4px;">ENTRY</span>';
          const directionBadge = isShort
            ? '<span style="color:#dc2626;font-weight:800;">SHORT ADR / LONG KR</span>'
            : '<span style="color:#16a34a;font-weight:800;">LONG ADR / SHORT KR</span>';
          const sizeStr = `${Number(trade.adr_qty || 0).toFixed(4)} SKHY / ${Number(trade.domestic_qty || 0).toFixed(4)} KR`;
          const exposure = this.tradeExposure(trade);
          const exposureStr = `${sizeStr}<br><small>ADR $${exposure.adr.toFixed(2)} + KR $${exposure.domestic.toFixed(2)}<br><b>Gross $${exposure.gross.toFixed(2)} · est. 1x margin $${exposure.margin.toFixed(2)}</b></small>`;
          const entryRatio = Number(trade.entry_ratio || 0);
          const exitRatio = Number(trade.exit_ratio || (isExit ? trade.ratio : 0) || 0);
          const ratioStr = isExit && exitRatio
            ? `${entryRatio ? entryRatio.toFixed(4) + '% → ' : ''}${exitRatio.toFixed(4)}%`
            : (entryRatio ? `${entryRatio.toFixed(4)}%` : "—");
          const fee = Number(trade.fee_usd || 0);
          const feeBps = Number(trade.fee_bps || 0);
          const grossPnl = isExit ? Number(trade.gross_pnl_usd ?? trade.pnl ?? 0) : null;
          const netPnl = isExit ? Number(trade.net_pnl_usd ?? trade.pnl ?? 0) : null;
          const pnlPct = isExit ? Number(trade.pnl_pct ?? ((netPnl / Number(trade.notional_usd || 25)) * 100)) : null;
          const pnlVerified = trade.pnl_authoritative || trade.pnl_source === "LIGHTER_REALIZED_PNL";
          const pnlStr = isExit && pnlVerified
            ? `<div style="font-weight:800;color:${netPnl >= 0 ? '#16a34a' : '#dc2626'}">${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)} net (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}%)</div><small style="color:#64748b">Gross ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(4)}</small>`
            : (isExit ? '<span style="color:#b45309;font-weight:700">Legacy estimate excluded</span>' : '<span style="color:#64748b">Open cost basis</span>');
          const status = trade.status || (isExit ? "CLOSED" : "OPEN");
          return `<tr>
            <td style="font-family:monospace;font-size:11px;color:#475569;">${timeStr}</td>
            <td>${eventBadge}</td>
            <td>${directionBadge}</td>
            <td style="font-family:monospace;line-height:1.45;">${exposureStr}</td>
            <td style="font-family:monospace;font-weight:700;">${ratioStr}</td>
            <td style="font-family:monospace;color:#64748b;">$${fee.toFixed(4)}<br><small>${feeBps.toFixed(2)} bps</small></td>
            <td>${pnlStr}</td>
            <td><span style="color:${status === 'CLOSED' ? '#059669' : '#0369a1'};font-weight:800;">● ${status}</span></td>
          </tr>`;
        }).join("");
      } else {
        const ledger = Array.isArray(this.ledger) ? this.ledger : [];
        this.setText("countOrderLog", String(ledger.length));
        const summary = lid("executionHistorySummary");
        if (summary) summary.textContent = ledger.length ? `${ledger.length} paper execution events` : "No persisted live or paper executions";
        if (!ledger.length) {
          historyBody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#94a3b8;padding:24px;">No paper executions logged yet</td></tr>';
          return;
        }
        historyBody.innerHTML = ledger.slice(0, 50).map((row) => {
          const timeStr = formatKstDateTime(row.time || Date.now(), false);
          const isExit = row.action === "EXIT";
          const isShort = row.side < 0 || row.action === "SHORT RATIO";
          const sideBadge = isExit
            ? '<span style="color:#059669;font-weight:800;background:#d1fae5;padding:2px 6px;border-radius:4px;">PAPER EXIT</span>'
            : (isShort
              ? '<span style="color:#dc2626;font-weight:800;background:#fee2e2;padding:2px 6px;border-radius:4px;">PAPER SHORT</span>'
              : '<span style="color:#16a34a;font-weight:800;background:#dcfce7;padding:2px 6px;border-radius:4px;">PAPER LONG</span>');
          const pnlVal = row.pnl != null ? Number(row.pnl) : null;
          const pnlStr = pnlVal != null
            ? `<span style="font-weight:700;color:${pnlVal >= 0 ? "#16a34a" : "#dc2626"}">${pnlVal >= 0 ? "+" : ""}$${pnlVal.toFixed(2)}</span>`
            : "—";
          return `<tr>
            <td style="font-family:monospace;font-size:11px;color:#475569;">${timeStr}</td>
            <td><strong>SKHY / SKHYNIXUSD</strong></td>
            <td>${sideBadge}</td>
            <td style="font-family:monospace;line-height:1.45;">$${Number(row.notional || 0).toFixed(2)} / leg<br><small><b>Gross $${(Number(row.notional || 0) * 2).toFixed(2)} · est. 1x margin $${(Number(row.notional || 0) * 2).toFixed(2)}</b></small></td>
            <td style="font-family:monospace;font-weight:700;">${row.ratio ? row.ratio.toFixed(3) + "%" : "—"}</td>
            <td style="color:#64748b;">$0.00</td>
            <td>${pnlStr}</td>
            <td><span style="color:#64748b;font-weight:700;">SIMULATED</span></td>
          </tr>`;
        }).join("");
      }
    }
  };

  window.lighterEngine = lighterEngine;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => lighterEngine.init());
  } else {
    lighterEngine.init();
  }
})();
