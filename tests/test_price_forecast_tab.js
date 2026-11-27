const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const modulePath = path.join(__dirname, "../price-forecast-tab.js");
delete require.cache[require.resolve(modulePath)];
const forecast = require(modulePath);

assert.equal(forecast.DEFAULT_SETTINGS.symbol, "ETHUSDT");
assert.equal(forecast.DEFAULT_SETTINGS.confidence_pct, 52);
assert.equal(forecast.DEFAULT_SETTINGS.daily_ma_period, 100);
assert.equal(forecast.DEFAULT_SETTINGS.entry_direction_mode, "long_only");
assert.equal(forecast.DEFAULT_SETTINGS.horizon_bars, 1);
assert.equal(forecast.DEFAULT_SETTINGS.min_hold_bars, 3);

function syntheticBars(count = 900) {
  const start = 1_700_000_000;
  const bars = [];
  for (let index = 0; index < count; index += 1) {
    const center = 100 + index * 0.012 + Math.sin(index / 19) * 2.1 + Math.sin(index / 6) * 0.7;
    const open = center - Math.sin(index / 4) * 0.13;
    const close = center + Math.cos(index / 5) * 0.14;
    bars.push({
      time: start + index * 300,
      close_time: start + (index + 1) * 300,
      open,
      high: Math.max(open, close) + 0.35,
      low: Math.min(open, close) - 0.35,
      close,
      volume: 100 + (index % 31),
    });
  }
  return bars;
}

const bars = syntheticBars();
const settings = forecast.normalizeSettings({
  ...forecast.DEFAULT_SETTINGS,
  min_train_samples: 120,
  train_window: 300,
  neutral_bps: 5,
});
const result = forecast.buildCausalForecast(bars, settings);

assert.equal(result.error, null);
assert.ok(result.latest, "latest completed candle must receive a forecast");
assert.ok(result.forecast_signals.length > 100, "final-quarter holdout must produce walk-forward forecasts");
assert.equal(result.validation.predictions, result.forecast_signals.length);
assert.ok(result.validation.rank_ic >= -1 && result.validation.rank_ic <= 1);
assert.ok(result.validation.brier >= 0 && result.validation.brier <= 1);
const probabilityTotal = Object.values(result.latest.probabilities).reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(probabilityTotal - 1) < 1e-12, "Up/Neutral/Down probabilities must sum to one");
assert.ok(result.latest.train_samples <= settings.train_window, "training window must be enforced");
assert.ok(result.indicators.maFast.slice(0, settings.ma_fast - 1).every((value) => value === null),
  "MA warm-up values must remain null rather than being coerced to zero and distorting the chart scale");

const sourceIndex = 600;
const originalAtSource = forecast.forecastAtIndex(bars, settings, sourceIndex);
const changedFuture = bars.map((bar, index) => index > sourceIndex
  ? { ...bar, open: bar.open * 4, high: bar.high * 4, low: bar.low * 4, close: bar.close * 4 }
  : { ...bar });
const changedAtSource = forecast.forecastAtIndex(changedFuture, settings, sourceIndex);
assert.deepEqual(changedAtSource, originalAtSource,
  "changing candles after the source time must not alter a historical forecast");

const noInputs = forecast.buildCausalForecast(bars, {
  ...settings,
  use_momentum: false,
  use_macd: false,
  use_rsi: false,
  use_ma: false,
  use_volatility: false,
});
assert.match(noInputs.error, /Enable at least one model input group/);

const momentumOnly = forecast.buildCausalForecast(bars, {
  ...settings,
  use_macd: false,
  use_rsi: false,
  use_ma: false,
  use_volatility: false,
});
assert.equal(momentumOnly.error, null);
assert.deepEqual(momentumOnly.latest.feature_names, ["return_1_bps", "return_6_bps", "momentum_accel_bps"],
  "feature switches must change the real fitted design matrix");

const now = 1_700_001_000;
const rawRows = [
  [1_700_000_000_000, "100", "101", "99", "100.5", "10", 1_700_000_299_000],
  [1_700_000_300_000, "100.5", "102", "100", "101", "12", 1_700_001_200_000],
];
const parsed = forecast.parseKlines(rawRows, "5m", now);
assert.equal(parsed.length, 1, "forming or future-close candles must be excluded");
assert.equal(parsed[0].close, 100.5);

const dupRows = [
  [1_700_000_000_000, "100", "101", "99", "100.5", "10", 1_700_000_299_000],
  [1_700_000_000_000, "100", "101.5", "99", "100.8", "15", 1_700_000_299_000],
];
const deduped = forecast.parseKlines(dupRows, "5m", now);
assert.equal(deduped.length, 1, "duplicate timestamps must be deduplicated cleanly");
assert.equal(deduped[0].close, 100.8, "latest duplicate candle update must be retained");

