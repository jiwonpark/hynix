(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = "skhynix_lighter_virtual_ledger_v2";
  const STRATEGY_STORAGE_KEY = "skhynix_lighter_selected_strategy";
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
          rowCondEntryLeverage: "7. Fixed 1.0x Position Sizing",
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
      this.setText("lblDaemonUpbitBadge", "RISK TIER: TIER 2 (1x NEUTRAL)");
      this.setText("valDeployedStrategyName", "🏛️ Institutional Grid Engine (Multi-Tier Parity Bands)");
      this.setText("valDeployedEngine", "Asymmetric Delta-Neutral Parity Grid Harvester");
      this.setText("valDeployedInterval", "5m completed candles");
      this.setText("valDeployedWindow", "24 completed bars");
      this.setText("valDeployedEdge", "Entry |Z| ≥ 1.50");
      this.setText("valDeployedMaxLeverage", "100% (1.0x)");
      this.setText("valDeployedSpeed", "Configurable order cooldown (1–1440m)");
      this.setText("valDeployedMinProfit", "Exit |Z| ≤ 0.25");
      this.setText("valDeployedCost", "0 BPS advertised fee / slippage excluded");
      this.setText("lblAccountEquity", "Virtual Grid Capital");
      this.setText("badgeEquitySource", "SIMULATED");
      this.setText("valAccountEquity", "$10,000.00");
      this.setText("lblAvailMargin", "Free Grid Margin");
      this.setText("valAvailMargin", "$8,240.00");
      this.setText("lblUnrealizedPnl", "Grid Harvested PnL");
      this.setText("lblActivePairs", "Active Grid Rungs");
      this.setText("lblMarginRisk", "Target Leverage");
      this.setText("valMarginRisk", "1.0x");
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

      // Custom-labeled Scale-In Checklist for Grid Bands
      const entryLabelMap = {
        rowCondEntryMaStretch: "1. Grid Band Trigger (Upper Rung ≥ +0.12%)",
        rowCondEntryBase: "2. ATR Dynamic Volatility Spacing",
        rowCondEntryPeak: "3. 5m Peak Rollover Filter (Exhaustion Gate)",
        rowCondEntryMaStack5m: "4. 5m Micro-Trend Neutrality Confirmation",
        rowCondEntryMaStack1h: "5. 1h Macro Divergence Boundary",
        rowCondEntryCapacity: "6. Max Active Grid Tiers (Cap: 8 Rungs)",
        rowCondEntryLeverage: "7. Fixed 1.0x Position Sizing",
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

      const paper = lid("modePaper");
      const semi = lid("modeSemiAuto");
      const live = lid("modeLive");
      const kill = lid("btnKillSwitch");
      const resetPaper = lid("btnResetPaperBalance");
      const auto = lid("lblAutoPeriodicText");
      if (auto) auto.textContent = "24/7 EC2 Lighter bot (continues when this browser closes)";

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
          status: "PAPER ONLY · Select a strategy and interval, then rerun",
          description: "Paper results intentionally change with the selected candle interval and strategy. These controls never reconfigure the real EC2 bot.",
          secondaryStatus: "Historical replay only · Live bot remains fixed to Dynamic Grid on completed 5m candles.",
          height: 420,
          legend: '<span style="color:#0284c7"><span style="display:inline-block;width:10px;height:3px;background:#0284c7"></span> Parity</span><span id="lighter_legendShortMa7" style="cursor:pointer;color:#b45309">— 7-MA: <strong id="lighter_valShortTermMa7">--%</strong></span><span id="lighter_legendShortMa24" style="cursor:pointer;color:#6d28d9">— 24-MA: <strong id="lighter_valShortTermMa24">--%</strong></span><span id="lighter_legendShortMa60" style="cursor:pointer;color:#0891b2">— 60-MA: <strong id="lighter_valShortTermMa60">--%</strong></span><span><strong style="color:#dc2626">▼</strong>/<strong style="color:#16a34a">▲</strong> Actual</span><span><strong style="color:#dc2626;opacity:.45">⇩</strong>/<strong style="color:#16a34a;opacity:.45">⇧</strong> Virtual</span><span style="color:#0f766e">Selected net PnL: <strong id="lighter_valShortTermNetPnl">--</strong> · Exit &gt; <strong id="lighter_valSelectedMinProfit">—</strong></span><span>Scale-In</span>',
          syncText: "Updated 0s ago",
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
        this.setText("valCalculatedMargin", "1x pair sizing");
        if (!lid("orderIntervalControl")) {
          const intervalControl = document.createElement("div");
          intervalControl.id = "lighter_orderIntervalControl";
          intervalControl.className = "ticketRow";
          intervalControl.style.cssText = "display:grid;grid-template-columns:minmax(150px,1fr) 110px auto;align-items:end;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid #e2e8f0";
          intervalControl.innerHTML = `
            <label for="lighter_inputOrderIntervalMinutes" style="font-size:11px;font-weight:800;color:#475569;line-height:1.35">
              Minimum order interval
              <small style="display:block;color:#64748b;font-weight:600">Minutes between paired market-order actions</small>
            </label>
            <input id="lighter_inputOrderIntervalMinutes" type="number" min="1" max="1440" step="1" value="5" aria-label="Minimum order interval in minutes" style="height:34px;margin:0;font-weight:800">
            <button id="lighter_btnSaveOrderInterval" type="button" style="height:34px;padding:0 12px;border:0;border-radius:6px;background:#0284c7;color:#fff;font-size:11px;font-weight:800;cursor:pointer">Save interval</button>`;
          ticket.append(intervalControl);
        }
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
      const saveInterval = lid("btnSaveOrderInterval");
      if (saveInterval) saveInterval.addEventListener("click", () => this.saveLiveBotInterval());
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
        const headers = ["Timestamp (KST)", "Event", "Direction", "Filled Size", "Entry → Exit Ratio", "Fees", "Net P&L / Return", "Status"];
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

      const controllerCard = lid("hedgedControllerCard");
      if (controllerCard && !$("lighterLiveRulesPanel")) {
        const panel = document.createElement("section");
        panel.id = "lighterLiveRulesPanel";
        panel.style.cssText = "margin:12px 0;padding:13px 14px;border:2px solid #059669;border-radius:9px;background:#ecfdf5;color:#064e3b";
        panel.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:9px">
            <strong style="font-size:13px;letter-spacing:.35px">REAL EC2 BOT — FIXED PRODUCTION RULES</strong>
            <span id="lighterLiveRulesState" style="font-size:10px;font-weight:900;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#475569">LOADING</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:7px;font-size:11px;line-height:1.4">
            <div><b>Engine</b><br>Dynamic Grid only</div>
            <div><b>Data</b><br>Completed 5m candles · 24-bar mean/std</div>
            <div><b>Entry</b><br>|Z| ≥ <span id="lighterLiveEntryZ">1.50</span></div>
            <div><b>Direction</b><br>Z high: short SKHY / long KR<br>Z low: long SKHY / short KR</div>
            <div><b>Exit</b><br>|Z| ≤ <span id="lighterLiveExitZ">0.25</span> · no separate PnL gate</div>
            <div><b>Size / capacity</b><br>$<span id="lighterLiveNotional">25</span> · max <span id="lighterLiveMaxTranches">3</span> tranches · 1x</div>
            <div><b>Execution guards</b><br>Book spread ≤ <span id="lighterLiveMaxSpread">45</span> bps · <span id="lighterLiveCooldown">5m</span> cooldown</div>
            <div><b>Current evaluation</b><br><span id="lighterLiveEvaluation">Awaiting completed bar</span></div>
          </div>
          <div style="margin-top:10px;padding:8px 10px;border-radius:6px;background:#fff7ed;color:#9a3412;font-size:11px;font-weight:800">The chart interval, selected paper strategy, condition switches, and “Rerun Paper” do not change any rule above.</div>`;
        const telemetry = controllerCard.querySelector(".hedgedTelemetryCard");
        if (telemetry) controllerCard.insertBefore(panel, telemetry);
        else controllerCard.prepend(panel);
      }

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
      localStorage.setItem(STRATEGY_STORAGE_KEY, mode);
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
      this.updateRulesMatchStatus();
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
      const spacingEl = $("lighter_valGridSpacing");
      if (spacingEl) spacingEl.textContent = `±${step.toFixed(3)}% (${tier.name.split(":")[1]?.trim() || "Dynamic"})`;

      const activeRungsEl = $("lighter_valActiveRungs");
      const activeCount = this.mode === "live"
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
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
        this.entries = Array.isArray(saved.entries) ? saved.entries : [];
        this.ledger = Array.isArray(saved.ledger) ? saved.ledger : [];
      } catch (_) {}
      const selectedStrategy = localStorage.getItem(STRATEGY_STORAGE_KEY);
      if (this.paradigms[selectedStrategy]) this.currentParadigm = selectedStrategy;
      this.mode = localStorage.getItem("skhynix_lighter_mode") || "paper";
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
      this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.renderTrendRanges());

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
          stock: this.assetChart.addLineSeries({ priceScaleId: 'left', color: '#d97706', lineWidth: 2, title: 'SKHYNIXUSD' }),
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
      if (host && this.chart && host.clientWidth > 0) {
        this.chart.applyOptions({ width: host.clientWidth });
        this.renderTrendRanges();
      }
      const assetHost = lid("shortTermAssetHost");
      if (assetHost && this.assetChart && assetHost.clientWidth > 0) this.assetChart.applyOptions({ width: assetHost.clientWidth });
    },

    async refresh() {
      try {
        let status, botStatus, trendStatus;
        try {
          status = await api("/api/lighter/status");
          const sParam = encodeURIComponent(this.smallTrendInterval || "5m");
          const bParam = encodeURIComponent(this.bigTrendInterval || "1h");
          [botStatus, trendStatus] = await Promise.all([
            api("/api/lighter/bot/status").catch(() => null),
            api(`/api/lighter/trends?small=${sParam}&big=${bParam}`).catch(() => null),
          ]);
        } catch (_) {
          status = { success: true, parity_ratio: 140.09, server_time_ms: Date.now(), adr: { spread_bps: 12 }, domestic: { spread_bps: 15 } };
        }
        this.liveVenue = status;
        this.livePositions = Array.isArray(status?.positions) ? status.positions : [];
        await this.refreshChart();
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
        if (trendStatus?.trends) this.renderTrends(trendStatus.trends);
        this.renderVirtualState();
        this.updateGridLadderData();
      } catch (error) {
        this.setText("lblHedgedSyncBadge", `GRID ENGINE: ${error.message}`);
      }
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
        if (res?.trends) this.renderTrends(res.trends);
      } catch (_) {}
    },

    updateRulesMatchStatus() {
      const isIntervalMatch = this.interval === "5m";
      const isParadigmMatch = this.currentParadigm === "grid";
      const isBotActive = Boolean(this.botState?.enabled);

      const pill = $("lighterMatchPill");
      if (!pill) return;

      if (isIntervalMatch && isParadigmMatch) {
        if (isBotActive) {
          pill.textContent = "● LIVE-MATCHED (5m · Grid · Bot Active)";
          pill.style.background = "#dcfce7";
          pill.style.color = "#166534";
          pill.style.borderColor = "#86efac";
        } else {
          pill.textContent = "○ LIVE-MATCHED (5m · Grid · Bot Paused)";
          pill.style.background = "#fef3c7";
          pill.style.color = "#92400e";
          pill.style.borderColor = "#fcd34d";
        }
      } else {
        const diffs = [];
        if (!isIntervalMatch) diffs.push(`Interval ${this.interval} ≠ 5m`);
        if (!isParadigmMatch) diffs.push(`Strategy ${this.paradigms[this.currentParadigm]?.name || this.currentParadigm} ≠ Grid`);
        pill.textContent = `▲ PAPER DIVERGENT (${diffs.join(" · ")})`;
        pill.style.background = "#fff7ed";
        pill.style.color = "#c2410c";
        pill.style.borderColor = "#fdba74";
      }
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

    renderTrendRanges() {
      const layer = $("lighterTrendBandLayer");
      const host = lid("shortTermSpreadChartHost");
      if (!layer || !host || !this.chart || !this.trendRanges.length) return;
      const scale = this.chart.timeScale();
      const width = host.clientWidth;
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
      const toggle = lid("chkAutoPeriodic48h");
      if (toggle) {
        toggle.checked = isEnabled;
        toggle.disabled = Boolean(window.terminalLockManager?.isLocked) || !venue?.execution_enabled || isRecovery;
      }
      const badge = lid("badgeAutoPeriodicStatus");
      if (badge) {
        badge.style.display = "inline-block";
        badge.textContent = isEnabled ? "● EC2 LIVE BOT ACTIVE" : (isRecovery ? "⚠ RECOVERY REQUIRED" : "○ EC2 BOT PAUSED");
        badge.style.background = isEnabled ? "#dcfce7" : (isRecovery ? "#fef3c7" : "#f1f5f9");
        badge.style.color = isEnabled ? "#166534" : (isRecovery ? "#92400e" : "#475569");
      }
      this.setText("lblDaemonLatency", isEnabled ? "Lighter Bot: Running on EC2" : "Lighter Bot: Paused");
      this.setText("lblDaemonStats", bot?.last_evaluation ? `Z ${Number(bot.last_evaluation.z || 0).toFixed(2)} · ${tranches.length}/${bot?.max_tranches || 3} tranches` : "Awaiting first closed-bar evaluation");
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
      writeRule("lighterLiveEntryZ", Number(bot?.entry_z ?? 1.5).toFixed(2));
      writeRule("lighterLiveExitZ", Number(bot?.exit_z ?? 0.25).toFixed(2));
      writeRule("lighterLiveNotional", Number(bot?.notional_usd ?? 25).toFixed(0));
      writeRule("lighterLiveMaxTranches", String(bot?.max_tranches ?? 3));
      writeRule("lighterLiveMaxSpread", Number(bot?.max_book_spread_bps ?? 45).toFixed(0));
      const cooldownMinutes = Math.max(1, Math.round(Number(bot?.min_seconds_between_orders ?? 300) / 60));
      writeRule("lighterLiveCooldown", `${cooldownMinutes}m`);
      writeRule("lighterLiveEvaluation", bot?.last_evaluation
        ? `Z ${Number(bot.last_evaluation.z || 0).toFixed(3)} · ratio ${Number(bot.last_evaluation.ratio || 0).toFixed(3)}% · mean ${Number(bot.last_evaluation.mean || 0).toFixed(3)}%`
        : "Awaiting completed bar");
      const notionalInput = lid("inputOrderNotional");
      if (notionalInput && document.activeElement !== notionalInput) {
        notionalInput.value = String(bot?.notional_usd || 25);
        notionalInput.min = "10"; notionalInput.max = "500"; notionalInput.step = "5";
      }
      const intervalInput = lid("inputOrderIntervalMinutes");
      if (intervalInput && document.activeElement !== intervalInput) {
        intervalInput.value = String(cooldownMinutes);
      }
      this.setText("valDeployedSpeed", `${cooldownMinutes}-minute order cooldown`);
      const engineCondition = lid("rowCondEntryEngine")?.querySelector(".condLabel");
      if (engineCondition) engineCondition.textContent = `9. Grid Engine State & ${cooldownMinutes}m Cooldown`;
      this.setText("valCritRetainedCore", `${tranches.length} tracked pair tranche${tranches.length === 1 ? "" : "s"}`);
      if (bot?.last_error) this.setText("lblHedgedSyncBadge", `BOT PAUSED: ${bot.last_error}`);
      this.updateRulesMatchStatus();
      this.updateLeverageMetrics();
    },

    updateLeverageMetrics() {
      const levCap = 8.0;
      let grossNotional = 0;
      let collateral = 187.55;
      let adrQty = 0;
      let domesticQty = 0;
      let adrNotional = 0;
      let domesticNotional = 0;
      let tranchesCount = 0;
      let maxTranches = 8;

      if (this.mode === "live") {
        collateral = this.liveVenue?.collateral != null ? Number(this.liveVenue.collateral) : 187.55;
        const positions = Array.isArray(this.livePositions) ? this.livePositions : [];
        positions.forEach((pos) => {
          const rawSize = Number(pos.position || pos.size || 0);
          const size = Math.abs(rawSize);
          const price = Number(pos.avg_entry_price || pos.entry_price || pos.price || 0);
          const notional = Number(pos.position_value) > 0 ? Number(pos.position_value) : (size * price);
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
          grossNotional = tranchesCount * singleLeg * 2;
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
      const freeMarginUsd = Math.max(0, collateral - (grossNotional / levCap));
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
      this.setText("valHedgedNotional", `Notional: $${grossNotional.toFixed(2)} USDT`);

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
      this.setText("lblTranchePct", `${utilPct.toFixed(1)}% (${grossLev.toFixed(2)}x / ${levCap.toFixed(1)}x)`);
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

      const reqMarginPerTranche = Number(this.orderNotional() || 25) / levCap;
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
      try {
        if (enabled) {
          const notional = Math.max(10, Math.min(500, Number(lid("inputOrderNotional")?.value || 25)));
          const intervalMinutes = this.orderIntervalMinutes();
          const confirmed = window.confirm(`Enable REAL 24/7 Lighter trading on EC2?\n\nPair: SKHY / SKHYNIXUSD (no 2x ETF)\nSizing: $${notional.toFixed(0)} per SKHY leg, 1x\nMinimum interval: ${intervalMinutes} minute${intervalMinutes === 1 ? "" : "s"}\n\nThe bot may place orders after the next closed-bar signal.`);
          if (!confirmed) { if (toggle) toggle.checked = false; return false; }
          await apiPost("/api/lighter/bot/config", { notional_usd: notional, min_seconds_between_orders: intervalMinutes * 60 });
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

    orderIntervalMinutes() {
      const input = lid("inputOrderIntervalMinutes");
      const raw = Number(input?.value || Math.round(Number(this.botState?.min_seconds_between_orders || 300) / 60));
      const minutes = Math.max(1, Math.min(1440, Math.round(Number.isFinite(raw) ? raw : 5)));
      if (input) input.value = String(minutes);
      return minutes;
    },

    async saveLiveBotInterval() {
      const button = lid("btnSaveOrderInterval");
      const minutes = this.orderIntervalMinutes();
      if (button) button.disabled = true;
      try {
        const data = await apiPost("/api/lighter/bot/config", { min_seconds_between_orders: minutes * 60 });
        if (data?.bot) this.updateBotStatus(data.bot, this.liveVenue || { execution_enabled: true });
        window.showToast?.(`Live bot minimum order interval saved: ${minutes} minute${minutes === 1 ? "" : "s"}.`, "success");
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
      let data;
      try {
        data = await api(`/api/lighter/parity?interval=${this.interval}&limit=300`);
      } catch (_) {
        data = await api(`/api/trade/short_term_parity?interval=${this.interval}&limit=120`);
      }
      if (!data || !data.success || !data.bars || !data.bars.length) return;
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
          const sVal = b.domestic != null ? b.domestic : b.csop;
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
        time: marker.time,
        position: marker.position || (marker.is_entry ? "aboveBar" : "belowBar"),
        color: marker.color || (marker.is_entry ? "rgba(220, 38, 38, 0.70)" : "rgba(22, 163, 74, 0.85)"),
        activeColor: marker.activeColor || (marker.is_entry ? "#dc2626" : "#16a34a"),
        shape: marker.shape || (marker.is_entry ? "arrowDown" : "arrowUp"),
        text: marker.text || (marker.is_entry ? "" : "COVER"),
        hoverText: marker.hoverText || marker.text || "Actual",
        source: "actual",
        hypothetical: false,
        is_entry: marker.is_entry !== false,
        is_exit: Boolean(marker.is_exit || marker.is_entry === false),
        entry_price: marker.entry_price || marker.ratio || marker.value,
        exit_price: marker.exit_price || (marker.is_entry ? null : (marker.ratio || marker.value)),
        ratio: marker.ratio || marker.value,
        pnl: marker.pnl,
        pnl_pct: marker.pnl_pct,
      })) : [];
      this.renderMarkers();
      this.renderCurrentPositionReferenceLines();
      this.chart.timeScale().fitContent();
      window.requestAnimationFrame(() => this.renderTrendRanges());
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
      localStorage.setItem("skhynix_lighter_mode", mode);
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
      window.showToast?.(`Submitting live 1x pair order ($${notional}) on Lighter DEX...`, "info");
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
      const count = this.entries.length;
      let totalPnl = 0;
      this.entries.forEach((entry) => {
        const pnl = entry.notional * entry.side * (this.currentRatio - entry.ratio) / entry.ratio;
        totalPnl += pnl;
        this.ledger.unshift({
          time: Date.now(),
          ratio: this.currentRatio,
          notional: entry.notional,
          action: "EXIT",
          pnl,
        });
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
      const paperMarkers = this.ledger.slice(0, 40).map((row) => {
        const isExit = row.action === "EXIT";
        const isShort = row.side < 0 || row.action === "SHORT RATIO";
        return {
          time: TerminalCommon.alignTime(this.bars, row.time / 1000),
          position: isExit ? (isShort ? "belowBar" : "aboveBar") : (isShort ? "aboveBar" : "belowBar"),
          color: isExit ? "#10b981" : (isShort ? "#7c3aed" : "#2563eb"),
          shape: isExit ? (isShort ? "arrowUp" : "arrowDown") : (isShort ? "arrowDown" : "arrowUp"),
          text: "",
          hoverText: isExit
            ? `COVER ${row.ratio ? row.ratio.toFixed(2) + "%" : ""}${row.pnl != null ? " · " + (row.pnl >= 0 ? "+" : "") + "$" + row.pnl.toFixed(2) : ""}`
            : `${isShort ? "SHORT" : "BUY"} ${row.ratio ? row.ratio.toFixed(2) + "%" : ""} ($${(row.notional || 0).toFixed(0)})`,
          source: "virtual",
          hypothetical: true,
          is_paper: true,
          is_entry: !isExit,
          ratio: row.ratio,
          entry_price: row.ratio,
          exit_price: isExit ? row.ratio : null,
          pnl: row.pnl,
        };
      });
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
        if (summary) summary.innerHTML = `[<strong>PAPER · ${pName} · ${this.interval}</strong>] <strong>${data.summary.trades}</strong> trades · <strong>${data.summary.win_rate.toFixed(1)}%</strong> wins · net <strong>${data.summary.net_pct >= 0 ? "+" : ""}${data.summary.net_pct.toFixed(3)}%</strong> · <em>live rules unchanged</em>`;

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
      if (this.mode === "live") {
        const col = this.liveVenue?.collateral != null ? Number(this.liveVenue.collateral) : 187.55;
        const validTranches = (this.botState?.tranches || []).filter(t => (t.adr_qty > 0 || t.domestic_qty > 0));
        const liveUnrealized = (this.livePositions || []).reduce((acc, pos) => acc + Number(pos.unrealized_pnl || 0), 0);
        const pnlPct = col > 0 ? (liveUnrealized / col) * 100 : 0;
        const pnlSign = liveUnrealized >= 0 ? "+" : "";
        const pnlText = `${pnlSign}$${liveUnrealized.toFixed(2)} (${pnlSign}${pnlPct.toFixed(2)}%)`;
        this.setText("valAccountEquity", `$${col.toFixed(2)}`);
        this.setText("badgeEquitySource", "LIGHTER L2");
        const openLive = (this.livePositions || []).filter(p => Math.abs(Number(p.position || p.size || 0)) > 1e-6);
        this.setText("valActivePairs", `${openLive.length} Open on Exchange`);
        const maxTranches = Number(this.botState?.max_tranches || 8);
        this.setText("valHedgedTranches", `${validTranches.length} / ${maxTranches} Active Units`);
        this.setText("valHedgedQuantities", "SKHY / SKHYNIXUSD 1x Pair");
        this.setText("valHedgedCombinedPnl", this.botState?.last_error ? `Error: ${this.botState.last_error}` : pnlText);
        const pnlEl = lid("valHedgedCombinedPnl");
        if (pnlEl) pnlEl.style.color = liveUnrealized > 0 ? "#16a34a" : (liveUnrealized < 0 ? "#dc2626" : "#0f172a");
        this.setText("valHedgedPnlSubtitle", validTranches.length > 0 ? (liveUnrealized >= 0 ? "✅ Positive Net Return (Take-Profit Eligible)" : "Holding (Awaiting Convergence)") : "All positions flat (Awaiting signal)");
        this.setText("valUnrealizedPnl", `${pnlSign}$${liveUnrealized.toFixed(2)}`);
        this.setText("countPositions", String(openLive.length));

        const body = lid("activePositionsBody");
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
              const sideBadge = isLong
                ? '<span style="color:#16a34a;font-weight:800;background:#dcfce7;padding:2px 6px;border-radius:4px;">LONG</span>'
                : '<span style="color:#dc2626;font-weight:800;background:#fee2e2;padding:2px 6px;border-radius:4px;">SHORT</span>';
              return `<tr><td>L-${idx + 1}</td><td><strong>${sym}</strong></td><td>${sideBadge}</td><td>$${price.toFixed(price > 500 ? 3 : 2)}</td><td>${signedSize > 0 ? "+" : ""}${signedSize.toFixed(4)}</td><td style="font-weight:700;color:${pnl >= 0 ? "#16a34a" : "#dc2626"}">${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</td></tr>`;
            }).join("");
          } else {
            body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b;padding:24px 16px;line-height:1.6;">🛡️ All positions closed / flat (Take-profit mean-reversion executed)<br><small style="color:#059669;font-weight:700;">Check Execution History tab below for filled orders</small></td></tr>';
          }
        }
        this.updateLeverageMetrics();
        this.renderExecutionHistory();
        return;
      }

      const total = this.entries.reduce((sum, entry) => sum + entry.notional, 0);
      this.setText("valAccountEquity", "$10,000.00");
      this.setText("badgeEquitySource", "SIMULATED");
      this.setText("valHedgedTranches", `${this.entries.length} / 8 Grid Units`);
      this.setText("valHedgedQuantities", `$${total.toFixed(0)} notional · ${this.virtualPnlText()} unrealized`);
      this.setText("valHedgedCombinedPnl", this.virtualPnlText());
      this.setText("valHedgedPnlSubtitle", this.entries.length > 0 ? "Simulated Grid Position" : "No active paper tranches");
      this.setText("valActivePairs", this.entries.length ? `${this.entries.length} Active Rungs` : "0 Open (Flat)");
      this.setText("valUnrealizedPnl", this.virtualPnlText());
      this.setText("countPositions", String(this.entries.length));
      const body = lid("activePositionsBody");
      if (body) body.innerHTML = this.entries.length ? this.entries.map((entry, index) => `<tr><td>G-${index + 1}</td><td>SKHY / SKHYNIXUSD</td><td>${entry.side < 0 ? "SHORT / LONG" : "LONG / SHORT"}</td><td>${entry.ratio.toFixed(3)}%</td><td>$${entry.notional.toFixed(0)}</td><td>${this.virtualPnlText()}</td></tr>`).join("") : '<tr><td colspan="6" style="text-align:center;color:#94a3b8;padding:20px;">No active grid positions</td></tr>';
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
        this.setText("countOrderLog", String(history.length));
        const exits = history.filter((trade) => trade.event === "EXIT" || trade.is_exit);
        const totalFees = history.reduce((sum, trade) => {
          const isExit = trade.event === "EXIT" || trade.is_exit;
          return sum + Number(isExit ? (trade.exit_fee_usd ?? trade.fee_usd ?? 0) : (trade.fee_usd || 0));
        }, 0);
        const totalNet = exits.reduce((sum, trade) => sum + Number(trade.net_pnl_usd ?? trade.pnl ?? 0), 0);
        const wins = exits.filter((trade) => Number(trade.net_pnl_usd ?? trade.pnl ?? 0) > 0).length;
        const summary = lid("executionHistorySummary");
        if (summary) {
          summary.innerHTML = `<span><b>${history.length}</b> persisted events</span><span><b>${exits.length}</b> completed exits</span><span>Fees <b>$${totalFees.toFixed(4)}</b></span><span>Net P&L <b style="color:${totalNet >= 0 ? '#16a34a' : '#dc2626'}">${totalNet >= 0 ? '+' : ''}$${totalNet.toFixed(4)}</b></span><span>Win rate <b>${exits.length ? (wins / exits.length * 100).toFixed(1) : '0.0'}%</b></span><span style="color:#64748b">EC2 durable ledger · fee-adjusted ratio P&L</span>`;
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
          const pnlStr = isExit
            ? `<div style="font-weight:800;color:${netPnl >= 0 ? '#16a34a' : '#dc2626'}">${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)} net (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(3)}%)</div><small style="color:#64748b">Gross ${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(4)}</small>`
            : '<span style="color:#64748b">Open cost basis</span>';
          const status = trade.status || (isExit ? "CLOSED" : "OPEN");
          return `<tr>
            <td style="font-family:monospace;font-size:11px;color:#475569;">${timeStr}</td>
            <td>${eventBadge}</td>
            <td>${directionBadge}</td>
            <td style="font-family:monospace;">${sizeStr}</td>
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
            <td style="font-family:monospace;">$${(row.notional || 0).toFixed(0)} virtual</td>
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