assert.ok(result.validation.rank_ic > 0.7, `expected strong causal rank IC on predictable sine series, got ${result.validation.rank_ic}`);
assert.ok(result.validation.hit_rate_pct > 65, `expected strong OOS hit rate on predictable sine series, got ${result.validation.hit_rate_pct}`);

const skewedResiduals = [...Array.from({ length: 45 }, (_, i) => ((i % 9) - 4) * 2.5 + 4), -200, -180, -160];
const posProbs = forecast.probabilityFromResiduals(2.0, skewedResiduals, 8);
const negProbs = forecast.probabilityFromResiduals(-2.0, skewedResiduals, 8);
assert.ok(posProbs.up > posProbs.down, "positive expected move must yield P(up) > P(down) despite crash tail skew");
assert.ok(negProbs.down > negProbs.up, "negative expected move must yield P(down) > P(up) despite crash tail skew");

const kstMidnightEpoch = Date.UTC(2023, 10, 15, 15, 0, 0) / 1000; // 2023-11-16 00:00:00 KST
assert.equal(forecast.formatKstTick(kstMidnightEpoch, 3), "11-16", "chart tick formatter must format UTC+9 KST midnight as date boundary");
assert.equal(forecast.formatKstTick(kstMidnightEpoch + 3600, 3), "01:00", "chart tick formatter must render KST HH:MM rather than UTC");

const source = fs.readFileSync(modulePath, "utf8");
assert.doesNotMatch(source, /RESEARCH ONLY · NO ORDERS/,
  "streamlined Tab 11 must remove research-only badge clutter");
assert.doesNotMatch(source, /pfForecastRows|pfRankIc|pfBrier/,
  "non-essential walk-forward research KPIs/table must be removed");
assert.match(source, /completed 4h candles|completed.*bar/,
  "UI must disclose completed-candle evaluation vs forming bar");
assert.match(source, /pfTradeTrianglesLayer/,
  "Tab 11 chart must include Tab 4 SVG paired trade triangles layer");
assert.match(source, /pfHistoryBody/,
  "Tab 11 must include Tab 4-style Historical Trades table");
assert.match(source, /focusTradePair[\s\S]*?setVisibleRange/,
  "clicking a historical trade must move the chart to its paired entry and exit markers");
assert.match(source, /terminal-action-control/,
  "live bot buttons must integrate with fail-closed read-only lock");
assert.doesNotMatch(source, /Enable AUTONOMOUS LIVE TRADING/,
  "the authenticated Start Live Bot action must not be blocked by a redundant native dialog");
assert.match(source, /confirm_live_trading:\s*next/,
  "the server request must retain explicit live-trading confirmation");
assert.match(source, /value !== null && value !== undefined && value !== ""/,
  "numeric guards must reject null indicator warm-up values");
assert.match(source, /@media \(max-width:980px\)[\s\S]*?\.pfGrid \{ display:block; \}/,
  "the chart and condition grid must collapse cleanly on mobile");
assert.match(source, /localization:\s*\{\s*locale:\s*"ko-KR",\s*timeFormatter:/,
  "chart must enable KST timeFormatter localization");
assert.match(source, /tickMarkFormatter:\s*\(t,\s*type\)\s*=>\s*formatKstTick/,
  "chart timeScale must format tick marks in KST");
assert.match(source, /loadedMarket/,
  "controller must track loadedMarket separately from pending UI selections");

const featureMarkup = forecast.featureRowsMarkup(settings);
for (const group of ["momentum", "macd", "rsi", "ma", "volatility"]) {
  assert.match(featureMarkup, new RegExp(`id="pfUse_${group}"`),
    `${group} must have a real input switch`);
}

const index = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
assert.match(index, /id="navTabPriceForecast"/);
assert.match(index, /id="tabContentPriceForecast"/);
assert.match(index, /price-forecast-tab\.js/);
assert.match(index, /activateEngineWhenReady\(\(\) => window\.priceForecastTab, isPriceForecast, "tabContentPriceForecast"\)/,
  "tab activation must use the shared lazy activation path");
assert.match(index, /window\.priceForecastTab\.onTabDeactivated\(\)/,
  "navigation away must stop forecast polling");

// 1350 completed 4h bars + 180 1d bars V8 replay benchmark & forming-bar guard
const bars1350 = [];
const start4h = 1_680_000_000;
for (let i = 0; i < 1350; i += 1) {
  const c = 2000 + i * 0.4 + Math.sin(i / 17) * 45 + Math.cos(i / 5) * 9;
  const o = c - Math.sin(i / 4) * 3;
  bars1350.push({ time: start4h + i * 14400, close_time: start4h + (i + 1) * 14400, open: o, high: Math.max(o, c) + 6, low: Math.min(o, c) - 6, close: c, volume: 400 + (i % 20), completed: true });
}
bars1350.push({ time: start4h + 1350 * 14400, close_time: start4h + 1351 * 14400, open: 3000, high: 9999, low: 1, close: 9999, volume: 1, completed: false });
const daily180 = [];
const firstDay = Math.floor(bars1350[0].time / 86400) * 86400;
for (let d = 0; d < 250; d += 1) {
  const c = 1900 + d * 2.5 + Math.sin(d / 6) * 80;
  daily180.push({ time: firstDay + d * 86400, close_time: firstDay + (d + 1) * 86400, open: c - 4, high: c + 10, low: c - 10, close: c, volume: 2000, completed: true });
}
daily180.push({ time: firstDay + 250 * 86400, close_time: firstDay + 251 * 86400, open: 10, high: 10, low: 10, close: 10, volume: 1, completed: false });

const tReplayStart = Date.now();
const rep1 = forecast.runCausalReplayWithDaily(bars1350, daily180, { ...forecast.DEFAULT_SETTINGS, confidence_pct: 45 }, { max_eval_bars: 360, notional_usd: 200, leverage: 1 });
const replayMs = Date.now() - tReplayStart;
const rep5 = forecast.runCausalReplayWithDaily(bars1350, daily180, { ...forecast.DEFAULT_SETTINGS, confidence_pct: 45, use_stop_loss: true, stop_loss_pct: 1.5 }, { max_eval_bars: 360, notional_usd: 2000, leverage: 5 });
assert.equal(rep1.error, null);
assert.equal(rep1.summary.eval_bars, 360);
assert.equal(rep1.latest_evaluation.close_time, bars1350[1349].close_time, "forming 4h candle must be excluded from evaluation");
assert.deepEqual(rep1.entry_signals, rep5.entry_signals, "notional/leverage/stop-loss must never mutate position-independent entry_signals");
assert.ok(replayMs < 5000, `client V8 replay should be fast (<5000ms), got ${replayMs}ms`);

const firstPaperEntry = rep1.markers.find((marker) => marker.is_entry);
assert.ok(firstPaperEntry, "replay should create at least one simulated fill");
const fillIndex = bars1350.findIndex((bar) => bar.time === firstPaperEntry.time);
assert.ok(fillIndex > 0, "paper entry must occur after its completed signal candle");
assert.equal(firstPaperEntry.entry_price, bars1350[fillIndex].open,
  "paper fills must use the next bar open, never the signal candle close");
assert.ok(rep1.entry_signals.some((signal) => signal.entry_allowed && signal.index === fillIndex - 1),
  "next-open fill must be linked to the independently retained prior-candle entry signal");
assert.equal(rep1.summary.fill_model, "next_bar_open");

const held3 = forecast.runCausalReplayWithDaily(bars1350, daily180, {
  ...forecast.DEFAULT_SETTINGS, confidence_pct: 45, min_hold_bars: 3,
}, { max_eval_bars: 360, notional_usd: 200, leverage: 1 });
assert.ok(held3.trades.every((trade) => trade.reason === "stop_loss" || trade.exit_time - trade.entry_time >= 3 * 14400),
  "minimum hold must delay ordinary paper exits for the configured completed-bar count");

const edgeBlocked = forecast.runCausalReplayWithDaily(bars1350, daily180, {
  ...forecast.DEFAULT_SETTINGS, confidence_pct: 0, use_expected_edge_gate: true, min_expected_bps: 500,
}, { max_eval_bars: 120 });
assert.ok(edgeBlocked.entry_signals.length > 0);
assert.ok(edgeBlocked.entry_signals.every((signal) => !signal.entry_allowed && signal.edge_pass === false),
  "expected-edge switch and threshold must gate the real entry stream");

const confidenceOff = forecast.runCausalReplayWithDaily(bars1350, daily180, {
  ...forecast.DEFAULT_SETTINGS, use_confidence_gate: false, confidence_pct: 100,
}, { max_eval_bars: 120 });
assert.ok(confidenceOff.entry_signals.some((signal) => signal.entry_allowed),
  "disabling the confidence gate must affect replay instead of leaving a decorative switch");
assert.match(source, /id="pfBtnValidatedPreset"/);
assert.match(source, /min_hold_bars:\s*3/,
  "validated ETH preset must keep one-bar prediction separate from three-bar minimum hold");

console.log(`Causal price forecast tab tests passed (V8 360x1000 replay=${replayMs}ms)`);
